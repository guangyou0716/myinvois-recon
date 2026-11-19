import { InputError } from './errors.js';
import type { DocumentList, EDocument, LedgerEntry } from './input.js';
import { formatMoney } from './money.js';
import { STATE_CHANGE_WINDOW_MS, consolidatedDeadline, formatHours, formatMyt, mytMonth } from './time.js';
import { GENERAL_PUBLIC_TIN } from './vocabulary.js';
import type { DocumentStatus } from './vocabulary.js';

/** Finding kinds in report order. */
export const FINDING_KINDS = [
  'not-submitted',
  'not-received',
  'consolidated-overdue',
  'consolidated-not-valid',
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

/** issued = your own sales e-Invoices vs the sales ledger (default); received = supplier e-Invoices vs the AP ledger. */
export const DIRECTIONS = ['issued', 'received'] as const;
export type Direction = (typeof DIRECTIONS)[number];

export interface Finding {
  kind: FindingKind;
  severity: 'error' | 'warning';
  /** Ledger invoice number / document internalId. */
  invoice: string;
  /** Supplier TIN (issuer TIN of the document); direction received only. */
  supplier?: string;
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
  /** issued (default): sales ledger vs your e-Invoices, matched on internalId. received: AP ledger vs supplier
   * e-Invoices, matched on supplier TIN (ledger `supplier`) = document issuerTin plus invoice = internalId; only Valid
   * and Cancelled documents are used (a receiver cannot see Submitted / Invalid ones). */
  direction?: Direction;
  /** Add a per-month summary (`months`) to the report. */
  byMonth?: boolean;
}

/** Ledger vs Valid e-Invoice totals of one MYT month. Amounts in cents. */
export interface MonthSummary {
  /** YYYY-MM (MYT), or "unknown" for Valid documents with no ledger row and no dateTimeIssued. */
  month: string;
  /** Booked (not void) distinct invoices dated in the month, consolidated rows included. */
  invoices: number;
  /** Of those, invoices in state valid. */
  validInvoices: number;
  /** Sum of |total| of the booked invoices. */
  ledgerTotal: number;
  /** Booked consolidated e-Invoice rows and their |total| sum (part of invoices / ledgerTotal). */
  consolidated: number;
  consolidatedTotal: number;
  /** Void ledger invoices dated in the month (not in invoices / ledgerTotal). */
  voided: number;
  /** Valid documents: those of the month's ledger invoices (void ones included) plus Valid documents with no ledger
   * row issued in the month. */
  validDocuments: number;
  validDocumentTotal: number;
  /** validDocumentTotal - ledgerTotal. */
  difference: number;
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
  /** Direction received only: Submitted / Invalid rows not used (a receiver only sees Valid and Cancelled). */
  ignoredDocuments?: number;
}

export interface DueItem {
  invoice: string;
  ledgerRow: number;
  deadline: number;
}

export interface Report {
  asOf: number;
  /** Only set for direction received (issued is the default and is not repeated). */
  direction?: 'received';
  period?: string;
  toleranceCents: number;
  summary: Summary;
  counts: Partial<Record<FindingKind, number>>;
  /** Consolidated e-Invoices not yet submitted whose deadline has not passed. */
  due: DueItem[];
  findings: Finding[];
  /** Per-month summary, only when requested (CheckOptions.byMonth). */
  months?: MonthSummary[];
}

const zero = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

/** Earliest instant the document reached MyInvois: received, else validated, else issued. */
const submittedAt = (d: EDocument) => d.received ?? d.validated ?? d.issued;

const byValidation = (a: EDocument, b: EDocument) => (a.validated ?? Infinity) - (b.validated ?? Infinity) || a.row - b.row;

/** Upper-cased, trimmed TIN for matching. */
const tinKey = (tin: string) => tin.trim().toUpperCase();

/**
 * Reconciles the ledger against the document list. Direction issued (default): documents are matched to ledger rows
 * by internalId = invoice number (exact, after trimming). Direction received: by issuerTin = ledger supplier TIN
 * (case-insensitive) plus internalId = invoice number, using only Valid and Cancelled documents. Pure function; reads
 * no files and no clock except the `asOf` default.
 */
export function check(ledger: readonly LedgerEntry[], list: DocumentList, options: CheckOptions = {}): Report {
  const asOf = options.asOf ?? Date.now();
  const tolerance = options.toleranceCents ?? 0;
  if (!Number.isSafeInteger(tolerance) || tolerance < 0) throw new InputError('tolerance must be a non-negative number of cents.');
  const period = options.period;
  if (period !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new InputError(`period "${period}" is not a month like 2026-10.`);
  const direction = options.direction ?? 'issued';
  if (!DIRECTIONS.includes(direction)) throw new InputError(`direction "${String(direction)}" must be issued or received.`);
  const received = direction === 'received';

  let docs = list.documents;
  let ignoredDocuments = 0;
  if (received) {
    for (const l of ledger) {
      if (l.supplier === undefined) throw new InputError(`ledger row ${l.row}: empty supplier TIN (the supplier column is required for direction received).`);
      if (l.consolidated) throw new InputError(`ledger row ${l.row}: consolidated rows do not apply to direction received (consolidated e-Invoices are issued by the seller).`);
    }
    const used = docs.filter((d) => d.status === 'Valid' || d.status === 'Cancelled');
    for (const d of used) {
      if (d.issuerTin === undefined) throw new InputError(`documents row ${d.row}: empty issuerTin (required for direction received).`);
    }
    ignoredDocuments = docs.length - used.length;
    docs = used;
  }
  const ledgerKey = (l: LedgerEntry) => (received ? `${tinKey(l.supplier!)}\u0000${l.invoice}` : l.invoice);
  const docKey = (d: EDocument) => (received ? `${tinKey(d.issuerTin!)}\u0000${d.internalId}` : d.internalId);
  const who = (supplier: string | undefined) => (received && supplier !== undefined ? { supplier: tinKey(supplier) } : {});

  const findings: Finding[] = [];
  const add = (f: Omit<Finding, 'severity' | 'uuids'> & { uuids?: string[] }) =>
    findings.push({ ...f, severity: WARNING_KINDS.includes(f.kind) ? 'warning' : 'error', uuids: f.uuids ?? [] });

  const byId = new Map<string, EDocument[]>();
  for (const d of docs) {
    const k = docKey(d);
    const group = byId.get(k);
    if (group) group.push(d);
    else byId.set(k, [d]);
  }

  const inPeriod = ledger.filter((l) => period === undefined || mytMonth(l.date) === period);
  const first = new Map<string, LedgerEntry>();
  let duplicateLedgerRows = 0;
  for (const l of inPeriod) {
    const prev = first.get(ledgerKey(l));
    if (prev) {
      duplicateLedgerRows++;
      add({ kind: 'duplicate-ledger', invoice: l.invoice, ...who(l.supplier), ledgerRow: l.row, detail: `invoice number ${received ? 'from this supplier ' : ''}already on ledger row ${prev.row}` });
    } else {
      first.set(ledgerKey(l), l);
    }
  }
  const allLedgerIds = new Set(ledger.map(ledgerKey));

  const states = zero(STATES);
  const due: DueItem[] = [];
  let ledgerValidTotal = 0;
  let documentValidTotal = 0;
  let ledgerUnmatchedTotal = 0;
  /** Final state per first ledger row (for the monthly summary). */
  const stateOf = new Map<LedgerEntry, State>();

  for (const l of first.values()) {
    const mine = (byId.get(ledgerKey(l)) ?? []).slice().sort(byValidation);
    const of = (s: DocumentStatus) => mine.filter((d) => d.status === s);
    const valid = of('Valid');
    const submitted = of('Submitted');
    const cancelled = of('Cancelled');
    const invalid = of('Invalid');
    const base = { invoice: l.invoice, ...who(l.supplier), ledgerRow: l.row };
    const amount = Math.abs(l.total);
    const set = (st: State) => {
      states[st]++;
      stateOf.set(l, st);
    };

    if (l.void) {
      const active = [...valid, ...submitted];
      if (active.length === 0) {
        set('void-ok');
        continue;
      }
      set('void-but-valid');
      const d = active[0];
      let detail = received
        ? `AP ledger marks the invoice void but the supplier's e-Invoice ${d.uuid} is ${d.status}`
        : `ledger marks the invoice void but document ${d.uuid} is ${d.status}`;
      let deadline: number | undefined;
      if (d.status === 'Valid' && d.validated !== undefined) {
        deadline = d.validated + STATE_CHANGE_WINDOW_MS;
        if (received) {
          detail +=
            asOf < deadline
              ? `; request rejection or ask the supplier to cancel it before ${formatMyt(deadline)} (72 h after validation), ${formatHours(deadline - asOf)} left`
              : `; the 72 h window closed ${formatMyt(deadline)}, the supplier has to issue a credit / refund note instead`;
        } else {
          detail +=
            asOf < deadline
              ? `; cancel it before ${formatMyt(deadline)} (72 h after validation), ${formatHours(deadline - asOf)} left`
              : `; the 72 h cancel window closed ${formatMyt(deadline)}, issue a credit / refund note instead`;
        }
      } else if (d.status === 'Submitted') {
        detail += '; cancel it within 72 h after it becomes Valid';
      } else if (received) {
        detail += '; ask the supplier to cancel it (or issue a credit / refund note after the 72 h window)';
      }
      add({ ...base, kind: 'void-but-valid', uuids: active.map((x) => x.uuid), documentAmount: d.total, ...(deadline !== undefined && { deadline }), detail });
      continue;
    }

    if (valid.length > 0) {
      set('valid');
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
        let detail = received
          ? `rejection requested at ${formatMyt(d.rejectRequested)}${d.reason ? ` ("${d.reason}")` : ''}; the e-Invoice stays Valid until the supplier cancels it`
          : `buyer requested rejection at ${formatMyt(d.rejectRequested)}${d.reason ? ` ("${d.reason}")` : ''}; the document stays Valid until cancelled`;
        if (deadline !== undefined) {
          if (received) {
            detail +=
              asOf < deadline
                ? `; the supplier can cancel it before ${formatMyt(deadline)}`
                : `; cancel window closed ${formatMyt(deadline)}, the supplier has to issue a credit / debit / refund note if a correction is needed`;
          } else {
            detail +=
              asOf < deadline
                ? `; cancel before ${formatMyt(deadline)} or agree with the buyer`
                : `; cancel window closed ${formatMyt(deadline)}, use a credit / debit / refund note if a correction is needed`;
          }
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
      set('pending');
      ledgerUnmatchedTotal += amount;
      add({ ...base, kind: 'pending', uuids: submitted.map((x) => x.uuid), detail: `e-Invoice ${submitted[0].uuid} is still Submitted (validation not finished)` });
      if (l.consolidated) {
        const deadline = consolidatedDeadline(l.date);
        if (asOf >= deadline) {
          const d = submitted[0];
          const at = submittedAt(d);
          let when = '';
          if (at !== undefined) {
            when = at >= deadline ? `; submitted ${formatMyt(at)}, ${formatHours(at - deadline)} late` : `; submitted ${formatMyt(at)} (in time) but not validated`;
          }
          add({
            ...base,
            kind: 'consolidated-not-valid',
            uuids: submitted.map((x) => x.uuid),
            ledgerAmount: amount,
            deadline,
            detail: `consolidated e-Invoice for ${mytMonth(l.date)} is still Submitted, not Valid, after the deadline ${formatMyt(deadline - 1000)}${when}; check its validation result (if it ends Invalid, the resubmission will be late)`,
          });
        }
      }
      continue;
    }
    if (cancelled.length > 0) {
      set('cancelled');
      ledgerUnmatchedTotal += amount;
      const d = cancelled[cancelled.length - 1];
      const at = `${d.cancelled !== undefined ? ` at ${formatMyt(d.cancelled)}` : ''}${d.reason ? ` ("${d.reason}")` : ''}`;
      add({
        ...base,
        kind: 'cancelled-but-booked',
        uuids: cancelled.map((x) => x.uuid),
        ledgerAmount: amount,
        detail: received
          ? `the supplier cancelled e-Invoice ${d.uuid}${at} but the AP ledger still books ${formatMoney(amount)}; get a replacement e-Invoice from the supplier or reverse the entry`
          : `e-Invoice ${d.uuid} was cancelled${at} but the ledger still books ${formatMoney(amount)}; re-issue or void the ledger entry`,
      });
      continue;
    }
    if (invalid.length > 0) {
      set('invalid-only');
      ledgerUnmatchedTotal += amount;
      add({ ...base, kind: 'invalid-only', uuids: invalid.map((x) => x.uuid), ledgerAmount: amount, detail: `${invalid.length} Invalid submission${invalid.length > 1 ? 's' : ''}, no Valid e-Invoice` });
      continue;
    }
    if (l.consolidated) {
      const deadline = consolidatedDeadline(l.date);
      if (asOf < deadline) {
        set('due');
        due.push({ invoice: l.invoice, ledgerRow: l.row, deadline });
        continue;
      }
      set('missing');
      ledgerUnmatchedTotal += amount;
      add({ ...base, kind: 'consolidated-overdue', ledgerAmount: amount, deadline, detail: `no e-Invoice for the ${mytMonth(l.date)} consolidated e-Invoice; deadline was ${formatMyt(deadline - 1000)}` });
      continue;
    }
    set('missing');
    ledgerUnmatchedTotal += amount;
    if (received) {
      add({
        ...base,
        kind: 'not-received',
        ledgerAmount: amount,
        detail: `no Valid or Cancelled e-Invoice from supplier ${tinKey(l.supplier!)} with internalId ${l.invoice}; ask the supplier for it`,
      });
    } else {
      add({ ...base, kind: 'not-submitted', ledgerAmount: amount, detail: `no e-Invoice with internalId ${l.invoice}` });
    }
  }

  const docInPeriod = (d: EDocument) => period === undefined || d.issued === undefined || mytMonth(d.issued) === period;
  for (const mine of byId.values()) {
    const valid = mine.filter((d) => d.status === 'Valid').sort(byValidation);
    if (valid.length > 1 && valid.some(docInPeriod)) {
      add({ kind: 'duplicate-valid', invoice: valid[0].internalId, ...who(valid[0].issuerTin), uuids: valid.map((d) => d.uuid), detail: `${valid.length} Valid e-Invoices with the same ${received ? 'issuer TIN and ' : ''}internalId` });
    }
  }
  for (const d of docs) {
    if (!docInPeriod(d)) continue;
    if (d.status === 'Valid' || d.status === 'Submitted') {
      if (!allLedgerIds.has(docKey(d))) {
        add({
          kind: 'not-in-ledger',
          invoice: d.internalId,
          ...who(d.issuerTin),
          uuids: [d.uuid],
          documentAmount: d.total,
          detail: received
            ? `Valid e-Invoice ${d.uuid} (${formatMoney(d.total)}) from supplier ${tinKey(d.issuerTin!)} has no AP ledger row (purchase not booked?)`
            : `${d.status} e-Invoice ${d.uuid} (${formatMoney(d.total)}) has no ledger row`,
        });
      }
    }
    if (d.validated !== undefined) {
      const end = d.validated + STATE_CHANGE_WINDOW_MS;
      if (d.cancelled !== undefined && d.cancelled > end) {
        add({ kind: 'cancel-outside-window', invoice: d.internalId, ...who(d.issuerTin), uuids: [d.uuid], detail: `cancelled ${formatHours(d.cancelled - d.validated)} after validation; MyInvois allows 72 h, check the timestamps / time zone` });
      }
      if (d.rejectRequested !== undefined && d.rejectRequested > end) {
        add({ kind: 'reject-outside-window', invoice: d.internalId, ...who(d.issuerTin), uuids: [d.uuid], detail: `rejection requested ${formatHours(d.rejectRequested - d.validated)} after validation; MyInvois allows 72 h, check the timestamps / time zone` });
      }
    }
  }

  const order = (k: FindingKind) => FINDING_KINDS.indexOf(k);
  findings.sort(
    (a, b) =>
      order(a.kind) - order(b.kind) ||
      (a.ledgerRow ?? Infinity) - (b.ledgerRow ?? Infinity) ||
      a.invoice.localeCompare(b.invoice) ||
      (a.supplier ?? '').localeCompare(b.supplier ?? ''),
  );
  const counts: Partial<Record<FindingKind, number>> = {};
  for (const f of findings) counts[f.kind] = (counts[f.kind] ?? 0) + 1;
  const documentsByStatus = zero(['Submitted', 'Valid', 'Invalid', 'Cancelled'] as const);
  for (const d of list.documents) documentsByStatus[d.status]++;
  const errors = findings.filter((f) => f.severity === 'error').length;

  let months: MonthSummary[] | undefined;
  if (options.byMonth) {
    const rows = new Map<string, MonthSummary>();
    const row = (month: string) => {
      let m = rows.get(month);
      if (!m) {
        m = { month, invoices: 0, validInvoices: 0, ledgerTotal: 0, consolidated: 0, consolidatedTotal: 0, voided: 0, validDocuments: 0, validDocumentTotal: 0, difference: 0 };
        rows.set(month, m);
      }
      return m;
    };
    for (const [key, l] of first) {
      const m = row(mytMonth(l.date));
      const amount = Math.abs(l.total);
      if (l.void) m.voided++;
      else {
        m.invoices++;
        m.ledgerTotal += amount;
        if (stateOf.get(l) === 'valid') m.validInvoices++;
        if (l.consolidated) {
          m.consolidated++;
          m.consolidatedTotal += amount;
        }
      }
      for (const d of byId.get(key) ?? []) {
        if (d.status !== 'Valid') continue;
        m.validDocuments++;
        m.validDocumentTotal += d.total;
      }
    }
    for (const d of docs) {
      if (d.status !== 'Valid' || allLedgerIds.has(docKey(d)) || !docInPeriod(d)) continue;
      const m = row(d.issued === undefined ? 'unknown' : mytMonth(d.issued));
      m.validDocuments++;
      m.validDocumentTotal += d.total;
    }
    months = [...rows.values()].sort((a, b) => (a.month === 'unknown' ? 1 : b.month === 'unknown' ? -1 : a.month.localeCompare(b.month)));
    for (const m of months) m.difference = m.validDocumentTotal - m.ledgerTotal;
  }

  return {
    asOf,
    ...(received && { direction: 'received' as const }),
    ...(period !== undefined && { period }),
    toleranceCents: tolerance,
    summary: {
      ledgerRows: ledger.length,
      ledgerRowsOutsidePeriod: ledger.length - inPeriod.length,
      invoices: first.size,
      duplicateLedgerRows,
      documents: list.documents.length,
      duplicateDocumentRows: list.duplicateRows,
      documentsByStatus,
      states,
      ledgerValidTotal,
      documentValidTotal,
      ledgerUnmatchedTotal,
      findings: findings.length,
      errors,
      warnings: findings.length - errors,
      ...(received && { ignoredDocuments }),
    },
    counts,
    due,
    findings,
    ...(months !== undefined && { months }),
  };
}
