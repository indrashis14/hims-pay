# HIMS Fee Payment Portal — Design (POC)

Date: 2026-10-27
Status: revision 2 for approval. It replaces the approved Node/SQLite version
because the owner chose GitHub Pages + Supabase hosting.

## 1. Intent

A weekend proof-of-concept website where students of HIMS, a medical
college, pay their fees by UPI. Paying fees is the only thing it does. It is
a standalone project with no ties to any employer's code or infrastructure.
Anyone can open it from a public link.

Success means it shows the whole fee cycle working end to end:

- A student signs up, logs in, pays by UPI, and gets a bill with a
  transaction ID.
- The admin sees who has paid and who hasn't.
- Late fines are added correctly.
- It holds up with 1,000 students paying at the same time.

## 2. Decisions made by the owner

| Topic | Decision |
|---|---|
| Users | Students register with **phone number + email** (plus password) and get a **UUID**. |
| Password recovery | **Forgot password** is required. |
| Scope | **Fee payment only.** |
| Payment method | **UPI only, simulated.** No money moves. It sits behind a gateway boundary so a real gateway can be added later. |
| Receipt | Each successful payment produces a **bill showing the transaction ID**. |
| Fee structure | **One fee for everyone.** The admin sets the amount and last date of payment per fee term. |
| Late fine | **₹5/day** for days 1–10 after the last date, then **₹10/day** for days 11–20. |
| After day 20 | **Online payment is blocked.** The student has to contact the office. The admin can unblock them. |
| "Not paid" | **Registered students only.** Anyone can sign up. |
| Reset-code delivery | Real student details are expected. Codes go out **by email over SMTP**. Until SMTP is set up, they go **only to an admin-only outbox** and never appear on the student's screen. |
| Admin side | A separate admin area that students never see, with statistics: who paid, who hasn't, and so on. |
| Scale | **1,000 students in total**, with **very light traffic**. It is a mess-bill payment site, so expect a few requests per second at most, and students do not all register or pay at once. The owner clarified this on 2026-10-27. |
| Hosting | **A public link anyone can open.** The site is served from **GitHub Pages**. Data lives in a **free Supabase project**. |
| Repo | **Public repo on the owner's personal GitHub account**, not the Nexthop account. |
| Cost | **Everything free.** GitHub Pages and Actions are free for public repos. Supabase is on the free plan. Email uses a free Gmail app password. Nothing in the build or setup may need a paid plan or a card. |

## 3. Goals

1. **Registration.**
   - The student enters full name, 10-digit Indian mobile number, email and
     password. Phone and email must each be unique.
   - Their student ID is their Supabase account's UUID (v4).
   - Email confirmation is off, so signup works before email is set up.
2. **Login** with email + password.
3. **Forgot password.**
   - The student enters their email and always sees the same reply: "If an
     account exists, a code has been sent." The screen never reveals whether
     the account exists.
   - The 6-digit code is valid for 10 minutes and works once.
   - Entering the code lets them set a new password, and their other
     sessions are signed out.
   - Delivery depends on the mode (§7.4):
     - **Email mode:** emailed through the owner's SMTP account.
     - **Outbox mode:** shown only on the admin outbox page.
4. **Fee dashboard.**
   - Lists every fee term the student owes and hasn't paid, including older
     terms (§6a).
   - For each term it shows the due date and the amount due today, broken
     into base fee, fine and days late. Terms past day 20 show as blocked.
   - Paid terms link to their bills.
5. **UPI payment (simulated).**
   - **Pay** creates an order on the server. The amount (base + fine) is
     calculated from the **server clock** in IST, fixed on the order, and the
     order expires after 10 minutes. If a pending order already exists, it
     is reused.
   - **Pay with UPI ID.** The student enters a UPI ID, then a simulated
     "UPI app" panel asks them to **Approve** or **Decline**. UPI IDs ending
     in `@fail` always fail.
   - **Scan QR.** The QR opens the simulated UPI-app page for that order on
     a phone, using a one-time pay token in the link. It is deliberately not
     a real `upi://` link, so no real UPI app can be triggered. The
     student's original tab checks every few seconds and shows the bill when
     the payment goes through.
   - On success the server records a 12-digit UTR-style transaction
     reference and a bill number.
6. **Bill.**
   - A printable page that can be saved as PDF from the browser.
   - Payment details: college name, bill number, UPI transaction ID, order
     ID, and date and time paid (IST).
   - Student details: name, UUID, phone, email.
   - Amounts: fee term, base fee, fine with days late, and total.
   - Also: payer UPI ID, status, and a **"DEMO — no real money was charged"**
     label.
   - Students can open their past bills at any time.
7. **Admin area.**
   - It lives at `/admin/` on the same site. Nothing on the student side
     links to it.
   - The admin signs in with an admin account. That account is created by
     the owner (§9) and cannot be made through signup.
   - Every admin data call is checked in the database. A student account
     gets nothing back from it, and the admin account cannot use the student
     pages. The admin page's code is public (the repo is public), but the
     code alone gives no access to data.
   - Stats for the selected term (default: active term):
     - students registered, paid, unpaid
     - paid on time vs paid late
     - students currently in the fine window, and students blocked
     - total collected, split into base fees and fines
     - collections per day
   - Students table: search (name, phone, email, UUID), filters (paid / unpaid
     / paid late / in fine window / blocked), CSV export.
   - Payments table: transaction ID, student, amount, fine, time, with a
     toggle to include failed payments. CSV export.
   - Fee terms: create a new term (name, amount, due date), which becomes
     the active one. The active term's amount and due date can be edited.
     Past payments keep the amount they were charged.
   - Unblock a given student for a given term after day 20.
   - **Reset-code outbox:** in outbox mode, lists reset requests that are
     still valid (student, email, time, code). In email mode it is empty,
     because codes go straight to the student's inbox.
8. **1,000 students.** A load-test script runs in two phases:
   - **Phase A:** 1,000 students sign up and log in, spread over about 60
     seconds.
   - **Phase B:** all 1,000 go through dashboard → create order → pay with
     UPI ID → open bill, spread over 60 seconds. That is a deadline-day rush
     far heavier than 1,000 students would really produce.

   An optional burst mode (`--pay-ramp 0`) sends all 1,000 payments at the
   same instant. It is a stress test only, not a pass/fail gate.

   Pass means all of these:
   - zero server errors and zero timeouts (30 s limit)
   - zero duplicate successful payments, and zero lost payments (each
     approved order has exactly one bill)
   - Phase B: 95% of requests under 1 s
   - Phase A: 95% under 5 s

   The full 1,000-student run is a safety margin, far above real mess-bill
   traffic. It runs against the local Supabase stack, and its results go in
   the README. The hosted project only gets a small smoke test of about 20
   students, cleaned up afterwards, so the owner's free project never holds
   1,000 fake accounts.

## 4. Non-goals (POC)

- Moving real money. SMS delivery. Logging in with phone number.
- Fees that differ by course or year. Separate fee heads. Partial payments.
- Refunds, settlement, reconciliation.
- A student roster, or checking that someone is a real HIMS student.
- Several admin accounts or admin roles.
- A mobile app, multiple languages, or formal accessibility certification.
- A paid hosting tier.

## 5. Anti-goals (unacceptable even if everything else works)

- **Charging a student twice** for the same term, or two successful payments
  recorded for one student and term.
- **A bill that shows a different amount than was charged**, or a wrong fine
  at the day boundaries: due date, day 10/11, day 20/21.
- **A fine calculated from the student's own device clock**, which a student
  could change to avoid the fine.
- **A student seeing any other student's data**, or any admin data.
- **Plain-text passwords in the database.** Supabase stores password hashes.
  Reset codes are handled by Supabase Auth. In outbox mode, unsent codes are
  kept in a table only the admin can read. Expired codes are purged on the
  next reset request or the next time the admin opens the outbox. Supabase
  Auth rejects them after 10 minutes either way.
- **Revealing whether an email is registered** from the forgot-password
  screen.
- **Looking like it takes real money.** Every payment screen and bill carries
  the DEMO label.
- **Breaking under the 1,000-user test.**
- **Secrets in the public repo.** The Supabase service-role key and the SMTP
  password never go in the repo. The Supabase URL and the public "anon" key
  are meant to be public and are safe because of database row-level security
  (RLS).

## 6. Late-fine rules (exact)

All dates are IST (Asia/Kolkata), taken from the database server's clock.
`days_late = max(0, today_IST − due_date)`.

| days_late | fine | can pay online? |
|---|---|---|
| 0 | ₹0 | yes |
| 1–10 | ₹5 × days_late | yes |
| 11–20 | ₹50 + ₹10 × (days_late − 10) | yes |
| 21+ | — | **no**, unless the admin unblocked this student for this term. Then the fine is ₹150, capped. |

Examples: 1 day late → +₹5, 10 days → +₹50, 11 → +₹60, 15 → +₹100, 20 → +₹150.

- A student who signs up after the due date is still charged by the table.
  Lateness counts from the term's due date, not from signup.
- "Paid late" means the order's fine was above ₹0.
- The amount is fixed when the order is created. An order created before
  midnight, or just before the block starts, can still be paid within its
  10-minute window at that fixed amount.

## 6a. Fee terms and arrears

- Each term is tracked separately, with its own amount, due date, fine clock,
  block and unblock.
- Creating a new term makes it the active one for the admin's default view.
  Unpaid older terms stay due and payable under their own rules.
- A student owes the term that is active when they sign up, and every term
  created after that.
- If the admin edits a term's amount, pending orders keep their fixed amount
  and expire normally.

## 7. How it is built

### 7.1 Pieces

- **Frontend:** static HTML, CSS and vanilla JavaScript (ES modules). The
  pinned `supabase-js` and QR libraries are bundled in `site/js/vendor`, so no
  third-party script loads at runtime. There is no build step.
  It is deployed to GitHub Pages by a GitHub Actions workflow on every push
  to `main`.
- **Backend:** a free Supabase project.
  - **Auth:** email + password.
  - **Postgres:** all business rules live in SQL.
  - **Data API:** called from the browser using the public anon key.

  There is no separate server.
- **Business logic in Postgres.** Fines, blocking, orders, payments, admin
  stats and unblock are `SECURITY DEFINER` functions, called as RPCs. Tables
  have RLS on. Students can read only their own rows and cannot write to
  orders or payments directly. Every grant is written out explicitly in the
  migrations; Supabase requires this for new tables from 2026-10-30.
- **Double-payment guard.** A unique index allows one successful payment per
  (student, term) and one pending order per (student, term). Payment
  finalisation locks the order row and is idempotent by order ID.
- **Gateway boundary.** One internal function,
  `finalize_payment(order_id, gateway_txn_id, status)`, records the result.
  - The **mock UPI RPC** plays the bank and calls it. It is authorised by the
    student's session or by the order's one-time pay token.
  - A **real gateway** later would be a Supabase Edge Function webhook. It
    checks the gateway's signature and calls the same function with the
    service role.

### 7.2 Repo layout (public repo, owner's personal GitHub)

```
site/               static site → GitHub Pages
  index.html  register.html  forgot.html  dashboard.html
  pay.html  upi.html  bill.html  admin/index.html
  js/config.js      Supabase URL + anon key (public by design)
supabase/
  config.toml       local stack config (hooks, rate limits, OTP expiry)
  migrations/       schema, RLS, grants, functions
  tests/            pgTAP database tests
tests/              end-to-end tests against the local stack
loadtest/           1,000-user script
.github/workflows/  Pages deploy (and tests)
docs/design.md
README.md           owner setup steps + load-test results
```

### 7.3 Development and testing

- Everything is built and tested first on the **local Supabase stack** (the
  Supabase CLI running in Docker on this machine). Nothing goes online until
  the owner creates the accounts (§9).
- Database tests (pgTAP) cover:
  - every fine boundary in §6
  - block and unblock
  - RLS: student A can't read B, and a student can't call admin RPCs
  - order reuse and expiry
  - a double approve leading to only one payment
  - the bill amount matching the order
- End-to-end tests (Node + `supabase-js`) cover:
  - signup and login
  - duplicate phone and duplicate email
  - forgot password in outbox mode
  - pay success and pay failure
  - the QR pay token
  - a student blocked from admin
- A browser check of the main pages.

### 7.4 Password-reset delivery modes

- **Outbox mode** (default until SMTP is configured):
  - Supabase's Send Email hook points to a Postgres function. That function
    saves recovery codes into an admin-only outbox table.
  - No email is sent.
- **Email mode:**
  - The owner turns the hook off and enters SMTP details in the Supabase
    dashboard. A Gmail app password on port 587 works.
  - Supabase emails a 6-digit code using a custom template.
- Supabase emails go only to the owner's own team until SMTP is
  configured. That is why outbox mode is the default.

### 7.5 Limits to raise in the Supabase dashboard (part of setup)

Students connect from their own mobile networks, not one shared campus
connection. Indian mobile carriers do put many phones behind a single public
IP (carrier-grade NAT), so a deadline-day rush can still land a few dozen
students on one IP. Supabase's default auth limits are 30 sign-ups or
sign-ins per 5 minutes per IP, and 150 token requests per 5 minutes per IP.
Those are tight for that rush, so this setup raises them moderately and
keeps brute-force protection:

- sign-ups and sign-ins: 300 per 5 min per IP
- token requests: 1,000 per 5 min per IP
- emails: 100 per hour, once SMTP is on
- OTP expiry: 600 s

The load test sends all 1,000 students from one machine. For the one hosted
test run (§3.8), the limits are raised temporarily and then put back to the
values above. The local stack uses the test values in `config.toml`.

### 7.6 Free-tier facts the owner should know

- Free Supabase projects **pause after about 7 days with no activity**. Data
  is kept, but the site stops working until the owner clicks "Restore" in
  the dashboard.
- Limits: 500 MB database, 50,000 monthly active users, 2 free projects.
- The 1,000-user target holds only if the hosted load test passes on this
  tier. If it doesn't, the README will say so with numbers.

## 8. Owner setup (one time, about 15 minutes, guided by the README)

1. Create a free Supabase project. Give me a Supabase access token, or run
   `supabase login` here, so I can push the schema and settings.
2. Create the public GitHub repo on your personal account. Log in here with
   `gh auth login` so I can push. **I push only when you say so.**
3. Turn on GitHub Pages for the repo (source: GitHub Actions).
4. Create the admin user in the Supabase dashboard. Then run one SQL line,
   from the README, that marks it as admin.
5. Optional: add SMTP details to switch to email mode.

## 9. Calls made by the designer (open to override)

- **Login is by email only.** The phone number is collected and shown on
  bills and in the admin view. Supabase can't do phone + password login
  without an SMS provider, and phone login was my addition, not your
  requirement.
- **Email confirmation is off.** Otherwise signup would stall until SMTP is
  set up.
- **Outbox codes are stored as plain text** in a table only the admin can
  read, and deleted once they expire. This replaces "encrypted" from rev 1:
  Supabase generates the codes, so a key held in the same database added
  little.
- **In email mode the outbox is empty**, because Supabase sends the mail
  directly.
- **Old-term debts stay payable** (§6a). The simpler option is to show only
  the current term.
- **The QR opens the simulated UPI page**, not a real `upi://` link.
- **After an admin unblock, the fine is capped at ₹150.** An order created
  just before the block can still be paid within its 10-minute window.
- **The load test runs locally during the build**, then once against the
  hosted project with your OK.
- **The project folder is `~/hims-pay`**, outside the nh repo.

## 10. Left to the builder

Page layout and visual design, bill number format, the per-day collections
chart, exact RPC names and test framework details.
