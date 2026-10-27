# HIMS Fee Portal (demo)

A free, proof-of-concept website where HIMS students pay their (mess) bills
by UPI.

> **DEMO: no real money moves.** UPI payments are simulated. Every payment
> screen and every bill says so.

- Students sign up with **name, mobile number, email and password**. Each one
  gets a **UUID** as their student ID.
- They log in with email + password, and can reset a forgotten password with a
  6-digit code.
- They see what they owe, pay by **UPI ID** or by **scanning a QR code**, and
  get a printable **bill with the UPI transaction ID**.
- **Late fine:** ₹5/day for days 1–10 after the last date, then ₹10/day for
  days 11–20. After 20 days, online payment closes, and the admin can unblock
  a student.
- A separate **admin area** (`/admin/`, not linked from the student pages):
  - who paid and who hasn't
  - amounts collected, split into fees and fines
  - collections per day
  - search, filters and CSV export
  - fee-term management, unblocking, and password-reset codes

It runs entirely on free tiers: **GitHub Pages** for the website and
**Supabase** (free plan) for the database and logins.

## How it works

```
Browser (GitHub Pages: static HTML/JS)
   │  supabase-js with the public "anon" key
   ▼
Supabase (free)
   ├─ Auth      email + password, reset codes
   ├─ Data API  calls Postgres functions (RPCs)
   └─ Postgres  all the rules: fines, blocking, orders, payments, admin stats
                row-level security on every table
```

- Every rule is enforced **in the database**, not in the browser. That covers
  the fine calculation (IST, from the database clock), the block after day 20,
  one payment per student per term, and admin-only data. A student cannot
  change their fine by changing their phone's clock or by editing the page.
- Paying the same bill twice is impossible. A unique index allows one
  successful payment per student per term, and two tabs paying at once share
  one order.
- The simulated UPI "bank" is `public.mock_upi_pay`. It hands the result to
  `private.finalize_payment`, the single function that records a payment. A
  real gateway would call that same function from a webhook (see "Using a
  real payment gateway later").

## Put it online (free, about 15 minutes)

You need: Node.js 24, a free [Supabase](https://supabase.com) account, and a
free GitHub account.

1. **Create a Supabase project.** Use the free plan; the Mumbai region is
   closest to India. From *Project Settings → API*, note three things:
   - the **Project URL**
   - the **anon public** key
   - the **service_role** key. It is secret: never commit it or put it in
     the site.
2. **Push the database and auth settings** from this folder:
   ```bash
   npm install
   npx supabase login
   npx supabase link --project-ref <your-project-ref>
   npx supabase db push
   HIMS_SITE_URL=https://<your-github-username>.github.io/hims-pay npx supabase config push
   ```
   `config push` applies, among other things, the rate limits from
   `supabase/.env`, the 10-minute reset codes, the reset-code email template,
   and the outbox hook.
3. **Create the admin account now, before anything is public.** Signup is
   open once the site is live. `create-admin` refuses an email that already
   has an account, so nobody can register your admin email first and get
   promoted. Use a strong password; the admin can see every student.
   ```bash
   node scripts/create-admin.mjs --url https://<ref>.supabase.co \
     --service-key <service_role key> --email you@example.com --password '<12+ characters>'
   ```
   Running it again for the same admin email just changes the password.
4. **Smoke test, before you share the link** (optional). This creates 20
   throwaway students and a temporary bill, pays it for each one, checks the
   database, then deletes everything it made:
   ```bash
   node loadtest/run.mjs --url https://<ref>.supabase.co --anon <anon key> \
     --service <service_role key> --users 20 --ramp 10 --pay-ramp 10
   ```
5. **Point the site at your project.** In `site/js/config.js`, set
   `HOSTED.url` and `HOSTED.anonKey`. The anon key is meant to be public.
6. **Publish the site.** Create a **public** repo named `hims-pay` on your
   GitHub account and push this folder to it. Then go to *Settings → Pages →
   Build and deployment → Source: GitHub Actions*. The site appears at
   `https://<your-github-username>.github.io/hims-pay/`.
7. **Create the first bill.** Open
   `https://<your-github-username>.github.io/hims-pay/admin/`, log in, and go
   to **Fee terms**. For example: "Mess bill — November 2026".

## Password reset: outbox mode and email mode

- **Outbox mode** (the default). No email is sent. The code shows up on the
  admin page under **Reset codes**, and the office gives it to the student
  after checking who they are. Codes expire after 10 minutes.
- **Email mode.** Codes are emailed to the student. To switch:
  1. In your Google account, turn on 2-Step Verification and create an **App
     password**.
  2. In Supabase, go to *Authentication → Emails → SMTP Settings*. Enter host
     `smtp.gmail.com`, port `587`, your Gmail address as the username, the
     app password, and a sender name.
  3. Go to *Authentication → Hooks* and turn **off** the *Send Email* hook.

  Gmail's free sending limit is a few hundred emails a day, which is plenty
  here.

The forgot-password screen always says the same thing, whether or not the
email belongs to an account.

## Free-tier facts

- A free Supabase project **pauses after about 7 days without visits**. Data
  is kept. Click *Restore* in the Supabase dashboard to bring the site back.
- Limits: 500 MB database (enough for many years of bills), 50,000 monthly
  active users, and 2 free projects per account.
- GitHub Pages is free for public repos. The website code is public; the data
  is not.

## Security notes

- The anon key in `site/js/config.js` is public by design. Row-level security
  and the database functions decide what it can do:
  - students can read only their own records
  - every admin function checks for the admin account
- The service-role key and SMTP passwords must never go in the repo or the
  site.
- The admin page's code is public, but it shows no data unless you log in as
  the admin account.
- Bills and payment screens carry a DEMO label while payments are simulated.
- An account that has a payment cannot be deleted (the database refuses), so
  bills never disappear. Accounts with no payments can be deleted from the
  Supabase dashboard.
- A login session that existed **before** an account was made admin never
  gets admin rights. The person has to log in again.
- The site loads no third-party scripts at runtime. `supabase-js` and the QR
  library are bundled in `site/js/vendor/`; refresh them with `npm run
  vendor`.
- Known and accepted: the forgot-password **screen** never reveals whether an
  email is registered. The underlying auth API can, though: asking twice in a
  minute is rate-limited only for real accounts. The signup form reveals this
  too ("an account with this email already exists"), which this design
  accepts.

## Load test

`loadtest/run.mjs` signs up N students and logs them in (phase A), then has
every one of them pay (phase B): load dues, create an order, pay by UPI ID,
open the bill. Afterwards it checks the database and deletes everything it
created.

**Result on the local Supabase stack, 2026-10-27** (1,000 students; signups
over 60 s, then all 1,000 payments within 60 s):

| Request | OK | Errors | Timeouts | p50 ms | p95 ms | max ms |
|---|---|---|---|---|---|---|
| sign up | 1000 | 0 | 0 | 89 | 122 | 256 |
| log in | 1000 | 0 | 0 | 80 | 112 | 212 |
| load dues | 1000 | 0 | 0 | 9 | 12 | 31 |
| create order | 1000 | 0 | 0 | 4 | 6 | 43 |
| pay (simulated UPI) | 1000 | 0 | 0 | 4 | 6 | 20 |
| open bill | 1000 | 0 | 0 | 1 | 2 | 9 |

The database check found 1,000 successful payments, one per student, each
with a 12-digit UPI transaction ID and a bill. **PASS.**

That is far more than a mess-bill site sees; real traffic is a few requests a
second. As a stress test beyond the target, all 1,000 payments were also sent
at the same instant (`--pay-ramp 0 --concurrency 200`). Every payment was
still recorded exactly once with zero errors. The 95th-percentile time rose
to about 1.5 s for payments and 5.3 s for loading dues, held back by the
local dev gateway.

## Local development

Needs Node.js 24 and Docker.

```bash
npm install
# High auth limits locally, because the tests create many users from one IP.
HIMS_SIGNIN_LIMIT=100000 HIMS_TOKEN_REFRESH_LIMIT=100000 npx supabase start \
  -x studio,imgproxy,storage-api,logflare,vector,edge-runtime,realtime,postgres-meta,supavisor
npx supabase db reset            # applies migrations + a sample term
npx supabase status              # shows the local keys
node scripts/create-admin.mjs --url http://127.0.0.1:54321 \
  --service-key <SERVICE_ROLE_KEY> --email admin@hims.local --password 'LocalAdmin#2026'
python3 -m http.server 3000 -d site   # then open http://127.0.0.1:3000
```

Tests (GitHub Actions runs these too, through `.github/workflows/ci.yml`):

```bash
npm run test:db    # pgTAP: fine boundaries
npm run test:e2e   # signup, payments, double-payment guard, blocking, admin, reset
```

## Using a real payment gateway later

1. Add a Supabase Edge Function as the gateway's webhook. It verifies the
   gateway's signature, then calls `private.finalize_payment(order_id,
   success, reason, payer_vpa)` with the service role.
2. Replace the simulated UPI panel and `upi.html` with the gateway's checkout.
3. Remove the DEMO labels.

Real gateways (Razorpay, Cashfree, PhonePe…) need a merchant account and
charge per transaction.

## Project layout

```
site/                     the website (GitHub Pages)
  index, register, forgot, dashboard, pay, upi (demo UPI app), bill .html
  admin/index.html        admin area
  js/ css/
supabase/migrations/      schema, row-level security, all business rules
supabase/tests/           pgTAP tests
supabase/config.toml      auth settings, limits, reset-code hook, email template
tests/                    end-to-end tests (node:test + supabase-js)
loadtest/run.mjs          load test
scripts/create-admin.mjs  creates the admin account
docs/design.md            the design this was built from
```
