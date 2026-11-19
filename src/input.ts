import { parseCsv } from './csv.js';
import { InputError } from './errors.js';
import { parseMoney } from './money.js';
import { MYT_OFFSET_MINUTES, parseStamp } from './time.js';
import { normaliseStatus, normaliseType, DOCUMENT_STATUSES } from './vocabulary.js';
import type { DocumentStatus, DocumentType } from './vocabulary.js';

export const LEDGER_KEYS = ['invoice', 'date', 'total', 'type', 'net', 'status', 'consolidated', 'supplier'] as const;
export type LedgerKey = (typeof LEDGER_KEYS)[number];
const LEDGER_REQUIRED: readonly LedgerKey[] = ['invoice', 'date', 'total'];

export const DOCUMENT_KEYS = [
  'uuid',
  'internalId',
  'status',
  'total',
  'typeName',
  'netAmount',
  'dateTimeIssued',
  'dateTimeReceived',
  'dateTimeValidated',
  'cancelDateTime',
  'rejectRequestDateTime',
  'documentStatusReason',
  'buyerTin',
  'issuerTin',
] as const;
export type DocumentKey = (typeof DOCUMENT_KEYS)[number];
const DOCUMENT_REQUIRED: readonly DocumentKey[] = ['uuid', 'internalId', 'status', 'total'];

export type LedgerColumns = Partial<Record<LedgerKey, string>>;
export type DocumentColumns = Partial<Record<DocumentKey, string>>;

/** One sales ledger row (ERP / accounting side). Amounts in cents, instants in epoch ms. */
export interface LedgerEntry {
  /** 1-based CSV line of the row (header = line 1). */
  row: number;
  invoice: string;
  date: number;
  total: number;
  type?: DocumentType;
  net?: number;
  /** The ledger marks the invoice as voided / cancelled (status column matched a void value). */
  void: boolean;
  /** The row is a monthly consolidated e-Invoice; its date is any day of the covered month. */
  consolidated: boolean;
  /** Supplier TIN (AP ledger, used by direction received). */
  supplier?: string;
}

/** One MyInvois document (e-Invoice side). Amounts in cents, instants in epoch ms. */
export interface EDocument {
  row: number;
  uuid: string;
  internalId: string;
  status: DocumentStatus;
  total: number;
  type?: DocumentType;
  net?: number;
  issued?: number;
  received?: number;
  validated?: number;
  cancelled?: number;
  rejectRequested?: number;
  reason?: string;
  buyerTin?: string;
  /** TIN of the issuer (supplier); used by direction received. */
  issuerTin?: string;
}

export interface DocumentList {
  documents: EDocument[];
  /** Rows dropped because they repeat an earlier row exactly (overlapping exports). */
  duplicateRows: number;
}

export const DEFAULT_VOID_VALUES = ['void', 'voided', 'cancelled', 'canceled'];
const TRUE_VALUES = ['yes', 'y', 'true', '1'];
const FALSE_VALUES = ['', 'no', 'n', 'false', '0'];

/**
 * Parses repeated `key=Header` overrides (e.g. from --ledger-column) into a column map, checking the keys.
 */
export function parseColumnMap<K extends string>(values: readonly string[], keys: readonly K[], flag: string): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};
  for (const v of values) {
    for (const part of v.split(',')) {
      const m = /^\s*([^=\s]+)\s*=\s*(.+?)\s*$/.exec(part);
      if (!m) throw new InputError(`${flag} "${part}" must look like key=Header.`);
      const key = keys.find((k) => k.toLowerCase() === m[1].toLowerCase());
      if (key === undefined) throw new InputError(`${flag}: unknown key "${m[1]}"; keys: ${keys.join(', ')}.`);
      out[key] = m[2];
    }
  }
  return out;
}

interface Table<K extends string> {
  rows: string[][];
  index: Partial<Record<K, number>>;
}

function table<K extends string>(
  text: string,
  what: string,
  keys: readonly K[],
  required: readonly K[],
  columns: Partial<Record<K, string>>,
): Table<K> {
  const rows = parseCsv(text);
  if (rows.length === 0) throw new InputError(`${what}: the file is empty.`);
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const index: Partial<Record<K, number>> = {};
  for (const key of keys) {
    const name = (columns[key] ?? key).trim().toLowerCase();
    const i = header.indexOf(name);
    if (i >= 0) index[key] = i;
    else if (required.includes(key)) {
      throw new InputError(`${what}: missing column "${columns[key] ?? key}" (header: ${rows[0].join(',')}).`);
    } else if (columns[key] !== undefined) {
      throw new InputError(`${what}: column "${columns[key]}" given for ${key} is not in the header.`);
    }
  }
  return { rows: rows.slice(1), index };
}

/** Line number of data row i (0-based, header excluded). Blank lines are skipped by the parser, so this is the
 * row number counting non-blank lines; it matches the file line when the file has no blank or multi-line rows. */
const lineOf = (i: number) => i + 2;

function cell<K extends string>(t: Table<K>, row: string[], key: K): string {
  const i = t.index[key];
  return i === undefined ? '' : (row[i] ?? '').trim();
}

/** Parses the sales ledger CSV. */
export function parseLedger(text: string, columns: LedgerColumns = {}, voidValues: readonly string[] = DEFAULT_VOID_VALUES): LedgerEntry[] {
  const t = table(text, 'ledger', LEDGER_KEYS, LEDGER_REQUIRED, columns);
  const voids = new Set(voidValues.map((v) => v.trim().toLowerCase()));
  return t.rows.map((r, i) => {
    const row = lineOf(i);
    const where = `ledger row ${row}`;
    const invoice = cell(t, r, 'invoice');
    if (invoice === '') throw new InputError(`${where}: empty invoice number.`);
    const date = parseStamp(cell(t, r, 'date'), `${where} date`, MYT_OFFSET_MINUTES);
    if (date === undefined) throw new InputError(`${where}: empty date.`);
    const total = parseMoney(cell(t, r, 'total'), `${where} total`);
    if (total === undefined) throw new InputError(`${where}: empty total.`);
    const typeText = cell(t, r, 'type');
    const type = typeText === '' ? undefined : normaliseType(typeText);
    if (typeText !== '' && type === undefined) throw new InputError(`${where}: unknown document type "${typeText}" (use 01-04, 11-14 or a name like credit note).`);
    const net = parseMoney(cell(t, r, 'net'), `${where} net`);
    const flag = cell(t, r, 'consolidated').toLowerCase();
    if (!TRUE_VALUES.includes(flag) && !FALSE_VALUES.includes(flag)) {
      throw new InputError(`${where}: consolidated "${flag}" must be yes / no (or y, true, 1 / n, false, 0, empty).`);
    }
    const supplier = cell(t, r, 'supplier');
    return {
      row,
      invoice,
      date,
      total,
      ...(type !== undefined && { type }),
      ...(net !== undefined && { net }),
      void: voids.has(cell(t, r, 'status').toLowerCase()),
      consolidated: TRUE_VALUES.includes(flag),
      ...(supplier !== '' && { supplier }),
    };
  });
}

/** Parses the MyInvois document list CSV. Timestamps without a zone are read as UTC (MyInvois uses UTC). */
export function parseDocuments(text: string, columns: DocumentColumns = {}): DocumentList {
  const t = table(text, 'documents', DOCUMENT_KEYS, DOCUMENT_REQUIRED, columns);
  const seen = new Map<string, { row: number; key: string }>();
  const documents: EDocument[] = [];
  let duplicateRows = 0;
  t.rows.forEach((r, i) => {
    const row = lineOf(i);
    const where = `documents row ${row}`;
    const uuid = cell(t, r, 'uuid');
    if (uuid === '') throw new InputError(`${where}: empty uuid.`);
    const key = DOCUMENT_KEYS.map((k) => cell(t, r, k)).join('\u0000');
    const prev = seen.get(uuid);
    if (prev) {
      if (prev.key === key) {
        duplicateRows++;
        return;
      }
      throw new InputError(`${where}: uuid ${uuid} already on row ${prev.row} with different values (mixed exports?).`);
    }
    seen.set(uuid, { row, key });
    const internalId = cell(t, r, 'internalId');
    if (internalId === '') throw new InputError(`${where}: empty internalId.`);
    const statusText = cell(t, r, 'status');
    const status = normaliseStatus(statusText);
    if (status === undefined) throw new InputError(`${where}: unknown status "${statusText}" (${DOCUMENT_STATUSES.join(', ')}).`);
    const total = parseMoney(cell(t, r, 'total'), `${where} total`);
    if (total === undefined) throw new InputError(`${where}: empty total.`);
    const typeText = cell(t, r, 'typeName');
    const type = typeText === '' ? undefined : normaliseType(typeText);
    if (typeText !== '' && type === undefined) throw new InputError(`${where}: unknown document type "${typeText}".`);
    const stamp = (k: DocumentKey) => parseStamp(cell(t, r, k), `${where} ${k}`, 0);
    const opt = <T>(name: string, v: T | undefined) => (v === undefined || v === '' ? {} : { [name]: v });
    documents.push({
      row,
      uuid,
      internalId,
      status,
      total,
      ...opt('type', type),
      ...opt('net', parseMoney(cell(t, r, 'netAmount'), `${where} netAmount`)),
      ...opt('issued', stamp('dateTimeIssued')),
      ...opt('received', stamp('dateTimeReceived')),
      ...opt('validated', stamp('dateTimeValidated')),
      ...opt('cancelled', stamp('cancelDateTime')),
      ...opt('rejectRequested', stamp('rejectRequestDateTime')),
      ...opt('reason', cell(t, r, 'documentStatusReason')),
      ...opt('buyerTin', cell(t, r, 'buyerTin')),
      ...opt('issuerTin', cell(t, r, 'issuerTin')),
    } as EDocument);
  });
  return { documents, duplicateRows };
}
