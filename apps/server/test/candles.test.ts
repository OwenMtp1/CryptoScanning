import { describe, expect, it } from "vitest";
import { loadCandles, parseExchangeCandles } from "../src/intel/candles.js";

describe("exchange candle parsers", () => {
  it("reads each exchange's column order into oldest-first candles", () => {
    expect(parseExchangeCandles("okx", { data: [["2000", "1", "3", "0.5", "2", "10"], ["1000", "1", "2", "0.5", "1.5", "5"]] }).map((c) => [c.t, c.c])).toEqual([[1000, 1.5], [2000, 2]]);
    expect(parseExchangeCandles("bybit", { result: { list: [["2000", "1", "3", "0.5", "2", "10", "20"]] } })[0]).toMatchObject({ t: 2000, h: 3, c: 2 });
    // KuCoin: [time s, open, CLOSE, HIGH, LOW, volume]
    expect(parseExchangeCandles("kucoin", { data: [["2", "1", "2", "3", "0.5", "10", "20"]] })[0]).toEqual({ t: 2000, o: 1, c: 2, h: 3, l: 0.5, v: 10 });
    // Gate: [t s, quote vol, CLOSE, HIGH, LOW, OPEN, base vol]
    expect(parseExchangeCandles("gate", [["2", "100", "2", "3", "0.5", "1", "10", "true"]])[0]).toEqual({ t: 2000, c: 2, h: 3, l: 0.5, o: 1, v: 10 });
    expect(parseExchangeCandles("mexc", [[1000, "1", "2", "0.5", "1.5", "10"]])[0]).toMatchObject({ t: 1000, c: 1.5 });
    expect(parseExchangeCandles("okx", { code: "51001", msg: "Instrument ID does not exist", data: [] })).toEqual([]);
  });

  it("falls back to the other exchanges when Binance and Coinbase do not have the coin", async () => {
    const rows = Array.from({ length: 50 }, (_, i) => [String(i * 3_600_000), "1", "2", "0.5", String(1 + i / 100), "10"]);
    const calls: string[] = [];
    const get = async (url: string) => {
      calls.push(url);
      if (url.includes("binance") || url.includes("coinbase")) throw new Error("HTTP 400");
      if (url.includes("ex=okx")) return JSON.stringify({ data: [] });
      if (url.includes("ex=bybit")) return JSON.stringify({ result: { list: rows } });
      throw new Error("unexpected");
    };
    const r = await loadCandles(get, "ZZZ", "1h", 48, { extraBase: "" });
    expect(r.source).toBe("Bybit");
    expect(r.candles).toHaveLength(48);
    expect(calls.some((u) => u.startsWith("/api/candles?ex=okx&coin=ZZZ&interval=1h"))).toBe(true);
    // A chosen source is the only one asked.
    calls.length = 0;
    await expect(loadCandles(get, "ZZZ", "1h", 48, { extraBase: "", only: "okx" })).rejects.toThrow(/OKX/);
    expect(calls.every((u) => u.includes("ex=okx"))).toBe(true);
  });
});
