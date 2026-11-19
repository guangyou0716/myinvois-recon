import { InputError } from './errors.js';

/** Malaysia time (UTC+08:00, no daylight saving). Calendar days and months are counted in this zone. */
export const MYT_OFFSET_MINUTES = 8 * 60;
export const HOUR_MS = 3_600_000;
/** Cancellation and rejection are allowed within 72 hours from validation (MyInvois SDK, Cancel / Reject Document). */
export const STATE_CHANGE_WINDOW_MS = 72 * HOUR_MS;

const STAMP = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

/**
 * Parses a date or timestamp: 2026-10-31, 2026-10-31 14:05, 2026-10-31T06:05:00Z, 2026-10-31T14:05:00+08:00,
 * optional fractional seconds. A value without a zone is read at `defaultOffsetMinutes` east of UTC.
 * Returns epoch ms, or undefined for an empty value.
 */
export function parseStamp(text: string, where: string, defaultOffsetMinutes: number): number | undefined {
  const t = text.trim();
  if (t === '') return undefined;
  const m = STAMP.exec(t);
  if (!m) throw new InputError(`${where}: "${text}" is not a date / timestamp like 2026-10-31 or 2026-10-31T06:05:00Z.`);
  const [, y, mo, d, h = '0', mi = '0', s = '0', frac = '', zone] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  const local = Date.UTC(year, month - 1, day, hour, minute, second, Number((frac + '000').slice(0, 3)));
  const check = new Date(local);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw new InputError(`${where}: "${text}" is not a valid date / time.`);
  }
  let offset = defaultOffsetMinutes;
  if (zone !== undefined && zone.toUpperCase() !== 'Z') {
    const z = /^([+-])(\d{2}):?(\d{2})$/.exec(zone)!;
    offset = (z[1] === '-' ? -1 : 1) * (Number(z[2]) * 60 + Number(z[3]));
  } else if (zone !== undefined) {
    offset = 0;
  }
  return local - offset * 60_000;
}

/** The Malaysia-time calendar month (YYYY-MM) of an instant. */
export function mytMonth(ms: number): string {
  return new Date(ms + MYT_OFFSET_MINUTES * 60_000).toISOString().slice(0, 7);
}

/**
 * Deadline for the consolidated e-Invoice of the month containing `ms` (MYT): within seven calendar days after the
 * month end, i.e. before 00:00 MYT on day 8 of the next month (IRBM e-Invoice Specific Guideline para 3.6.2).
 * Returns the exclusive end instant.
 */
export function consolidatedDeadline(ms: number): number {
  const local = new Date(ms + MYT_OFFSET_MINUTES * 60_000);
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 8) - MYT_OFFSET_MINUTES * 60_000;
}

/** Formats an instant in Malaysia time: 2026-10-31 14:05:00 MYT. */
export function formatMyt(ms: number): string {
  return new Date(ms + MYT_OFFSET_MINUTES * 60_000).toISOString().replace('T', ' ').slice(0, 19) + ' MYT';
}

/** Formats a duration as e.g. 3d04h, 5h30m, 45m (rounded down to the minute, so time left is never overstated). */
export function formatHours(ms: number): string {
  const totalMin = Math.floor(Math.abs(ms) / 60_000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d) return `${d}d${String(h).padStart(2, '0')}h`;
  if (h) return `${h}h${String(m).padStart(2, '0')}m`;
  return `${m}m`;
}
