import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  requiredReactions,
  planReactions,
  maxPostsInWindow,
  interPostDelayMs,
  executeReactionJob,
  assertTwentyPercentOf10k,
} from "../../src/lib/reaction-engine.js";
import { setNow } from "../../src/lib/clock.js";
import { resetDurableStore, saveOwner, saveChannel, saveBot, savePool, saveJob } from "../../src/lib/store.js";
import { setTelegramFetch } from "../../src/lib/telegram.js";
import type { BotProfile, ReactionJob } from "../../src/lib/types.js";
import { DEFAULT_TIMING } from "../../src/lib/types.js";

describe("reaction target calculation", () => {
  it("meets 20% reaction target across 10k subscribers (2000)", () => {
    expect(requiredReactions(10_000, 20)).toBe(2000);
    expect(assertTwentyPercentOf10k()).toBe(2000);
  });

  it("handles edge subscriber counts", () => {
    expect(requiredReactions(0, 20)).toBe(0);
    expect(requiredReactions(1, 20)).toBe(1);
    expect(requiredReactions(999, 20)).toBe(200);
    expect(requiredReactions(10_000, 0)).toBe(0);
    expect(requiredReactions(10_000, 100)).toBe(10_000);
  });
});

describe("rate limit planning", () => {
  it("caps capacity by ready bots and timing window", () => {
    // 5 bots * 60 min * 20/min = 6000
    expect(maxPostsInWindow(5, DEFAULT_TIMING)).toBe(6000);
    expect(maxPostsInWindow(0, DEFAULT_TIMING)).toBe(0);
  });

  it("plans min(required, capacity) for high-volume jobs", () => {
    const bots = Array.from({ length: 2 }, (_, i) => ({
      id: `b${i}`,
      token: `1:token${i}`,
      displayName: `B${i}`,
      createdAt: "",
      ownerId: 1,
      status: "ready" as const,
      tokenHint: "••••",
    }));
    // 10k @ 20% = 2000 required; capacity 2*60*20 = 2400 → planned 2000
    const plan = planReactions(10_000, 20, bots, DEFAULT_TIMING);
    expect(plan.required).toBe(2000);
    expect(plan.capacity).toBe(2400);
    expect(plan.planned).toBe(2000);
    expect(plan.delayMs).toBeGreaterThan(0);
  });

  it("computes inter-post delay under rate limits", () => {
    // 2 bots * 20/min = 40/min → 1500 ms
    expect(interPostDelayMs(2, DEFAULT_TIMING)).toBe(1500);
  });
});

describe("executeReactionJob with mocked Telegram", () => {
  const calls: { url: string; body: unknown }[] = [];

  beforeEach(() => {
    resetDurableStore();
    setNow(() => 1_700_000_000_000);
    calls.length = 0;

    setTelegramFetch(async (url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ url, body });

      if (url.includes("getChatMemberCount")) {
        return json({ ok: true, result: 10_000 });
      }
      if (url.includes("sendMessage")) {
        // Simulate rate limit on 3rd pool-bot message only
        const botToken = url.match(/bot([^/]+)\//)?.[1] ?? "";
        const prior = calls.filter(
          (c) => c.url.includes(botToken) && c.url.includes("sendMessage"),
        ).length;
        if (botToken.includes("ratelimited") && prior === 1) {
          return json({
            ok: false,
            error_code: 429,
            description: "Too Many Requests",
            parameters: { retry_after: 0 },
          });
        }
        if (botToken.includes("removed")) {
          return json({
            ok: false,
            error_code: 403,
            description: "Forbidden: bot was kicked from the channel chat",
          });
        }
        return json({ ok: true, result: { message_id: 42 } });
      }
      return json({ ok: true, result: true });
    });
  });

  afterEach(() => {
    setTelegramFetch(null);
    setNow(null);
  });

  it("creates bots and posts without inventing BotFather accounts", async () => {
    // Profiles only — tokens provided by owner/pool env, never auto-registered accounts
    await seedJob({
      bots: [
        readyBot("bot_a", "100:aaa"),
        readyBot("bot_b", "100:bbb"),
      ],
      subscribers: 10_000,
      target: 20,
    });

    const result = await executeReactionJob("job_1", {
      managerToken: "manager:token",
      maxPostsThisCall: 5,
      sleep: async () => {},
    });

    expect(result.required).toBe(2000);
    expect(result.posted).toBe(5);
    expect(result.failed).toBe(0);
    const sends = calls.filter((c) => c.url.includes("sendMessage") && !c.url.includes("manager"));
    // manager may also DM; filter reaction bots
    const reactionSends = calls.filter(
      (c) => c.url.includes("sendMessage") && (c.url.includes("100:aaa") || c.url.includes("100:bbb")),
    );
    expect(reactionSends.length).toBe(5);
    void sends;
  });

  it("handles rate limits during high-volume job with backoff retry", async () => {
    await seedJob({
      bots: [readyBot("bot_rl", "100:ratelimited")],
      subscribers: 10_000,
      target: 20,
    });

    const result = await executeReactionJob("job_1", {
      managerToken: "manager:token",
      maxPostsThisCall: 3,
      sleep: async () => {},
    });

    // First attempt on this bot rate-limits once then retries
    expect(result.rateLimited).toBeGreaterThanOrEqual(1);
    expect(result.posted + result.failed).toBeGreaterThan(0);
    const rlLogs = result.logs.filter((l) => l.status === "rate_limited");
    expect(rlLogs.length).toBeGreaterThanOrEqual(1);
  });

  it("marks bots removed when Telegram returns 403 kicked", async () => {
    await seedJob({
      bots: [readyBot("bot_rm", "100:removed")],
      subscribers: 1000,
      target: 20,
    });

    const result = await executeReactionJob("job_1", {
      managerToken: "manager:token",
      maxPostsThisCall: 2,
      sleep: async () => {},
    });

    expect(result.removed).toBeGreaterThanOrEqual(1);
    expect(result.posted).toBe(0);
  });
});

function readyBot(id: string, token: string): BotProfile {
  return {
    id,
    token,
    displayName: id,
    createdAt: "2024-01-01T00:00:00.000Z",
    ownerId: 1,
    status: "ready",
    tokenHint: "••••",
  };
}

async function seedJob(opts: {
  bots: BotProfile[];
  subscribers: number;
  target: number;
}): Promise<void> {
  await saveOwner({
    userId: 1,
    connectedAt: "2024-01-01T00:00:00.000Z",
    notifyDm: true,
    botCount: opts.bots.length,
  });
  await saveChannel({
    channelId: "@test",
    title: "@test",
    subscriberCount: opts.subscribers,
    linked: true,
    ownerId: 1,
    updatedAt: "2024-01-01T00:00:00.000Z",
  });
  for (const b of opts.bots) await saveBot(b);
  await savePool({
    id: "pool_1",
    channelId: "@test",
    ownerId: 1,
    botIds: opts.bots.map((b) => b.id),
    status: "active",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  });
  const job: ReactionJob = {
    id: "job_1",
    ownerId: 1,
    channelId: "@test",
    targetPercentage: opts.target,
    timing: { ...DEFAULT_TIMING },
    templates: ["Nice!", "Thanks!"],
    status: "configured",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
  await saveJob(job);
}

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
