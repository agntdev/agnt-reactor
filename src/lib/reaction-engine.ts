/**
 * Reaction job calculation + rate-limit-aware execution.
 * Pure calculation is fully testable; execution uses injectable telegram API.
 */

import { now, nowIso } from "./clock.js";
import { newId } from "./ids.js";
import {
  getChannel,
  getJob,
  listBotsByIds,
  getPoolForChannel,
  saveChannel,
  saveJob,
  saveLog,
  saveBot,
  getOwner,
} from "./store.js";
import {
  sendReactionMessage,
  getChatMemberCount,
  safeDm,
  type TgApiResult,
} from "./telegram.js";
import type { BotProfile, ReactionJob, ReactionLog, TimingRules } from "./types.js";
import { DEFAULT_TARGET_PERCENT } from "./types.js";

/** How many reactions are required for a subscriber count + target %. */
export function requiredReactions(
  subscriberCount: number,
  targetPercentage: number = DEFAULT_TARGET_PERCENT,
): number {
  if (subscriberCount <= 0) return 0;
  const pct = Math.min(100, Math.max(0, targetPercentage));
  return Math.ceil((subscriberCount * pct) / 100);
}

/**
 * Max posts the pool can deliver in one run without exceeding per-bot rate.
 * spreadMinutes * maxPerBotPerMinute * readyBots.
 */
export function maxPostsInWindow(
  readyBotCount: number,
  timing: TimingRules,
): number {
  if (readyBotCount <= 0) return 0;
  const minutes = Math.max(1, timing.spreadMinutes);
  const perMin = Math.max(1, timing.maxPerBotPerMinute);
  return readyBotCount * minutes * perMin;
}

/** Delay between posts (ms) to stay under rate limits across the pool. */
export function interPostDelayMs(readyBotCount: number, timing: TimingRules): number {
  if (readyBotCount <= 0) return 60_000;
  const perMin = Math.max(1, timing.maxPerBotPerMinute);
  // Pool-wide posts per minute = readyBots * perMin
  const poolPerMin = readyBotCount * perMin;
  return Math.ceil(60_000 / poolPerMin);
}

export interface PlanResult {
  subscriberCount: number;
  targetPercentage: number;
  required: number;
  capacity: number;
  planned: number;
  readyBots: BotProfile[];
  delayMs: number;
}

/** Build an execution plan (no side effects). */
export function planReactions(
  subscriberCount: number,
  targetPercentage: number,
  readyBots: BotProfile[],
  timing: TimingRules,
): PlanResult {
  const required = requiredReactions(subscriberCount, targetPercentage);
  const capacity = maxPostsInWindow(readyBots.length, timing);
  const planned = Math.min(required, capacity);
  return {
    subscriberCount,
    targetPercentage,
    required,
    capacity,
    planned,
    readyBots,
    delayMs: interPostDelayMs(readyBots.length, timing),
  };
}

export interface ExecuteOptions {
  /** Management bot token (for getChatMemberCount refresh + owner DM). */
  managerToken: string;
  /** Optional sleep; tests inject a no-op. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Cap posts in this invocation (for interactive / dry runs).
   * Full background jobs omit this.
   */
  maxPostsThisCall?: number;
  /** Target message to reply under (channel post id). Optional. */
  replyToMessageId?: number;
}

export interface ExecuteResult {
  job: ReactionJob;
  posted: number;
  failed: number;
  rateLimited: number;
  removed: number;
  planned: number;
  required: number;
  logs: ReactionLog[];
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Execute a reaction job: refresh subscriber count, select ready bots,
 * post with rate-limit awareness, log every attempt, alert owner on quota.
 */
export async function executeReactionJob(
  jobId: string,
  opts: ExecuteOptions,
): Promise<ExecuteResult> {
  const sleep = opts.sleep ?? defaultSleep;
  const job = await getJob(jobId);
  if (!job) throw new Error("job not found");

  const channel = await getChannel(job.channelId);
  if (!channel) throw new Error("channel not found");

  const pool = await getPoolForChannel(job.channelId);
  if (!pool || pool.status === "paused") {
    job.status = "paused";
    job.updatedAt = nowIso();
    await saveJob(job);
    return {
      job,
      posted: 0,
      failed: 0,
      rateLimited: 0,
      removed: 0,
      planned: 0,
      required: 0,
      logs: [],
    };
  }

  // Refresh subscriber count mid-job capability (edge case).
  let subscribers = channel.subscriberCount;
  const countRes = await getChatMemberCount(opts.managerToken, normalizeChatId(channel.channelId));
  if (countRes.ok && typeof countRes.result === "number") {
    subscribers = countRes.result;
    channel.subscriberCount = subscribers;
    channel.updatedAt = nowIso();
    await saveChannel(channel);
  }

  const bots = await listBotsByIds(pool.botIds);
  const readyBots = bots.filter((b) => b.status === "ready" && b.token);

  const plan = planReactions(subscribers, job.targetPercentage, readyBots, job.timing);
  const limit = opts.maxPostsThisCall ?? plan.planned;
  const toPost = Math.min(plan.planned, limit);

  job.status = "running";
  job.requiredReactions = plan.required;
  job.subscriberSnapshot = subscribers;
  job.postedCount = 0;
  job.failedCount = 0;
  job.lastRunAt = nowIso();
  job.updatedAt = nowIso();
  await saveJob(job);

  const logs: ReactionLog[] = [];
  let posted = 0;
  let failed = 0;
  let rateLimited = 0;
  let removed = 0;

  if (toPost === 0 || readyBots.length === 0) {
    job.status = readyBots.length === 0 ? "failed" : "completed";
    job.updatedAt = nowIso();
    await saveJob(job);
    // Quota / empty pool alert
    await alertOwner(opts.managerToken, job.ownerId, emptyPoolMessage(readyBots.length, plan));
    return { job, posted, failed, rateLimited, removed, planned: toPost, required: plan.required, logs };
  }

  const templates =
    job.templates.length > 0 ? job.templates : ["Great post!"];

  for (let i = 0; i < toPost; i++) {
    // Mid-run subscriber refresh every 50 posts
    if (i > 0 && i % 50 === 0) {
      const mid = await getChatMemberCount(opts.managerToken, normalizeChatId(channel.channelId));
      if (mid.ok && typeof mid.result === "number" && mid.result !== subscribers) {
        subscribers = mid.result;
        channel.subscriberCount = subscribers;
        channel.updatedAt = nowIso();
        await saveChannel(channel);
        // Recompute remaining target vs already posted
        const newRequired = requiredReactions(subscribers, job.targetPercentage);
        job.requiredReactions = newRequired;
        job.subscriberSnapshot = subscribers;
      }
    }

    const bot = readyBots[i % readyBots.length]!;
    const text = templates[i % templates.length]!;
    const res = await sendReactionMessage(bot.token, normalizeChatId(channel.channelId), text, {
      replyToMessageId: opts.replyToMessageId,
    });

    const log = await recordAttempt(job.id, bot.id, text, res);
    logs.push(log);

    if (res.ok) {
      posted++;
    } else if (res.error_code === 429) {
      rateLimited++;
      failed++;
      const retryAfter = res.parameters?.retry_after ?? 1;
      await sleep(retryAfter * 1000);
      // Retry once after backoff
      const retry = await sendReactionMessage(bot.token, normalizeChatId(channel.channelId), text, {
        replyToMessageId: opts.replyToMessageId,
      });
      const retryLog = await recordAttempt(job.id, bot.id, text, retry, "rate_limit_retry");
      logs.push(retryLog);
      if (retry.ok) {
        posted++;
        failed--; // net one success
      } else {
        // stay failed
      }
    } else if (
      res.error_code === 403 ||
      (res.description && /not a member|kicked|removed|chat not found/i.test(res.description))
    ) {
      removed++;
      failed++;
      bot.status = "removed";
      await saveBot(bot);
    } else {
      failed++;
    }

    // Inter-post delay (skip after last)
    if (i < toPost - 1 && plan.delayMs > 0) {
      await sleep(Math.min(plan.delayMs, 5_000)); // cap sleep in interactive runs
    }
  }

  job.postedCount = posted;
  job.failedCount = failed;
  if (posted >= plan.required) job.status = "completed";
  else if (posted > 0) job.status = "partial";
  else job.status = "failed";
  job.updatedAt = nowIso();
  await saveJob(job);

  if (rateLimited > 0) {
    await alertOwner(
      opts.managerToken,
      job.ownerId,
      `Rate limits hit on ${channel.title || channel.channelId}: ${rateLimited} throttled attempt(s). The job backed off and continued.`,
    );
  }
  if (removed > 0) {
    await alertOwner(
      opts.managerToken,
      job.ownerId,
      `${removed} bot(s) were removed from ${channel.title || channel.channelId}. Open Create Bot Pool to replace them.`,
    );
  }

  return { job, posted, failed, rateLimited, removed, planned: toPost, required: plan.required, logs };
}

async function recordAttempt(
  jobId: string,
  botId: string,
  text: string,
  res: TgApiResult,
  detailExtra?: string,
): Promise<ReactionLog> {
  let status: ReactionLog["status"] = "ok";
  if (!res.ok) {
    if (res.error_code === 429) status = "rate_limited";
    else if (res.error_code === 403) status = "bot_removed";
    else status = "error";
  }
  const log: ReactionLog = {
    id: newId("log"),
    jobId,
    botId,
    messageContent: text,
    timestamp: nowIso(),
    status,
    detail: [res.description, detailExtra].filter(Boolean).join(" | ") || undefined,
  };
  await saveLog(log);
  return log;
}

async function alertOwner(token: string, ownerId: number, text: string): Promise<void> {
  const owner = await getOwner(ownerId);
  if (owner && owner.notifyDm === false) return;
  // Tolerate 403 without aborting
  await safeDm(token, ownerId, text);
}

function emptyPoolMessage(readyCount: number, plan: PlanResult): string {
  if (readyCount === 0) {
    return "A reaction job couldn't start — no ready bots with tokens in the pool. Add tokens or create bots, then try again.";
  }
  return `Reaction job planned ${plan.planned} of ${plan.required} reactions (capacity ${plan.capacity}).`;
}

/** Normalize @username or -100… ids for Telegram API. */
export function normalizeChatId(channelId: string): string | number {
  const t = channelId.trim();
  if (/^-?\d+$/.test(t)) return Number(t);
  return t.startsWith("@") ? t : `@${t}`;
}

/** Verify 20% of 10_000 = 2_000 — used by required tests. */
export function assertTwentyPercentOf10k(): number {
  return requiredReactions(10_000, 20);
}
