/**
 * Jalali (Iranian) calendar helpers.
 * Codal reports carry Jalali dates in Persian digits (۱۴۰۵/۰۵/۳۱);
 * the DB stores Gregorian dates for consistent ordering/serialization.
 */

/** Persian/Arabic-Indic digits → ASCII */
export function toAsciiDigits(s: string): string {
  return s
    .replace(/[\u06F0-\u06F9]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0x06f0 + 48),
    )
    .replace(/[\u0660-\u0669]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0x0660 + 48),
    );
}

// ── Jalali → Gregorian (algorithm from jalaali-js, MIT) ──────────────

const BREAKS = [
  -61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097,
  2192, 2262, 2324, 2394, 2456, 3178,
];

function div(a: number, b: number): number {
  return ~~(a / b);
}

function mod(a: number, b: number): number {
  return a - ~~(a / b) * b;
}

function jalCal(jy: number): { leap: number; gy: number; march: number } {
  const bl = BREAKS.length;
  const gy = jy + 621;
  let leapJ = -14;
  let jp = BREAKS[0];
  let jump = 0;
  for (let i = 1; i < bl; i += 1) {
    const jm = BREAKS[i]!;
    jump = jm - jp!;
    if (jy < jm) break;
    leapJ = leapJ + div(jump, 33) * 8 + div(mod(jump, 33), 4);
    jp = jm;
  }
  let n = jy - jp!;
  leapJ = leapJ + div(n, 33) * 8 + div(mod(n, 33) + 3, 4);
  if (mod(jump, 33) === 4 && jump - n === 4) leapJ += 1;
  const leapG = div(gy, 4) - div((div(gy, 100) + 1) * 3, 4) - 150;
  const march = 20 + leapJ - leapG;
  if (jump - n < 6) n = n - jump + div(jump + 4, 33) * 33;
  let leap = mod(mod(n + 1, 33) - 1, 4);
  if (leap === -1) leap = 4;
  return { leap, gy, march };
}

function g2d(gy: number, gm: number, gd: number): number {
  let d =
    div((gy + div(gm - 8, 6) + 100100) * 1461, 4) +
    div(153 * mod(gm + 9, 12) + 2, 5) +
    gd -
    34840408;
  d = d - div(div(gy + 100100 + div(gm - 8, 6), 100) * 3, 4) + 752;
  return d;
}

function d2g(jdn: number): { gy: number; gm: number; gd: number } {
  let j = 4 * jdn + 139361631;
  j = j + div(div(4 * jdn + 183187720, 146097) * 3, 4) * 4 - 3908;
  const i = div(mod(j, 1461), 4) * 5 + 308;
  const gd = div(mod(i, 153), 5) + 1;
  const gm = mod(div(i, 153), 12) + 1;
  const gy = div(j, 1461) - 100100 + div(8 - gm, 6);
  return { gy, gm, gd };
}

/** Convert Jalali (Iranian calendar) date to Gregorian Date. */
export function jalaliToGregorian(jy: number, jm: number, jd: number): Date {
  const { gy, march } = jalCal(jy);
  const julianDay = g2d(gy, 3, march) + (jm - 1) * 31 - div(jm, 7) * (jm - 7) + jd - 1;
  const { gy: gY, gm: gM, gd } = d2g(julianDay);
  return new Date(Date.UTC(gY, gM! - 1, gd!));
}

/** Julian day number for a Jalali (jy, jm, jd). */
function j2d(jy: number, jm: number, jd: number): number {
  const { gy, march } = jalCal(jy);
  return g2d(gy, 3, march) + (jm - 1) * 31 - div(jm, 7) * (jm - 7) + jd - 1;
}

/** Convert a Gregorian date to the Jalali (Iranian) calendar. */
export function gregorianToJalali(gy: number, gm: number, gd: number): {
  jy: number;
  jm: number;
  jd: number;
} {
  const target = g2d(gy, gm, gd);

  // Binary-search for the Jalali year whose Farvardin 1 ≤ target.
  let lo = 1;
  let hi = 3000;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (j2d(mid, 1, 1) <= target) lo = mid;
    else hi = mid - 1;
  }
  const jy = lo;
  const yearStart = j2d(jy, 1, 1);
  const isLeap = j2d(jy + 1, 1, 1) - yearStart > 365;

  const daysInMonth = (m: number): number => {
    if (m <= 6) return 31;
    if (m <= 11) return 30;
    return isLeap ? 30 : 29; // Esfand
  };

  let rem = target - yearStart;
  let jm = 1;
  while (jm <= 12 && rem >= daysInMonth(jm)) {
    rem -= daysInMonth(jm);
    jm++;
  }
  const jd = rem + 1;

  return { jy, jm, jd };
}

/** Convert a Gregorian Date to Jalali */
export function dateToJalali(d: Date): { jy: number; jm: number; jd: number } {
  return gregorianToJalali(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** Format a Gregorian Date as YYYY-MM-DD (UTC) */
export function toIsoDate(d: Date): string {
  return d.toISOString().split("T")[0]!;
}