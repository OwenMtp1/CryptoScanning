import { describe, expect, it } from "vitest";
import { buildTrends, type NewsItem } from "../src/index.js";

const H = 3_600_000;
const now = Date.UTC(2026, 9, 1, 12);
const news = (id: string, title: string, agoMin: number, coins: string[] = [], direction: NewsItem["direction"] = "neutral"): NewsItem => ({ id, ts: now - agoMin * 60_000, feed: "Decrypt", title, link: `https://x/${id}`, summary: "", coins, direction, tags: [] });
const rows: Record<string, { name: string; change1h: number; change24h: number }> = { FET: { name: "Fetch.ai", change1h: 2, change24h: 12 }, TAO: { name: "Bittensor", change1h: 1, change24h: 8 }, BTC: { name: "Bitcoin", change1h: 0.1, change24h: 1 } };

describe("buildTrends", () => {
  it("heats up a narrative talked about recently, with momentum, sentiment and its coins", () => {
    const v = buildTrends({
      now,
      news: [
        news("1", "AI agents token FET surges", 10, ["FET"], "bullish"),
        news("2", "Bittensor TAO rallies as AI hype returns", 30, ["TAO"], "bullish"),
        news("3", "Nvidia earnings lift AI tokens", 50, [], "bullish"),
        news("4", "AI agents: is it a bubble?", 70, [], "bearish"),
        news("5", "SEC delays ETF decision", 300, [], "bearish"),
        news("5b", "SEC delays ETF decision", 300, [], "bearish"), // same headline on another feed
      ],
      social: [{ id: "r1", ts: now - 5 * 60_000, title: "FET to the moon", link: "https://reddit/x", feed: "r/CryptoCurrency", coins: ["FET"], direction: "bullish", kind: "social" }],
      trending: [{ symbol: "FET", name: "Fetch.ai", rank: 1 }],
      categories: [{ name: "Artificial Intelligence (AI)", change24h: 9.5, change1h: 0.4, coinsCount: 300 }],
      signals: [],
      coin: (s) => rows[s] ?? null,
      previousRanks: { FET: 3, TAO: 1 },
    });
    const ai = v.themes[0]!;
    expect(ai.id).toBe("ai");
    expect(ai.mentions6h).toBe(5);
    expect(ai.momentum).toBeGreaterThan(1); // everything in the last 2 h
    expect(ai.sentiment).toBeGreaterThan(0.5);
    expect(ai.coins[0]!.coin).toBe("FET");
    expect(ai.category?.change24h).toBe(9.5);
    expect(ai.timeline.reduce((a, b) => a + b, 0)).toBe(5);
    expect(v.themes.find((t) => t.id === "regulation")!.heat).toBeLessThan(ai.heat);
    // Attention: FET first (news + Reddit + trending #1), up 2 places.
    expect(v.coins[0]).toMatchObject({ coin: "FET", rank: 1, rankDelta: 2, trendingRank: 1 });
    expect(v.headlines.filter((h) => h.title === "SEC delays ETF decision")).toHaveLength(1);
    expect(v.headlines[0]!.breaking).toBe(true);
    expect(v.pulse).toHaveLength(24);
    expect(v.pulse.at(-1)!.bull).toBeGreaterThan(0);
  });
});
