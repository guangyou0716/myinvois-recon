#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { check } from './check.js';
import { InputError } from './errors.js';
import { DEFAULT_VOID_VALUES, DOCUMENT_KEYS, LEDGER_KEYS, parseColumnMap, parseDocuments, parseLedger } from './input.js';
import { parseMoney } from './money.js';
import { jsonReport, textReport } from './report.js';
import { MYT_OFFSET_MINUTES, parseStamp } from './time.js';

const USAGE = `Usage: myinvois-recon <ledger.csv> <documents.csv> [options]

Reconciles a sales ledger (ERP / accounting export) against a MyInvois (LHDN e-Invoice) document list and lists
the exceptions: invoices booked but never validated, documents cancelled while the ledger still books the sale,
ledger voids with a Valid e-Invoice, amount / type mismatches, duplicate Valid documents, Valid documents with no
ledger row, buyer rejection requests and the consolidated e-Invoice 7-day deadline. Offline; reads two local files
and never calls the MyInvois API.

ledger.csv:     header with invoice,date,total and optional type, net, status, consolidated columns.
                invoice = your invoice number (the internalId sent to MyInvois); date = 2026-10-31 (MYT);
                total = amount incl. tax (sign ignored, credit notes may be negative); type = 01-04 / 11-14 or a
                name (invoice, credit note, ...); status = a void value (--void-values) marks a voided invoice;
                consolidated = yes for a monthly consolidated e-Invoice row (date = any day of that month).
documents.csv:  MyInvois document list with the API field names as header: uuid, internalId, status, total and
                optional typeName, netAmount, dateTimeIssued, dateTimeReceived, dateTimeValidated, cancelDateTime,
                rejectRequestDateTime, documentStatusReason, buyerTin. Status = Submitted / Valid / Invalid /
                Cancelled. Timestamps without a zone are UTC (as MyInvois returns them). Identical repeated rows
                (overlapping exports) are dropped.

Matching: document internalId = ledger invoice number (exact). Calendar days and months are Malaysia time.

Findings (error unless marked warning):
  not-submitted          booked invoice with no document at all
  consolidated-overdue   consolidated row with no document after its deadline (7 calendar days after month end)
  invalid-only           only Invalid documents for the invoice
  cancelled-but-booked   only Cancelled (and Invalid) documents, but the ledger still books the invoice
  void-but-valid         ledger void, but a Valid / Submitted document exists (72 h cancel window open or closed)
  total-mismatch         |ledger total| differs from the Valid document total by more than --tolerance
  net-mismatch           |ledger net| differs from netAmount (only when both columns are present)
  type-mismatch          ledger type differs from typeName (only when both are present)
  duplicate-valid        more than one Valid document with the same internalId
  not-in-ledger          Valid / Submitted document whose internalId is not in the ledger
  consolidated-late      consolidated document received after the deadline
  consolidated-buyer     consolidated document with a buyer TIN other than EI00000000010
  duplicate-ledger       invoice number repeated in the ledger (later rows ignored)
  pending                (warning) only Submitted documents: validation not finished
  rejection-requested    (warning) the buyer asked to reject a Valid document
  cancel-outside-window  (warning) cancelled more than 72 h after validation: check timestamps / time zone
  reject-outside-window  (warning) rejection requested more than 72 h after validation

Options:
  --as-of <time>               evaluation time for deadlines and windows (default now); 2026-11-05 or
                               2026-11-05T09:00 (MYT unless a zone is given)
  --period <YYYY-MM>           only ledger rows dated in this month (MYT); document-only findings
                               (not-in-ledger, duplicate-valid, *-outside-window) only for documents issued in
                               it (documents without dateTimeIssued always count)
  --tolerance <amount>         allowed amount difference, e.g. 0.01 (default 0)
  --void-values <a,b>          ledger status values meaning voided (default ${DEFAULT_VOID_VALUES.join(',')})
  --ledger-column <key=Header> ledger column name override, repeatable or comma list; keys: ${LEDGER_KEYS.join(', ')}
  --doc-column <key=Header>    document column name override; keys: uuid, internalId, status, total, typeName,
                               netAmount, dateTimeIssued, dateTimeReceived, dateTimeValidated, cancelDateTime,
                               rejectRequestDateTime, documentStatusReason, buyerTin
  --limit <n>                  findings listed per kind in the text report (default 50)
  --json                       JSON report (summary, counts, due consolidated e-Invoices, every finding)
  -h, --help                   show this help

Exit codes: 0 no findings, 1 findings (errors or warnings), 2 input error.
`;

function read(path: string, what: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    throw new InputError(`cannot read ${what} file ${path}: ${(e as Error).message}`);
  }
}

function int(v: string | undefined, flag: string, def: number, min: number, max: number): number {
  if (v === undefined) return def;
  if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max) {
    throw new InputError(`${flag} must be a whole number from ${min} to ${max}.`);
  }
  return Number(v);
}

export function main(argv: string[]): number {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        'as-of': { type: 'string' },
        period: { type: 'string' },
        tolerance: { type: 'string' },
        'void-values': { type: 'string' },
        'ledger-column': { type: 'string', multiple: true },
        'doc-column': { type: 'string', multiple: true },
        limit: { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    if (values.help) {
      process.stdout.write(USAGE);
      return 0;
    }
    const [ledgerFile, documentsFile, ...rest] = positionals;
    if (ledgerFile === undefined || documentsFile === undefined) {
      throw new InputError('need the ledger CSV and the documents CSV; see --help.');
    }
    if (rest.length) throw new InputError(`unexpected arguments: ${rest.join(' ')}`);
    const limit = int(values.limit, '--limit', 50, 1, 1_000_000);
    const asOf = values['as-of'] === undefined ? undefined : parseStamp(values['as-of'], '--as-of', MYT_OFFSET_MINUTES);
    if (values['as-of'] !== undefined && asOf === undefined) throw new InputError('--as-of is empty.');
    let toleranceCents: number | undefined;
    if (values.tolerance !== undefined) {
      toleranceCents = parseMoney(values.tolerance, '--tolerance');
      if (toleranceCents === undefined || toleranceCents < 0) throw new InputError('--tolerance must be an amount like 0.01.');
    }
    const voidValues = values['void-values']?.split(',').map((v) => v.trim()).filter(Boolean);
    if (voidValues !== undefined && voidValues.length === 0) throw new InputError('--void-values is empty.');
    const ledger = parseLedger(
      read(ledgerFile, 'ledger'),
      parseColumnMap(values['ledger-column'] ?? [], LEDGER_KEYS, '--ledger-column'),
      voidValues,
    );
    const documents = parseDocuments(
      read(documentsFile, 'documents'),
      parseColumnMap(values['doc-column'] ?? [], DOCUMENT_KEYS, '--doc-column'),
    );
    const report = check(ledger, documents, {
      ...(asOf !== undefined && { asOf }),
      ...(values.period !== undefined && { period: values.period.trim() }),
      ...(toleranceCents !== undefined && { toleranceCents }),
    });
    process.stdout.write(values.json ? jsonReport(report) : textReport(report, limit));
    return report.findings.length ? 1 : 0;
  } catch (e) {
    if (e instanceof InputError || (e as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
      process.stderr.write(`myinvois-recon: ${(e as Error).message}\n`);
      return 2;
    }
    throw e;
  }
}

function isEntryPoint(): boolean {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.exitCode = main(process.argv.slice(2));
}
