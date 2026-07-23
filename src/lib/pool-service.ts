/**
 * Bot pool creation, scaling, pause — free-tier aware, TOS-conscious.
 * Telegram does not expose BotFather programmatically; the system creates
 * bot *profiles* and assigns tokens from BOT_TOKEN_POOL env or owner input.
 */

import { nowIso } from "./clock.js";
import { newId } from "./ids.js";
import {
  getOwner,
  listOwnerBots,
  saveBot,
  saveOwner,
  savePool,
  getPoolForChannel,
  getChannel,
} from "./store.js";
import { maskToken } from "./telegram.js";
import {
  FREE_TIER_BOT_LIMIT,
  type BotPool,
  type BotProfile,
  type BotStatus,
} from "./types.js";

export interface CreatePoolInput {
  ownerId: number;
  channelId: string;
  /** Requested bot count; clamped to free-tier remaining. */
  count: number;
  /** Optional tokens (one per bot). Excess ignored; shortfall → pending_token. */
  tokens?: string[];
}

export interface CreatePoolResult {
  ok: boolean;
  error?: string;
  pool?: BotPool;
  bots?: BotProfile[];
  /** How many were created this call. */
  created: number;
  /** Remaining free-tier slots after creation. */
  remainingQuota: number;
}

/** Tokens the platform may auto-assign (comma-separated BOT_TOKEN_POOL). */
function systemTokenPool(): string[] {
  const raw = typeof process !== "undefined" ? process.env.BOT_TOKEN_POOL ?? "" : "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function remainingBotQuota(ownerId: number): Promise<number> {
  const owner = await getOwner(ownerId);
  const used = owner?.botCount ?? (await listOwnerBots(ownerId)).length;
  return Math.max(0, FREE_TIER_BOT_LIMIT - used);
}

/**
 * Create or extend a bot pool for a channel.
 * Does not spam-register via BotFather (TOS); creates managed profiles and
 * attaches provided / pooled tokens only.
 */
export async function createBotPool(input: CreatePoolInput): Promise<CreatePoolResult> {
  const channel = await getChannel(input.channelId);
  if (!channel || channel.ownerId !== input.ownerId) {
    return { ok: false, error: "Channel not linked. Onboard a channel first.", created: 0, remainingQuota: 0 };
  }

  const quota = await remainingBotQuota(input.ownerId);
  if (quota <= 0) {
    return {
      ok: false,
      error: `Free tier allows up to ${FREE_TIER_BOT_LIMIT} bots. Remove or upgrade before adding more.`,
      created: 0,
      remainingQuota: 0,
    };
  }

  const want = Math.max(1, Math.floor(input.count));
  if (want > quota) {
    return {
      ok: false,
      error: `You asked for ${want} bots but only ${quota} free-tier slot(s) remain (max ${FREE_TIER_BOT_LIMIT}).`,
      created: 0,
      remainingQuota: quota,
    };
  }

  const poolTokens = [...(input.tokens ?? []), ...systemTokenPool()];
  const created: BotProfile[] = [];
  const ts = nowIso();

  for (let i = 0; i < want; i++) {
    const token = poolTokens[i] ?? "";
    const status: BotStatus = token ? "ready" : "pending_token";
    const bot: BotProfile = {
      id: newId("bot"),
      token,
      displayName: `Reactor ${String(i + 1).padStart(2, "0")}`,
      createdAt: ts,
      ownerId: input.ownerId,
      status,
      tokenHint: maskToken(token),
    };
    await saveBot(bot);
    created.push(bot);
  }

  let pool = await getPoolForChannel(input.channelId);
  if (pool) {
    pool.botIds = [...pool.botIds, ...created.map((b) => b.id)];
    pool.updatedAt = ts;
    if (pool.status === "paused") {
      // keep paused until owner resumes
    }
  } else {
    pool = {
      id: newId("pool"),
      channelId: input.channelId,
      ownerId: input.ownerId,
      botIds: created.map((b) => b.id),
      status: "active",
      createdAt: ts,
      updatedAt: ts,
    };
  }
  await savePool(pool);

  const owner = await getOwner(input.ownerId);
  if (owner) {
    owner.botCount = (owner.botCount ?? 0) + created.length;
    await saveOwner(owner);
  }

  return {
    ok: true,
    pool,
    bots: created,
    created: created.length,
    remainingQuota: quota - created.length,
  };
}

/** Auto-size pool: aim for enough bots to hit 20% with rate limits in mind. */
export function autoBotCount(subscriberCount: number, remainingQuota: number): number {
  // Rough: 1 bot per 500 target reactions, min 2, max remaining quota
  const target = Math.ceil(subscriberCount * 0.2);
  const suggested = Math.max(2, Math.ceil(target / 500));
  return Math.min(remainingQuota, suggested, FREE_TIER_BOT_LIMIT);
}

export async function setPoolStatus(
  channelId: string,
  ownerId: number,
  status: "active" | "paused",
): Promise<BotPool | undefined> {
  const pool = await getPoolForChannel(channelId);
  if (!pool || pool.ownerId !== ownerId) return undefined;
  pool.status = status;
  pool.updatedAt = nowIso();
  await savePool(pool);
  return pool;
}

export async function attachBotToken(
  botId: string,
  ownerId: number,
  token: string,
): Promise<BotProfile | undefined> {
  const { getBot } = await import("./store.js");
  const bot = await getBot(botId);
  if (!bot || bot.ownerId !== ownerId) return undefined;
  const trimmed = token.trim();
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(trimmed)) return undefined;
  bot.token = trimmed;
  bot.tokenHint = maskToken(trimmed);
  bot.status = "ready";
  await saveBot(bot);
  return bot;
}
