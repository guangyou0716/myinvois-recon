/** e-Invoice types (MyInvois SDK e-Invoice Types code table) by code. */
export const DOCUMENT_TYPES = {
  '01': 'invoice',
  '02': 'credit-note',
  '03': 'debit-note',
  '04': 'refund-note',
  '11': 'self-billed-invoice',
  '12': 'self-billed-credit-note',
  '13': 'self-billed-debit-note',
  '14': 'self-billed-refund-note',
} as const;

export type DocumentType = (typeof DOCUMENT_TYPES)[keyof typeof DOCUMENT_TYPES];

const SHORT: Record<string, DocumentType> = {
  inv: 'invoice',
  cn: 'credit-note',
  dn: 'debit-note',
  rn: 'refund-note',
};

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Normalises a document type given as a code (01, 2), a name in any spelling ("Credit Note", credit_note,
 * self-billed invoice) or a short form (INV, CN, DN, RN). Returns undefined when it is not recognised.
 */
export function normaliseType(text: string): DocumentType | undefined {
  const t = text.trim();
  if (/^\d{1,2}$/.test(t)) return DOCUMENT_TYPES[t.padStart(2, '0') as keyof typeof DOCUMENT_TYPES];
  const s = squash(t);
  if (SHORT[s]) return SHORT[s];
  return Object.values(DOCUMENT_TYPES).find((name) => squash(name) === s);
}

/** Document statuses in MyInvois (Get Recent Documents / Search Documents). */
export const DOCUMENT_STATUSES = ['Submitted', 'Valid', 'Invalid', 'Cancelled'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/** Normalises a status ignoring case; "canceled" is accepted. Undefined when it is not one of the four. */
export function normaliseStatus(text: string): DocumentStatus | undefined {
  const s = squash(text);
  if (s === 'canceled') return 'Cancelled';
  return DOCUMENT_STATUSES.find((v) => v.toLowerCase() === s);
}

/** TIN for the general public buyer used on consolidated e-Invoices (IRBM e-Invoice Specific Guideline). */
export const GENERAL_PUBLIC_TIN = 'EI00000000010';
