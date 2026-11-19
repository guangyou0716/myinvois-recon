import { InputError } from './errors.js';
import type { DocumentList, EDocument, LedgerEntry } from './input.js';
import { formatMoney } from './money.js';
import { STATE_CHANGE_WINDOW_MS, consolidatedDeadline, formatHours, formatMyt, mytMonth } from './time.js';
import { GENERAL_PUBLIC_TIN } from './vocabulary.js';
import type { DocumentStatus } from './vocabulary.js';

/** Finding kinds in report order. */
export const FINDING_KINDS = [
  'not-submitted',
  'consolidated-overdue',
  'invalid-only',
  'cancelled-but-booked',
  'void-but-valid',
  'total-mismatch',
  'net-mismatch',
  'type-mismatch',
  'duplicate-valid',
  'not-in-ledger',
  'consolidated-late',
  'consolidated-buyer',
  'duplicate-ledger',
  'pending',
  'rejection-requested',
  'cancel-outside-window',
  'reject-outside-window',
] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

/** Kinds that need a check but are not necessarily wrong. Every other kind is an error. */
export const WARNING_KINDS: readonly FindingKind[] = ['pending', 'rejection-requested', 'cancel-outside-window', 'reject-outside-window'];

/** Outcome of each distinct ledger invoice number (first row when the number repeats). */
export const STATES = ['valid', 'pending', 'cancelled', 'invalid-only', 'missing', 'due', 'void-ok', 'void-but-valid'] as const;
export type State = (typeof STATES)[number];

export interface Finding {
  kind: FindingKind;
  severity: 'error' | 'warning';
  /** Ledger invoice number / document internalId. */
  invoice: string;
  /** Ledger row (when the finding comes from the ledger side). */
  ledgerRow?: number;
  /** Document uuid(s) involved. */
  uuids: string[];
  /** Ledger amount in cents (total, or net for net-mismatch). */
  ledgerAmount?: number;
  /** Document amount in cents (total, or netAmount for net-mismatch). */
  documentAmount?: number;
  /** Deadline instant (cancel window end, consolidated deadline). */
  deadline?: number;
  detail: string;
}

export interface CheckOptions {
  /** Evaluation instant (epoch ms) for open windows and deadlines. Default: now. */
  asOf?: number;
  /** Only ledger rows dated in this MYT month (YYYY-MM); document-only checks (not-in-ledger, duplicate-valid,
   * outside-window) only for documents issued in it (documents without dateTimeIssued always count). */
  period?: string;
  /** Allowed amount difference in cents (default 0). */
  toleranceCents?: number;
}

export interface Summary {
  ledgerRows: number;
  /** Ledger rows outside --period (ignored). */
  ledgerRowsOutsidePeriod: number;
  /** Distinct invoice numbers checked (= sum of states). */
  invoices: number;
  duplicateLedgerRows: number;
  documents: number;
  duplicateDocumentRows: number;
  documentsByStatus: Record<DocumentStatus, number>;
  states: Record<State, number>;
  /** Sum of |total| of ledger invoices in state valid (cents). */
  ledgerValidTotal: number;
  /** Sum of total of the matched Valid document of those invoices (cents). */
  documentValidTotal: number;
  /** Sum of |total| of ledger invoices that are booked but have no Valid e-Invoice (pending, cancelled, invalid-only,
   * missing; due excluded) (cents). */
  ledgerUnmatchedTotal: number;
  findings: number;
  errors: number;
  warnings: number;
}

export interface DueItem {
  invoice: string;
  ledgerRow: number;
  deadline: number;
}

export interface Report {
  asOf: number;
  period?: string;
  toleranceCents: number;
  summary: Summary;
  counts: Partial<Record<FindingKind, number>>;
  /** Consolidated e-Invoices not yet submitted whose deadline has not passed. */
  due: DueItem[];
  findings: Finding[];
}

const zero = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

/** Earliest instant the document reached MyInvois: received, else validated, else issued. */
const submittedAt = (d: EDocument) => d.received ?? d.validated ?? d.issued;

const byValidation = (a: EDocument, b: EDocument) => (a.validated ?? Infinity) - (b.validated ?? Infinity) || a.row - b.row;

/**
 * Reconciles the ledger against the document list. Documents are matched to ledger rows by internalId = invoice
 * number (exact, after trimming). Pure function; reads no files and no clock except the `asOf` default.
 */
export function check(ledger: readonly LedgerEntry[], list: DocumentList, options: CheckOptions = {}): Report {
  const asOf = options.asOf ?? Date.now();
  const tolerance = options.toleranceCents ?? 0;
  if (!Number.isSafeInteger(tolerance) || tolerance < 0) throw new InputError('tolerance must be a non-negative number of cents.');
  const period = options.period;
  if (period !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new InputError(`period "${period}" is not a month like 2026-10.`);
  const docs = list.documents;

  const findings: Finding[] = [];
  const add = (f: Omit<Finding, 'severity' | 'uuids'> & { uuids?: string[] }) =>
    findings.push({ ...f, severity: WARNING_KINDS.includes(f.kind) ? 'warning' : 'error', uuids: f.uuids ?? [] });

  const byId = new Map<string, EDocument[]>();
  for (const d of docs) {
    const group = byId.get(d.internalId);
    if (group) group.push(d);
    else byId.set(d.internalId, [d]);
  }

  const inPeriod = ledger.filter((l) => period === undefined || mytMonth(l.date) === period);
  const first = new Map<string, LedgerEntry>();
  let duplicateLedgerRows = 0;
  for (const l of inPeriod) {
    const prev = first.get(l.invoice);
    if (prev) {
      duplicateLedgerRows++;
      add({ kind: 'duplicate-ledger', invoice: l.invoice, ledgerRow: l.row, detail: `invoice number already on ledger row ${prev.row}` });
    } else {
      first.set(l.invoice, l);
    }
  }
  const allLedgerIds = new Set(ledger.map((l) => l.invoice));

  const states = zero(STATES);
  const due: DueItem[] = [];
  let ledgerValidTotal = 0;
  let documentValidTotal = 0;
  let ledgerUnmatchedTotal = 0;

  for (const l of first.values()) {
    const mine = (byId.get(l.invoice) ?? []).slice().sort(byValidation);
    const of = (s: DocumentStatus) => mine.filter((d) => d.status === s);
    const valid = of('Valid');
    const submitted = of('Submitted');
    const cancelled = of('Cancelled');
    const invalid = of('Invalid');
    const base = { invoice: l.invoice, ledgerRow: l.row };
    const amount = Math.abs(l.total);

    if (l.void) {
      const active = [...valid, ...submitted];
      if (active.length === 0) {
        states['void-ok']++;
        continue;
      }
      states['void-but-valid']++;
      const d = active[0];
      let detail = `ledger marks the invoice void but document ${d.uuid} is ${d.status}`;
      let deadline: number | undefined;
      if (d.status === 'Valid' && d.validated !== undefined) {
        deadline = d.validated + STATE_CHANGE_WINDOW_MS;
        detail +=
          asOf < deadline
            ? `; cancel it before ${formatMyt(deadline)} (72 h after validation), ${formatHours(deadline - asOf)} left`
            : `; the 72 h cancel window closed ${formatMyt(deadline)}, issue a credit / refund note instead`;
      } else if (d.status === 'Submitted') {
        detail += '; cancel it within 72 h after it becomes Valid';
      }
      add({ ...base, kind: 'void-but-valid', uuids: active.map((x) => x.uuid), documentAmount: d.total, ...(deadline !== undefined && { deadline }), detail });
      continue;
    }

    if (valid.length > 0) {
      states.valid++;
      const d = valid[0];
      ledgerValidTotal += amount;
      documentValidTotal += d.total;
      if (Math.abs(amount - d.total) > tolerance) {
        add({
          ...base,
          kind: 'total-mismatch',
          uuids: [d.uuid],
          ledgerAmount: amount,
          documentAmount: d.total,
          detail: `ledger ${formatMoney(amount)} vs e-Invoice ${formatMoney(d.total)} (difference ${formatMoney(d.total - amount)})`,
        });
      }
      if (l.net !== undefined && d.net !== undefined && Math.abs(Math.abs(l.net) - d.net) > tolerance) {
        const net = Math.abs(l.net);
        add({
          ...base,
          kind: 'net-mismatch',
          uuids: [d.uuid],
          ledgerAmount: net,
          documentAmount: d.net,
          detail: `ledger net ${formatMoney(net)} vs e-Invoice netAmount ${formatMoney(d.net)} (difference ${formatMoney(d.net - net)})`,
        });
      }
      if (l.type !== undefined && d.type !== undefined && l.type !== d.type) {
        add({ ...base, kind: 'type-mismatch', uuids: [d.uuid], detail: `ledger type ${l.type} vs e-Invoice type ${d.type}` });
      }
      if (d.rejectRequested !== undefined) {
        const deadline = d.validated === undefined ? undefined : d.validated + STATE_CHANGE_WINDOW_MS;
        let detail = `buyer requested rejection at ${formatMyt(d.rejectRequested)}${d.reason ? ` ("${d.reason}")` : ''}; the document stays Valid until cancelled`;
        if (deadline !== undefined) {
          detail +=
            asOf < deadline
              ? `; cancel before ${formatMyt(deadline)} or agree with the buyer`
              : `; cancel window closed ${formatMyt(deadline)}, use a credit / debit / refund note if a correction is needed`;
        }
        add({ ...base, kind: 'rejection-requested', uuids: [d.uuid], ...(deadline !== undefined && { deadline }), detail });
      }
      if (l.consolidated) {
        const deadline = consolidatedDeadline(l.date);
        const at = submittedAt(d);
        if (at !== undefined && at >= deadline) {
          add({
            ...base,
            kind: 'consolidated-late',
            uuids: [d.uuid],
            deadline,
            detail: `consolidated e-Invoice for ${mytMonth(l.date)} submitted ${formatMyt(at)}, ${formatHours(at - deadline)} after the deadline (7 calendar days after month end)`,
          });
        }
        if (d.buyerTin !== undefined && d.buyerTin.toUpperCase() !== GENERAL_PUBLIC_TIN) {
          add({ ...base, kind: 'consolidated-buyer', uuids: [d.uuid], detail: `consolidated e-Invoice has buyer TIN ${d.buyerTin}, expected ${GENERAL_PUBLIC_TIN} (general public)` });
        }
      }
      continue;
    }

    if (submitted.length > 0) {
      states.pending++;
      ledgerUnmatchedTotal += amount;
      add({ ...base, kind: 'pending', uuids: submitted.map((x) => x.uuid), detail: `e-Invoice ${submitted[0].uuid} is still Submitted (validation not finished)` });
      continue;
    }
    if (cancelled.length > 0) {
      states.cancelled++;
      ledgerUnmatchedTotal += amount;
      const d = cancelled[cancelled.length - 1];
      add({
        ...base,
        kind: 'cancelled-but-booked',
        uuids: cancelled.map((x) => x.uuid),
        ledgerAmount: amount,
        detail: `e-Invoice ${d.uuid} was cancelled${d.cancelled !== undefined ? ` at ${formatMyt(d.cancelled)}` : ''}${d.reason ? ` ("${d.reason}")` : ''} but the ledger still books ${formatMoney(amount)}; re-issue or void the ledger entry`,
      });
      continue;
    }
    if (invalid.length > 0) {
      states['invalid-only']++;
      ledgerUnmatchedTotal += amount;
      add({ ...base, kind: 'invalid-only', uuids: invalid.map((x) => x.uuid), ledgerAmount: amount, detail: `${invalid.length} Invalid submission${invalid.length > 1 ? 's' : ''}, no Valid e-Invoice` });
      continue;
    }
    if (l.consolidated) {
      const deadline = consolidatedDeadline(l.date);
      if (asOf < deadline) {
        states.due++;
        due.push({ invoice: l.invoice, ledgerRow: l.row, deadline });
        continue;
      }
      states.missing++;
      ledgerUnmatchedTotal += amount;
      add({ ...base, kind: 'consolidated-overdue', ledgerAmount: amount, deadline, detail: `no e-Invoice for the ${mytMonth(l.date)} consolidated e-Invoice; deadline was ${formatMyt(deadline - 1000)}` });
      continue;
    }
    states.missing++;
    ledgerUnmatchedTotal += amount;
    add({ ...base, kind: 'not-submitted', ledgerAmount: amount, detail: `no e-Invoice with internalId ${l.invoice}` });
  }

  const docInPeriod = (d: EDocument) => period === undefined || d.issued === undefined || mytMonth(d.issued) === period;
  for (const [id, mine] of byId) {
    const valid = mine.filter((d) => d.status === 'Valid').sort(byValidation);
    if (valid.length > 1 && valid.some(docInPeriod)) {
      add({ kind: 'duplicate-valid', invoice: id, uuids: valid.map((d) => d.uuid), detail: `${valid.length} Valid e-Invoices with the same internalId` });
    }
  }
  for (const d of docs) {
    if (!docInPeriod(d)) continue;
    if (d.status === 'Valid' || d.status === 'Submitted') {
      if (!allLedgerIds.has(d.internalId)) {
        add({ kind: 'not-in-ledger', invoice: d.internalId, uuids: [d.uuid], documentAmount: d.total, detail: `${d.status} e-Invoice ${d.uuid} (${formatMoney(d.total)}) has no ledger row` });
      }
    }
    if (d.validated !== undefined) {
      const end = d.validated + STATE_CHANGE_WINDOW_MS;
      if (d.cancelled !== undefined && d.cancelled > end) {
        add({ kind: 'cancel-outside-window', invoice: d.internalId, uuids: [d.uuid], detail: `cancelled ${formatHours(d.cancelled - d.validated)} after validation; MyInvois allows 72 h, check the timestamps / time zone` });
      }
      if (d.rejectRequested !== undefined && d.rejectRequested > end) {
        add({ kind: 'reject-outside-window', invoice: d.internalId, uuids: [d.uuid], detail: `rejection requested ${formatHours(d.rejectRequested - d.validated)} after validation; MyInvois allows 72 h, check the timestamps / time zone` });
      }
    }
  }

  const order = (k: FindingKind) => FINDING_KINDS.indexOf(k);
  findings.sort((a, b) => order(a.kind) - order(b.kind) || (a.ledgerRow ?? Infinity) - (b.ledgerRow ?? Infinity) || a.invoice.localeCompare(b.invoice));
  const counts: Partial<Record<FindingKind, number>> = {};
  for (const f of findings) counts[f.kind] = (counts[f.kind] ?? 0) + 1;
  const documentsByStatus = zero(['Submitted', 'Valid', 'Invalid', 'Cancelled'] as const);
  for (const d of docs) documentsByStatus[d.status]++;
  const errors = findings.filter((f) => f.severity === 'error').length;

  return {
    asOf,
    ...(period !== undefined && { period }),
    toleranceCents: tolerance,
    summary: {
      ledgerRows: ledger.length,
      ledgerRowsOutsidePeriod: ledger.length - inPeriod.length,
      invoices: first.size,
      duplicateLedgerRows,
      documents: docs.length,
      duplicateDocumentRows: list.duplicateRows,
      documentsByStatus,
      states,
      ledgerValidTotal,
      documentValidTotal,
      ledgerUnmatchedTotal,
      findings: findings.length,
      errors,
      warnings: findings.length - errors,
    },
    counts,
    due,
    findings,
  };
}
