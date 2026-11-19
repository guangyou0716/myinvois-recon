import { InputError } from './errors.js';

/**
 * Parses a money amount into whole cents (sen). Accepts an optional sign, digits with optional thousands commas
 * (1,234.50) and up to two decimals; further decimals are allowed only when they are zeros (12.500). Returns
 * undefined for an empty value. Throws InputError for anything else.
 */
export function parseMoney(text: string, where: string): number | undefined {
  const t = text.trim();
  if (t === '') return undefined;
  const m = /^([+-]?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?$/.exec(t);
  if (!m) throw new InputError(`${where}: "${text}" is not an amount like 1234.50.`);
  const decimals = m[3] ?? '';
  if (/[1-9]/.test(decimals.slice(2))) throw new InputError(`${where}: "${text}" has more than two decimals.`);
  const whole = Number(m[2].replace(/,/g, ''));
  const cents = whole * 100 + Number((decimals + '00').slice(0, 2));
  if (!Number.isSafeInteger(cents)) throw new InputError(`${where}: "${text}" is too large.`);
  return m[1] === '-' ? -cents : cents;
}

/** Formats cents as a plain decimal amount: -123456 -> "-1234.56". */
export function formatMoney(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const a = Math.abs(cents);
  return `${sign}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}
