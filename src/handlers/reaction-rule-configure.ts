import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import {
  inlineButton,
  inlineKeyboard,
  registerMainMenuItem,
} from "../toolkit/index.js";
import { nowIso } from "../lib/clock.js";
import { fmtNum } from "../lib/format.js";
import { newId } from "../lib/ids.js";
import {
  getChannel,
  getOwner,
  listOwnerChannels,
  getPoolForChannel,
  getJobForChannel,
  saveJob,
} from "../lib/store.js";
import { executeReactionJob, requiredReactions } from "../lib/reaction-engine.js";
import {
  DEFAULT_TARGET_PERCENT,
  DEFAULT_TIMING,
  DEFAULT_TEMPLATES,
  type ReactionJob,
} from "../lib/types.js";
import { backMenu, withCancel } from "../lib/ui.js";

registerMainMenuItem({
  label: "Configure rules",
  data: "reaction_rule:configure",
  order: 30,
});

const composer = new Composer<Ctx>();

composer.callbackQuery("reaction_rule:configure", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from?.id;
  if (!userId) return;

  const owner = await getOwner(userId);
  if (!owner) {
    await ctx.reply("Connect your account first via Onboard account.", {
      reply_markup: inlineKeyboard([
        [inlineButton("Onboard account", "onboard:start")],
        [inlineButton("⬅️ Back to menu", "menu:main")],
      ]),
    });
    return;
  }

  const channels = await listOwnerChannels(userId);
  if (channels.length === 0) {
    await ctx.reply("Link a channel before configuring reaction rules.", {
      reply_markup: inlineKeyboard([
        [inlineButton("Onboard account", "onboard:start")],
        [inlineButton("⬅️ Back to menu", "menu:main")],
      ]),
    });
    return;
  }

  if (channels.length === 1) {
    await beginRuleForChannel(ctx, channels[0]!.channelId);
    return;
  }

  const rows = channels.map((c) => [
    inlineButton(
      (c.title || c.channelId).slice(0, 28),
      `reaction_rule:ch:${shortId(c.channelId)}`,
    ),
  ]);
  await ctx.reply("Which channel should these reaction rules apply to?", {
    reply_markup: withCancel(rows),
  });
});

composer.callbackQuery(/^reaction_rule:ch:(.+)$/, async (ctx) => {
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
  await beginRuleForChannel(ctx, ch.channelId);
});

composer.callbackQuery("reaction_rule:default_target", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.draftTargetPct = DEFAULT_TARGET_PERCENT;
  await askTiming(ctx);
});

composer.callbackQuery("reaction_rule:default_timing", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.draftSpreadMin = DEFAULT_TIMING.spreadMinutes;
  await askTemplates(ctx);
});

composer.callbackQuery("reaction_rule:default_templates", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.draftTemplates = DEFAULT_TEMPLATES.join("\n");
  await saveRuleFromSession(ctx);
});

composer.callbackQuery("reaction_rule:execute", async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Starting job…" });
  const userId = ctx.from?.id;
  const channelId = ctx.session.draftChannelId;
  if (!userId || !channelId) {
    await ctx.reply("Configure a rule first.", { reply_markup: backMenu() });
    return;
  }

  const job = await getJobForChannel(channelId);
  if (!job || job.ownerId !== userId) {
    await ctx.reply("No reaction rule for that channel yet.", {
      reply_markup: inlineKeyboard([
        [inlineButton("Configure rules", "reaction_rule:configure")],
        [inlineButton("⬅️ Back to menu", "menu:main")],
      ]),
    });
    return;
  }

  const pool = await getPoolForChannel(channelId);
  if (!pool) {
    await ctx.reply("Create a bot pool for this channel before running a job.", {
      reply_markup: inlineKeyboard([
        [inlineButton("Create bot pool", "bot_pool:create")],
        [inlineButton("⬅️ Back to menu", "menu:main")],
      ]),
    });
    return;
  }

  const managerToken = process.env.BOT_TOKEN || "harness-test-token";
  try {
    const result = await executeReactionJob(job.id, {
      managerToken,
      maxPostsThisCall: 20,
      sleep: async () => {},
    });

    const ch = await getChannel(channelId);
    await ctx.reply(
      `Job ${result.job.status} for ${ch?.title || channelId}.\n\n` +
        `Target: ${fmtNum(result.required)} reactions ` +
        `(${result.job.targetPercentage}% of ${result.job.subscriberSnapshot != null ? fmtNum(result.job.subscriberSnapshot) : "—"} subs)\n` +
        `Posted this run: ${result.posted} (planned ${result.planned})\n` +
        `Failed: ${result.failed}` +
        (result.rateLimited ? ` · rate-limited: ${result.rateLimited}` : "") +
        (result.removed ? ` · bots removed: ${result.removed}` : "") +
        `\n\nHigh-volume runs respect rate limits and spread posts over the configured window.`,
      {
        reply_markup: inlineKeyboard([
          [inlineButton("Monitor jobs", "monitor:jobs")],
          [inlineButton("⬅️ Back to menu", "menu:main")],
        ]),
      },
    );
  } catch {
    await ctx.reply("Couldn't run the job. Check that the pool has ready bots and try again.", {
      reply_markup: backMenu(),
    });
  }
});

composer.on("message:text", async (ctx, next) => {
  const step = ctx.session.step;
  if (
    step !== "rule_await_target" &&
    step !== "rule_await_timing" &&
    step !== "rule_await_templates"
  ) {
    return next();
  }

  const text = ctx.message.text.trim();

  if (step === "rule_await_target") {
    const n = Number(text.replace(/%/g, ""));
    if (!Number.isFinite(n) || n <= 0 || n > 100) {
      await ctx.reply("Send a target percentage between 1 and 100 (default 20).");
      return;
    }
    ctx.session.draftTargetPct = Math.round(n);
    await askTiming(ctx);
    return;
  }

  if (step === "rule_await_timing") {
    const n = Number(text.replace(/[^\d]/g, ""));
    if (!Number.isFinite(n) || n < 1 || n > 24 * 60) {
      await ctx.reply("Send spread window in minutes (1–1440). Default is 60.");
      return;
    }
    ctx.session.draftSpreadMin = Math.floor(n);
    await askTemplates(ctx);
    return;
  }

  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    await ctx.reply("Send at least one reply template (one per line).");
    return;
  }
  if (lines.some((l) => l.length > 500)) {
    await ctx.reply("Keep each template under 500 characters.");
    return;
  }
  ctx.session.draftTemplates = lines.join("\n");
  await saveRuleFromSession(ctx);
});

async function beginRuleForChannel(ctx: Ctx, channelId: string): Promise<void> {
  const ch = await getChannel(channelId);
  ctx.session.draftChannelId = channelId;
  ctx.session.step = "rule_await_target";
  const existing = await getJobForChannel(channelId);
  const need = requiredReactions(
    ch?.subscriberCount ?? 0,
    existing?.targetPercentage ?? DEFAULT_TARGET_PERCENT,
  );
  await ctx.reply(
    `Rules for ${ch?.title || channelId}\n` +
      `Subscribers: ${fmtNum(ch?.subscriberCount ?? 0)} → ` +
      `~${fmtNum(need)} reactions at ${existing?.targetPercentage ?? DEFAULT_TARGET_PERCENT}%\n\n` +
      `Send the reaction target percentage (1–100). Default is ${DEFAULT_TARGET_PERCENT}.`,
    {
      reply_markup: withCancel([
        [inlineButton(`Use ${DEFAULT_TARGET_PERCENT}%`, "reaction_rule:default_target")],
      ]),
    },
  );
}

async function askTiming(ctx: Ctx): Promise<void> {
  ctx.session.step = "rule_await_timing";
  await ctx.reply(
    `Target set to ${ctx.session.draftTargetPct ?? DEFAULT_TARGET_PERCENT}%.\n\n` +
      "Send how many minutes to spread posts over (rate-limit friendly). Default 60.",
    {
      reply_markup: withCancel([
        [inlineButton("Use 60 min", "reaction_rule:default_timing")],
      ]),
    },
  );
}

async function askTemplates(ctx: Ctx): Promise<void> {
  ctx.session.step = "rule_await_templates";
  await ctx.reply(
    "Send reply templates, one per line.\n" +
      "Keep them natural — spammy blasts risk channel limits and TOS issues.",
    {
      reply_markup: withCancel([
        [inlineButton("Use defaults", "reaction_rule:default_templates")],
      ]),
    },
  );
}

async function saveRuleFromSession(ctx: Ctx): Promise<void> {
  const userId = ctx.from?.id;
  const channelId = ctx.session.draftChannelId;
  if (!userId || !channelId) {
    await ctx.reply("Session expired. Start Configure rules again.", {
      reply_markup: backMenu(),
    });
    return;
  }

  const templates = (ctx.session.draftTemplates ?? DEFAULT_TEMPLATES.join("\n"))
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const existing = await getJobForChannel(channelId);
  const job: ReactionJob = {
    id: existing?.id ?? newId("job"),
    ownerId: userId,
    channelId,
    targetPercentage: ctx.session.draftTargetPct ?? DEFAULT_TARGET_PERCENT,
    timing: {
      spreadMinutes: ctx.session.draftSpreadMin ?? DEFAULT_TIMING.spreadMinutes,
      maxPerBotPerMinute: DEFAULT_TIMING.maxPerBotPerMinute,
    },
    templates,
    status: "configured",
    createdAt: existing?.createdAt ?? nowIso(),
    updatedAt: nowIso(),
  };
  await saveJob(job);

  ctx.session.step = "idle";
  const ch = await getChannel(channelId);
  const need = requiredReactions(ch?.subscriberCount ?? 0, job.targetPercentage);

  await ctx.reply(
    `Reaction rule saved for ${ch?.title || channelId}.\n\n` +
      `Target: ${job.targetPercentage}% (~${fmtNum(need)} reactions)\n` +
      `Spread: ${job.timing.spreadMinutes} min · max ${job.timing.maxPerBotPerMinute}/bot/min\n` +
      `Templates: ${job.templates.length}\n` +
      `Status: ${job.status}`,
    {
      reply_markup: inlineKeyboard([
        [inlineButton("Run job now", "reaction_rule:execute")],
        [inlineButton("Monitor jobs", "monitor:jobs")],
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
