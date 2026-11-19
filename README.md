# myinvois-recon

[![CI](https://github.com/guangyou0716/myinvois-recon/actions/workflows/ci.yml/badge.svg)](https://github.com/guangyou0716/myinvois-recon/actions/workflows/ci.yml)

Offline month-end check for Malaysian e-Invoicing: compares your **sales ledger** (ERP / accounting export) with
your **MyInvois document list** and lists every invoice where the two disagree.

- booked in the ledger but never validated by MyInvois (no document, only Invalid attempts, still Submitted);
- cancelled in MyInvois (or the buyer asked for rejection) while the ledger still books the sale;
- voided in the ledger while a Valid e-Invoice still exists, with the 72-hour cancel window still open or closed;
- different total / net amount or document type; the same invoice number validated twice; a Valid e-Invoice with
  no ledger row;
- the monthly consolidated e-Invoice submitted after its deadline (7 calendar days after month end), or not at all.

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

Pick one of `--json`, `--md`, `--csv` (more than one is an input error, exit 2). Exit codes are the same for every
format.

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
| `consolidated-overdue` | error | consolidated row, no document, deadline passed | [4] |
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
--limit <n>                  findings listed per kind in the text and Markdown reports (default 50)
--json                       JSON report (amounts as decimal strings, instants as UTC ISO)
--md                         Markdown report
--csv                        CSV, one row per finding (all findings)
```

## Library

```ts
// not published to npm; import from the build in a clone
import { readFileSync } from 'node:fs';
import { check, csvReport, jsonReport, mdReport, parseDocuments, parseLedger, textReport } from './dist/index.js';

const ledger = parseLedger(readFileSync('ledger.csv', 'utf8'));
const documents = parseDocuments(readFileSync('documents.csv', 'utf8'));
const report = check(ledger, documents, { asOf: Date.now(), toleranceCents: 1 });
console.log(report.summary.states, report.findings.length);
process.stdout.write(textReport(report)); // or mdReport(report, 50), csvReport(report), jsonReport(report)
```

`report.summary` holds the invariants used in tests: the states add up to `invoices`, and
`documentValidTotal - ledgerValidTotal` equals the sum of the `total-mismatch` differences.

## Limits

- Not tax or legal advice; it points at differences, a person decides what to do.
- Matching is by invoice number only; documents submitted with a different `internalId` show as `not-submitted`
  plus `not-in-ledger`.
- Received (purchase) e-Invoices are out of scope for now; give it the documents you issued.
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
