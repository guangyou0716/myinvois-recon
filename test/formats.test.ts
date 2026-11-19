import { describe, expect, it } from 'vitest';
import { check, CSV_HEADER, csvCell, csvReport, mdCell, mdReport, parseDocuments, parseLedger } from '../src/index.js';

const AS_OF = Date.UTC(2026, 10, 1, 1); // 2026-11-01 09:00 MYT

const report = (ledger: string[], documents: string[], options = {}) =>
  check(parseLedger(['invoice,date,total', ...ledger].join('\n')), parseDocuments(['uuid,internalId,status,total', ...documents].join('\n')), {
    asOf: AS_OF,
    ...options,
  });

const lines = (text: string) => text.trimEnd().split('\n');

describe('csvCell', () => {
  it.each([
    ['plain', 'plain'],
    ['', ''],
    [undefined, ''],
    [null, ''],
    [0, '0'],
    [18, '18'],
    ['-27.00', '-27.00'],
    ['-5', '-5'],
    ['a,b', '"a,b"'],
    ['say "hi"', '"say ""hi"""'],
    ['two\nlines', '"two\nlines"'],
    ['=1+1', "'=1+1"],
    ['+60', "'+60"],
    ['-1+2', "'-1+2"],
    ['-x', "'-x"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['\tx', "'\tx"],
    ['\rx', `"'\rx"`],
    ['=a,b', `"'=a,b"`],
    ['a=b', 'a=b'],
  ])('%j -> %j', (v, want) => {
    expect(csvCell(v as string | number | null | undefined)).toBe(want);
  });
});

describe('mdCell', () => {
  it('escapes pipes and backslashes, flattens line breaks', () => {
    expect(mdCell('a|b\\c')).toBe('a\\|b\\\\c');
    expect(mdCell('x\r\ny\nz\rw')).toBe('x y z w');
    expect(mdCell(5)).toBe('5');
  });
});

describe('csvReport', () => {
  it('header only when there are no findings', () => {
    const r = report(['A,2026-10-01,10.00'], ['U1,A,Valid,10.00']);
    expect(csvReport(r)).toBe(`${CSV_HEADER.join(',')}\n`);
  });

  it('one row per finding in kind order, all findings, amounts as decimals, guarded and quoted cells', () => {
    const r = report(
      ['=CMD,2026-10-01,5.00', 'B,2026-10-01,10.00', 'C,2026-10-01,7.00', 'D,2026-10-01,1.00', 'E,2026-10-01,2.00'],
      ['U2,B,Valid,12.50', 'U3,"X""1",Valid,3.00', 'U4,"X""1",Valid,3.00', 'U5,C,Submitted,7.00'],
    );
    const out = lines(csvReport(r));
    expect(out[0]).toBe('kind,severity,invoice,ledger_row,uuids,ledger_amount,document_amount,deadline,detail');
    expect(out.slice(1)).toEqual([
      "not-submitted,error,'=CMD,2,,5.00,,,no e-Invoice with internalId =CMD",
      'not-submitted,error,D,5,,1.00,,,no e-Invoice with internalId D',
      'not-submitted,error,E,6,,2.00,,,no e-Invoice with internalId E',
      'total-mismatch,error,B,3,U2,10.00,12.50,,ledger 10.00 vs e-Invoice 12.50 (difference 2.50)',
      'duplicate-valid,error,"X""1",,U3 U4,,,,2 Valid e-Invoices with the same internalId',
      'not-in-ledger,error,"X""1",,U3,,3.00,,Valid e-Invoice U3 (3.00) has no ledger row',
      'not-in-ledger,error,"X""1",,U4,,3.00,,Valid e-Invoice U4 (3.00) has no ledger row',
      'pending,warning,C,4,U5,,,,e-Invoice U5 is still Submitted (validation not finished)',
    ]);
  });

  it('deadline column is the UTC ISO instant, like --json', () => {
    const r = check(
      parseLedger('invoice,date,total,consolidated\nCON-1,2026-09-15,100.00,yes\n'),
      parseDocuments('uuid,internalId,status,total\n'),
      { asOf: AS_OF },
    );
    expect(lines(csvReport(r))[1]).toBe(
      'consolidated-overdue,error,CON-1,2,,100.00,,2026-10-07T16:00:00.000Z,no e-Invoice for the 2026-09 consolidated e-Invoice; deadline was 2026-10-07 23:59:59 MYT',
    );
  });
});

describe('mdReport', () => {
  it('summary, settings, states and "No findings." when clean', () => {
    const r = report(['A,2026-10-01,10.00', 'B,2026-09-01,1.00'], ['U1,A,Valid,10.00'], { period: '2026-10', toleranceCents: 1 });
    const md = mdReport(r);
    expect(md).toContain('# MyInvois reconciliation\n');
    expect(md).toContain('| 2 | 1 | 0 | 1 | 0 | 0 | 0 | 0 |\n');
    expect(md).toContain('Settings: as of 2026-11-01 09:00:00 MYT, period 2026-10 (1 ledger row outside ignored), amount tolerance 0.01.\n');
    expect(md).toContain('| Valid | Submitted | Invalid | Cancelled |\n| ---: | ---: | ---: | ---: |\n| 1 | 0 | 0 | 0 |\n');
    expect(md).toContain('| valid | 1 |\n');
    expect(md).toContain('Valid totals: ledger 10.00, e-Invoices 10.00 (difference 0.00); booked without a Valid e-Invoice 0.00.\n');
    expect(md).not.toContain('## Findings');
    expect(md.endsWith('\nNo findings.\n')).toBe(true);
  });

  it('counts per kind, lists capped by limit, escaped cells, due consolidated e-Invoices', () => {
    const r = check(
      parseLedger(
        'invoice,date,total,consolidated\nA|1,2026-10-01,1.00,\nB,2026-10-01,1.00,\nC,2026-10-01,1.00,\nCON-10,2026-10-31,5.00,yes\n',
      ),
      parseDocuments('uuid,internalId,status,total\nU1,Z,Submitted,2.00\n'),
      { asOf: AS_OF },
    );
    const md = mdReport(r, 2);
    expect(md).toContain('## Consolidated e-Invoices not yet due: 1\n\n| invoice | ledger row | submit by |\n| --- | ---: | --- |\n| CON-10 | 5 | 2026-11-07 23:59:59 MYT |\n');
    expect(md).toContain('## Findings: 4 findings (4 errors, 0 warnings)\n');
    expect(md).toContain('| not-submitted | error | 3 |\n| not-in-ledger | error | 1 |\n');
    expect(md).toContain(
      '### not-submitted: 3\n\n- **A\\|1** (ledger row 2): no e-Invoice with internalId A\\|1\n- **B** (ledger row 3): no e-Invoice with internalId B\n- ... 1 more (use --json or --csv for all, or a higher --limit)\n',
    );
    expect(md).toContain('### not-in-ledger: 1\n\n- **Z**: Submitted e-Invoice U1 (2.00) has no ledger row\n');
  });

  it('warning kinds are labelled warning in the counts table', () => {
    const r = report(['A,2026-10-01,1.00'], ['U1,A,Submitted,1.00']);
    expect(mdReport(r)).toContain('| pending | warning | 1 |\n');
    expect(mdReport(r)).toContain('## Findings: 1 finding (0 errors, 1 warning)\n');
  });
});
