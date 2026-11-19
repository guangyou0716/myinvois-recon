import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { ex } from './helpers.js';
import { check, csvReport, CSV_HEADER, InputError, jsonReport, mdReport, parseDocuments, parseLedger, STATES, textReport } from '../src/index.js';
import type { Report } from '../src/index.js';

const AS_OF = Date.UTC(2026, 9, 7, 1); // 2026-10-07 09:00 MYT

// Worked table (AP ledger vs supplier e-Invoices, direction received, as of 2026-10-07 09:00 MYT):
//  row  invoice  supplier  ledger         documents (issuer TIN)                  state           finding(s)
//   2   S-1      C111       100.00        V1 Valid 100.00 (c111, lower case)      valid           -
//   3   S-1      C222        50.00        V2 Valid  55.00 (C222)                  valid           total-mismatch (same number, other supplier)
//   4   S-2      C111        70.00        -                                       missing         not-received
//   5   S-3      C111        40.00        X1 Cancelled (C111)                     cancelled       cancelled-but-booked
//   6   S-4      C111        30.00 void   V3 Valid, validated 10-06 10:00 MYT     void-but-valid  void-but-valid (window open)
//   7   S-5      C111        20.00        P1 Submitted (ignored)                  missing         not-received
//   8   S-6      C111        25.00        V4 Valid 25.00, rejection requested     valid           rejection-requested (warning)
//   9   S-1      C111       100.00        (repeat of row 2)                       -               duplicate-ledger
//   -   X-9      C333        -            V5 Valid 12.00                          -               not-in-ledger
//   -   S-7      C444        -            V6, V7 Valid 9.00                       -               duplicate-valid, not-in-ledger x2
//   -   S-8      C333        -            I1 Invalid (ignored)                    -               -
const LEDGER = [
  'invoice,date,total,supplier,status',
  'S-1,2026-10-02,100.00,C111,',
  'S-1,2026-10-03,50.00,C222,',
  'S-2,2026-10-04,70.00,C111,',
  'S-3,2026-10-05,40.00,C111,',
  'S-4,2026-10-06,30.00,C111,void',
  'S-5,2026-10-06,20.00,C111,',
  'S-6,2026-10-06,25.00, c111 ,',
  'S-1,2026-10-02,100.00,C111,',
].join('\n');
const DOCS = [
  'uuid,internalId,status,total,issuerTin,dateTimeIssued,dateTimeValidated,cancelDateTime,rejectRequestDateTime,documentStatusReason',
  'V1,S-1,Valid,100.00,c111,2026-10-02T01:00:00Z,2026-10-02T01:01:00Z,,,',
  'V2,S-1,Valid,55.00,C222,2026-10-03T01:00:00Z,2026-10-03T01:01:00Z,,,',
  'X1,S-3,Cancelled,40.00,C111,2026-10-05T01:00:00Z,2026-10-05T01:01:00Z,2026-10-05T05:00:00Z,,Wrong invoice details',
  'V3,S-4,Valid,30.00,C111,2026-10-06T02:00:00Z,2026-10-06T02:00:00Z,,,',
  'P1,S-5,Submitted,20.00,C111,2026-10-06T02:00:00Z,,,,',
  'V4,S-6,Valid,25.00,C111,2026-10-06T02:00:00Z,2026-10-06T02:00:00Z,,2026-10-06T03:00:00Z,Wrong quantity',
  'V5,X-9,Valid,12.00,C333,2026-10-04T01:00:00Z,2026-10-04T01:01:00Z,,,',
  'V6,S-7,Valid,9.00,C444,2026-10-04T01:00:00Z,2026-10-04T01:01:00Z,,,',
  'V7,S-7,Valid,9.00,C444,2026-10-04T02:00:00Z,2026-10-04T02:01:00Z,,,',
  'I1,S-8,Invalid,8.00,C333,2026-10-04T01:00:00Z,,,,',
].join('\n');

const run = (options = {}) => check(parseLedger(LEDGER), parseDocuments(DOCS), { asOf: AS_OF, direction: 'received', ...options });
const brief = (r: Report) => r.findings.map((f) => [f.kind, f.supplier, f.invoice, f.ledgerRow ?? null]);

describe('direction received (AP ledger vs supplier e-Invoices)', () => {
  it('matches the worked table', () => {
    const r = run();
    expect(r.direction).toBe('received');
    expect(r.summary.states).toEqual({ valid: 3, pending: 0, cancelled: 1, 'invalid-only': 0, missing: 2, due: 0, 'void-ok': 0, 'void-but-valid': 1 });
    expect(STATES.reduce((a, k) => a + r.summary.states[k], 0)).toBe(r.summary.invoices);
    expect(r.summary.invoices).toBe(7);
    expect(r.summary.ignoredDocuments).toBe(2);
    expect(r.summary.documents).toBe(10);
    expect(r.summary.documentsByStatus).toEqual({ Submitted: 1, Valid: 7, Invalid: 1, Cancelled: 1 });
    expect(brief(r)).toEqual([
      ['not-received', 'C111', 'S-2', 4],
      ['not-received', 'C111', 'S-5', 7],
      ['cancelled-but-booked', 'C111', 'S-3', 5],
      ['void-but-valid', 'C111', 'S-4', 6],
      ['total-mismatch', 'C222', 'S-1', 3],
      ['duplicate-valid', 'C444', 'S-7', null],
      ['not-in-ledger', 'C444', 'S-7', null],
      ['not-in-ledger', 'C444', 'S-7', null],
      ['not-in-ledger', 'C333', 'X-9', null],
      ['duplicate-ledger', 'C111', 'S-1', 9],
      ['rejection-requested', 'C111', 'S-6', 8],
    ]);
    expect(r.summary.ledgerValidTotal).toBe(17500);
    expect(r.summary.documentValidTotal).toBe(18000);
    expect(r.summary.ledgerUnmatchedTotal).toBe(13000);
    expect(r.summary.errors).toBe(10);
    expect(r.summary.warnings).toBe(1);
    // Never issuer-only findings in this direction.
    for (const k of ['not-submitted', 'pending', 'invalid-only', 'consolidated-overdue', 'consolidated-late', 'consolidated-buyer', 'consolidated-not-valid']) {
      expect(r.counts[k as keyof typeof r.counts]).toBeUndefined();
    }
  });

  it('buyer-side wording', () => {
    const r = run();
    const detail = (kind: string) => r.findings.find((f) => f.kind === kind)!.detail;
    expect(detail('not-received')).toBe('no Valid or Cancelled e-Invoice from supplier C111 with internalId S-2; ask the supplier for it');
    expect(detail('cancelled-but-booked')).toBe(
      'the supplier cancelled e-Invoice X1 at 2026-10-05 13:00:00 MYT ("Wrong invoice details") but the AP ledger still books 40.00; get a replacement e-Invoice from the supplier or reverse the entry',
    );
    expect(detail('void-but-valid')).toBe(
      "AP ledger marks the invoice void but the supplier's e-Invoice V3 is Valid; request rejection or ask the supplier to cancel it before 2026-10-09 10:00:00 MYT (72 h after validation), 2d01h left",
    );
    expect(detail('rejection-requested')).toBe(
      'rejection requested at 2026-10-06 11:00:00 MYT ("Wrong quantity"); the e-Invoice stays Valid until the supplier cancels it; the supplier can cancel it before 2026-10-09 10:00:00 MYT',
    );
    expect(detail('not-in-ledger')).toBe('Valid e-Invoice V6 (9.00) from supplier C444 has no AP ledger row (purchase not booked?)');
    expect(detail('duplicate-valid')).toBe('2 Valid e-Invoices with the same issuer TIN and internalId');
    expect(detail('duplicate-ledger')).toBe('invoice number from this supplier already on ledger row 2');
  });

  it('after the 72 h window the void and rejection details point to a supplier note', () => {
    const r = run({ asOf: Date.UTC(2026, 9, 10) });
    expect(r.findings.find((f) => f.kind === 'void-but-valid')!.detail).toContain('; the 72 h window closed 2026-10-09 10:00:00 MYT, the supplier has to issue a credit / refund note instead');
    expect(r.findings.find((f) => f.kind === 'rejection-requested')!.detail).toContain('the supplier has to issue a credit / debit / refund note');
  });

  it('issued direction on the same files keys on internalId only (different result)', () => {
    const r = check(parseLedger(LEDGER), parseDocuments(DOCS), { asOf: AS_OF });
    expect(r.direction).toBeUndefined();
    expect(r.summary.ignoredDocuments).toBeUndefined();
    expect(r.findings.every((f) => f.supplier === undefined)).toBe(true);
    expect(r.counts['duplicate-ledger']).toBe(2); // S-1 three times regardless of supplier
    expect(r.counts.pending).toBe(1);
  });

  it('input errors', () => {
    const docs = parseDocuments(DOCS);
    expect(() => check(parseLedger('invoice,date,total\nA,2026-10-01,1.00\n'), docs, { direction: 'received' })).toThrow(/ledger row 2: empty supplier TIN/);
    expect(() => check(parseLedger('invoice,date,total,supplier,consolidated\nA,2026-10-01,1.00,C1,yes\n'), docs, { direction: 'received' })).toThrow(
      /consolidated rows do not apply to direction received/,
    );
    expect(() => check(parseLedger(LEDGER), parseDocuments('uuid,internalId,status,total\nU,S-1,Valid,1.00\n'), { direction: 'received' })).toThrow(/documents row 2: empty issuerTin/);
    expect(() => check([], { documents: [], duplicateRows: 0 }, { direction: 'sideways' as never })).toThrow(InputError);
    // Ignored statuses do not need an issuerTin.
    const r = check(parseLedger(LEDGER), parseDocuments('uuid,internalId,status,total,issuerTin\nU,S-1,Submitted,1.00,\nW,S-1,Valid,100.00,C111\n'), { direction: 'received', asOf: AS_OF });
    expect(r.summary.ignoredDocuments).toBe(1);
  });

  it('by-month in the received direction', () => {
    const r = run({ byMonth: true });
    expect(r.months).toEqual([
      {
        month: '2026-10',
        invoices: 6,
        validInvoices: 3,
        ledgerTotal: 30500,
        consolidated: 0,
        consolidatedTotal: 0,
        voided: 1,
        validDocuments: 7,
        validDocumentTotal: 24000,
        difference: -6500,
      },
    ]);
  });

  it('renders supplier in text, Markdown, JSON and CSV', () => {
    const r = run();
    const text = textReport(r);
    expect(text).toContain('Direction: received (supplier e-Invoices vs AP ledger, matched on issuer TIN + internalId)\n');
    expect(text).toContain('Documents: 7 Valid, 1 Submitted, 1 Invalid, 1 Cancelled (2 Submitted / Invalid ignored: a receiver only sees Valid and Cancelled)\n');
    expect(text).toContain('not-received (2, error):\n  - C111 S-2 (ledger row 4): ');
    const md = mdReport(r);
    expect(md).toContain('direction received (supplier e-Invoices vs AP ledger, matched on issuer TIN + internalId), 2 Submitted / Invalid documents ignored');
    expect(md).toContain('- **C111 S-2** (ledger row 4): ');
    const j = JSON.parse(jsonReport(r));
    expect(j.direction).toBe('received');
    expect(j.summary.ignoredDocuments).toBe(2);
    expect(j.findings[0]).toMatchObject({ kind: 'not-received', invoice: 'S-2', supplier: 'C111', ledgerRow: 4, ledgerAmount: '70.00' });
    const csv = csvReport(r).split('\n');
    expect(csv[0]).toBe('kind,severity,invoice,supplier,ledger_row,uuids,ledger_amount,document_amount,deadline,detail');
    expect(csv[1]).toBe('not-received,error,S-2,C111,4,,70.00,,,no Valid or Cancelled e-Invoice from supplier C111 with internalId S-2; ask the supplier for it');
    expect(CSV_HEADER).not.toContain('supplier');
  });
});

function cli(args: string[]) {
  let out = '';
  let err = '';
  const o = vi.spyOn(process.stdout, 'write').mockImplementation((s) => ((out += String(s)), true));
  const e = vi.spyOn(process.stderr, 'write').mockImplementation((s) => ((err += String(s)), true));
  try {
    return { code: main(args), out, err };
  } finally {
    o.mockRestore();
    e.mockRestore();
  }
}

describe('cli: --direction, --by-month, --csv-months', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mir-recv-'));
  const L = join(dir, 'ap.csv');
  const D = join(dir, 'received.csv');
  writeFileSync(L, LEDGER);
  writeFileSync(D, DOCS);
  const base = [L, D, '--as-of', '2026-10-07T09:00'];

  it('--direction received', () => {
    const r = cli([...base, '--direction', 'received', '--json']);
    expect(r.code).toBe(1);
    expect(r.err).toBe('');
    const j = JSON.parse(r.out);
    expect(j.direction).toBe('received');
    expect(j.counts['not-received']).toBe(2);
    expect(cli([...base, '--direction', 'RECEIVED']).out).toContain('Direction: received');
  });

  it('--direction issued equals the default output', () => {
    expect(cli([...base, '--direction', 'issued']).out).toBe(cli(base).out);
  });

  it('bad combinations exit 2', () => {
    expect(cli([...base, '--direction', 'sent'])).toMatchObject({ code: 2, out: '', err: 'myinvois-recon: --direction must be issued or received.\n' });
    expect(cli([...base, '--csv-months', '--json']).code).toBe(2);
    expect(cli([...base, '--csv-months', '--csv']).err).toBe('myinvois-recon: pick one of --json, --md, --csv, --csv-months.\n');
    expect(cli([...base, '--by-month', '--csv']).err).toBe('myinvois-recon: --by-month does not change the findings CSV; use --csv-months for the per-month CSV.\n');
    expect(cli([L, D, '--direction', 'received', '--ledger-column', 'supplier=vendor']).code).toBe(2);
  });

  it('--by-month and --csv-months', () => {
    const t = cli([...base, '--by-month']);
    expect(t.code).toBe(1);
    expect(t.out).toContain('By month (MYT;');
    const j = JSON.parse(cli([...base, '--by-month', '--json']).out);
    expect(j.months).toHaveLength(1);
    expect(cli([...base, '--by-month', '--md']).out).toContain('## By month (MYT)');
    const c = cli([...base, '--csv-months', '--direction', 'received']);
    expect(c.code).toBe(1);
    expect(c.out).toBe('month,invoices,valid_invoices,ledger_total,consolidated,consolidated_total,voided,valid_documents,valid_document_total,difference\n2026-10,6,3,305.00,0,0.00,1,7,240.00,-65.00\n');
  });
});

describe('examples/ap-ledger.csv vs examples/received-documents.csv', () => {
  it('README example: exit 1, one finding per kind', () => {
    const r = cli([ex('ap-ledger.csv'), ex('received-documents.csv'), '--direction', 'received', '--as-of', '2026-11-02T09:00', '--json']);
    expect(r.code).toBe(1);
    const j = JSON.parse(r.out);
    expect(j.counts).toEqual({
      'not-received': 1,
      'cancelled-but-booked': 1,
      'void-but-valid': 1,
      'total-mismatch': 1,
      'not-in-ledger': 1,
      'rejection-requested': 1,
    });
    expect(j.summary.ignoredDocuments).toBe(1);
    expect(j.summary.states.valid).toBe(3);
  });
});
