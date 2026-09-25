/**
 * Parse Coinbase RFC3339 timestamps, which may carry nanosecond precision
 * (e.g. "2023-02-09T20:30:37.167359596Z"). Fractions are truncated to ms.
 * Returns NaN if the value cannot be parsed.
 */
export function parseCoinbaseTime(value: string): number {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})$/.exec(value);
  if (!m) return Number.NaN;
  const [, base, frac = "", zone] = m;
  const ms = frac.slice(0, 3).padEnd(3, "0");
  return Date.parse(`${base}.${ms}${zone}`);
}
