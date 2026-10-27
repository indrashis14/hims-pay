import { adminClient, call } from './supa.js';
import { page, $, el, inr, istDate, istDateTime, showAlert, busy, friendlyError, statusChip } from './ui.js';

page({ wide: true });
const sb = adminClient();
const PAGE = 50;
let terms = [];
let termId = null;
let currentTab = 'overview';

const STATUS = {
  paid: ['Paid', 'ok'],
  paid_late: ['Paid late', 'ok'],
  unpaid: ['Not paid', 'neutral'],
  fine_window: ['In fine window', 'warn'],
  blocked: ['Blocked', 'danger'],
};
const chipFor = (s) => statusChip(...(STATUS[s] ?? [s, 'neutral']));
const termById = (id) => terms.find((t) => t.id === id);
const say = (kind, text) => showAlert($('#msg'), kind, text);

// ---------- auth ----------

async function boot() {
  const { data } = await sb.auth.getSession();
  if (data.session) {
    const me = await call(sb, 'whoami').catch(() => ({ role: 'none' }));
    if (me.role === 'admin') return startApp();
    await sb.auth.signOut({ scope: 'local' });
  }
  $('#login').classList.remove('hidden');
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  busy($('#loginBtn'), true, 'Logging in…');
  try {
    const { error } = await sb.auth.signInWithPassword({
      email: $('#email').value.trim().toLowerCase(), password: $('#password').value,
    });
    if (error) throw error;
    const me = await call(sb, 'whoami');
    if (me.role !== 'admin') {
      await sb.auth.signOut({ scope: 'local' });
      throw new Error('This is not an admin account.');
    }
    $('#login').classList.add('hidden');
    await startApp();
  } catch (err) {
    showAlert($('#loginMsg'), 'error', err.message === 'This is not an admin account.' ? err.message : friendlyError(err));
  } finally {
    busy($('#loginBtn'), false);
  }
});

async function startApp() {
  const out = el('button', { class: 'btn secondary small', type: 'button' }, 'Log out');
  out.addEventListener('click', async () => { await sb.auth.signOut({ scope: 'local' }); location.reload(); });
  $('#who').replaceChildren(out);
  $('#app').classList.remove('hidden');
  await loadTerms();
  for (const b of document.querySelectorAll('[data-tab]')) b.addEventListener('click', () => selectTab(b.dataset.tab));
  $('#term').addEventListener('change', () => { termId = Number($('#term').value); selectTab(currentTab); });
  selectTab('overview');
}

async function loadTerms() {
  terms = await call(sb, 'admin_terms');
  if (!termById(termId)) termId = terms[0]?.id ?? null;
  $('#term').replaceChildren(...terms.map((t, i) => el('option', { value: t.id, selected: t.id === termId },
    `${t.name} — due ${istDate(t.due_date)}${i === 0 ? ' (active)' : ''}`)));
}

function selectTab(tab) {
  currentTab = tab;
  for (const b of document.querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  say('info', '');
  $('#panel').replaceChildren(el('p', { class: 'muted' }, 'Loading…'));
  const render = { overview, students, payments, termsTab, outbox }[tab === 'terms' ? 'termsTab' : tab];
  render().catch((err) => { $('#panel').replaceChildren(); say('error', friendlyError(err)); });
}

// ---------- helpers ----------

function table(headers, rows) {
  return el('div', { class: 'table-wrap' }, el('table', { class: 'data' },
    el('thead', {}, el('tr', {}, headers.map(([h, num]) => el('th', { class: num ? 'num' : null }, h)))),
    el('tbody', {}, rows.length ? rows : el('tr', {}, el('td', { colspan: headers.length, class: 'muted' }, 'Nothing to show.')))));
}
const td = (v, cls) => el('td', { class: cls }, v ?? '');

function pager(offset, total, go) {
  const prev = el('button', { class: 'btn secondary small', type: 'button', disabled: offset === 0 }, '← Prev');
  const next = el('button', { class: 'btn secondary small', type: 'button', disabled: offset + PAGE >= total }, 'Next →');
  prev.addEventListener('click', () => go(Math.max(0, offset - PAGE)));
  next.addEventListener('click', () => go(offset + PAGE));
  const shown = total ? `${offset + 1}–${Math.min(offset + PAGE, total)} of ${total}` : '0 results';
  return el('div', { class: 'pager' }, el('span', { class: 'small muted' }, shown), prev, next);
}

// Spreadsheet apps run cells starting with = + - @ as formulas; neutralise them.
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function download(filename, header, rows) {
  const text = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }));
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
// The Data API returns at most 1,000 rows per call, so page until total_count.
async function fetchAll(fn, args) {
  const out = [];
  for (;;) {
    const rows = await call(sb, fn, { ...args, p_limit: 1000, p_offset: out.length });
    out.push(...rows);
    if (!rows.length || out.length >= Number(rows[0].total_count)) return out;
  }
}
const billLink = (orderId, text) => (orderId ? el('a', { href: `../bill.html?order=${orderId}&admin=1` }, text) : '');

// ---------- overview ----------

function tile(label, value, sub) {
  return el('div', { class: 'tile' }, el('div', { class: 'label' }, label), el('div', { class: 'value' }, value),
    sub ? el('div', { class: 'sub' }, sub) : null);
}

function chart(perDay) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = (tag, attrs, text) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text != null) n.textContent = text;
    return n;
  };
  if (!perDay.length) return el('p', { class: 'muted' }, 'No payments yet for this term.');
  const W = 820, H = 230, padL = 70, padB = 28, padT = 12;
  const max = Math.max(...perDay.map((d) => Number(d.amount)));
  const bw = Math.min(48, (W - padL - 10) / perDay.length - 4);
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Amount collected per day' });
  root.append(svg('line', { class: 'axis', x1: padL, y1: H - padB, x2: W, y2: H - padB }));
  for (const f of [0, 0.5, 1]) {
    const y = H - padB - f * (H - padB - padT);
    root.append(svg('text', { x: padL - 6, y: y + 4, 'text-anchor': 'end' }, inr(Math.round(max * f))));
  }
  const step = Math.ceil(perDay.length / 12);
  perDay.forEach((d, i) => {
    const h = (Number(d.amount) / max) * (H - padB - padT);
    const x = padL + 6 + i * ((W - padL - 10) / perDay.length);
    const bar = svg('rect', { class: 'bar', x, y: H - padB - h, width: bw, height: Math.max(h, 1), rx: 3 });
    bar.append(svg('title', {}, `${istDate(d.day)}: ${inr(d.amount)} from ${d.count} payment${d.count > 1 ? 's' : ''}`));
    root.append(bar);
    if (i % step === 0) {
      root.append(svg('text', { x: x + bw / 2, y: H - 8, 'text-anchor': 'middle' },
        istDate(d.day).replace(/ \d{4}$/, '')));
    }
  });
  return el('div', { class: 'chart' }, root);
}

async function overview() {
  if (!termId) return $('#panel').replaceChildren(el('p', {}, 'Create a fee term to get started (Fee terms tab).'));
  const st = await call(sb, 'admin_stats', { p_term_id: termId });
  $('#panel').replaceChildren(
    el('div', { class: 'tiles' },
      tile('Students owing this term', st.registered),
      tile('Paid', st.paid, `${st.paid_on_time} on time · ${st.paid_late} late`),
      tile('Not paid', st.unpaid, `${st.in_fine_window} in fine window · ${st.blocked} blocked`),
      tile('Collected', inr(st.collected_total), `${inr(st.collected_base)} fees + ${inr(st.collected_fine)} fines`),
      tile('Fee per student', inr(st.term.amount_inr), `Last date ${istDate(st.term.due_date)}`)),
    el('div', { class: 'card' }, el('h2', {}, 'Collected per day (IST)'), chart(st.per_day)));
}

// ---------- students ----------

let stuState = { filter: 'all', search: '', offset: 0 };

async function students() {
  const filter = el('select', { 'aria-label': 'Filter' },
    [['all', 'All students'], ['paid', 'Paid'], ['unpaid', 'Not paid'], ['paid_late', 'Paid late'],
      ['fine_window', 'In fine window'], ['blocked', 'Blocked']]
      .map(([v, t]) => el('option', { value: v, selected: v === stuState.filter }, t)));
  const search = el('input', { type: 'search', placeholder: 'Search name, mobile, email, ID', value: stuState.search });
  const csv = el('button', { class: 'btn secondary small', type: 'button' }, 'Export CSV');
  const body = el('div');
  $('#panel').replaceChildren(el('div', { class: 'toolbar' }, filter, search, csv), body);

  const load = async (offset) => {
    stuState = { filter: filter.value, search: search.value.trim(), offset };
    const rows = await call(sb, 'admin_students', {
      p_term_id: termId, p_filter: stuState.filter, p_search: stuState.search, p_limit: PAGE, p_offset: offset,
    });
    const total = Number(rows[0]?.total_count ?? 0);
    body.replaceChildren(table(
      [['Name'], ['Mobile'], ['Email'], ['Student ID'], ['Status'], ['Days late', 1], ['Fine', 1],
        ['Amount', 1], ['Paid on'], ['UPI txn ID'], ['Bill'], ['']],
      rows.map((r) => {
        let action = '';
        if (r.status === 'blocked') {
          action = el('button', { class: 'btn secondary small', type: 'button' }, 'Unblock');
          action.addEventListener('click', async () => {
            if (!confirm(`Let ${r.full_name} pay online again? Their late fine stays at ₹150.`)) return;
            try {
              await call(sb, 'admin_unblock', { p_student_id: r.student_id, p_term_id: termId });
              say('ok', `${r.full_name} can now pay online.`);
              load(offset);
            } catch (err) { say('error', friendlyError(err)); }
          });
        }
        return el('tr', {}, td(r.full_name), td(r.phone), td(r.email),
          td(el('span', { class: 'mono small', title: r.student_id }, r.student_id.slice(0, 8) + '…')),
          td(chipFor(r.status)), td(r.days_late, 'num'), td(inr(r.fine_inr), 'num'), td(inr(r.total_inr), 'num'),
          td(istDateTime(r.paid_at)), td(r.utr, 'mono'), td(billLink(r.order_id, r.bill_no)), td(action));
      })), pager(offset, total, load));
  };

  let t;
  filter.addEventListener('change', () => load(0));
  search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => load(0), 300); });
  csv.addEventListener('click', async () => {
    busy(csv, true, 'Exporting…');
    try {
      const rows = await fetchAll('admin_students', { p_term_id: termId, p_filter: filter.value, p_search: search.value.trim() });
      download(`hims-students-term-${termId}-${filter.value}.csv`,
        ['Name', 'Mobile', 'Email', 'Student ID', 'Status', 'Days late', 'Fine (INR)', 'Amount (INR)', 'Paid on', 'UPI txn ID', 'Bill no', 'Registered on'],
        rows.map((r) => [r.full_name, r.phone, r.email, r.student_id, STATUS[r.status]?.[0] ?? r.status, r.days_late,
          r.fine_inr, r.total_inr, istDateTime(r.paid_at), r.utr, r.bill_no, istDateTime(r.registered_at)]));
    } catch (err) { say('error', friendlyError(err)); }
    busy(csv, false);
  });
  await load(stuState.offset);
}

// ---------- payments ----------

async function payments() {
  const failed = el('input', { type: 'checkbox', id: 'failed', style: 'width:auto' });
  const csv = el('button', { class: 'btn secondary small', type: 'button' }, 'Export CSV');
  const body = el('div');
  $('#panel').replaceChildren(el('div', { class: 'toolbar' },
    el('label', { for: 'failed', style: 'margin:0;display:flex;gap:.4rem;align-items:center' }, failed, 'Include failed attempts'),
    csv), body);

  const load = async (offset) => {
    const rows = await call(sb, 'admin_payments', {
      p_term_id: termId, p_include_failed: failed.checked, p_limit: PAGE, p_offset: offset,
    });
    const total = Number(rows[0]?.total_count ?? 0);
    body.replaceChildren(table(
      [['Paid on'], ['Bill no'], ['UPI txn ID'], ['Student'], ['Mobile'], ['Fee', 1], ['Fine', 1], ['Total', 1], ['Paid from'], ['Status']],
      rows.map((r) => el('tr', {},
        td(istDateTime(r.paid_at ?? r.created_at)), td(billLink(r.status === 'success' && r.order_id, r.bill_no)),
        td(r.utr, 'mono'), td(r.full_name), td(r.phone), td(inr(r.base_inr), 'num'), td(inr(r.fine_inr), 'num'),
        td(inr(r.total_inr), 'num'), td(r.payer_vpa, 'mono'),
        td(r.status === 'success' ? statusChip('Success', 'ok') : el('span', {}, statusChip('Failed', 'danger'), ' ',
          el('span', { class: 'small muted' }, r.failed_reason ?? '')))))),
    pager(offset, total, load));
  };
  failed.addEventListener('change', () => load(0));
  csv.addEventListener('click', async () => {
    busy(csv, true, 'Exporting…');
    try {
      const rows = await fetchAll('admin_payments', { p_term_id: termId, p_include_failed: failed.checked });
      download(`hims-payments-term-${termId}.csv`,
        ['Paid on', 'Bill no', 'UPI txn ID', 'Order ID', 'Student', 'Student ID', 'Mobile', 'Email', 'Term',
          'Fee (INR)', 'Days late', 'Fine (INR)', 'Total (INR)', 'Paid from', 'Status', 'Failure reason'],
        rows.map((r) => [istDateTime(r.paid_at ?? r.created_at), r.bill_no, r.utr, r.order_id, r.full_name, r.student_id,
          r.phone, r.email, r.term_name, r.base_inr, r.days_late, r.fine_inr, r.total_inr, r.payer_vpa, r.status, r.failed_reason]));
    } catch (err) { say('error', friendlyError(err)); }
    busy(csv, false);
  });
  await load(0);
}

// ---------- fee terms ----------

function termForm(title, values, submitLabel, onSave) {
  const name = el('input', { required: true, maxlength: 100, value: values.name ?? '' });
  const amount = el('input', { type: 'number', min: 1, step: 1, required: true, value: values.amount_inr ?? '' });
  const due = el('input', { type: 'date', required: true, value: values.due_date ?? '' });
  const btn = el('button', { class: 'btn', type: 'submit' }, submitLabel);
  const form = el('form', { class: 'card', novalidate: true },
    el('h2', {}, title),
    el('div', { class: 'grid2' },
      el('div', {}, el('label', {}, 'Name'), name),
      el('div', {}, el('label', {}, 'Fee per student (₹)'), amount)),
    el('label', {}, 'Last date of payment'), due,
    el('div', { style: 'margin-top:1rem' }, btn));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    busy(btn, true, 'Saving…');
    try {
      await onSave({ p_name: name.value.trim(), p_amount_inr: Number(amount.value), p_due_date: due.value || null });
    } catch (err) { say('error', friendlyError(err)); }
    busy(btn, false);
  });
  return form;
}

async function termsTab() {
  await loadTerms();
  const active = terms[0];
  const list = table([['Name'], ['Fee', 1], ['Last date'], ['Created'], ['']],
    terms.map((t, i) => el('tr', {}, td(t.name), td(inr(t.amount_inr), 'num'), td(istDate(t.due_date)),
      td(istDateTime(t.created_at)), td(i === 0 ? statusChip('Active', 'ok') : ''))));
  const parts = [el('h2', {}, 'All fee terms'), list, el('div', { style: 'height:1rem' })];
  if (active) {
    parts.push(termForm(`Edit active term: ${active.name}`, active, 'Save changes', async (v) => {
      await call(sb, 'admin_save_term', { p_id: active.id, ...v });
      say('ok', 'Saved. Payments already made keep the amount they were charged.');
      await termsTab();
    }));
  }
  parts.push(termForm('Create a new term', {}, 'Create term', async (v) => {
    if (!confirm(`Create "${v.p_name}"? It becomes the active term, and every registered student will owe it.`)) return;
    termId = await call(sb, 'admin_save_term', { p_id: null, ...v });
    say('ok', `Created "${v.p_name}". It is now the active term.`);
    await termsTab();
  }));
  $('#panel').replaceChildren(...parts);
}

// ---------- reset codes ----------

async function outbox() {
  const rows = await call(sb, 'admin_outbox');
  const refresh = el('button', { class: 'btn secondary small', type: 'button', onclick: () => selectTab('outbox') }, 'Refresh');
  $('#panel').replaceChildren(
    el('div', { class: 'alert info' },
      'Password reset codes appear here only while email sending is not set up (outbox mode). ',
      'Give a code only to the student it belongs to, after checking who they are. Codes expire after 10 minutes.'),
    el('div', { class: 'toolbar' }, refresh),
    table([['Requested'], ['Student'], ['Email'], ['Code'], ['Expires']],
      rows.map((r) => el('tr', {}, td(istDateTime(r.created_at)), td(r.full_name ?? '—'), td(r.email),
        td(el('b', { class: 'mono', style: 'font-size:1.1rem;letter-spacing:2px' }, r.code)), td(istDateTime(r.expires_at))))));
}

boot();
