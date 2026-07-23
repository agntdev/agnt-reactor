/**
 * Telegram Bot API via fetch (Workers-safe). Credentials from env / bot tokens.
 * Injectable fetch for tests.
 */

export interface TgApiResult<T = unknown> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

export type TgFetch = (input: string, init?: RequestInit) => Promise<Response>;

let _fetch: TgFetch = (input, init) => globalThis.fetch(input, init);

/** Override fetch (unit tests). Pass null to restore. */
export function setTelegramFetch(fn: TgFetch | null): void {
  _fetch = fn ?? ((input, init) => globalThis.fetch(input, init));
}

export async function tgCall<T = unknown>(
  token: string,
  method: string,
  body?: Record<string, unknown>,
): Promise<TgApiResult<T>> {
  if (!token) {
    return { ok: false, description: "missing bot token", error_code: 401 };
  }
  try {
    const res = await _fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    // Network / non-JSON failures
    let data: TgApiResult<T>;
    try {
      data = (await res.json()) as TgApiResult<T>;
    } catch {
      return {
        ok: false,
        description: `Telegram HTTP ${res.status}`,
        error_code: res.status,
      };
    }
    return data;
  } catch (err) {
    return {
      ok: false,
      description: err instanceof Error ? err.message : "network error",
      error_code: 0,
    };
  }
}

export interface TgChat {
  id: number;
  title?: string;
  username?: string;
  type: string;
}

/** Resolve a channel by @username or numeric id. */
export async function getChat(
  token: string,
  chatId: string | number,
): Promise<TgApiResult<TgChat>> {
  return tgCall<TgChat>(token, "getChat", { chat_id: chatId });
}

export async function getChatMemberCount(
  token: string,
  chatId: string | number,
): Promise<TgApiResult<number>> {
  return tgCall<number>(token, "getChatMemberCount", { chat_id: chatId });
}

/**
 * Post a reaction reply in a channel/discussion. Uses sendMessage.
 * For channels, bots typically need admin rights; discussion group replies
 * use message_thread_id when applicable.
 */
export async function sendReactionMessage(
  token: string,
  chatId: string | number,
  text: string,
  opts?: { replyToMessageId?: number },
): Promise<TgApiResult<{ message_id: number }>> {
  return tgCall(token, "sendMessage", {
    chat_id: chatId,
    text,
    ...(opts?.replyToMessageId != null
      ? { reply_to_message_id: opts.replyToMessageId }
      : {}),
  });
}

/** Mask a bot token for display (show last 4 only). */
export function maskToken(token: string): string {
  if (!token) return "(none)";
  if (token.length <= 4) return "••••";
  return `••••${token.slice(-4)}`;
}

/**
 * Safe DM: never throws on 403 (user blocked / never started).
 * Returns false if delivery failed.
 */
export async function safeDm(
  token: string,
  userId: number,
  text: string,
): Promise<boolean> {
  const res = await tgCall(token, "sendMessage", { chat_id: userId, text });
  if (!res.ok && res.error_code === 403) return false;
  return !!res.ok;
}
