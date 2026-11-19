import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { ex } from './helpers.js';

function run(args: string[]) {
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

afterEach(() => vi.restoreAllMocks());

function tmp(name: string, text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'mir-'));
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
}

const EX = [ex('ledger.csv'), ex('documents.csv'), '--as-of', '2026-11-10T09:00'];

describe('cli', () => {
  it('example text report: exit 1', () => {
    const r = run(EX);
    expect(r.code).toBe(1);
    expect(r.err).toBe('');
    expect(r.out).toContain('myinvois-recon: 17 ledger rows, 16 invoice numbers checked, 15 documents (1 duplicate row dropped)\n');
    expect(r.out).toContain('As of 2026-11-10 09:00:00 MYT\n');
    expect(r.out).toContain('Documents: 10 Valid, 1 Submitted, 2 Invalid, 2 Cancelled\n');
    expect(r.out).toContain('  valid                 7\n');
    expect(r.out).toContain('  void-but-valid        1\n');
    expect(r.out).toContain('Valid totals: ledger 7950.00, e-Invoices 7923.00 (difference -27.00); booked without a Valid e-Invoice 2427.40\n');
    expect(r.out).toContain('  - CON-2611 (ledger row 17): submit by 2026-12-07 23:59:59 MYT\n');
    expect(r.out).toContain('Findings: 14 findings (11 errors, 3 warnings)\n');
    expect(r.out).toContain('total-mismatch (1, error):\n  - INV-002 (ledger row 3): ledger 530.00 vs e-Invoice 503.00 (difference -27.00)\n');
    expect(r.out).toContain('pending (1, warning):\n');
  });

  it('JSON report with amounts as strings and ISO instants', () => {
    const r = run([...EX, '--json']);
    expect(r.code).toBe(1);
    const d = JSON.parse(r.out);
    expect(d.tool).toBe('myinvois-recon');
    expect(d.asOf).toBe('2026-11-10T01:00:00.000Z');
    expect(d.summary.ledgerValidTotal).toBe('7950.00');
    expect(d.summary.documentValidTotal).toBe('7923.00');
    expect(d.summary.findings).toBe(d.findings.length);
    expect(Object.values(d.summary.states as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(d.summary.invoices);
    expect(d.counts['total-mismatch']).toBe(1);
    expect(d.findings.find((f: { kind: string }) => f.kind === 'total-mismatch')).toEqual({
      kind: 'total-mismatch',
      severity: 'error',
      invoice: 'INV-002',
      ledgerRow: 3,
      uuids: ['DEMO0000000000000000000002'],
      ledgerAmount: '530.00',
      documentAmount: '503.00',
      detail: 'ledger 530.00 vs e-Invoice 503.00 (difference -27.00)',
    });
    expect(d.due).toEqual([{ invoice: 'CON-2611', ledgerRow: 17, deadline: '2026-12-07T16:00:00.000Z' }]);
  });

  it('--limit caps each kind in the text report', () => {
    const led = tmp('l.csv', 'invoice,date,total\nA,2026-10-01,1\nB,2026-10-01,1\nC,2026-10-01,1\n');
    const docs = tmp('d.csv', 'uuid,internalId,status,total\n');
    const r = run([led, docs, '--limit', '1', '--as-of', '2026-11-01']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('not-submitted (3, error):\n  - A (ledger row 2): no e-Invoice with internalId A\n  ... 2 more (see --json)\n');
  });

  it('exit 0 and "No findings." when clean; --period, --tolerance, column overrides, --void-values', () => {
    const led = tmp('l.csv', 'Doc,Posted,Amount,State\nA,2026-10-01,10.00,\nB,2026-09-01,5.00,\nV,2026-10-02,3.00,reversed\n');
    const docs = tmp('d.csv', 'UUID,Ref,Status,Total\nU1,A,Valid,10.01\n');
    const r = run([
      led,
      docs,
      '--period',
      '2026-10',
      '--tolerance',
      '0.01',
      '--ledger-column',
      'invoice=Doc,date=Posted,total=Amount',
      '--ledger-column',
      'status=State',
      '--void-values',
      'reversed',
      '--doc-column',
      'uuid=UUID,internalId=Ref,status=Status,total=Total',
      '--as-of',
      '2026-11-01',
    ]);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toContain('(period 2026-10, 1 outside)');
    expect(r.out).toContain('amount tolerance 0.01');
    expect(r.out).toContain('  void-ok               1\n');
    expect(r.out).toContain('No findings.\n');
  });

  it('help exits 0', () => {
    const r = run(['--help']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Usage: myinvois-recon <ledger.csv> <documents.csv>');
  });

  it('input errors exit 2 with a message', () => {
    const cases: [string[], RegExp][] = [
      [[], /need the ledger CSV and the documents CSV/],
      [[ex('ledger.csv')], /need the ledger CSV/],
      [[ex('ledger.csv'), ex('documents.csv'), 'extra'], /unexpected arguments: extra/],
      [['/nonexistent/l.csv', ex('documents.csv')], /cannot read ledger file/],
      [[ex('ledger.csv'), ex('documents.csv'), '--as-of', 'tomorrow'], /--as-of/],
      [[ex('ledger.csv'), ex('documents.csv'), '--period', '2026-13'], /period "2026-13"/],
      [[ex('ledger.csv'), ex('documents.csv'), '--tolerance', '-1'], /--tolerance/],
      [[ex('ledger.csv'), ex('documents.csv'), '--tolerance', 'abc'], /--tolerance/],
      [[ex('ledger.csv'), ex('documents.csv'), '--limit', '0'], /--limit/],
      [[ex('ledger.csv'), ex('documents.csv'), '--void-values', ' , '], /--void-values is empty/],
      [[ex('ledger.csv'), ex('documents.csv'), '--doc-column', 'nope=X'], /unknown key "nope"/],
      [[ex('ledger.csv'), ex('documents.csv'), '--bogus'], /Unknown option/],
      [[ex('documents.csv'), ex('ledger.csv')], /ledger: missing column "invoice"/],
    ];
    for (const [args, re] of cases) {
      const r = run(args);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.out).toBe('');
      expect(r.err).toMatch(/^myinvois-recon: /);
      expect(r.err).toMatch(re);
    }
  });
});
