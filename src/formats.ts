import { FINDING_KINDS, STATES, WARNING_KINDS } from './check.js';
import type { Finding, MonthSummary, Report } from './check.js';
import { formatMoney } from './money.js';
import { label } from './report.js';
import { formatMyt } from './time.js';
import type { DocumentStatus } from './vocabulary.js';

/** Document statuses in the text report's order. */
const STATUS_ORDER: readonly DocumentStatus[] = ['Valid', 'Submitted', 'Invalid', 'Cancelled'];

type Cell = string | number | null | undefined;

/**
 * One CSV cell (RFC 4180): quoted when it holds a quote, comma or line break. Cells starting with = + - @ tab or CR
 * get a leading ' so spreadsheets do not run them as formulas; plain numbers such as -27.00 are left as they are.
 */
export function csvCell(v: Cell): string {
  let s = v === undefined || v === null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const csvLine = (cells: Cell[]) => cells.map(csvCell).join(',');

/** Markdown table / list text: backslashes and pipes escaped, line breaks flattened. */
export const mdCell = (v: string | number) => String(v).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r\n|\r|\n/g, ' ');

export const CSV_HEADER = ['kind', 'severity', 'invoice', 'ledger_row', 'uuids', 'ledger_amount', 'document_amount', 'deadline', 'detail'];

const money = (c: number | undefined) => (c === undefined ? undefined : formatMoney(c));
const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());

/** Findings in report kind order (stable within a kind). */
const byKind = (findings: readonly Finding[]) => [...findings].sort((a, b) => FINDING_KINDS.indexOf(a.kind) - FINDING_KINDS.indexOf(b.kind));

/**
 * Findings as CSV, one row per finding (all of them, --limit is ignored), in the text report's kind order. Amounts
 * are decimal MYR like --json (ledger_amount is the net amount for net-mismatch); uuids are space separated; deadline
 * is the same UTC ISO instant as in --json (consolidated deadlines are the exclusive end, 00:00 MYT on day 8). Empty
 * cells where a finding has no such value. No findings = header only.
 */
export function csvReport(r: Report): string {
  const received = r.direction === 'received';
  const header = received ? [...CSV_HEADER.slice(0, 3), 'supplier', ...CSV_HEADER.slice(3)] : CSV_HEADER;
  const lines = [csvLine(header)];
  for (const f of byKind(r.findings)) {
    const who: Cell[] = received ? [f.invoice, f.supplier] : [f.invoice];
    lines.push(
      csvLine([f.kind, f.severity, ...who, f.ledgerRow, f.uuids.join(' '), money(f.ledgerAmount), money(f.documentAmount), iso(f.deadline), f.detail]),
    );
  }
  return lines.join('\n') + '\n';
}

export const MONTH_CSV_HEADER = [
  'month',
  'invoices',
  'valid_invoices',
  'ledger_total',
  'consolidated',
  'consolidated_total',
  'voided',
  'valid_documents',
  'valid_document_total',
  'difference',
];

/** Per-month summary as CSV (one row per month, amounts decimal MYR). A report without months gives the header only. */
export function monthsCsv(months: readonly MonthSummary[] | undefined): string {
  const lines = [csvLine(MONTH_CSV_HEADER)];
  for (const m of months ?? []) {
    lines.push(
      csvLine([
        m.month,
        m.invoices,
        m.validInvoices,
        formatMoney(m.ledgerTotal),
        m.consolidated,
        formatMoney(m.consolidatedTotal),
        m.voided,
        m.validDocuments,
        formatMoney(m.validDocumentTotal),
        formatMoney(m.difference),
      ]),
    );
  }
  return lines.join('\n') + '\n';
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const more = (n: number) => `- ... ${n} more (use --json or --csv for all, or a higher --limit)`;

/**
 * Markdown report: summary, settings, documents by status, ledger invoice states, Valid totals, consolidated
 * e-Invoices not yet due and findings per kind (each list capped at `limit`, like the text report).
 */
export function mdReport(r: Report, limit = 50): string {
  const s = r.summary;
  const settings = [`as of ${formatMyt(r.asOf)}`];
  if (r.period !== undefined) settings.push(`period ${r.period} (${plural(s.ledgerRowsOutsidePeriod, 'ledger row')} outside ignored)`);
  settings.push(`amount tolerance ${formatMoney(r.toleranceCents)}`);
  if (r.direction === 'received') settings.push('direction received (supplier e-Invoices vs AP ledger, matched on issuer TIN + internalId)');
  if (s.ignoredDocuments) settings.push(`${plural(s.ignoredDocuments, 'Submitted / Invalid document')} ignored (a receiver only sees Valid and Cancelled)`);
  const out = [
    '# MyInvois reconciliation',
    '',
    '| ledger rows | invoice numbers | duplicate ledger rows | documents | duplicate document rows dropped | findings | errors | warnings |',
    '| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    `| ${s.ledgerRows} | ${s.invoices} | ${s.duplicateLedgerRows} | ${s.documents} | ${s.duplicateDocumentRows} | ${s.findings} | ${s.errors} | ${s.warnings} |`,
    '',
    `Settings: ${settings.join(', ')}.`,
    '',
    '## Documents',
    '',
    `| ${STATUS_ORDER.join(' | ')} |`,
    `|${' ---: |'.repeat(STATUS_ORDER.length)}`,
    `| ${STATUS_ORDER.map((k) => s.documentsByStatus[k]).join(' | ')} |`,
    '',
    '## Ledger invoices',
    '',
    '| state | invoices |',
    '| --- | ---: |',
    ...STATES.map((k) => `| ${k} | ${s.states[k]} |`),
    '',
    `Valid totals: ledger ${formatMoney(s.ledgerValidTotal)}, e-Invoices ${formatMoney(s.documentValidTotal)} (difference ${formatMoney(s.documentValidTotal - s.ledgerValidTotal)}); booked without a Valid e-Invoice ${formatMoney(s.ledgerUnmatchedTotal)}.`,
  ];

  if (r.months !== undefined) {
    out.push(
      '',
      '## By month (MYT)',
      '',
      'Ledger by invoice date; Valid e-Invoices by their ledger row, unbooked ones by issue date.',
      '',
      '| month | invoices | valid | ledger total | consolidated | consolidated total | voided | Valid docs | e-Invoice total | difference |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    );
    for (const m of r.months) {
      out.push(
        `| ${m.month} | ${m.invoices} | ${m.validInvoices} | ${formatMoney(m.ledgerTotal)} | ${m.consolidated} | ${formatMoney(m.consolidatedTotal)} | ${m.voided} | ${m.validDocuments} | ${formatMoney(m.validDocumentTotal)} | ${formatMoney(m.difference)} |`,
      );
    }
  }
  if (r.due.length) {
    out.push('', `## Consolidated e-Invoices not yet due: ${r.due.length}`, '', '| invoice | ledger row | submit by |', '| --- | ---: | --- |');
    for (const d of r.due.slice(0, limit)) out.push(`| ${mdCell(d.invoice)} | ${d.ledgerRow} | ${formatMyt(d.deadline - 1000)} |`);
    if (r.due.length > limit) out.push('', more(r.due.length - limit));
  }

  if (!r.findings.length) {
    out.push('', 'No findings.');
    return out.join('\n') + '\n';
  }
  out.push('', `## Findings: ${plural(s.findings, 'finding')} (${plural(s.errors, 'error')}, ${plural(s.warnings, 'warning')})`, '');
  out.push('| kind | severity | count |', '| --- | --- | ---: |');
  for (const kind of FINDING_KINDS) {
    if (r.counts[kind]) out.push(`| ${kind} | ${WARNING_KINDS.includes(kind) ? 'warning' : 'error'} | ${r.counts[kind]} |`);
  }
  for (const kind of FINDING_KINDS) {
    const list = r.findings.filter((f) => f.kind === kind);
    if (!list.length) continue;
    out.push('', `### ${kind}: ${list.length}`, '');
    for (const f of list.slice(0, limit)) {
      const where = f.ledgerRow !== undefined ? ` (ledger row ${f.ledgerRow})` : '';
      out.push(`- **${mdCell(label(f))}**${where}: ${mdCell(f.detail)}`);
    }
    if (list.length > limit) out.push(more(list.length - limit));
  }
  return out.join('\n') + '\n';
}
