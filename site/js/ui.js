import { CONFIGURED } from './config.js';
import { studentClient, call } from './supa.js';

// Build DOM nodes without innerHTML so names and other user input are never
// interpreted as markup.
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : String(c));
  }
  return node;
}

export const $ = (sel, root = document) => root.querySelector(sel);

export const inr = (n) => '₹' + Number(n ?? 0).toLocaleString('en-IN');

const dateFmt = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric',
  hour: '2-digit', minute: '2-digit', hour12: true,
});
// Due dates are plain calendar dates; pin them to IST midnight before formatting.
export const istDate = (d) => (d ? dateFmt.format(new Date(String(d).length === 10 ? `${d}T00:00:00+05:30` : d)) : '');
export const istDateTime = (ts) => (ts ? dateTimeFmt.format(new Date(ts)) + ' IST' : '');

const MESSAGES = {
  NOT_A_STUDENT: 'This account is not a student account.',
  TERM_NOT_OWED: 'This fee is not due on your account.',
  ALREADY_PAID: 'This fee is already paid.',
  BLOCKED: 'Online payment for this fee has closed (more than 20 days late). Please contact the HIMS accounts office.',
  BAD_TOKEN: 'This payment link is not valid. Start the payment again from the fee portal.',
  EXPIRED: 'This payment request has expired. Start the payment again.',
  BAD_VPA: 'Enter a valid UPI ID, like name@bank.',
  NOT_FOUND: 'Bill not found.',
  FORBIDDEN: 'You do not have access to this.',
  NOT_ACTIVE_TERM: 'Only the active fee term can be edited.',
  BAD_AMOUNT: 'Enter an amount greater than zero.',
  BAD_NAME: 'Enter a name.',
  BAD_DATE: 'Choose a due date.',
};

export function friendlyError(err) {
  const msg = err?.message ?? String(err ?? '');
  if (MESSAGES[msg]) return MESSAGES[msg];
  if (/already registered|already exists/i.test(msg)) return 'An account with this email already exists. Try logging in.';
  if (/Database error saving new user/i.test(msg)) return 'This phone number is already registered.';
  if (/Invalid login credentials/i.test(msg)) return 'Wrong email or password.';
  if (/expired|invalid/i.test(msg) && /otp|token/i.test(msg)) return 'That code is wrong or has expired.';
  if (/rate limit|too many/i.test(msg) || err?.status === 429) return 'Too many attempts. Please wait a minute and try again.';
  if (/weak|at least/i.test(msg) && /password/i.test(msg)) return 'Use a password of at least 8 characters.';
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return 'Cannot reach the server. Check your internet connection and try again.';
  return 'Something went wrong. Please try again.';
}

export function showAlert(container, kind, text) {
  container.replaceChildren(text ? el('div', { class: `alert ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, text) : '');
}

export function busy(button, isBusy, label) {
  if (isBusy) {
    button.dataset.label ??= button.textContent;
    button.textContent = label ?? 'Please wait…';
    button.disabled = true;
  } else {
    button.textContent = button.dataset.label ?? button.textContent;
    button.disabled = false;
  }
}

export function page({ wide = false } = {}) {
  if (wide) document.body.classList.add('wide');
  document.body.prepend(el('div', { class: 'demo-banner' },
    'DEMO — this is a proof of concept. No real money is charged.'));
  if (!CONFIGURED) {
    document.querySelector('main')?.prepend(el('div', { class: 'alert warn' },
      'This copy of the site is not connected to a database yet. See the README setup steps.'));
  }
}

// Redirects to login unless a student is signed in. Returns whoami().
export async function requireStudent() {
  const sb = studentClient();
  const { data } = await sb.auth.getSession();
  if (!data.session) {
    location.replace('index.html');
    return new Promise(() => {});
  }
  try {
    const me = await call(sb, 'whoami');
    if (me.role === 'student') return me;
  } catch { /* fall through to sign-out */ }
  await sb.auth.signOut({ scope: 'local' });
  location.replace('index.html');
  return new Promise(() => {});
}

export function statusChip(text, kind) {
  return el('span', { class: `chip ${kind}` }, text);
}

export function param(name) {
  return new URLSearchParams(location.search).get(name);
}

export function renderWho(me, client, after = 'index.html') {
  const who = document.getElementById('who');
  if (!who) return;
  const out = el('button', { class: 'btn secondary small', type: 'button' }, 'Log out');
  out.addEventListener('click', async () => {
    await client.auth.signOut({ scope: 'local' });
    location.replace(after);
  });
  who.replaceChildren(el('div', { class: 'row' },
    me?.student ? el('span', { class: 'small muted' }, me.student.full_name) : null, out));
}
