#!/usr/bin/env node
// 1,000-user load test (design §3.8).
//
// Phase A: N students sign up and log in, spread evenly over --ramp seconds.
// Phase B: all N load their dues, create an order, pay by UPI ID and open the
//          bill, spread over --pay-ramp seconds (0 = everyone at the same
//          instant, a stress test beyond the design target).
// Then it checks the database: exactly one successful payment, with a bill,
// per student. Exits non-zero if any pass criterion fails.
//
//   node loadtest/run.mjs --url URL --anon ANON_KEY --service SERVICE_KEY \
//     [--users 1000] [--ramp 60] [--pay-ramp 60] [--concurrency 0] [--keep]
//   node loadtest/run.mjs --url URL --anon ANON_KEY --service SERVICE_KEY --cleanup-only
//
// It creates its own fee term and its own users (lt-…@loadtest.invalid) and
// deletes both afterwards unless --keep is given. --cleanup-only removes every
// leftover load-test user and term from earlier runs. Auth rate limits must be
// raised for the run because every request comes from one IP.
//
// --concurrency caps open requests on the client (0 = no cap). The local dev
// gateway (Kong, one worker) drops sockets above a few hundred connections, so
// local runs use ~200; every phase-B sequence still starts at the same moment
// and time spent waiting for a free slot counts toward the measured latency.
import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const { values: a } = parseArgs({
  options: {
    url: { type: 'string' }, anon: { type: 'string' }, service: { type: 'string' },
    users: { type: 'string', default: '1000' }, ramp: { type: 'string', default: '60' },
    'pay-ramp': { type: 'string', default: '60' },
    keep: { type: 'boolean', default: false }, timeout: { type: 'string', default: '30000' },
    concurrency: { type: 'string', default: '0' }, 'cleanup-only': { type: 'boolean', default: false },
  },
});
if (!a.url || !a.anon || !a.service) {
  console.error('usage: run.mjs --url URL --anon ANON_KEY --service SERVICE_KEY [--users N] [--ramp S] [--keep]');
  process.exit(2);
}
const N = Number(a.users);
const RAMP_MS = Number(a.ramp) * 1000;
const PAY_RAMP_MS = Number(a['pay-ramp']) * 1000;
const TIMEOUT = Number(a.timeout);
const RUN = Date.now().toString(36);
const PASSWORD = 'LoadTest#2026';
const CONCURRENCY = Number(a.concurrency);

let active = 0;
const waiting = [];
async function acquire() {
  if (!CONCURRENCY) return;
  if (active < CONCURRENCY) { active++; return; }
  await new Promise((resolve) => waiting.push(resolve));
}
function release() {
  if (!CONCURRENCY) return;
  const next = waiting.shift();
  if (next) next(); else active--;
}

// ---------- http with timing ----------

const stats = {};
function record(op, ms, ok, kind) {
  const s = (stats[op] ??= { ms: [], errors: 0, timeouts: 0, samples: [] });
  if (ok) s.ms.push(ms);
  else {
    if (kind === 'timeout') s.timeouts++;
    else s.errors++;
    if (s.samples.length < 3) s.samples.push(kind);
  }
}

async function req(op, path, { method = 'POST', token, body, key = a.anon } = {}) {
  const t0 = performance.now();
  await acquire();
  try {
    const res = await fetch(a.url + path, {
      method,
      headers: {
        apikey: key, authorization: `Bearer ${token ?? key}`, 'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const text = await res.text();
    const ms = performance.now() - t0;
    if (!res.ok) {
      record(op, ms, false, `${res.status} ${text.slice(0, 160)}`);
      return null;
    }
    record(op, ms, true);
    return text ? JSON.parse(text) : {};
  } catch (err) {
    record(op, performance.now() - t0, false,
      err.name === 'TimeoutError' ? 'timeout' : `${err.message} ${err.cause?.code ?? err.cause?.message ?? ''}`.trim());
    return null;
  } finally {
    release();
  }
}

const svc = (path, opts = {}) => req('admin', path, { ...opts, key: a.service });

// Deletes users by email prefix (not by recorded ids: a signup can succeed on
// the server after the client already gave up), then the terms.
async function cleanup(emailPrefix, termFilter) {
  const ids = [];
  for (let page = 1; ; page++) {
    const r = await svc(`/auth/v1/admin/users?page=${page}&per_page=1000`, { method: 'GET' });
    const list = r?.users ?? [];
    ids.push(...list.filter((u) => u.email?.startsWith(emailPrefix) && u.email.endsWith('@loadtest.invalid')).map((u) => u.id));
    if (list.length < 1000) break;
  }
  for (let i = 0; i < ids.length; i += 25) {
    await Promise.all(ids.slice(i, i + 25).map((id) => svc(`/auth/v1/admin/users/${id}`, { method: 'DELETE' })));
  }
  const terms = (await svc(`/rest/v1/fee_terms?${termFilter}&select=id`, { method: 'GET' })) ?? [];
  for (const t of terms) {
    await svc(`/rest/v1/orders?term_id=eq.${t.id}`, { method: 'DELETE' });
    await svc(`/rest/v1/fee_terms?id=eq.${t.id}`, { method: 'DELETE' });
  }
  const left = (await svc(`/rest/v1/fee_terms?${termFilter}&select=id`, { method: 'GET' })) ?? [];
  console.log(`cleanup: deleted ${ids.length} users and ${terms.length - left.length} term(s)` +
    (left.length ? `; ${left.length} term(s) could NOT be deleted` : ''));
  return left.length === 0;
}

if (a['cleanup-only']) {
  const ok = await cleanup('lt-', `name=like.${encodeURIComponent('Load test %')}`);
  process.exit(ok ? 0 : 1);
}

// ---------- setup ----------

const today = new Date(Date.now() + 5.5 * 3600e3);
today.setUTCDate(today.getUTCDate() + 30);
const [term] = await (await fetch(`${a.url}/rest/v1/fee_terms`, {
  method: 'POST',
  headers: {
    apikey: a.service, authorization: `Bearer ${a.service}`,
    'content-type': 'application/json', prefer: 'return=representation',
  },
  body: JSON.stringify({ name: `Load test ${RUN}`, amount_inr: 1000, due_date: today.toISOString().slice(0, 10) }),
})).json();
if (!term?.id) throw new Error('could not create load-test term (check the service key)');
console.log(`run ${RUN}: term ${term.id}, ${N} users, signup ramp ${RAMP_MS / 1000}s, pay ramp ${PAY_RAMP_MS / 1000}s`);

const users = Array.from({ length: N }, (_, i) => ({
  i,
  email: `lt-${RUN}-${i}@loadtest.invalid`,
  phone: '9' + String((Number.parseInt(RUN.slice(-4), 36) * 1000 + i) % 1e9).padStart(9, '0'),
}));

// ---------- phase A: sign up + log in, ramped ----------

const tA = performance.now();
await Promise.all(users.map(async (u) => {
  await sleep((u.i * RAMP_MS) / N);
  const s = await req('A signup', '/auth/v1/signup', {
    body: { email: u.email, password: PASSWORD, data: { full_name: `Load Test ${u.i}`, phone: u.phone } },
  });
  u.id = s?.user?.id;
  const l = await req('A login', '/auth/v1/token?grant_type=password', {
    body: { email: u.email, password: PASSWORD },
  });
  u.token = l?.access_token;
}));
const phaseA = ((performance.now() - tA) / 1000).toFixed(1);
const ready = users.filter((u) => u.token);
console.log(`phase A done in ${phaseA}s, ${ready.length}/${N} logged in`);

// ---------- phase B: everyone pays ----------

const tB = performance.now();
await Promise.all(ready.map(async (u, k) => {
  await sleep((k * PAY_RAMP_MS) / ready.length);
  const dues = await req('B my_dues', '/rest/v1/rpc/my_dues', { token: u.token, body: {} });
  if (!dues?.some((d) => d.term_id === term.id)) return;
  const [o] = (await req('B create_order', '/rest/v1/rpc/create_order', {
    token: u.token, body: { p_term_id: term.id },
  })) ?? [];
  if (!o) return;
  const [p] = (await req('B mock_upi_pay', '/rest/v1/rpc/mock_upi_pay', {
    token: u.token,
    body: { p_order_id: o.order_id, p_pay_token: o.pay_token, p_vpa: `lt${u.i}@okbank`, p_approve: true },
  })) ?? [];
  if (p?.status !== 'success') return;
  const bill = await req('B get_bill', '/rest/v1/rpc/get_bill', { token: u.token, body: { p_order_id: o.order_id } });
  u.paid = bill?.utr === p.utr && bill?.total_inr === 1000;
}));
const phaseB = ((performance.now() - tB) / 1000).toFixed(1);
console.log(`phase B done in ${phaseB}s`);

// ---------- verify in the database ----------

const rows = await svc(`/rest/v1/orders?term_id=eq.${term.id}&status=eq.success&select=student_id,utr,bill_no,total_inr`, { method: 'GET' });
const students = new Set(rows?.map((r) => r.student_id));
const verify = {
  success_orders: rows?.length ?? -1,
  distinct_students: students.size,
  all_have_bill_and_utr: !!rows?.every((r) => r.bill_no && /^\d{12}$/.test(r.utr) && r.total_inr === 1000),
  clients_saw_bill: users.filter((u) => u.paid).length,
};

// ---------- report ----------

const pct = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((x, y) => x - y);
  return Math.round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]);
};
const table = Object.entries(stats).filter(([op]) => op !== 'admin').map(([op, s]) => ({
  op, ok: s.ms.length, errors: s.errors, timeouts: s.timeouts,
  p50: pct(s.ms, 50), p95: pct(s.ms, 95), max: pct(s.ms, 100), samples: s.samples,
}));

const checks = [
  ['every request succeeded', table.every((r) => r.errors === 0 && r.timeouts === 0)],
  [`${N} successful payments, one per student`, verify.success_orders === N && verify.distinct_students === N],
  ['every payment has a 12-digit UTR and a bill', verify.all_have_bill_and_utr && verify.clients_saw_bill === N],
  ['phase B p95 < 1 s for every request type', table.filter((r) => r.op.startsWith('B')).every((r) => r.p95 != null && r.p95 < 1000)],
  ['phase A p95 < 5 s for signup and login', table.filter((r) => r.op.startsWith('A')).every((r) => r.p95 != null && r.p95 < 5000)],
];

console.log('\n| Request | OK | Errors | Timeouts | p50 ms | p95 ms | max ms |');
console.log('|---|---|---|---|---|---|---|');
for (const r of table) console.log(`| ${r.op} | ${r.ok} | ${r.errors} | ${r.timeouts} | ${r.p50} | ${r.p95} | ${r.max} |`);
for (const r of table.filter((x) => x.samples.length)) console.log(`  ${r.op} error samples:`, r.samples);
console.log(`\nPhase A ${phaseA}s, phase B ${phaseB}s. DB check:`, verify);
for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
const passed = checks.every(([, ok]) => ok);

writeFileSync(new URL(`results-${RUN}.json`, import.meta.url), JSON.stringify({
  run: RUN, url: a.url, users: N, rampSeconds: RAMP_MS / 1000, payRampSeconds: PAY_RAMP_MS / 1000,
  concurrency: CONCURRENCY,
  phaseA, phaseB, table, verify, checks, passed,
}, null, 2));

// ---------- cleanup ----------

if (!a.keep) await cleanup(`lt-${RUN}-`, `id=eq.${term.id}`);
console.log(passed ? '\nRESULT: PASS' : '\nRESULT: FAIL');
process.exit(passed ? 0 : 1);
