import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import {
  inlineButton,
  inlineKeyboard,
  registerMainMenuItem,
} from "../toolkit/index.js";
import { fmtNum } from "../lib/format.js";
import {
  autoBotCount,
  createBotPool,
  remainingBotQuota,
  setPoolStatus,
  attachBotToken,
} from "../lib/pool-service.js";
import {
  getChannel,
  getOwner,
  listOwnerChannels,
  getPoolForChannel,
  listBotsByIds,
  getBot,
} from "../lib/store.js";
import { FREE_TIER_BOT_LIMIT } from "../lib/types.js";
import { backMenu, withCancel } from "../lib/ui.js";

registerMainMenuItem({ label: "Create bot pool", data: "bot_pool:create", order: 20 });
registerMainMenuItem({ label: "Manage pool", data: "bot_pool:manage", order: 25 });

const composer = new Composer<Ctx>();

composer.callbackQuery("bot_pool:create", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from?.id;
  if (!userId) return;

  const owner = await getOwner(userId);
  if (!owner) {
    await ctx.reply(
      "Connect your account first — open Onboard account from the menu.",
      {
        reply_markup: inlineKeyboard([
          [inlineButton("Onboard account", "onboard:start")],
          [inlineButton("⬅️ Back to menu", "menu:main")],
        ]),
      },
    );
    return;
  }

  const channels = await listOwnerChannels(userId);
  if (channels.length === 0) {
    await ctx.reply(
      "No channels linked yet — onboard a channel before creating a bot pool.",
      {
        reply_markup: inlineKeyboard([
          [inlineButton("Onboard account", "onboard:start")],
          [inlineButton("⬅️ Back to menu", "menu:main")],
        ]),
      },
    );
    return;
  }

  const quota = await remainingBotQuota(userId);
  if (quota <= 0) {
    await ctx.reply(
      `Free tier supports up to ${FREE_TIER_BOT_LIMIT} bots and you're at the limit. Pause or remove bots under Manage pool, or upgrade your plan.`,
      { reply_markup: backMenu() },
    );
    return;
  }

  if (channels.length === 1) {
    const ch = channels[0]!;
    ctx.session.draftChannelId = ch.channelId;
    await askBotCount(ctx, ch.channelId, ch.subscriberCount, quota);
    return;
  }

  const rows = channels.map((c) => [
    inlineButton(
      `${c.title || c.channelId}`.slice(0, 28),
      `bot_pool:ch:${shortId(c.channelId)}`,
    ),
  ]);
  await ctx.reply(
    `Pick a channel for the new pool (${quota} bot slot(s) left on free tier):`,
    { reply_markup: withCancel(rows) },
  );
});

composer.callbackQuery(/^bot_pool:ch:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from?.id;
  if (!userId) return;
  const short = ctx.match[1]!;
  const channels = await listOwnerChannels(userId);
  const ch = channels.find((c) => shortId(c.channelId) === short || c.channelId === short);
  if (!ch) {
    await ctx.reply("Couldn't find that channel. Try again from the menu.", {
      reply_markup: backMenu(),
    });
    return;
  }
  ctx.session.draftChannelId = ch.channelId;
  const quota = await remainingBotQuota(userId);
  await askBotCount(ctx, ch.channelId, ch.subscriberCount, quota);
});

composer.callbackQuery("bot_pool:auto", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from?.id;
  const channelId = ctx.session.draftChannelId;
  if (!userId || !channelId) {
    await ctx.reply("Start from Create bot pool.", { reply_markup: backMenu() });
    return;
  }
  const ch = await getChannel(channelId);
  const quota = await remainingBotQuota(userId);
  const n = autoBotCount(ch?.subscriberCount ?? 1000, quota);
  ctx.session.step = "idle";
  await finishCreate(ctx, userId, channelId, n);
});

composer.callbackQuery("bot_pool:manage", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from?.id;
  if (!userId) return;
  const channels = await listOwnerChannels(userId);
  if (channels.length === 0) {
    await ctx.reply("No pools yet — create a bot pool after onboarding a channel.", {
      reply_markup: inlineKeyboard([
        [inlineButton("Create bot pool", "bot_pool:create")],
        [inlineButton("⬅️ Back to menu", "menu:main")],
      ]),
    });
    return;
  }

  const lines: string[] = [];
  const rows: ReturnType<typeof inlineButton>[][] = [];
  for (const ch of channels) {
    const pool = await getPoolForChannel(ch.channelId);
    if (!pool) {
      lines.push(`• ${ch.title || ch.channelId}: no pool`);
      continue;
    }
    const bots = await listBotsByIds(pool.botIds);
    const ready = bots.filter((b) => b.status === "ready").length;
    lines.push(
      `• ${ch.title || ch.channelId}: ${bots.length} bots (${ready} ready), ${pool.status}`,
    );
    rows.push([
      inlineButton(
        pool.status === "active" ? "Pause pool" : "Resume pool",
        `bot_pool:toggle:${shortId(ch.channelId)}`,
      ),
    ]);
    for (const b of bots.filter((x) => x.status === "pending_token").slice(0, 3)) {
      rows.push([
        inlineButton(`Add token: ${b.displayName}`, `bot_pool:token:${b.id}`),
      ]);
    }
  }

  if (lines.length === 0) {
    await ctx.reply("No pools yet — tap Create bot pool.", {
      reply_markup: inlineKeyboard([
        [inlineButton("Create bot pool", "bot_pool:create")],
        [inlineButton("⬅️ Back to menu", "menu:main")],
      ]),
    });
    return;
  }

  await ctx.reply(`Bot pools\n\n${lines.join("\n")}`, {
    reply_markup: inlineKeyboard([
      ...rows,
      [inlineButton("Create bot pool", "bot_pool:create")],
      [inlineButton("⬅️ Back to menu", "menu:main")],
    ]),
  });
});

composer.callbackQuery(/^bot_pool:toggle:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from?.id;
  if (!userId) return;
  const short = ctx.match[1]!;
  const channels = await listOwnerChannels(userId);
  const ch = channels.find((c) => shortId(c.channelId) === short || c.channelId === short);
  if (!ch) {
    await ctx.reply("Channel not found.", { reply_markup: backMenu() });
    return;
  }
  const pool = await getPoolForChannel(ch.channelId);
  if (!pool) {
    await ctx.reply("No pool on that channel.", { reply_markup: backMenu() });
    return;
  }
  const next = pool.status === "active" ? "paused" : "active";
  await setPoolStatus(ch.channelId, userId, next);
  await ctx.reply(
    next === "paused"
      ? `Paused the pool for ${ch.title || ch.channelId}. Jobs won't post until you resume.`
      : `Resumed the pool for ${ch.title || ch.channelId}.`,
    { reply_markup: backMenu() },
  );
});

composer.callbackQuery(/^bot_pool:token:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const botId = ctx.match[1]!;
  const userId = ctx.from?.id;
  if (!userId) return;
  const bot = await getBot(botId);
  if (!bot || bot.ownerId !== userId) {
    await ctx.reply("Bot not found.", { reply_markup: backMenu() });
    return;
  }
  ctx.session.step = "pool_await_token";
  ctx.session.draftBotId = botId;
  await ctx.reply(
    `Send the BotFather token for ${bot.displayName}.\n\n` +
      "Tokens stay server-side and are never shown in full. Create bots only via BotFather — we don't automate account creation (Telegram TOS).",
    { reply_markup: withCancel([]) },
  );
});

composer.on("message:text", async (ctx, next) => {
  const step = ctx.session.step;
  const userId = ctx.from?.id;
  if (!userId) return next();

  if (step === "pool_await_token") {
    const botId = ctx.session.draftBotId;
    if (!botId) {
      ctx.session.step = "idle";
      return next();
    }
    const bot = await attachBotToken(botId, userId, ctx.message.text.trim());
    ctx.session.step = "idle";
    ctx.session.draftBotId = undefined;
    if (!bot) {
      await ctx.reply(
        "That token doesn't look valid. It should look like 123456:AA…. Get it from @BotFather.",
        {
          reply_markup: withCancel([
            [inlineButton("Try again", `bot_pool:token:${botId}`)],
          ]),
        },
      );
      return;
    }
    await ctx.reply(
      `${bot.displayName} is ready (${bot.tokenHint}). Add it to the channel as admin so it can post reactions.`,
      { reply_markup: backMenu() },
    );
    return;
  }

  if (step !== "pool_await_count") return next();

  const channelId = ctx.session.draftChannelId;
  if (!channelId) {
    ctx.session.step = "idle";
    await ctx.reply("Start from Create bot pool.", { reply_markup: backMenu() });
    return;
  }

  const text = ctx.message.text.trim().toLowerCase();
  if (text === "auto") {
    const ch = await getChannel(channelId);
    const quota = await remainingBotQuota(userId);
    const n = autoBotCount(ch?.subscriberCount ?? 1000, quota);
    ctx.session.step = "idle";
    await finishCreate(ctx, userId, channelId, n);
    return;
  }

  const n = Number(text.replace(/[^\d]/g, ""));
  if (!Number.isFinite(n) || n < 1) {
    await ctx.reply("Send a whole number of bots (1 or more), or auto.");
    return;
  }

  ctx.session.step = "idle";
  await finishCreate(ctx, userId, channelId, Math.floor(n));
});

async function askBotCount(
  ctx: Ctx,
  channelId: string,
  subscribers: number,
  quota: number,
): Promise<void> {
  const suggested = autoBotCount(subscribers, quota);
  ctx.session.step = "pool_await_count";
  ctx.session.draftChannelId = channelId;
  const ch = await getChannel(channelId);
  await ctx.reply(
    `Channel: ${ch?.title || channelId}\n` +
      `Subscribers: ${fmtNum(ch?.subscriberCount ?? subscribers)}\n` +
      `Free-tier slots left: ${quota} (max ${FREE_TIER_BOT_LIMIT})\n\n` +
      `How many bots? Suggested: ${suggested}. Send a number, or tap Auto.`,
    {
      reply_markup: withCancel([
        [inlineButton(`Auto (${suggested})`, "bot_pool:auto")],
      ]),
    },
  );
}

async function finishCreate(
  ctx: Ctx,
  userId: number,
  channelId: string,
  count: number,
): Promise<void> {
  const result = await createBotPool({ ownerId: userId, channelId, count });
  if (!result.ok || !result.bots || !result.pool) {
    await ctx.reply(result.error ?? "Couldn't create the pool.", {
      reply_markup: backMenu(),
    });
    return;
  }

  const lines = result.bots.map(
    (b) => `• ${b.displayName} — ${b.status === "ready" ? "ready" : "needs token"}`,
  );
  const pending = result.bots.filter((b) => b.status === "pending_token");

  let extra =
    "\nAdd each bot to the channel as admin. We never auto-create Telegram accounts — tokens come from BotFather or BOT_TOKEN_POOL.";
  if (pending.length > 0) {
    extra += `\n${pending.length} bot(s) need a token — open Manage pool to paste them.`;
  }

  await ctx.reply(
    `Created ${result.created} bot(s) for this channel.\n\n` +
      `${lines.join("\n")}\n` +
      `Remaining free-tier slots: ${result.remainingQuota}` +
      extra,
    {
      reply_markup: inlineKeyboard([
        [inlineButton("Manage pool", "bot_pool:manage")],
        [inlineButton("Configure rules", "reaction_rule:configure")],
        [inlineButton("⬅️ Back to menu", "menu:main")],
      ]),
    },
  );
}

function shortId(channelId: string): string {
  if (channelId.length <= 40) return channelId;
  let h = 0;
  for (let i = 0; i < channelId.length; i++) h = (h * 31 + channelId.charCodeAt(i)) | 0;
  return `h${(h >>> 0).toString(36)}`;
}

export default composer;
