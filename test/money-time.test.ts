import { describe, expect, it } from 'vitest';
import { InputError, formatMoney, parseMoney } from '../src/index.js';
import { consolidatedDeadline, formatHours, formatMyt, mytMonth, parseStamp } from '../src/time.js';

describe('parseMoney / formatMoney', () => {
  it('parses to whole cents', () => {
    expect(parseMoney('1234.5', 'x')).toBe(123450);
    expect(parseMoney(' 1,234.56 ', 'x')).toBe(123456);
    expect(parseMoney('-106.00', 'x')).toBe(-10600);
    expect(parseMoney('+7', 'x')).toBe(700);
    expect(parseMoney('12.500', 'x')).toBe(1250);
    expect(parseMoney('0.07', 'x')).toBe(7);
    expect(parseMoney('', 'x')).toBeUndefined();
  });
  it('rejects bad amounts', () => {
    for (const bad of ['12.345', '1,23', 'RM10', '1.', '.5', '1e3', '12,3456.00']) {
      expect(() => parseMoney(bad, 'row 2')).toThrow(InputError);
    }
  });
  it('round-trips', () => {
    for (const c of [0, 7, 99, 100, 123456, -10600, -5]) expect(parseMoney(formatMoney(c), 'x')).toBe(c);
    expect(formatMoney(-5)).toBe('-0.05');
  });
});

describe('time', () => {
  it('reads bare values at the default offset and honours zones', () => {
    const utc = Date.UTC(2026, 9, 31, 6, 5, 0);
    expect(parseStamp('2026-10-31T06:05:00Z', 'x', 480)).toBe(utc);
    expect(parseStamp('2026-10-31 14:05', 'x', 480)).toBe(utc);
    expect(parseStamp('2026-10-31T14:05:00+08:00', 'x', 0)).toBe(utc);
    expect(parseStamp('2026-10-31T14:05:00+0800', 'x', 0)).toBe(utc);
    expect(parseStamp('2026-10-31T06:05:00', 'x', 0)).toBe(utc);
    expect(parseStamp('2026-10-31T06:05:00.250Z', 'x', 0)).toBe(utc + 250);
    expect(parseStamp('2026-10-31', 'x', 480)).toBe(Date.UTC(2026, 9, 30, 16));
    expect(parseStamp(' ', 'x', 0)).toBeUndefined();
  });
  it('rejects impossible dates', () => {
    for (const bad of ['2026-02-30', '2026-13-01', '2026-10-31 24:00', '31/10/2026', '2026-10-31T10:61']) {
      expect(() => parseStamp(bad, 'x', 0)).toThrow(InputError);
    }
  });
  it('counts months and the consolidated deadline in MYT', () => {
    // 2026-10-31 16:30Z is 2026-11-01 00:30 MYT -> November.
    expect(mytMonth(Date.UTC(2026, 9, 31, 16, 30))).toBe('2026-11');
    expect(mytMonth(Date.UTC(2026, 9, 31, 15, 59))).toBe('2026-10');
    // October -> before 2026-11-08 00:00 MYT = 2026-11-07 16:00Z.
    expect(consolidatedDeadline(Date.UTC(2026, 9, 15))).toBe(Date.UTC(2026, 10, 7, 16));
    // December rolls into January.
    expect(consolidatedDeadline(Date.UTC(2026, 11, 31, 10))).toBe(Date.UTC(2027, 0, 7, 16));
    expect(formatMyt(Date.UTC(2026, 10, 7, 16) - 1000)).toBe('2026-11-07 23:59:59 MYT');
  });
  it('formats durations', () => {
    expect(formatHours(45 * 60_000)).toBe('45m');
    expect(formatHours(5.5 * 3_600_000)).toBe('5h30m');
    expect(formatHours(80 * 3_600_000)).toBe('3d08h');
    // rounded down: 1 s short of 72 h is still 2d23h, not 3d00h
    expect(formatHours(72 * 3_600_000 - 1000)).toBe('2d23h');
  });
});
