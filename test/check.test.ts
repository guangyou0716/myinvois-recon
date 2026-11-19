import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { check, FINDING_KINDS, InputError, parseDocuments, parseLedger, STATES } from '../src/index.js';
import type { DocumentList, EDocument, LedgerEntry, Report } from '../src/index.js';
import { ex } from './helpers.js';

const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 10, 2); // 2026-10-10 10:00 MYT

const led = (invoice: string, total: number, extra: Partial<LedgerEntry> = {}): LedgerEntry => ({
  row: 2,
  invoice,
  date: T0,
  total,
  void: false,
  consolidated: false,
  ...extra,
});
let n = 0;
const doc = (internalId: string, status: EDocument['status'], total: number, extra: Partial<EDocument> = {}): EDocument => ({
  row: 2,
  uuid: `U${++n}`,
  internalId,
  status,
  total,
  validated: status === 'Valid' || status === 'Cancelled' ? T0 : undefined,
  ...extra,
});
const list = (...documents: EDocument[]): DocumentList => ({ documents, duplicateRows: 0 });
const kinds = (r: Report) => r.findings.map((f) => f.kind);
const stateSum = (r: Report) => STATES.reduce((a, k) => a + r.summary.states[k], 0);

describe('check: example files (worked table)', () => {
  // examples/ledger.csv vs examples/documents.csv, as of 2026-11-10 09:00 MYT (= 01:00Z):
  //  row invoice   ledger total  documents                         state           finding(s)
  //   2  INV-001   1060.00       Valid 1060.00                     valid           -
  //   3  INV-002    530.00       Valid  503.00                     valid           total-mismatch (-27.00)
  //   4  INV-003    212.00       -                                 missing         not-submitted
  //   5  INV-004    318.00       Invalid, then Valid 318.00        valid           -
  //   6  INV-005    106.00       Invalid                           invalid-only    invalid-only
  //   7  INV-006    424.00       Cancelled                         cancelled       cancelled-but-booked
  //   8  INV-007    742.00 void  Valid, validated 11-08 02:00Z     void-but-valid  void-but-valid (window to 11-11 02:00Z, 25 h left)
  //   9  INV-008    159.00 void  -                                 void-ok         -
  //  10  CN-001    -106.00 (02)  Valid 106.00 type 01              valid           type-mismatch
  //  11  INV-009   2120.00       Valid, reject requested           valid           rejection-requested (warning)
  //  12  INV-010    636.00       2 x Valid 636.00                  valid           duplicate-valid
  //  13  INV-011     95.40       Submitted                         pending         pending (warning)
  //  14  INV-013    530.00 void  Cancelled 80 h after validation   void-ok         cancel-outside-window (warning)
  //  15  CON-2609  1590.00 cons. -                                 missing         consolidated-overdue (deadline 10-07)
  //  16  CON-2610  3180.00 cons. Valid, received 11-08 03:00Z      valid           consolidated-late (deadline 11-07 16:00Z, 11 h late)
  //  17  CON-2611  2650.00 cons. -                                 due             - (deadline 12-07)
  //  18  INV-001 again                                             -               duplicate-ledger
  //  --  INV-999             Valid 250.00                          -               not-in-ledger
  // Valid totals: ledger 1060+530+318+106+2120+636+3180 = 7950.00; documents 1060+503+318+106+2120+636+3180 = 7923.00.
  // Booked without Valid: 95.40 + 424 + 106 + 212 + 1590 = 2427.40.
  const r = check(
    parseLedger(readFileSync(ex('ledger.csv'), 'utf8')),
    parseDocuments(readFileSync(ex('documents.csv'), 'utf8')),
    { asOf: Date.UTC(2026, 10, 10, 1) },
  );

  it('states and summary', () => {
    expect(r.summary.states).toEqual({ valid: 7, pending: 1, cancelled: 1, 'invalid-only': 1, missing: 2, due: 1, 'void-ok': 2, 'void-but-valid': 1 });
    expect(r.summary).toMatchObject({
      ledgerRows: 17,
      invoices: 16,
      duplicateLedgerRows: 1,
      documents: 15,
      duplicateDocumentRows: 1,
      documentsByStatus: { Valid: 10, Submitted: 1, Invalid: 2, Cancelled: 2 },
      ledgerValidTotal: 795000,
      documentValidTotal: 792300,
      ledgerUnmatchedTotal: 242740,
      findings: 14,
      errors: 11,
      warnings: 3,
    });
    expect(r.due).toEqual([{ invoice: 'CON-2611', ledgerRow: 17, deadline: Date.UTC(2026, 11, 7, 16) }]);
  });

  it('findings in kind order', () => {
    expect(r.findings.map((f) => `${f.kind} ${f.invoice}`)).toEqual([
      'not-submitted INV-003',
      'consolidated-overdue CON-2609',
      'invalid-only INV-005',
      'cancelled-but-booked INV-006',
      'void-but-valid INV-007',
      'total-mismatch INV-002',
      'type-mismatch CN-001',
      'duplicate-valid INV-010',
      'not-in-ledger INV-999',
      'consolidated-late CON-2610',
      'duplicate-ledger INV-001',
      'pending INV-011',
      'rejection-requested INV-009',
      'cancel-outside-window INV-013',
    ]);
    const f = (k: string) => r.findings.find((x) => x.kind === k)!;
    expect(f('void-but-valid').deadline).toBe(Date.UTC(2026, 10, 11, 2));
    expect(f('void-but-valid').detail).toContain('1d01h left');
    expect(f('consolidated-late').detail).toContain('11h00m after the deadline');
    expect(f('consolidated-overdue').detail).toContain('2026-10-07 23:59:59 MYT');
    expect(f('total-mismatch')).toMatchObject({ ledgerAmount: 53000, documentAmount: 50300 });
    expect(f('cancel-outside-window').detail).toContain('3d08h');
    expect(f('duplicate-valid').uuids).toHaveLength(2);
  });

  it('invariants: states sum to invoices, counts sum to findings, totals reconcile with mismatches', () => {
    expect(stateSum(r)).toBe(r.summary.invoices);
    expect(Object.values(r.counts).reduce((a, b) => a + (b ?? 0), 0)).toBe(r.findings.length);
    const mismatch = r.findings.filter((x) => x.kind === 'total-mismatch').reduce((a, x) => a + x.documentAmount! - x.ledgerAmount!, 0);
    expect(r.summary.documentValidTotal - r.summary.ledgerValidTotal).toBe(mismatch);
    expect(r.findings.every((x) => FINDING_KINDS.includes(x.kind))).toBe(true);
  });

  it('--period limits ledger rows and not-in-ledger', () => {
    const p = check(
      parseLedger(readFileSync(ex('ledger.csv'), 'utf8')),
      parseDocuments(readFileSync(ex('documents.csv'), 'utf8')),
      { asOf: Date.UTC(2026, 10, 10, 1), period: '2026-11' },
    );
    // November rows: INV-007 (void-but-valid) and CON-2611 (due). INV-999, INV-010 and INV-013 documents were
    // issued in October, so not-in-ledger / duplicate-valid / cancel-outside-window drop out.
    expect(p.summary.ledgerRowsOutsidePeriod).toBe(15);
    expect(p.summary.invoices).toBe(2);
    expect(stateSum(p)).toBe(2);
    expect(kinds(p)).toEqual(['void-but-valid']);
  });
});

describe('check: rules', () => {
  it('no findings when everything matches', () => {
    const r = check([led('A', 10000), led('B', -500, { type: 'credit-note' })], list(doc('A', 'Valid', 10000), doc('B', 'Valid', 500, { type: 'credit-note' })), { asOf: T0 });
    expect(r.findings).toEqual([]);
    expect(r.summary.states.valid).toBe(2);
  });

  it('tolerance is inclusive', () => {
    const l = [led('A', 10000)];
    expect(kinds(check(l, list(doc('A', 'Valid', 10001)), { asOf: T0, toleranceCents: 1 }))).toEqual([]);
    expect(kinds(check(l, list(doc('A', 'Valid', 10002)), { asOf: T0, toleranceCents: 1 }))).toEqual(['total-mismatch']);
  });

  it('net mismatch only when both sides have net', () => {
    expect(kinds(check([led('A', 106, { net: 100 })], list(doc('A', 'Valid', 106, { net: 99 })), { asOf: T0 }))).toEqual(['net-mismatch']);
    expect(kinds(check([led('A', 106)], list(doc('A', 'Valid', 106, { net: 99 })), { asOf: T0 }))).toEqual([]);
    expect(kinds(check([led('A', 106, { net: 100 })], list(doc('A', 'Valid', 106)), { asOf: T0 }))).toEqual([]);
  });

  it('void-but-valid: window open, closed, and Submitted', () => {
    const l = [led('A', 100, { void: true })];
    const open = check(l, list(doc('A', 'Valid', 100)), { asOf: T0 + 71 * H });
    expect(open.findings[0].detail).toContain('1h00m left');
    const closed = check(l, list(doc('A', 'Valid', 100)), { asOf: T0 + 72 * H });
    expect(closed.findings[0].detail).toContain('issue a credit / refund note');
    const sub = check(l, list(doc('A', 'Submitted', 100)), { asOf: T0 });
    expect(sub.findings[0].detail).toContain('within 72 h after it becomes Valid');
    expect(check(l, list(doc('A', 'Cancelled', 100)), { asOf: T0 }).summary.states['void-ok']).toBe(1);
  });

  it('a Valid document wins over earlier Invalid / Cancelled ones', () => {
    const r = check([led('A', 100)], list(doc('A', 'Invalid', 100), doc('A', 'Cancelled', 100), doc('A', 'Valid', 100)), { asOf: T0 });
    expect(r.findings).toEqual([]);
    expect(r.summary.states.valid).toBe(1);
  });

  it('cancelled beats invalid-only; Submitted is pending', () => {
    expect(kinds(check([led('A', 1)], list(doc('A', 'Invalid', 1), doc('A', 'Cancelled', 1)), { asOf: T0 }))).toEqual(['cancelled-but-booked']);
    expect(kinds(check([led('A', 1)], list(doc('A', 'Cancelled', 1), doc('A', 'Submitted', 1)), { asOf: T0 }))).toEqual(['pending']);
  });

  it('consolidated: on time, exactly at deadline is late, due, overdue, wrong buyer', () => {
    const l = [led('C', 100, { consolidated: true })];
    const deadline = Date.UTC(2026, 10, 7, 16); // 2026-11-08 00:00 MYT
    const ok = doc('C', 'Valid', 100, { received: deadline - 1000, buyerTin: 'EI00000000010' });
    expect(kinds(check(l, list(ok), { asOf: deadline + H }))).toEqual([]);
    expect(kinds(check(l, list(doc('C', 'Valid', 100, { received: deadline })), { asOf: deadline + H }))).toEqual(['consolidated-late']);
    expect(check(l, list(), { asOf: deadline - 1 }).summary.states.due).toBe(1);
    expect(kinds(check(l, list(), { asOf: deadline }))).toEqual(['consolidated-overdue']);
    expect(kinds(check(l, list(doc('C', 'Valid', 100, { received: deadline - H, buyerTin: 'C123' })), { asOf: deadline }))).toEqual(['consolidated-buyer']);
  });

  it('consolidated deadline falls back to validated, then issued', () => {
    const l = [led('C', 100, { consolidated: true })];
    const deadline = Date.UTC(2026, 10, 7, 16);
    expect(kinds(check(l, list(doc('C', 'Valid', 100, { validated: deadline })), { asOf: deadline }))).toEqual(['consolidated-late']);
    expect(kinds(check(l, list(doc('C', 'Valid', 100, { validated: undefined, issued: deadline })), { asOf: deadline }))).toEqual(['consolidated-late']);
    expect(kinds(check(l, list(doc('C', 'Valid', 100, { validated: undefined })), { asOf: deadline }))).toEqual([]);
  });

  it('rejection requested: open window wording; reject outside window warns', () => {
    const r = check([led('A', 1)], list(doc('A', 'Valid', 1, { rejectRequested: T0 + H })), { asOf: T0 + 2 * H });
    expect(kinds(r)).toEqual(['rejection-requested']);
    expect(r.findings[0].detail).toContain('cancel before');
    expect(r.findings[0].severity).toBe('warning');
    const late = check([led('A', 1)], list(doc('A', 'Valid', 1, { rejectRequested: T0 + 73 * H })), { asOf: T0 + 80 * H });
    expect(kinds(late)).toEqual(['rejection-requested', 'reject-outside-window']);
  });

  it('cancel at exactly 72 h is inside the window', () => {
    expect(kinds(check([], list(doc('A', 'Cancelled', 1, { cancelled: T0 + 72 * H })), { asOf: T0 }))).toEqual([]);
    expect(kinds(check([], list(doc('A', 'Cancelled', 1, { cancelled: T0 + 72 * H + 1 })), { asOf: T0 }))).toEqual(['cancel-outside-window']);
  });

  it('not-in-ledger ignores Invalid / Cancelled and uses all ledger rows even with --period', () => {
    expect(kinds(check([], list(doc('X', 'Invalid', 1), doc('Y', 'Cancelled', 1)), { asOf: T0 }))).toEqual([]);
    expect(kinds(check([], list(doc('X', 'Submitted', 1)), { asOf: T0 }))).toEqual(['not-in-ledger']);
    const sept = led('S', 1, { date: Date.UTC(2026, 8, 10) });
    const r = check([sept], list(doc('S', 'Valid', 1, { issued: T0 })), { asOf: T0, period: '2026-10' });
    expect(r.findings).toEqual([]);
    expect(r.summary.invoices).toBe(0);
  });

  it('library options: explicit undefined uses defaults; bad options throw', () => {
    const r = check([led('A', 1)], list(doc('A', 'Valid', 1)), { asOf: undefined, period: undefined, toleranceCents: undefined });
    expect(r.toleranceCents).toBe(0);
    expect(r.period).toBeUndefined();
    expect(() => check([], list(), { toleranceCents: -1 })).toThrow(InputError);
    expect(() => check([], list(), { toleranceCents: 0.5 })).toThrow(InputError);
    expect(() => check([], list(), { period: '2026-13' })).toThrow(InputError);
  });

  it('invariants hold on a generated mix', () => {
    const ledger: LedgerEntry[] = [];
    const docs: EDocument[] = [];
    const statuses: EDocument['status'][] = ['Valid', 'Submitted', 'Cancelled', 'Invalid'];
    for (let i = 0; i < 400; i++) {
      ledger.push(led(`I${i}`, 1000 + i, { row: i + 2, void: i % 11 === 0, consolidated: i % 37 === 0 }));
      const k = i % 5;
      if (k < 4) docs.push(doc(`I${i}`, statuses[k], 1000 + i + (i % 7 === 0 ? 1 : 0)));
    }
    const r = check(ledger, list(...docs), { asOf: T0 + 1000 * H });
    expect(stateSum(r)).toBe(400);
    expect(r.summary.findings).toBe(r.findings.length);
    expect(r.summary.errors + r.summary.warnings).toBe(r.findings.length);
    const mismatch = r.findings.filter((x) => x.kind === 'total-mismatch').reduce((a, x) => a + x.documentAmount! - x.ledgerAmount!, 0);
    expect(r.summary.documentValidTotal - r.summary.ledgerValidTotal).toBe(mismatch);
    const nonVoidValid = ledger.filter((l, i) => !l.void && i % 5 === 0);
    expect(r.summary.states.valid).toBe(nonVoidValid.length);
  });
});
