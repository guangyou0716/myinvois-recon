import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { check, jsonReport, mdReport, MONTH_CSV_HEADER, monthsCsv, parseDocuments, parseLedger, textReport } from '../src/index.js';
import type { MonthSummary, Report } from '../src/index.js';
import { ex } from './helpers.js';

const AS_OF = Date.UTC(2026, 11, 20, 1); // 2026-12-20 09:00 MYT

// Worked table (dates MYT unless the stamp has Z):
//  ledger  date              total    consolidated/void  Valid document(s)                          month
//  A-1     2026-10-05         100.00                     100.00                                     2026-10
//  A-2     2026-10-31 23:30    50.00                     -  (not-submitted)                         2026-10 (MYT, not Nov)
//  CON-10  2026-10-31         200.00  consolidated        200.00 issued 2026-11-05 (by ledger row)  2026-10
//  A-3     2026-11-01 00:10    30.00                     31.00 (total-mismatch)                     2026-11
//  A-4     2026-11-02          20.00  void                20.00 (void-but-valid)                    2026-11 (voided 1)
//  CN-1    2026-11-03         -10.00                     10.00 (credit note, |total|)               2026-11
//  -       Z-1 not in ledger, issued 2026-10-31T16:30Z = 2026-11-01 00:30 MYT, Valid 7.00            2026-11
//  -       Z-2 not in ledger, no dateTimeIssued, Valid 3.00                                           unknown
//  -       Z-3 not in ledger, Submitted 9.00 (not a Valid document: not counted)
// Expected:
//  2026-10: invoices 3, valid 2, ledger 350.00, consolidated 1 / 200.00, voided 0, docs 2 / 300.00, diff -50.00
//  2026-11: invoices 2, valid 2, ledger  40.00, consolidated 0 /   0.00, voided 1, docs 4 /  68.00, diff  28.00
//  unknown: invoices 0, valid 0, ledger   0.00,                           voided 0, docs 1 /   3.00, diff   3.00
const LEDGER = [
  'invoice,date,total,status,consolidated',
  'A-1,2026-10-05,100.00,,',
  'A-2,2026-10-31 23:30,50.00,,',
  'CON-10,2026-10-31,200.00,,yes',
  'A-3,2026-11-01 00:10,30.00,,',
  'A-4,2026-11-02,20.00,void,',
  'CN-1,2026-11-03,-10.00,,',
].join('\n');
const DOCS = [
  'uuid,internalId,status,total,dateTimeIssued,dateTimeReceived,dateTimeValidated,buyerTin',
  'U1,A-1,Valid,100.00,2026-10-05T02:00:00Z,2026-10-05T02:00:00Z,2026-10-05T02:01:00Z,',
  'U2,CON-10,Valid,200.00,2026-11-05T02:00:00Z,2026-11-05T02:00:00Z,2026-11-05T02:01:00Z,EI00000000010',
  'U3,A-3,Valid,31.00,2026-10-31T16:20:00Z,2026-10-31T16:20:00Z,2026-10-31T16:21:00Z,',
  'U4,A-4,Valid,20.00,2026-11-02T02:00:00Z,2026-11-02T02:00:00Z,2026-11-02T02:01:00Z,',
  'U5,CN-1,Valid,10.00,2026-11-03T02:00:00Z,2026-11-03T02:00:00Z,2026-11-03T02:01:00Z,',
  'U6,Z-1,Valid,7.00,2026-10-31T16:30:00Z,2026-10-31T16:30:00Z,2026-10-31T16:31:00Z,',
  'U7,Z-2,Valid,3.00,,,,',
  'U8,Z-3,Submitted,9.00,2026-11-04T02:00:00Z,2026-11-04T02:00:00Z,,',
].join('\n');

const run = (options = {}) => check(parseLedger(LEDGER), parseDocuments(DOCS), { asOf: AS_OF, byMonth: true, ...options });

const m = (month: string, v: Partial<MonthSummary>): MonthSummary => ({
  month,
  invoices: 0,
  validInvoices: 0,
  ledgerTotal: 0,
  consolidated: 0,
  consolidatedTotal: 0,
  voided: 0,
  validDocuments: 0,
  validDocumentTotal: 0,
  difference: 0,
  ...v,
});

const EXPECTED = [
  m('2026-10', { invoices: 3, validInvoices: 2, ledgerTotal: 35000, consolidated: 1, consolidatedTotal: 20000, validDocuments: 2, validDocumentTotal: 30000, difference: -5000 }),
  m('2026-11', { invoices: 2, validInvoices: 2, ledgerTotal: 4000, voided: 1, validDocuments: 4, validDocumentTotal: 6800, difference: 2800 }),
  m('unknown', { validDocuments: 1, validDocumentTotal: 300, difference: 300 }),
];

function invariants(r: Report) {
  const months = r.months!;
  const sum = (k: keyof Omit<MonthSummary, 'month'>) => months.reduce((a, x) => a + x[k], 0);
  expect(sum('invoices') + sum('voided')).toBe(r.summary.invoices);
  expect(sum('validInvoices')).toBe(r.summary.states.valid);
  for (const x of months) {
    expect(x.difference).toBe(x.validDocumentTotal - x.ledgerTotal);
    expect(x.consolidated).toBeLessThanOrEqual(x.invoices);
    expect(x.validInvoices).toBeLessThanOrEqual(x.invoices);
  }
  const sorted = months.map((x) => x.month).filter((x) => x !== 'unknown');
  expect(sorted).toEqual([...sorted].sort());
}

describe('per-month summary (--by-month)', () => {
  it('matches the worked table', () => {
    const r = run();
    expect(r.months).toEqual(EXPECTED);
    invariants(r);
    // Without --period every Valid document is counted exactly once.
    expect(r.months!.reduce((a, x) => a + x.validDocuments, 0)).toBe(r.summary.documentsByStatus.Valid);
  });

  it('is absent unless requested, and does not change findings', () => {
    const plain = check(parseLedger(LEDGER), parseDocuments(DOCS), { asOf: AS_OF });
    expect(plain.months).toBeUndefined();
    expect('months' in plain).toBe(false);
    const withMonths = run();
    expect(withMonths.findings).toEqual(plain.findings);
    expect(withMonths.summary).toEqual(plain.summary);
    expect(JSON.parse(jsonReport(plain)).months).toBeUndefined();
  });

  it('--period keeps the month and unbooked documents issued in it (or without an issue date)', () => {
    const r = run({ period: '2026-11' });
    expect(r.months).toEqual([EXPECTED[1], EXPECTED[2]]);
    invariants(r);
  });

  it('empty ledger: only unbooked Valid documents', () => {
    const r = check(parseLedger('invoice,date,total\n'), parseDocuments(DOCS), { asOf: AS_OF, byMonth: true });
    expect(r.months!.map((x) => [x.month, x.validDocuments, x.validDocumentTotal])).toEqual([
      ['2026-10', 1, 10000],
      ['2026-11', 5, 26800],
      ['unknown', 1, 300],
    ]);
    invariants(r);
  });

  it('text, JSON, Markdown and CSV renderings', () => {
    const r = run();
    const text = textReport(r);
    expect(text).toContain(
      [
        'By month (MYT; ledger by invoice date, Valid e-Invoices by their ledger row, unbooked ones by issue date):',
        '  month    invoices  valid  ledger total  consolidated  voided  Valid docs  e-Invoice total  difference',
        '  2026-10         3      2        350.00    1 / 200.00       0           2           300.00      -50.00',
        '  2026-11         2      2         40.00      0 / 0.00       1           4            68.00       28.00',
        '  unknown         0      0          0.00      0 / 0.00       0           1             3.00        3.00',
        '',
      ].join('\n'),
    );
    expect(JSON.parse(jsonReport(r)).months[0]).toEqual({
      month: '2026-10',
      invoices: 3,
      validInvoices: 2,
      ledgerTotal: '350.00',
      consolidated: 1,
      consolidatedTotal: '200.00',
      voided: 0,
      validDocuments: 2,
      validDocumentTotal: '300.00',
      difference: '-50.00',
    });
    expect(mdReport(r)).toContain('| 2026-11 | 2 | 2 | 40.00 | 0 | 0.00 | 1 | 4 | 68.00 | 28.00 |\n');
    expect(monthsCsv(r.months)).toBe(
      [
        MONTH_CSV_HEADER.join(','),
        '2026-10,3,2,350.00,1,200.00,0,2,300.00,-50.00',
        '2026-11,2,2,40.00,0,0.00,1,4,68.00,28.00',
        'unknown,0,0,0.00,0,0.00,0,1,3.00,3.00',
        '',
      ].join('\n'),
    );
    expect(monthsCsv(undefined)).toBe(MONTH_CSV_HEADER.join(',') + '\n');
  });

  it('empty month list renders as (none)', () => {
    const r = check(parseLedger('invoice,date,total\n'), parseDocuments('uuid,internalId,status,total\n'), { asOf: AS_OF, byMonth: true });
    expect(r.months).toEqual([]);
    expect(textReport(r)).toContain('By month (MYT; ledger by invoice date, Valid e-Invoices by their ledger row, unbooked ones by issue date):\n  (none)\n');
  });
});

describe('per-month summary on the example files', () => {
  it('matches a hand tally of examples/ (as of 2026-11-10 09:00 MYT)', () => {
    const r = check(parseLedger(readFileSync(ex('ledger.csv'), 'utf8')), parseDocuments(readFileSync(ex('documents.csv'), 'utf8')), {
      asOf: Date.UTC(2026, 10, 10, 1),
      byMonth: true,
    });
    // 2026-09: CON-2609 (consolidated, no document). 2026-10: 11 booked (incl. CON-2610), INV-008 / INV-013 void;
    // Valid docs INV-001, INV-002 (503), INV-004, CN-001, INV-009, INV-010 x2, CON-2610, INV-999 (not in ledger).
    // 2026-11: CON-2611 (due), INV-007 void with a Valid 742.00 document.
    expect(r.months).toEqual([
      m('2026-09', { invoices: 1, ledgerTotal: 159000, consolidated: 1, consolidatedTotal: 159000, difference: -159000 }),
      m('2026-10', { invoices: 11, validInvoices: 7, ledgerTotal: 878740, consolidated: 1, consolidatedTotal: 318000, voided: 2, validDocuments: 9, validDocumentTotal: 880900, difference: 2160 }),
      m('2026-11', { invoices: 1, ledgerTotal: 265000, consolidated: 1, consolidatedTotal: 265000, voided: 1, validDocuments: 1, validDocumentTotal: 74200, difference: -190800 }),
    ]);
    invariants(r);
    expect(r.months!.reduce((a, x) => a + x.validDocuments, 0)).toBe(r.summary.documentsByStatus.Valid);
  });
});

describe('consolidated-not-valid: consolidated e-Invoice still Submitted after the deadline', () => {
  // CON-09 covers 2026-09; deadline = before 2026-10-08 00:00 MYT = 2026-10-07T16:00:00Z.
  const ledger = parseLedger('invoice,date,total,consolidated\nCON-09,2026-09-30,500.00,yes\n');
  const docs = (received: string) => parseDocuments(`uuid,internalId,status,total,dateTimeReceived\nS1,CON-09,Submitted,500.00,${received}\n`);
  const AFTER = Date.UTC(2026, 9, 9, 1); // 2026-10-09 09:00 MYT

  it('submitted in time but still not Valid after the deadline: error plus the pending warning', () => {
    const r = check(ledger, docs('2026-10-07T15:00:00Z'), { asOf: AFTER });
    expect(r.findings.map((f) => f.kind)).toEqual(['consolidated-not-valid', 'pending']);
    const f = r.findings[0];
    expect(f).toMatchObject({ severity: 'error', invoice: 'CON-09', uuids: ['S1'], ledgerAmount: 50000, deadline: Date.UTC(2026, 9, 7, 16) });
    expect(f.detail).toBe(
      'consolidated e-Invoice for 2026-09 is still Submitted, not Valid, after the deadline 2026-10-07 23:59:59 MYT; submitted 2026-10-07 23:00:00 MYT (in time) but not validated; check its validation result (if it ends Invalid, the resubmission will be late)',
    );
    expect(r.summary.states.pending).toBe(1);
    expect(r.summary.errors).toBe(1);
    expect(r.summary.warnings).toBe(1);
  });

  it('submitted after the deadline: says how late', () => {
    const r = check(ledger, docs('2026-10-08T02:00:00Z'), { asOf: AFTER }); // 10:00 MYT on day 8
    expect(r.findings[0].detail).toContain('; submitted 2026-10-08 10:00:00 MYT, 10h00m late;');
  });

  it('no receive time: no submitted clause', () => {
    const r = check(ledger, docs(''), { asOf: AFTER });
    expect(r.findings[0].detail).toContain('after the deadline 2026-10-07 23:59:59 MYT; check its validation result');
  });

  it('deadline boundary: one ms before -> only pending; at the deadline -> consolidated-not-valid', () => {
    const deadline = Date.UTC(2026, 9, 7, 16);
    expect(check(ledger, docs('2026-10-07T15:00:00Z'), { asOf: deadline - 1 }).findings.map((f) => f.kind)).toEqual(['pending']);
    expect(check(ledger, docs('2026-10-07T15:00:00Z'), { asOf: deadline }).findings.map((f) => f.kind)).toEqual(['consolidated-not-valid', 'pending']);
  });

  it('not for ordinary (non-consolidated) invoices, and not once a Valid document exists', () => {
    const plain = parseLedger('invoice,date,total\nCON-09,2026-09-30,500.00\n');
    expect(check(plain, docs('2026-10-07T15:00:00Z'), { asOf: AFTER }).findings.map((f) => f.kind)).toEqual(['pending']);
    const valid = parseDocuments(
      'uuid,internalId,status,total,dateTimeReceived,dateTimeValidated\nS1,CON-09,Submitted,500.00,2026-10-07T15:00:00Z,\nV1,CON-09,Valid,500.00,2026-10-07T15:10:00Z,2026-10-07T15:11:00Z\n',
    );
    expect(check(ledger, valid, { asOf: AFTER }).findings).toEqual([]);
  });
});
