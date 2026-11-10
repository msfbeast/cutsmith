/**
 * Exact rational time, FCPXML-style.
 * A Time is a value in seconds represented as num/den (both integers, den > 0).
 * FCPXML strings: "Xs" (whole seconds) or "X/Ys" (num/den seconds).
 * Beware frameDuration="1/30s" means 1/30 second — parse() handles both semantics
 * because the caller decides what the string means; we only evaluate it.
 */

export interface Time {
  num: number; // numerator (may be negative)
  den: number; // denominator, always > 0
}

export function t(num: number, den = 1): Time {
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) {
    throw new Error(`invalid rational time ${num}/${den}`);
  }
  if (den < 0) { num = -num; den = -den; }
  const g = gcd(Math.abs(num), den) || 1;
  return { num: num / g, den: den / g };
}

function gcd(a: number, b: number): number {
  while (b) { const r = a % b; a = b; b = r; }
  return a;
}

/** Parse an FCPXML time string: "150/30s" or "150s". */
export function parseTime(s: string): Time {
  const m = /^(-?\d+)\/(\d+)s$/.exec(s) ?? /^(-?\d+)s$/.exec(s);
  if (!m) throw new Error(`unparseable FCPXML time: "${s}"`);
  return m[2] === undefined ? t(Number(m[1]), 1) : t(Number(m[1]), Number(m[2]));
}

/** Render to FCPXML string: den 1 => "Ns" else "N/Ds". */
export function timeStr(v: Time): string {
  return v.den === 1 ? `${v.num}s` : `${v.num}/${v.den}s`;
}

export function add(a: Time, b: Time): Time {
  return t(a.num * b.den + b.num * a.den, a.den * b.den);
}

export function sub(a: Time, b: Time): Time {
  return t(a.num * b.den - b.num * a.den, a.den * b.den);
}

export function mul(a: Time, k: number): Time {
  // k may be fractional (e.g. speed ratios); keep integer rationals via 1e6 scaling
  const SCALE = 1_000_000;
  const n = Math.round(k * SCALE);
  return t(a.num * n, a.den * SCALE);
}

export function cmp(a: Time, b: Time): number {
  const l = a.num * b.den, r = b.num * a.den;
  return l < r ? -1 : l > r ? 1 : 0;
}

export const eq = (a: Time, b: Time) => cmp(a, b) === 0;
export const lt = (a: Time, b: Time) => cmp(a, b) < 0;
export const lte = (a: Time, b: Time) => cmp(a, b) <= 0;

/** Seconds as a JS number (for ffmpeg, reports, humans). */
export function secs(v: Time): number {
  return v.num / v.den;
}

export function fromSeconds(s: number, fps = 30): Time {
  // snap to the nearest frame boundary at the given fps to stay DTD-valid.
  // At exact half-frame boundaries floating-point noise (10.05*30 = 301.500…06)
  // biases round() upward; bias downward instead so measured in-points do not
  // creep one frame into the next clip.
  const raw = s * fps;
  const frames = Math.ceil(raw - 0.5 - 1e-6);
  return t(frames, fps);
}

/** Frame duration Time for an fps rate, e.g. fps=29.97 => 100/2997s. */
export function frameDuration(fps: number): Time {
  const SCALE = 1000;
  return t(Math.round(SCALE), Math.round(fps * SCALE)); // normalized by t()
}

/** NTSC rates need Apple's exact, NON-reduced canonical frame durations. */
export function frameDurationCanonical(fps: number): Time {
  if (Math.abs(fps - 29.97) < 0.01) return { num: 100, den: 2997 };
  if (Math.abs(fps - 23.976) < 0.01) return { num: 100, den: 2398 };
  if (Math.abs(fps - 59.94) < 0.01) return { num: 100, den: 5994 };
  if (Math.abs(fps - 119.88) < 0.01) return { num: 100, den: 11988 };
  return t(1, Math.round(fps));
}
