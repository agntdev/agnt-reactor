/**
 * Durable domain store — Redis-backed when REDIS_URL is set, otherwise a
 * toolkit MemorySessionStorage (tests / local). Never scans the keyspace:
 * every collection is reached through explicit index records.
 */

import type { StorageAdapter } from "grammy";
import { MemorySessionStorage } from "../toolkit/session/memory.js";
import { defaultRedisStorage } from "../toolkit/session/redis.js";
import type {
  BotPool,
  BotProfile,
  Channel,
  OwnerAccount,
  ReactionJob,
  ReactionLog,
} from "./types.js";

// ─── KV adapter ─────────────────────────────────────────────────────────────

type Json = string;

function resolveKv(): StorageAdapter<Json> {
  const url = typeof process !== "undefined" ? process.env.REDIS_URL : undefined;
  if (url) return defaultRedisStorage<Json>(url);
  return new MemorySessionStorage<Json>();
}

let kv: StorageAdapter<Json> = resolveKv();

/** Test / harness isolation: wipe memory backend and re-resolve. */
export function resetDurableStore(): void {
  kv = resolveKv();
}

async function getJson<T>(key: string): Promise<T | undefined> {
  const raw = await kv.read(key);
  if (raw == null) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

async function setJson<T>(key: string, value: T): Promise<void> {
  await kv.write(key, JSON.stringify(value));
}

async function delKey(key: string): Promise<void> {
  await kv.delete(key);
}

// ─── Key helpers (no SCAN) ──────────────────────────────────────────────────

const k = {
  owner: (userId: number) => `owner:${userId}`,
  ownerChannels: (userId: number) => `owner:${userId}:channels`,
  ownerPools: (userId: number) => `owner:${userId}:pools`,
  ownerJobs: (userId: number) => `owner:${userId}:jobs`,
  ownerBots: (userId: number) => `owner:${userId}:bots`,
  channel: (channelId: string) => `channel:${channelId}`,
  pool: (poolId: string) => `pool:${poolId}`,
  poolByChannel: (channelId: string) => `poolByChannel:${channelId}`,
  bot: (botId: string) => `bot:${botId}`,
  job: (jobId: string) => `job:${jobId}`,
  jobByChannel: (channelId: string) => `jobByChannel:${channelId}`,
  jobLogs: (jobId: string) => `job:${jobId}:logs`,
  log: (logId: string) => `log:${logId}`,
};

// ─── Index helpers ──────────────────────────────────────────────────────────

async function readIndex(key: string): Promise<string[]> {
  return (await getJson<string[]>(key)) ?? [];
}

async function addToIndex(key: string, id: string): Promise<void> {
  const list = await readIndex(key);
  if (!list.includes(id)) {
    list.push(id);
    await setJson(key, list);
  }
}

async function removeFromIndex(key: string, id: string): Promise<void> {
  const list = await readIndex(key);
  const next = list.filter((x) => x !== id);
  if (next.length !== list.length) await setJson(key, next);
}

// ─── Owner ──────────────────────────────────────────────────────────────────

export async function getOwner(userId: number): Promise<OwnerAccount | undefined> {
  return getJson<OwnerAccount>(k.owner(userId));
}

export async function saveOwner(owner: OwnerAccount): Promise<void> {
  await setJson(k.owner(owner.userId), owner);
}

// ─── Channel ────────────────────────────────────────────────────────────────

export async function getChannel(channelId: string): Promise<Channel | undefined> {
  return getJson<Channel>(k.channel(channelId));
}

export async function saveChannel(channel: Channel): Promise<void> {
  await setJson(k.channel(channel.channelId), channel);
  await addToIndex(k.ownerChannels(channel.ownerId), channel.channelId);
}

export async function listOwnerChannels(ownerId: number): Promise<Channel[]> {
  const ids = await readIndex(k.ownerChannels(ownerId));
  const out: Channel[] = [];
  for (const id of ids) {
    const ch = await getChannel(id);
    if (ch) out.push(ch);
  }
  return out;
}

// ─── Bot profile ────────────────────────────────────────────────────────────

export async function getBot(botId: string): Promise<BotProfile | undefined> {
  return getJson<BotProfile>(k.bot(botId));
}

export async function saveBot(bot: BotProfile): Promise<void> {
  await setJson(k.bot(bot.id), bot);
  await addToIndex(k.ownerBots(bot.ownerId), bot.id);
}

export async function listOwnerBots(ownerId: number): Promise<BotProfile[]> {
  const ids = await readIndex(k.ownerBots(ownerId));
  const out: BotProfile[] = [];
  for (const id of ids) {
    const b = await getBot(id);
    if (b) out.push(b);
  }
  return out;
}

export async function listBotsByIds(ids: string[]): Promise<BotProfile[]> {
  const out: BotProfile[] = [];
  for (const id of ids) {
    const b = await getBot(id);
    if (b) out.push(b);
  }
  return out;
}

// ─── Bot pool ───────────────────────────────────────────────────────────────

export async function getPool(poolId: string): Promise<BotPool | undefined> {
  return getJson<BotPool>(k.pool(poolId));
}

export async function getPoolForChannel(channelId: string): Promise<BotPool | undefined> {
  const poolId = await getJson<string>(k.poolByChannel(channelId));
  if (!poolId) return undefined;
  return getPool(poolId);
}

export async function savePool(pool: BotPool): Promise<void> {
  await setJson(k.pool(pool.id), pool);
  await setJson(k.poolByChannel(pool.channelId), pool.id);
  await addToIndex(k.ownerPools(pool.ownerId), pool.id);
}

export async function listOwnerPools(ownerId: number): Promise<BotPool[]> {
  const ids = await readIndex(k.ownerPools(ownerId));
  const out: BotPool[] = [];
  for (const id of ids) {
    const p = await getPool(id);
    if (p) out.push(p);
  }
  return out;
}

// ─── Reaction job ───────────────────────────────────────────────────────────

export async function getJob(jobId: string): Promise<ReactionJob | undefined> {
  return getJson<ReactionJob>(k.job(jobId));
}

export async function getJobForChannel(channelId: string): Promise<ReactionJob | undefined> {
  const jobId = await getJson<string>(k.jobByChannel(channelId));
  if (!jobId) return undefined;
  return getJob(jobId);
}

export async function saveJob(job: ReactionJob): Promise<void> {
  await setJson(k.job(job.id), job);
  await setJson(k.jobByChannel(job.channelId), job.id);
  await addToIndex(k.ownerJobs(job.ownerId), job.id);
}

export async function listOwnerJobs(ownerId: number): Promise<ReactionJob[]> {
  const ids = await readIndex(k.ownerJobs(ownerId));
  const out: ReactionJob[] = [];
  for (const id of ids) {
    const j = await getJob(id);
    if (j) out.push(j);
  }
  // Newest first
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

// ─── Logs ───────────────────────────────────────────────────────────────────

export async function saveLog(log: ReactionLog): Promise<void> {
  await setJson(k.log(log.id), log);
  await addToIndex(k.jobLogs(log.jobId), log.id);
}

export async function listJobLogs(jobId: string, limit = 50): Promise<ReactionLog[]> {
  const ids = await readIndex(k.jobLogs(jobId));
  // Newest last in index; take from end
  const slice = ids.slice(-limit).reverse();
  const out: ReactionLog[] = [];
  for (const id of slice) {
    const log = await getJson<ReactionLog>(k.log(id));
    if (log) out.push(log);
  }
  return out;
}

// re-export del for rare cleanups (not scans)
export { delKey };
