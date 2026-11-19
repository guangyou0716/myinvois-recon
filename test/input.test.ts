import { describe, expect, it } from 'vitest';
import { InputError, normaliseStatus, normaliseType, parseColumnMap, parseDocuments, parseLedger, DOCUMENT_KEYS, LEDGER_KEYS } from '../src/index.js';

describe('vocabulary', () => {
  it('normalises types', () => {
    expect(normaliseType('01')).toBe('invoice');
    expect(normaliseType('2')).toBe('credit-note');
    expect(normaliseType('Credit Note')).toBe('credit-note');
    expect(normaliseType('self_billed invoice')).toBe('self-billed-invoice');
    expect(normaliseType('Self-billed Refund Note')).toBe('self-billed-refund-note');
    expect(normaliseType('CN')).toBe('credit-note');
    expect(normaliseType('05')).toBeUndefined();
    expect(normaliseType('receipt')).toBeUndefined();
  });
  it('normalises statuses', () => {
    expect(normaliseStatus('valid')).toBe('Valid');
    expect(normaliseStatus('CANCELED')).toBe('Cancelled');
    expect(normaliseStatus('Rejected')).toBeUndefined();
  });
});

describe('parseLedger', () => {
  it('reads required and optional columns, case-insensitive header', () => {
    const l = parseLedger('Invoice,Date,Total,Type,Net,Status,Consolidated\nA-1,2026-10-02,"1,060.00",CN,-1000,VOID,\nA-2,2026-10-03,5,,,,yes\n');
    expect(l).toEqual([
      { row: 2, invoice: 'A-1', date: Date.UTC(2026, 9, 1, 16), total: 106000, type: 'credit-note', net: -100000, void: true, consolidated: false },
      { row: 3, invoice: 'A-2', date: Date.UTC(2026, 9, 2, 16), total: 500, void: false, consolidated: true },
    ]);
  });
  it('supports column overrides and custom void values', () => {
    const cols = parseColumnMap(['invoice=Doc No,total=Amount', 'date=Posting Date'], LEDGER_KEYS, '--ledger-column');
    const l = parseLedger('Doc No,Posting Date,Amount,status\nX,2026-10-02,1,reversed\n', cols, ['reversed']);
    expect(l[0]).toMatchObject({ invoice: 'X', total: 100, void: true });
  });
  it('rejects bad input with the row number', () => {
    expect(() => parseLedger('')).toThrow(/empty/);
    expect(() => parseLedger('invoice,date\nA,2026-10-01\n')).toThrow(/missing column "total"/);
    expect(() => parseLedger('invoice,date,total\n,2026-10-01,1\n')).toThrow(/row 2: empty invoice/);
    expect(() => parseLedger('invoice,date,total\nA,01/10/2026,1\n')).toThrow(/row 2 date/);
    expect(() => parseLedger('invoice,date,total\nA,2026-10-01,abc\n')).toThrow(/row 2 total/);
    expect(() => parseLedger('invoice,date,total,type\nA,2026-10-01,1,receipt\n')).toThrow(/unknown document type/);
    expect(() => parseLedger('invoice,date,total,consolidated\nA,2026-10-01,1,maybe\n')).toThrow(/consolidated/);
    expect(() => parseColumnMap(['foo=Bar'], LEDGER_KEYS, '--ledger-column')).toThrow(InputError);
    expect(() => parseColumnMap(['invoice'], LEDGER_KEYS, '--ledger-column')).toThrow(/key=Header/);
    expect(() => parseLedger('invoice,date,total\nA,2026-10-01,1\n', { net: 'Net Amt' })).toThrow(/not in the header/);
  });
});

describe('parseDocuments', () => {
  const H = 'uuid,internalId,status,total,typeName,dateTimeValidated,cancelDateTime,documentStatusReason,buyerTin';
  it('reads API field names, UTC timestamps and drops identical repeats', () => {
    const r = parseDocuments(`${H}\nU1,A-1,valid,10.60,Invoice,2026-10-02T02:02:00,,,\nU1,A-1,valid,10.60,Invoice,2026-10-02T02:02:00,,,\nU2,A-2,Cancelled,5,02,2026-10-03T00:00:00Z,2026-10-03T05:00:00Z,Wrong buyer details,EI00000000010\n`);
    expect(r.duplicateRows).toBe(1);
    expect(r.documents).toEqual([
      { row: 2, uuid: 'U1', internalId: 'A-1', status: 'Valid', total: 1060, type: 'invoice', validated: Date.UTC(2026, 9, 2, 2, 2) },
      {
        row: 4,
        uuid: 'U2',
        internalId: 'A-2',
        status: 'Cancelled',
        total: 500,
        type: 'credit-note',
        validated: Date.UTC(2026, 9, 3),
        cancelled: Date.UTC(2026, 9, 3, 5),
        reason: 'Wrong buyer details',
        buyerTin: 'EI00000000010',
      },
    ]);
  });
  it('rejects conflicting rows and bad values', () => {
    expect(() => parseDocuments(`${H}\nU1,A,Valid,1,,,,,\nU1,A,Cancelled,1,,,,,\n`)).toThrow(/already on row 2/);
    expect(() => parseDocuments(`${H}\nU1,A,Rejected,1,,,,,\n`)).toThrow(/unknown status/);
    expect(() => parseDocuments(`${H}\nU1,,Valid,1,,,,,\n`)).toThrow(/empty internalId/);
    expect(() => parseDocuments(`${H}\n,A,Valid,1,,,,,\n`)).toThrow(/empty uuid/);
    expect(() => parseDocuments(`${H}\nU1,A,Valid,,,,,,\n`)).toThrow(/empty total/);
    expect(() => parseDocuments(`${H}\nU1,A,Valid,1,,yesterday,,,\n`)).toThrow(/dateTimeValidated/);
    expect(() => parseDocuments('uuid,status,total\nU1,Valid,1\n')).toThrow(/missing column "internalId"/);
  });
  it('supports column overrides', () => {
    const cols = parseColumnMap(['uuid=UUID', 'internalid=Invoice No', 'status=Status', 'total=Total Amount'], DOCUMENT_KEYS, '--doc-column');
    const r = parseDocuments('UUID,Invoice No,Status,Total Amount\nU9,B-1,Valid,2.00\n', cols);
    expect(r.documents[0]).toMatchObject({ uuid: 'U9', internalId: 'B-1', total: 200 });
  });
});
