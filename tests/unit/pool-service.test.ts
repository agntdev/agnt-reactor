import { describe, it, expect, beforeEach } from "vitest";
import { createBotPool, remainingBotQuota, autoBotCount } from "../../src/lib/pool-service.js";
import { resetDurableStore, saveOwner, saveChannel } from "../../src/lib/store.js";
import { FREE_TIER_BOT_LIMIT } from "../../src/lib/types.js";
import { setNow } from "../../src/lib/clock.js";

describe("bot pool free tier + TOS-safe creation", () => {
  beforeEach(() => {
    resetDurableStore();
    setNow(() => 1_700_000_000_000);
  });

  it("creates managed profiles without BotFather automation", async () => {
    await saveOwner({
      userId: 9,
      connectedAt: "2024-01-01T00:00:00.000Z",
      notifyDm: true,
      botCount: 0,
    });
    await saveChannel({
      channelId: "@c",
      title: "@c",
      subscriberCount: 2000,
      linked: true,
      ownerId: 9,
      updatedAt: "2024-01-01T00:00:00.000Z",
    });

    const res = await createBotPool({ ownerId: 9, channelId: "@c", count: 3 });
    expect(res.ok).toBe(true);
    expect(res.created).toBe(3);
    expect(res.bots?.every((b) => b.status === "pending_token")).toBe(true);
    expect(res.remainingQuota).toBe(FREE_TIER_BOT_LIMIT - 3);
  });

  it("rejects requests over free-tier limit", async () => {
    await saveOwner({
      userId: 9,
      connectedAt: "2024-01-01T00:00:00.000Z",
      notifyDm: true,
      botCount: 8,
    });
    await saveChannel({
      channelId: "@c",
      title: "@c",
      subscriberCount: 1000,
      linked: true,
      ownerId: 9,
      updatedAt: "2024-01-01T00:00:00.000Z",
    });

    const res = await createBotPool({ ownerId: 9, channelId: "@c", count: 5 });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/only 2 free-tier/);
  });

  it("autoBotCount stays within quota", () => {
    expect(autoBotCount(10_000, 10)).toBeLessThanOrEqual(10);
    expect(autoBotCount(100, 10)).toBeGreaterThanOrEqual(2);
  });

  it("remainingBotQuota respects free tier", async () => {
    await saveOwner({
      userId: 3,
      connectedAt: "2024-01-01T00:00:00.000Z",
      notifyDm: true,
      botCount: 4,
    });
    expect(await remainingBotQuota(3)).toBe(6);
  });
});
