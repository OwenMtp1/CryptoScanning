export function fmtPrice(p: number | null | undefined): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return "—";
  if (p >= 1000) return p.toLocaleString("fr-FR", { maximumFractionDigits: 2 });
  if (p >= 1) return p.toLocaleString("fr-FR", { maximumFractionDigits: 4 });
  return p.toLocaleString("fr-FR", { maximumSignificantDigits: 4 });
}

export function fmtPct(x: number | null | undefined, digits = 2): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  const r = Number(x.toFixed(digits));
  if (r === 0) return `${(0).toFixed(digits)} %`; // avoid "-0.00 %"
  return `${r > 0 ? "+" : ""}${r.toFixed(digits)} %`;
}

export function pctClass(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x) || Math.abs(x) < 0.005) return "text-slate-400";
  return x > 0 ? "text-emerald-400" : "text-rose-400";
}

export function fmtCompact(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  return new Intl.NumberFormat("fr-FR", { notation: "compact", maximumFractionDigits: 1 }).format(x);
}

export function fmtRatio(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  return `${x.toFixed(1)}x`;
}

export function fmtTime(ms: number | string): string {
  return new Date(ms).toLocaleTimeString("fr-FR", { hour12: false });
}

export function fmtDateTime(ms: number | string): string {
  return new Date(ms).toLocaleString("fr-FR", { hour12: false });
}

export function fmtAge(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return "< 1 s";
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

export function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}
