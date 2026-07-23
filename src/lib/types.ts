/** Domain entities for Multi-Bot Reaction Manager. All durable. */

export interface OwnerAccount {
  userId: number;
  email?: string;
  /** When the owner first connected their Telegram account. */
  connectedAt: string;
  /** Prefer Telegram DM for quota/error alerts (default true). */
  notifyDm: boolean;
  /** Total bots created under this owner (for free-tier quota). */
  botCount: number;
}

export interface Channel {
  channelId: string;
  /** Display handle or title when known. */
  title: string;
  subscriberCount: number;
  /** true once the management bot has verified admin access. */
  linked: boolean;
  ownerId: number;
  updatedAt: string;
}

export type BotStatus = "pending_token" | "ready" | "removed" | "paused";

export interface BotProfile {
  id: string;
  /** BotFather token when available. Stored server-side only — never shown full. */
  token: string;
  displayName: string;
  createdAt: string;
  ownerId: number;
  status: BotStatus;
  /** Masked token hint for UI (last 4 chars). */
  tokenHint: string;
}

export type PoolStatus = "active" | "paused";

export interface BotPool {
  id: string;
  channelId: string;
  ownerId: number;
  botIds: string[];
  status: PoolStatus;
  createdAt: string;
  updatedAt: string;
}

export type JobStatus =
  | "configured"
  | "running"
  | "completed"
  | "partial"
  | "failed"
  | "paused";

export interface TimingRules {
  /** Minutes over which to spread reactions (rate-limit friendly). */
  spreadMinutes: number;
  /** Max messages per bot per minute (Telegram-safe default 20). */
  maxPerBotPerMinute: number;
}

export interface ReactionJob {
  id: string;
  ownerId: number;
  channelId: string;
  targetPercentage: number;
  timing: TimingRules;
  /** Reply/message templates; one is chosen round-robin / cyclic. */
  templates: string[];
  status: JobStatus;
  /** Snapshot of required reactions at last run start. */
  requiredReactions?: number;
  /** Successfully posted this run. */
  postedCount?: number;
  /** Failed attempts this run. */
  failedCount?: number;
  /** Subscriber count used for the last calculation. */
  subscriberSnapshot?: number;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
}

export type LogStatus = "ok" | "rate_limited" | "error" | "bot_removed" | "skipped";

export interface ReactionLog {
  id: string;
  jobId: string;
  botId: string;
  messageContent: string;
  timestamp: string;
  status: LogStatus;
  detail?: string;
}

/** Free tier: max bots per owner. */
export const FREE_TIER_BOT_LIMIT = 10;

/** Default reaction target (percent of subscribers). */
export const DEFAULT_TARGET_PERCENT = 20;

/** Default timing: spread over 60 minutes, 20 msgs/bot/min. */
export const DEFAULT_TIMING: TimingRules = {
  spreadMinutes: 60,
  maxPerBotPerMinute: 20,
};

/** Default reply templates — natural engagement, not spammy. */
export const DEFAULT_TEMPLATES: string[] = [
  "Great post!",
  "Thanks for sharing this.",
  "Really useful — appreciate it.",
];
