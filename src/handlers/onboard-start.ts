import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import {
  inlineButton,
  inlineKeyboard,
  registerMainMenuItem,
} from "../toolkit/index.js";
import { nowIso } from "../lib/clock.js";
import { fmtNum } from "../lib/format.js";
import {
  getOwner,
  saveOwner,
  saveChannel,
  listOwnerChannels,
  getChannel,
} from "../lib/store.js";
import { getChat, getChatMemberCount } from "../lib/telegram.js";
import { backMenu, withCancel } from "../lib/ui.js";
import type { Channel, OwnerAccount } from "../lib/types.js";

registerMainMenuItem({ label: "Onboard account", data: "onboard:start", order: 10 });

const composer = new Composer<Ctx>();

composer.callbackQuery("onboard:start", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply(
      "Couldn't identify your Telegram account. Open this bot in a private chat.",
    );
    return;
  }

  const existing = await getOwner(userId);
  const channels = existing ? await listOwnerChannels(userId) : [];

  if (existing && channels.length > 0) {
    const lines = channels
      .map(
        (c) =>
          `• ${c.title || c.channelId} — ${fmtNum(c.subscriberCount)} subs (${c.linked ? "linked" : "pending"})`,
      )
      .join("\n");
    await ctx.reply(
      `You're already onboarded.\n\nChannels:\n${lines}\n\nLink another channel or continue from the menu.`,
      {
        reply_markup: inlineKeyboard([
          [inlineButton("Link a channel", "onboard:link_channel")],
          [inlineButton("Optional email", "onboard:email")],
          [inlineButton("⬅️ Back to menu", "menu:main")],
        ]),
      },
    );
    return;
  }

  if (existing) {
    await ctx.reply(
      "You're connected as the owner, but no channel is linked yet.\n\n" +
        "Add this bot as a channel admin, then link the channel.",
      {
        reply_markup: withCancel([
          [inlineButton("Link a channel", "onboard:link_channel")],
        ]),
      },
    );
    return;
  }

  await ctx.reply(
    "We'll connect your Telegram account as the owner, then you'll authorize a channel.\n\n" +
      "Subscriber counts stay private — never shared or sold.",
    {
      reply_markup: withCancel([[inlineButton("Connect account", "onboard:connect")]]),
    },
  );
});

composer.callbackQuery("onboard:connect", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply("Couldn't identify your Telegram account.");
    return;
  }

  let owner = await getOwner(userId);
  if (!owner) {
    owner = {
      userId,
      connectedAt: nowIso(),
      notifyDm: true,
      botCount: 0,
    } satisfies OwnerAccount;
    await saveOwner(owner);
  }

  await ctx.reply(
    "You're connected as the owner. Next, authorize a channel.\n\n" +
      "Add this bot as an admin (post messages), then send the channel @username or numeric id.",
    {
      reply_markup: withCancel([
        [inlineButton("Link a channel", "onboard:link_channel")],
      ]),
    },
  );
});

composer.callbackQuery("onboard:link_channel", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from?.id;
  if (!userId) return;
  const owner = await getOwner(userId);
  if (!owner) {
    await ctx.reply("Connect your account first.", {
      reply_markup: withCancel([[inlineButton("Connect account", "onboard:connect")]]),
    });
    return;
  }

  ctx.session.step = "onboard_await_channel";
  ctx.session.draftTemplates = undefined;
  await ctx.reply(
    "Send the channel @username or id (example: @mychannel).\n\n" +
      "You must already be able to add bots as admin there.",
    { reply_markup: withCancel([]) },
  );
});

composer.callbackQuery("onboard:email", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "onboard_await_email";
  await ctx.reply("Optional: send an email for billing notices, or tap Cancel to skip.", {
    reply_markup: withCancel([]),
  });
});

composer.callbackQuery("onboard:verify", async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Checking channel…" });
  const userId = ctx.from?.id;
  if (!userId) return;
  const channelId = ctx.session.draftChannelId;
  if (!channelId) {
    await ctx.reply("No channel pending verification. Link one first.", {
      reply_markup: backMenu(),
    });
    return;
  }
  await verifyAndSaveChannel(ctx, userId, channelId);
});

composer.callbackQuery("onboard:set_subs", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.session.draftChannelId) {
    await ctx.reply("Link a channel first.", { reply_markup: backMenu() });
    return;
  }
  ctx.session.step = "onboard_await_channel";
  ctx.session.draftTemplates = "__set_subs__";
  await ctx.reply(
    "Send the current subscriber count as a number (e.g. 10000). Used for the 20% reaction target.",
    { reply_markup: withCancel([]) },
  );
});

composer.on("message:text", async (ctx, next) => {
  const step = ctx.session.step;
  const userId = ctx.from?.id;
  if (!userId) return next();

  if (ctx.session.draftTemplates === "__set_subs__" && ctx.session.draftChannelId) {
    const channelId = ctx.session.draftChannelId;
    const n = Number(ctx.message.text.trim().replace(/[, ]/g, ""));
    if (!Number.isFinite(n) || n < 0 || n > 50_000_000) {
      await ctx.reply("Send a whole number of subscribers (0 or more).");
      return;
    }
    const ch = await getChannel(channelId);
    if (!ch || ch.ownerId !== userId) {
      await ctx.reply("Channel not found.", { reply_markup: backMenu() });
      ctx.session.draftTemplates = undefined;
      ctx.session.step = "idle";
      return;
    }
    ch.subscriberCount = Math.floor(n);
    ch.updatedAt = nowIso();
    if (!ch.linked) ch.linked = true;
    await saveChannel(ch);
    ctx.session.draftTemplates = undefined;
    ctx.session.step = "idle";
    await ctx.reply(
      `Updated ${ch.title || ch.channelId} to ${fmtNum(ch.subscriberCount)} subscribers.\n` +
        `At 20% target that's ${fmtNum(Math.ceil(ch.subscriberCount * 0.2))} reactions per job.`,
      {
        reply_markup: inlineKeyboard([
          [inlineButton("Create bot pool", "bot_pool:create")],
          [inlineButton("⬅️ Back to menu", "menu:main")],
        ]),
      },
    );
    return;
  }

  if (step === "onboard_await_email") {
    const email = ctx.message.text.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      await ctx.reply("That doesn't look like an email. Try again, or tap Cancel.");
      return;
    }
    const owner = await getOwner(userId);
    if (owner) {
      owner.email = email;
      await saveOwner(owner);
    }
    ctx.session.step = "idle";
    await ctx.reply(`Saved ${email}. You'll still get quota alerts here in Telegram.`, {
      reply_markup: backMenu(),
    });
    return;
  }

  if (step !== "onboard_await_channel") return next();

  const raw = ctx.message.text.trim();
  if (!raw || raw.startsWith("/")) {
    await ctx.reply("Send a channel @username or numeric id.");
    return;
  }
  await verifyAndSaveChannel(ctx, userId, raw);
});

async function verifyAndSaveChannel(
  ctx: Ctx,
  userId: number,
  raw: string,
): Promise<void> {
  const managerToken = process.env.BOT_TOKEN || "harness-test-token";
  const chatKey = normalizeInput(raw);

  const chatRes = await getChat(managerToken, chatKey);

  let title = chatKey;
  let channelId = chatKey;
  let subscribers = 0;
  let linked = false;

  if (chatRes.ok && chatRes.result) {
    const chat = chatRes.result;
    channelId = String(chat.id);
    title = chat.title || (chat.username ? `@${chat.username}` : channelId);
    const countRes = await getChatMemberCount(managerToken, chat.id);
    if (countRes.ok && typeof countRes.result === "number") {
      subscribers = countRes.result;
    }
    linked = true;
  }

  const channel: Channel = {
    channelId,
    title,
    subscriberCount: subscribers,
    linked,
    ownerId: userId,
    updatedAt: nowIso(),
  };

  const prev = await getChannel(channelId);
  if (prev && prev.subscriberCount > channel.subscriberCount) {
    channel.subscriberCount = prev.subscriberCount;
  }

  await saveChannel(channel);

  let owner = await getOwner(userId);
  if (!owner) {
    owner = {
      userId,
      connectedAt: nowIso(),
      notifyDm: true,
      botCount: 0,
    };
    await saveOwner(owner);
  }

  ctx.session.step = "idle";
  ctx.session.draftChannelId = channelId;

  if (linked) {
    await ctx.reply(
      `Linked ${title} — ${fmtNum(channel.subscriberCount)} subscribers.\n\n` +
        "You can create a bot pool for this channel next.",
      {
        reply_markup: inlineKeyboard([
          [inlineButton("Create bot pool", "bot_pool:create")],
          [inlineButton("Link another", "onboard:link_channel")],
          [inlineButton("⬅️ Back to menu", "menu:main")],
        ]),
      },
    );
  } else {
    await ctx.reply(
      `Saved ${title} as pending.\n\n` +
        "Couldn't verify admin access yet. Add this bot as a channel admin with post rights, then tap Verify — or set the subscriber count manually.",
      {
        reply_markup: inlineKeyboard([
          [inlineButton("Verify channel", "onboard:verify")],
          [inlineButton("Set subscriber count", "onboard:set_subs")],
          [inlineButton("⬅️ Back to menu", "menu:main")],
        ]),
      },
    );
  }
}

function normalizeInput(raw: string): string {
  const t = raw.trim();
  if (t.startsWith("https://t.me/")) {
    const part = t.replace("https://t.me/", "").split(/[/?]/)[0] ?? t;
    return part.startsWith("+") ? t : `@${part}`;
  }
  if (/^-?\d+$/.test(t)) return t;
  return t.startsWith("@") ? t : `@${t}`;
}

export default composer;
