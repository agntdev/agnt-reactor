import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import {
  inlineButton,
  inlineKeyboard,
  registerMainMenuItem,
} from "../toolkit/index.js";
import { now } from "../lib/clock.js";
import { fmtNum } from "../lib/format.js";
import {
  getChannel,
  getOwner,
  listOwnerChannels,
  listOwnerJobs,
  listJobLogs,
  getPoolForChannel,
  listBotsByIds,
} from "../lib/store.js";
import type { ReactionJob } from "../lib/types.js";
import { backMenu, withCancel } from "../lib/ui.js";

registerMainMenuItem({ label: "Monitor jobs", data: "monitor:jobs", order: 40 });

const composer = new Composer<Ctx>();

composer.callbackQuery("monitor:jobs", async (ctx) => {
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

  ctx.session.filterChannelId = undefined;
  ctx.session.filterRange = "all";
  await showJobs(ctx, userId);
});

composer.callbackQuery("monitor:filter_channel", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from?.id;
  if (!userId) return;
  const channels = await listOwnerChannels(userId);
  if (channels.length === 0) {
    await ctx.reply("No channels to filter on.", { reply_markup: backMenu() });
    return;
  }
  const rows = [
    [inlineButton("All channels", "monitor:ch:all")],
    ...channels.map((c) => [
      inlineButton(
        (c.title || c.channelId).slice(0, 28),
        `monitor:ch:${shortId(c.channelId)}`,
      ),
    ]),
  ];
  await ctx.reply("Filter jobs by channel:", { reply_markup: withCancel(rows) });
});

composer.callbackQuery(/^monitor:ch:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from?.id;
  if (!userId) return;
  const key = ctx.match[1]!;
  if (key === "all") {
    ctx.session.filterChannelId = undefined;
  } else {
    const channels = await listOwnerChannels(userId);
    const ch = channels.find((c) => shortId(c.channelId) === key || c.channelId === key);
    ctx.session.filterChannelId = ch?.channelId;
  }
  await showJobs(ctx, userId);
});

composer.callbackQuery(/^monitor:range:(24h|7d|all)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from?.id;
  if (!userId) return;
  ctx.session.filterRange = ctx.match[1] as "24h" | "7d" | "all";
  await showJobs(ctx, userId);
});

composer.callbackQuery(/^monitor:detail:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from?.id;
  if (!userId) return;
  const jobId = ctx.match[1]!;
  const jobs = await listOwnerJobs(userId);
  const job = jobs.find((j) => j.id === jobId);
  if (!job) {
    await ctx.reply("Job not found.", { reply_markup: backMenu() });
    return;
  }
  const ch = await getChannel(job.channelId);
  const logs = await listJobLogs(job.id, 10);
  const pool = await getPoolForChannel(job.channelId);
  const bots = pool ? await listBotsByIds(pool.botIds) : [];
  const ready = bots.filter((b) => b.status === "ready").length;

  const logLines =
    logs.length === 0
      ? "No posts logged yet."
      : logs
          .map((l) => `· ${statusLabel(l.status)} — ${truncate(l.messageContent, 40)}`)
          .join("\n");

  await ctx.reply(
    `Job detail — ${ch?.title || job.channelId}\n\n` +
      `Status: ${job.status}\n` +
      `Target: ${job.targetPercentage}%` +
      (job.requiredReactions != null
        ? ` (${fmtNum(job.requiredReactions)} reactions)`
        : "") +
      `\nPosted: ${job.postedCount ?? 0} · Failed: ${job.failedCount ?? 0}\n` +
      `Spread: ${job.timing.spreadMinutes} min\n` +
      `Pool: ${bots.length} bots (${ready} ready)${pool ? `, ${pool.status}` : ""}\n` +
      `Last run: ${job.lastRunAt ? friendlyTime(job.lastRunAt) : "never"}\n\n` +
      `Recent activity:\n${logLines}`,
    {
      reply_markup: inlineKeyboard([
        [inlineButton("Run job", "reaction_rule:execute")],
        [inlineButton("All jobs", "monitor:jobs")],
        [inlineButton("⬅️ Back to menu", "menu:main")],
      ]),
    },
  );
  ctx.session.draftChannelId = job.channelId;
});

async function showJobs(ctx: Ctx, userId: number): Promise<void> {
  let jobs = await listOwnerJobs(userId);
  const filterCh = ctx.session.filterChannelId;
  const range = ctx.session.filterRange ?? "all";

  if (filterCh) {
    jobs = jobs.filter((j) => j.channelId === filterCh);
  }
  if (range !== "all") {
    const ms = range === "24h" ? 24 * 3600_000 : 7 * 24 * 3600_000;
    const cutoff = now() - ms;
    jobs = jobs.filter((j) => Date.parse(j.updatedAt) >= cutoff);
  }

  if (jobs.length === 0) {
    await ctx.reply(
      "No jobs match these filters yet — configure a reaction rule to create one.",
      {
        reply_markup: inlineKeyboard([
          [inlineButton("Configure rules", "reaction_rule:configure")],
          [inlineButton("Filter channel", "monitor:filter_channel")],
          [
            inlineButton("24h", "monitor:range:24h"),
            inlineButton("7d", "monitor:range:7d"),
            inlineButton("All", "monitor:range:all"),
          ],
          [inlineButton("⬅️ Back to menu", "menu:main")],
        ]),
      },
    );
    return;
  }

  const summary = await Promise.all(jobs.slice(0, 8).map((j) => formatJobLine(j)));
  const detailRows = jobs.slice(0, 5).map((j) => [
    inlineButton(`Details · ${statusLabel(j.status)}`, `monitor:detail:${j.id}`),
  ]);

  const filterNote = [
    filterCh ? `channel filter on` : "all channels",
    range === "all" ? "any time" : range,
  ].join(", ");

  await ctx.reply(`Job status (${filterNote})\n\n${summary.join("\n\n")}`, {
    reply_markup: inlineKeyboard([
      ...detailRows,
      [inlineButton("Filter channel", "monitor:filter_channel")],
      [
        inlineButton("24h", "monitor:range:24h"),
        inlineButton("7d", "monitor:range:7d"),
        inlineButton("All", "monitor:range:all"),
      ],
      [inlineButton("⬅️ Back to menu", "menu:main")],
    ]),
  });
}

async function formatJobLine(job: ReactionJob): Promise<string> {
  const ch = await getChannel(job.channelId);
  const title = ch?.title || job.channelId;
  const posted = job.postedCount ?? 0;
  const required = job.requiredReactions;
  const progress =
    required != null ? `${fmtNum(posted)}/${fmtNum(required)}` : `${posted}`;
  return (
    `• ${title}\n` +
    `  ${statusLabel(job.status)} · ${job.targetPercentage}% · posts ${progress}\n` +
    `  updated ${friendlyTime(job.updatedAt)}`
  );
}

function statusLabel(s: string): string {
  switch (s) {
    case "configured":
      return "configured";
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "partial":
      return "partial";
    case "failed":
      return "failed";
    case "paused":
      return "paused";
    case "ok":
      return "ok";
    case "rate_limited":
      return "rate-limited";
    case "bot_removed":
      return "bot removed";
    case "error":
      return "error";
    default:
      return s;
  }
}

function friendlyTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "recently";
  const diff = Math.max(0, now() - t);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function shortId(channelId: string): string {
  if (channelId.length <= 40) return channelId;
  let h = 0;
  for (let i = 0; i < channelId.length; i++) h = (h * 31 + channelId.charCodeAt(i)) | 0;
  return `h${(h >>> 0).toString(36)}`;
}

export default composer;
