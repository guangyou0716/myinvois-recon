# myinvois-recon

[![CI](https://github.com/guangyou0716/myinvois-recon/actions/workflows/ci.yml/badge.svg)](https://github.com/guangyou0716/myinvois-recon/actions/workflows/ci.yml)

Offline month-end check for Malaysian e-Invoicing: compares your **sales ledger** (ERP / accounting export) with
your **MyInvois document list** and lists every invoice where the two disagree.

- booked in the ledger but never validated by MyInvois (no document, only Invalid attempts, still Submitted);
- cancelled in MyInvois (or the buyer asked for rejection) while the ledger still books the sale;
- voided in the ledger while a Valid e-Invoice still exists, with the 72-hour cancel window still open or closed;
- different total / net amount or document type; the same invoice number validated twice; a Valid e-Invoice with
  no ledger row;
- the monthly consolidated e-Invoice submitted after its deadline (7 calendar days after month end), still not
  Valid after it, or not at all.

Optional extras: a per-month summary of ledger vs Valid e-Invoice totals (`--by-month`, `--csv-months`) and the
purchase side, supplier e-Invoices you received vs your AP ledger (`--direction received`).

It reads two local CSV files, never calls the MyInvois API, needs no credentials, and has no runtime dependencies.
TypeScript CLI + library, Node 20+.

## Why

Issuing e-Invoices is only half the job: finance also has to prove that the books and MyInvois agree. ERP add-ons
do this inside one product; this tool does it for any ledger that can export CSV. LHDN notes that the Get Recent
Documents API is meant for troubleshooting, not reconciliation, so `myinvois-recon` does not poll it: use the
document statuses your system already stores, or a document list you saved.

## Quick start

```sh
npm ci && npm run build
node dist/cli.js examples/ledger.csv examples/documents.csv --as-of 2026-11-10T09:00
node dist/cli.js examples/ledger.csv examples/documents.csv --as-of 2026-11-10T09:00 --json
node dist/cli.js examples/ledger.csv examples/documents.csv --as-of 2026-11-10T09:00 --md > recon.md
node dist/cli.js examples/ledger.csv examples/documents.csv --as-of 2026-11-10T09:00 --csv > findings.csv
```

Exit codes: `0` no findings, `1` findings (errors or warnings), `2` input error.

Example output (synthetic data, abridged):

```text
myinvois-recon: 17 ledger rows, 16 invoice numbers checked, 15 documents (1 duplicate row dropped)
As of 2026-11-10 09:00:00 MYT
Documents: 10 Valid, 1 Submitted, 2 Invalid, 2 Cancelled

Ledger invoices:
  valid                 7
  pending               1
  cancelled             1
  invalid-only          1
  missing               2
  due                   1
  void-ok               2
  void-but-valid        1
Valid totals: ledger 7950.00, e-Invoices 7923.00 (difference -27.00); booked without a Valid e-Invoice 2427.40

Consolidated e-Invoices not yet due (1):
  - CON-2611 (ledger row 17): submit by 2026-12-07 23:59:59 MYT

Findings: 14 findings (11 errors, 3 warnings)

not-submitted (1, error):
  - INV-003 (ledger row 4): no e-Invoice with internalId INV-003
...
void-but-valid (1, error):
  - INV-007 (ledger row 8): ledger marks the invoice void but document DEMO0000000000000000000007 is Valid; cancel it before 2026-11-11 10:00:00 MYT (72 h after validation), 1d01h left
...
consolidated-late (1, error):
  - CON-2610 (ledger row 16): consolidated e-Invoice for 2026-10 submitted 2026-11-08 11:00:00 MYT, 11h00m after the deadline (7 calendar days after month end)
```

### Markdown and CSV

`--md` writes the same report as Markdown (for a ticket, pull request or month-end note): a summary table,
settings, documents by status, ledger invoice states, Valid totals, consolidated e-Invoices not yet due, a count per
finding kind and a list per kind (capped by `--limit`). Abridged:

```markdown
# MyInvois reconciliation

| ledger rows | invoice numbers | duplicate ledger rows | documents | duplicate document rows dropped | findings | errors | warnings |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 17 | 16 | 1 | 15 | 1 | 14 | 11 | 3 |

Settings: as of 2026-11-10 09:00:00 MYT, amount tolerance 0.00.
...
## Findings: 14 findings (11 errors, 3 warnings)

| kind | severity | count |
| --- | --- | ---: |
| not-submitted | error | 1 |
...
### total-mismatch: 1

- **INV-002** (ledger row 3): ledger 530.00 vs e-Invoice 503.00 (difference -27.00)
```

`--csv` writes one row per finding (all of them; `--limit` does not apply) in the text report's kind order, for a
spreadsheet or another script. Columns: `kind, severity, invoice, ledger_row, uuids` (space separated),
`ledger_amount, document_amount` (decimal MYR as in `--json`; net amounts for `net-mismatch`), `deadline` (UTC ISO
instant as in `--json`; for consolidated deadlines the exclusive end, 00:00 MYT on day 8) and `detail`. Cells are
quoted per RFC 4180; text starting with `= + - @`, tab or CR gets a leading `'` so spreadsheets do not run it as a
formula (plain negative numbers are left alone). No findings = header line only.

```csv
kind,severity,invoice,ledger_row,uuids,ledger_amount,document_amount,deadline,detail
not-submitted,error,INV-003,4,,212.00,,,no e-Invoice with internalId INV-003
total-mismatch,error,INV-002,3,DEMO0000000000000000000002,530.00,503.00,,ledger 530.00 vs e-Invoice 503.00 (difference -27.00)
duplicate-valid,error,INV-010,,DEMO0000000000000000000010 DEMO0000000000000000000011,,,,2 Valid e-Invoices with the same internalId
```

Pick one of `--json`, `--md`, `--csv`, `--csv-months` (more than one is an input error, exit 2). Exit codes are the
same for every format.

### Per-month summary

`--by-month` adds a table per Malaysia-time month to the text, `--json` (`months` array, amounts as strings) and
`--md` reports; `--csv-months` prints only that table as CSV (`month, invoices, valid_invoices, ledger_total,
consolidated, consolidated_total, voided, valid_documents, valid_document_total, difference`). Without these flags
the output is unchanged.

```text
$ node dist/cli.js examples/ledger.csv examples/documents.csv --as-of 2026-11-10T09:00 --by-month
...
By month (MYT; ledger by invoice date, Valid e-Invoices by their ledger row, unbooked ones by issue date):
  month    invoices  valid  ledger total  consolidated  voided  Valid docs  e-Invoice total  difference
  2026-09         1      0       1590.00   1 / 1590.00       0           0             0.00    -1590.00
  2026-10        11      7       8787.40   1 / 3180.00       2           9          8809.00       21.60
  2026-11         1      0       2650.00   1 / 2650.00       1           1           742.00    -1908.00
```

- `invoices` / `ledger total`: booked (not void) distinct invoice numbers dated in the month, consolidated rows
  included (`consolidated` shows how many and their total); `valid` = those in state `valid`; `voided` = void rows.
- `Valid docs` / `e-Invoice total`: every Valid document of the month's ledger invoices (duplicates and documents
  of voided invoices included, so the difference shows them) plus Valid documents with no ledger row, by their
  `dateTimeIssued` month (`unknown` without one). A consolidated e-Invoice issued in early November for October
  therefore counts in October, next to its ledger row.
- `difference` = e-Invoice total - ledger total. Amounts are absolute values like the rest of the report (credit
  notes are not netted against invoices).
- With `--period` only that month is listed (plus `unknown` for unbooked documents without an issue date).

### Received (purchase) e-Invoices

`--direction received` checks the buyer side: your **AP ledger** (supplier invoices you booked) against the
e-Invoices suppliers issued to you. The ledger needs a `supplier` column with the supplier's TIN and the document
list an `issuerTin` column (the Get Recent Documents field "TIN of issuer" [2]). A document belongs to a ledger row
when `issuerTin` equals `supplier` (trimmed, case-insensitive) **and** `internalId` equals the supplier's invoice
number, so two suppliers may use the same number.

```sh
node dist/cli.js examples/ap-ledger.csv examples/received-documents.csv --direction received --as-of 2026-11-02T09:00
```

Differences to the default (issued) direction, kept conservative:
- Only `Valid` and `Cancelled` documents are used: per the SDK a receiver can only retrieve those two statuses [2].
  `Submitted` / `Invalid` rows are ignored and counted (`ignoredDocuments` in `--json`), so `pending` and
  `invalid-only` never appear.
- A booked purchase with no Valid or Cancelled e-Invoice from that supplier is `not-received` (instead of
  `not-submitted`): ask the supplier for it.
- Consolidated rows are rejected (exit 2): consolidated e-Invoices are issued by the seller, so the consolidated
  checks do not apply.
- `void-but-valid`, `cancelled-but-booked`, `rejection-requested` and `not-in-ledger` keep their rules but the
  advice is the buyer's: request rejection or ask the supplier to cancel within 72 h of validation [5], after that
  the supplier has to issue a credit / refund note [3]; a supplier e-Invoice missing from the AP ledger may be an
  unbooked purchase.
- Findings carry the supplier TIN (`supplier` in `--json`, an extra `supplier` column after `invoice` in `--csv`,
  `TIN invoice` in the text and Markdown reports).
- Assumptions: self-billed e-Invoices (which you issue yourself) belong to the default direction; the tool does not
  check whether a supplier is exempt from issuing e-Invoices.

## Input

**ledger.csv** - one row per invoice / note in your books. Header names are matched ignoring case; rename with
`--ledger-column key=Header`.

| column | required | meaning |
| --- | --- | --- |
| `invoice` | yes | your invoice number, the `internalId` you sent to MyInvois |
| `date` | yes | invoice date, `2026-10-31` (Malaysia time) |
| `total` | yes | amount including tax; sign ignored (credit notes may be negative); `1,234.50` allowed |
| `type` | no | `01`-`04`, `11`-`14`, or a name (`invoice`, `credit note`, `CN`, `self-billed invoice`, ...) |
| `net` | no | amount before tax, compared with `netAmount` |
| `status` | no | a value from `--void-values` (default `void,voided,cancelled,canceled`) marks a voided invoice |
| `consolidated` | no | `yes` for a monthly consolidated e-Invoice row; its `date` is any day of the month it covers |
| `supplier` | with `--direction received` | supplier TIN of an AP ledger row |

**documents.csv** - one row per MyInvois document, with the field names of the MyInvois document list (Get Recent
Documents / Search Documents) as header; rename with `--doc-column key=Header`.

| column | required | used for |
| --- | --- | --- |
| `uuid`, `internalId`, `status`, `total` | yes | matching, status (`Submitted` / `Valid` / `Invalid` / `Cancelled`), amount |
| `typeName` | no | type-mismatch |
| `netAmount` | no | net-mismatch |
| `dateTimeIssued` | no | `--period` filter for document-only findings |
| `dateTimeReceived`, `dateTimeValidated` | no | consolidated deadline (received, else validated, else issued), 72 h windows |
| `cancelDateTime`, `rejectRequestDateTime`, `documentStatusReason` | no | cancellation / rejection details |
| `buyerTin` | no | consolidated-buyer |
| `issuerTin` | with `--direction received` | matching (supplier TIN) |

Timestamps without a zone are read as UTC, as MyInvois returns them. Rows that repeat an earlier row exactly
(overlapping exports) are dropped and counted; the same `uuid` with different values is an input error. Row numbers
in the report count the header as row 1 (blank lines are skipped).

## Matching and findings

A document belongs to a ledger row when `internalId` equals the invoice number (exact, after trimming). Each
distinct ledger invoice number ends in exactly one state: `valid`, `pending`, `cancelled`, `invalid-only`,
`missing`, `due` (consolidated, deadline not reached), `void-ok` or `void-but-valid`. A Valid document wins over
Invalid / Cancelled attempts for the same number.

| finding | severity | rule | source |
| --- | --- | --- | --- |
| `not-submitted` | error | booked, no document with that internalId | [1] |
| `not-received` | error | (`--direction received`) booked purchase, no Valid / Cancelled e-Invoice from that supplier with that internalId | [1], [2] |
| `consolidated-overdue` | error | consolidated row, no document, deadline passed | [4] |
| `consolidated-not-valid` | error | consolidated row whose documents are only Submitted (not Valid) at or after the deadline; says whether it was received in time or how late (also reported as `pending`) | [4] |
| `invalid-only` | error | only Invalid documents | [2] |
| `cancelled-but-booked` | error | only Cancelled (and Invalid) documents, ledger not void | [2], [3] |
| `void-but-valid` | error | ledger void, Valid / Submitted document exists; shows whether the 72 h cancel window is open (else credit / refund note) | [3] |
| `total-mismatch` | error | \|ledger total\| vs document `total` differs by more than `--tolerance` | - |
| `net-mismatch` | error | \|ledger net\| vs `netAmount` (both present) | - |
| `type-mismatch` | error | ledger type vs `typeName` (both present) | - |
| `duplicate-valid` | error | two or more Valid documents with the same internalId | [1] |
| `not-in-ledger` | error | Valid / Submitted document whose internalId is not in the ledger | - |
| `consolidated-late` | error | consolidated document received at or after 00:00 MYT on day 8 of the next month | [4] |
| `consolidated-buyer` | error | consolidated document with buyer TIN other than `EI00000000010` | [4] |
| `duplicate-ledger` | error | invoice number repeated in the ledger (later rows ignored) | - |
| `pending` | warning | only Submitted documents (validation not finished) | [2] |
| `rejection-requested` | warning | buyer asked to reject a Valid document; it stays Valid until the supplier cancels | [5] |
| `cancel-outside-window` | warning | cancelled more than 72 h after validation: MyInvois should not allow this, so check timestamps / time zone | [3] |
| `reject-outside-window` | warning | rejection requested more than 72 h after validation (same) | [5] |

Sources:
1. MyInvois SDK, Submit Documents - "Mapping Internal IDs to Assigned Ones":
   https://sdk.myinvois.hasil.gov.my/einvoicingapi/02-submit-documents/
2. MyInvois SDK, Get Recent Documents (statuses and fields; not intended for reconciliation polling):
   https://sdk.myinvois.hasil.gov.my/einvoicingapi/05-get-recent-documents/
3. MyInvois SDK, Cancel Document (within 72 hours from validation, afterwards credit / debit / refund note):
   https://sdk.myinvois.hasil.gov.my/einvoicingapi/03-cancel-document/
4. IRBM e-Invoice Specific Guideline (version 4.9), para 3.6.2: consolidated e-Invoice within seven (7) calendar
   days after the month end; general public TIN `EI00000000010`:
   https://www.hasil.gov.my/wp-content/uploads/IRBM-e-Invoice-Specific-Guideline.pdf
5. MyInvois SDK, Reject Document (within 72 hours from validation; the document stays Valid until cancelled):
   https://sdk.myinvois.hasil.gov.my/einvoicingapi/04-reject-document/

`consolidated-overdue` only covers a month with no document at all and `consolidated-late` only a Valid document,
so `consolidated-not-valid` closes the gap of a consolidated e-Invoice that is stuck in Submitted past the deadline
(if it later ends Invalid, the resubmission is late).

Rules marked "-" are plain bookkeeping comparisons, not LHDN rules. Tax is not compared separately because the
document list carries no tax total; use `net` + `total` instead.

## Options

```text
--as-of <time>               evaluation time for deadlines and windows (default now); MYT unless a zone is given
--period <YYYY-MM>           only ledger rows dated in this month; document-only findings only for documents
                             issued in it
--tolerance <amount>         allowed amount difference, e.g. 0.01 (default 0)
--void-values <a,b>          ledger status values meaning voided
--ledger-column <key=Header> ledger column override (repeatable or comma list)
--doc-column <key=Header>    document column override
--direction <dir>            issued (default) or received (supplier e-Invoices vs AP ledger)
--by-month                   add the per-month summary (text, --json, --md)
--limit <n>                  findings listed per kind in the text and Markdown reports (default 50)
--json                       JSON report (amounts as decimal strings, instants as UTC ISO)
--md                         Markdown report
--csv                        CSV, one row per finding (all findings)
--csv-months                 CSV, one row per month (the --by-month summary)
```

## Library

```ts
// not published to npm; import from the build in a clone
import { readFileSync } from 'node:fs';
import { check, csvReport, jsonReport, mdReport, parseDocuments, parseLedger, textReport } from './dist/index.js';

const ledger = parseLedger(readFileSync('ledger.csv', 'utf8'));
const documents = parseDocuments(readFileSync('documents.csv', 'utf8'));
const report = check(ledger, documents, { asOf: Date.now(), toleranceCents: 1, byMonth: true });
console.log(report.summary.states, report.findings.length, report.months);
process.stdout.write(textReport(report)); // or mdReport(report, 50), csvReport(report), jsonReport(report), monthsCsv(report.months)
// purchase side: check(apLedger, receivedDocuments, { direction: 'received' })
```

`report.summary` holds the invariants used in tests: the states add up to `invoices`, and
`documentValidTotal - ledgerValidTotal` equals the sum of the `total-mismatch` differences. With `byMonth`, the
months' `invoices + voided` add up to `invoices`, their `validInvoices` to `states.valid`, and (without a period)
their `validDocuments` to the number of Valid documents.

## Limits

- Not tax or legal advice; it points at differences, a person decides what to do.
- Matching is by invoice number only; documents submitted with a different `internalId` show as `not-submitted`
  plus `not-in-ledger`.
- Received (purchase) e-Invoices need `--direction received`, an AP ledger with supplier TINs and a document list
  with `issuerTin`; one direction per run.
- Day and month boundaries are Malaysia time (UTC+08:00).

## Development

```sh
npm ci
npm run lint && npm run typecheck && npm test
npm run build && npm run smoke   # 100,000 ledger rows + 90,500 documents through the built CLI (all formats)
```

All example data is synthetic (`DEMO...` uuids, made-up invoice numbers and amounts).

## Licence

MIT
