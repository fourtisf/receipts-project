/**
 * Display formatting. Money arrives as decimal strings and is formatted with string/bigint math only
 * (never parsed into floats). Percentages arrive as numbers with 2 decimals.
 */

const MINUS = '\u2212';

/** "+6.8%", "−2.6%", "0.0%"; null → "—". */
export function pct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const s = Math.abs(v).toFixed(digits);
  const zero = Number(s) === 0;
  return `${zero ? '' : v > 0 ? '+' : MINUS}${s}%`;
}

/** Same as pct but without a leading "+" (drawdowns). */
export function pctPlain(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const s = Math.abs(v).toFixed(digits);
  return `${Number(s) === 0 || v >= 0 ? '' : MINUS}${s}%`;
}

/** CSS class for a signed number. */
export function tone(v: number | null | undefined): '' | 'gain' | 'loss' {
  if (v === null || v === undefined || !Number.isFinite(v)) return '';
  return v > 0 ? 'gain' : v < 0 ? 'loss' : '';
}

/** Thousands separators for an integer (number or integer string). */
export function nf(v: number | string | bigint): string {
  const s = typeof v === 'string' ? v : v.toString();
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;
  return `${neg ? MINUS : ''}${body.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

function splitDec(s: string): { neg: boolean; whole: string; frac: string } {
  const t = s.trim();
  if (!/^-?\d+(\.\d+)?$/.test(t)) return { neg: false, whole: '0', frac: '' };
  const neg = t.startsWith('-');
  const [w = '0', f = ''] = (neg ? t.slice(1) : t).split('.');
  return { neg, whole: w.replace(/^0+(?=\d)/, ''), frac: f };
}

/** Round a decimal string half-up to `frac` digits, returning a decimal string. */
export function roundDec(s: string, frac: number): string {
  const { neg, whole, frac: f } = splitDec(s);
  const digits = BigInt(whole + (f + '0'.repeat(frac + 1)).slice(0, frac + 1));
  const rounded = (digits + 5n) / 10n;
  const str = rounded.toString().padStart(frac + 1, '0');
  const w = str.slice(0, str.length - frac) || '0';
  const fr = frac > 0 ? `.${str.slice(str.length - frac)}` : '';
  const isZero = rounded === 0n;
  return `${neg && !isZero ? '-' : ''}${w}${fr}`;
}

/** "2,480.00" from a decimal string. */
export function amount(s: string | null | undefined, frac = 2): string {
  if (s === null || s === undefined) return '—';
  const r = roundDec(s, frac);
  const neg = r.startsWith('-');
  const [w = '0', f] = (neg ? r.slice(1) : r).split('.');
  return `${neg ? MINUS : ''}${nf(w)}${f !== undefined ? `.${f}` : ''}`;
}

/** "$2,480.00" */
export function usd(s: string | null | undefined, frac = 2): string {
  if (s === null || s === undefined) return '—';
  const a = amount(s, frac);
  return a.startsWith(MINUS) ? `${MINUS}$${a.slice(1)}` : `$${a}`;
}

/** "$1.24M", "$61.2K", "$950" — compact display of a USD decimal string. */
export function usdCompact(s: string | null | undefined): string {
  if (s === null || s === undefined) return '—';
  const { neg, whole } = splitDec(s);
  const w = BigInt(whole || '0');
  const sign = neg && w > 0n ? MINUS : '';
  const units: [bigint, string, number][] = [
    [1_000_000_000n, 'B', 2],
    [1_000_000n, 'M', 2],
    [1_000n, 'K', 1],
  ];
  for (const [u, suffix, digits] of units) {
    if (w >= u) {
      const scale = 10n ** BigInt(digits);
      const q = (w * scale * 10n) / u;
      const r = (q + 5n) / 10n;
      const int = r / scale;
      const fr = (r % scale).toString().padStart(digits, '0').replace(/0+$/, '');
      return `${sign}$${nf(int)}${fr ? `.${fr}` : ''}${suffix}`;
    }
  }
  return `${sign}$${amount(s, 0)}`;
}

/** Price with 2 decimals and separators: "3,412.50". */
export function price(s: string | null | undefined): string {
  return amount(s, 2);
}

/** Basis points → "0.03%". */
export function bpsPct(b: number | null | undefined, digits = 2): string {
  if (b === null || b === undefined) return '—';
  const v = b / 100;
  const s = Math.abs(v).toFixed(digits);
  return `${v < 0 && Number(s) !== 0 ? MINUS : ''}${s}%`;
}

/** "0x7c1e…a94b" */
export function short(h: string | null | undefined, head = 6, tail = 4): string {
  if (!h) return '—';
  return h.length <= head + tail + 1 ? h : `${h.slice(0, head)}…${h.slice(-tail)}`;
}

/** "just now", "12m ago", "3h ago", "4d ago" relative to `now`. */
export function ago(iso: string, now: number = Date.now()): string {
  const d = Math.max(0, now - new Date(iso).getTime());
  const m = Math.floor(d / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** "in 42m" / "in 2h" until a future time; "now" when past. */
export function until(iso: string, now: number = Date.now()): string {
  const d = new Date(iso).getTime() - now;
  if (d <= 0) return 'now';
  const m = Math.ceil(d / 60_000);
  if (m < 60) return `in ${m}m`;
  return `in ${Math.round(m / 60)}h`;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "14:00:03 UTC" — deterministic on server and client. */
export function timeUtc(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Nov 17, 14:00 UTC" */
export function dateTimeUtc(iso: string): string {
  const d = new Date(iso);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** "Nov 17" */
export function dateUtc(iso: string): string {
  const d = new Date(iso);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** 3600 → "1 hour", 5400 → "90 min", 7200 → "2 hours". */
export function duration(sec: number): string {
  if (sec % 3600 === 0) {
    const h = sec / 3600;
    return `${h} hour${h === 1 ? '' : 's'}`;
  }
  if (sec % 60 === 0) return `${sec / 60} min`;
  return `${sec} s`;
}

/** Token amount (integer string in base units) → decimal display, e.g. "0.0431". */
export function tokenAmount(raw: string, decimals: number, maxFrac = 4): string {
  if (!/^\d+$/.test(raw)) return raw;
  const padded = raw.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals);
  const frac = padded.slice(padded.length - decimals);
  return amount(`${whole}.${frac || '0'}`, maxFrac)
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/\.$/, '');
}
