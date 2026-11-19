import { FINDING_KINDS, STATES } from './check.js';
import type { Finding, Report } from './check.js';
import { formatMoney } from './money.js';
import { formatMyt } from './time.js';

const iso = (ms: number) => new Date(ms).toISOString();

function jsonFinding(f: Finding) {
  return {
    kind: f.kind,
    severity: f.severity,
    invoice: f.invoice,
    ...(f.ledgerRow !== undefined && { ledgerRow: f.ledgerRow }),
    uuids: f.uuids,
    ...(f.ledgerAmount !== undefined && { ledgerAmount: formatMoney(f.ledgerAmount) }),
    ...(f.documentAmount !== undefined && { documentAmount: formatMoney(f.documentAmount) }),
    ...(f.deadline !== undefined && { deadline: iso(f.deadline) }),
    detail: f.detail,
  };
}

/** JSON report: amounts as decimal strings (MYR), instants as UTC ISO strings. */
export function jsonReport(r: Report): string {
  const s = r.summary;
  const out = {
    tool: 'myinvois-recon',
    asOf: iso(r.asOf),
    ...(r.period !== undefined && { period: r.period }),
    tolerance: formatMoney(r.toleranceCents),
    summary: {
      ...s,
      ledgerValidTotal: formatMoney(s.ledgerValidTotal),
      documentValidTotal: formatMoney(s.documentValidTotal),
      ledgerUnmatchedTotal: formatMoney(s.ledgerUnmatchedTotal),
    },
    counts: r.counts,
    due: r.due.map((d) => ({ invoice: d.invoice, ledgerRow: d.ledgerRow, deadline: iso(d.deadline) })),
    findings: r.findings.map(jsonFinding),
  };
  return JSON.stringify(out, null, 2) + '\n';
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Human-readable report; at most `limit` findings listed per kind. */
export function textReport(r: Report, limit = 50): string {
  const s = r.summary;
  const L: string[] = [];
  let head = `myinvois-recon: ${plural(s.ledgerRows, 'ledger row')}`;
  if (r.period !== undefined) head += ` (period ${r.period}, ${s.ledgerRowsOutsidePeriod} outside)`;
  head += `, ${s.invoices} invoice numbers checked, ${plural(s.documents, 'document')}`;
  if (s.duplicateDocumentRows) head += ` (${plural(s.duplicateDocumentRows, 'duplicate row')} dropped)`;
  L.push(head);
  L.push(`As of ${formatMyt(r.asOf)}${r.toleranceCents ? `, amount tolerance ${formatMoney(r.toleranceCents)}` : ''}`);
  const st = s.documentsByStatus;
  L.push(`Documents: ${st.Valid} Valid, ${st.Submitted} Submitted, ${st.Invalid} Invalid, ${st.Cancelled} Cancelled`);
  L.push('');
  L.push('Ledger invoices:');
  for (const k of STATES) L.push(`  ${k.padEnd(16)} ${String(s.states[k]).padStart(6)}`);
  L.push(
    `Valid totals: ledger ${formatMoney(s.ledgerValidTotal)}, e-Invoices ${formatMoney(s.documentValidTotal)} (difference ${formatMoney(s.documentValidTotal - s.ledgerValidTotal)}); booked without a Valid e-Invoice ${formatMoney(s.ledgerUnmatchedTotal)}`,
  );
  if (r.due.length) {
    L.push('');
    L.push(`Consolidated e-Invoices not yet due (${r.due.length}):`);
    for (const d of r.due.slice(0, limit)) L.push(`  - ${d.invoice} (ledger row ${d.ledgerRow}): submit by ${formatMyt(d.deadline - 1000)}`);
    if (r.due.length > limit) L.push(`  ... ${r.due.length - limit} more`);
  }
  L.push('');
  if (r.findings.length === 0) {
    L.push('No findings.');
    return L.join('\n') + '\n';
  }
  L.push(`Findings: ${plural(s.findings, 'finding')} (${plural(s.errors, 'error')}, ${plural(s.warnings, 'warning')})`);
  for (const kind of FINDING_KINDS) {
    const list = r.findings.filter((f) => f.kind === kind);
    if (!list.length) continue;
    L.push('');
    L.push(`${kind} (${list.length}, ${list[0].severity}):`);
    for (const f of list.slice(0, limit)) {
      const where = f.ledgerRow !== undefined ? ` (ledger row ${f.ledgerRow})` : '';
      L.push(`  - ${f.invoice}${where}: ${f.detail}`);
    }
    if (list.length > limit) L.push(`  ... ${list.length - limit} more (see --json)`);
  }
  return L.join('\n') + '\n';
}
