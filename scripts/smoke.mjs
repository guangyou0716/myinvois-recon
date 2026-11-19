#!/usr/bin/env node
// Smoke run on a synthetic 100,000-row ledger and a 90,500-row document list. Needs `npm run build` first.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'myinvois-recon-smoke-'));
const fail = (msg) => {
  console.error(`smoke: FAIL ${msg}`);
  process.exit(1);
};
const run = (args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });

const N = 100_000;
const EXTRA = 500;
const money = (c) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;
const ledger = ['invoice,date,total'];
const docs = ['uuid,internalId,status,total,dateTimeIssued,dateTimeValidated'];
// i % 10: 0-6 Valid (i % 1000 === 1 has a 1-cent difference), 7 Submitted, 8 Cancelled, 9 no document.
const STATUS = ['Valid', 'Valid', 'Valid', 'Valid', 'Valid', 'Valid', 'Valid', 'Submitted', 'Cancelled'];
let ledgerCents = 0;
let validCents = 0;
for (let i = 0; i < N; i++) {
  const inv = `INV-${String(i).padStart(6, '0')}`;
  const day = String(1 + (i % 28)).padStart(2, '0');
  const cents = 1000 + (i % 50_000);
  ledger.push(`${inv},2026-10-${day},${money(cents)}`);
  ledgerCents += cents;
  const k = i % 10;
  if (k < 9) {
    const total = i % 1000 === 1 ? cents + 1 : cents;
    if (STATUS[k] === 'Valid') validCents += total;
    const validated = STATUS[k] === 'Submitted' ? '' : `2026-10-${day}T03:00:00Z`;
    docs.push(`U${String(i).padStart(25, '0')},${inv},${STATUS[k]},${money(total)},2026-10-${day}T02:00:00Z,${validated}`);
  }
}
for (let j = 0; j < EXTRA; j++) docs.push(`X${String(j).padStart(25, '0')},EXTRA-${j},Valid,1.00,2026-10-15T02:00:00Z,2026-10-15T03:00:00Z`);
const ledgerFile = join(dir, 'ledger.csv');
const docsFile = join(dir, 'documents.csv');
writeFileSync(ledgerFile, ledger.join('\n') + '\n');
writeFileSync(docsFile, docs.join('\n') + '\n');

const t1 = Date.now();
const r = run([ledgerFile, docsFile, '--as-of', '2026-11-20', '--json']);
const ms = Date.now() - t1;
const d = r.stdout ? JSON.parse(r.stdout) : {};
const expected = {
  valid: 70_000,
  pending: 10_000,
  cancelled: 10_000,
  'invalid-only': 0,
  missing: 10_000,
  due: 0,
  'void-ok': 0,
  'void-but-valid': 0,
};
const counts = { 'not-submitted': 10_000, 'cancelled-but-booked': 10_000, 'total-mismatch': 100, 'not-in-ledger': EXTRA, pending: 10_000 };
if (
  r.status !== 1 ||
  d.summary?.ledgerRows !== N ||
  d.summary?.invoices !== N ||
  d.summary?.documents !== 90_000 + EXTRA ||
  JSON.stringify(d.summary?.states) !== JSON.stringify(expected) ||
  JSON.stringify(d.counts) !== JSON.stringify(counts) ||
  d.findings?.length !== 30_600 ||
  d.summary?.errors !== 20_600 ||
  d.summary?.warnings !== 10_000
) {
  fail(`json: status ${r.status} ${JSON.stringify(d.summary)} ${JSON.stringify(d.counts)} ${r.stderr}`);
}
const t2 = Date.now();
const t = run([ledgerFile, docsFile, '--as-of', '2026-11-20']);
const ms2 = Date.now() - t2;
if (t.status !== 1 || !t.stdout.includes('Findings: 30600 findings (20600 errors, 10000 warnings)')) fail(`text: status ${t.status} ${t.stderr}`);
const t3 = Date.now();
const c = run([ledgerFile, docsFile, '--as-of', '2026-11-20', '--csv']);
const ms3 = Date.now() - t3;
const csvLines = c.stdout.trimEnd().split('\n');
if (c.status !== 1 || csvLines.length !== 30_601 || csvLines[0] !== 'kind,severity,invoice,ledger_row,uuids,ledger_amount,document_amount,deadline,detail') {
  fail(`csv: status ${c.status}, ${csvLines.length} lines ${c.stderr}`);
}
const t4 = Date.now();
const m = run([ledgerFile, docsFile, '--as-of', '2026-11-20', '--md']);
const ms4 = Date.now() - t4;
if (m.status !== 1 || !m.stdout.includes('## Findings: 30600 findings (20600 errors, 10000 warnings)')) fail(`md: status ${m.status} ${m.stderr}`);
const t5 = Date.now();
const mo = run([ledgerFile, docsFile, '--as-of', '2026-11-20', '--csv-months']);
const ms5 = Date.now() - t5;
validCents += EXTRA * 100;
const monthLine = `2026-10,${N},70000,${money(ledgerCents)},0,0.00,0,${70_000 + EXTRA},${money(validCents)},${validCents >= ledgerCents ? '' : '-'}${money(Math.abs(validCents - ledgerCents))}`;
if (mo.status !== 1 || mo.stdout.trimEnd().split('\n')[1] !== monthLine) fail(`csv-months: status ${mo.status} ${JSON.stringify(mo.stdout)} expected ${monthLine} ${mo.stderr}`);
if (ms > 20_000 || ms2 > 20_000 || ms3 > 20_000 || ms4 > 20_000 || ms5 > 20_000) fail(`too slow: json ${ms} ms, text ${ms2} ms, csv ${ms3} ms, md ${ms4} ms, csv-months ${ms5} ms`);
console.log(`smoke: OK ${N} ledger rows, ${90_000 + EXTRA} documents; json ${ms} ms, text ${ms2} ms, csv ${ms3} ms, md ${ms4} ms, csv-months ${ms5} ms`);
