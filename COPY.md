# NightShift site copy

Every word on the public site, in one place. **Generated from `content/site.ts`** by `npm run copy:export`. Don't edit this file directly: edit `content/site.ts` (or mark your changes here and hand them back), then re-export. CI fails if this file is out of date or if any page contains a banned word.

Numbers such as ₹3.15 and the sample quote are computed by the pricing engine (`content/derived.ts`), not typed by hand.

## Promises checklist

The copy describes the finished prototype. Each phase ticks off what it delivers, with the test that proves it (source: `content/promises.ts`).

- [x] **Phase 2:** Prices follow the published formula in whole paise; electricity is covered first; breakdown lines add up to the total (proof: `tests/unit/pricing.test.ts`)
- [x] **Phase 2:** Default owner rate ₹25/hr; all-in price per GPU-hour shown on the pricing page (proof: `tests/unit/pricing.test.ts, tests/e2e/site.spec.ts`)
- [x] **Phase 2:** Time-Bank maths: credits in standard GPU-hours (RTX 3060 = 1), weighted by benchmark, capped at 10×, rounding never creates credit (proof: `tests/unit/timebank.test.ts`)
- [x] **Phase 2:** Waitlist only used to email about NightShift; same reply for new and existing emails (proof: `tests/integration/waitlist.test.ts, tests/e2e/site.spec.ts`)
- [x] **Phase 3:** Quote shows price and finish time before confirming; ₹0 if the job is late, refunded automatically (proof: `tests/integration/coordinator.test.ts (lifecycle, deadline guarantee)`)
- [x] **Phase 3:** Owners are still paid for finished work when a job is late; NightShift takes the loss (proof: `tests/integration/coordinator.test.ts (deadline guarantee)`)
- [x] **Phase 3:** Pieces from offline PCs are re-assigned; a backup copy starts when a piece runs slow near the deadline (proof: `tests/integration/coordinator.test.ts (timeouts, backups), tests/unit/scheduler.test.ts`)
- [x] **Phase 3:** Job data encrypted when stored; inputs and results deleted after 7 days (proof: `tests/unit/crypto.test.ts, tests/integration/coordinator.test.ts (data at rest and retention)`)
- [x] **Phase 3:** Measured watts replace the class default once a node reports them; owners can set their own tariff and rate (proof: `tests/integration/coordinator.test.ts, tests/unit/scheduler.test.ts`)
- [x] **Phase 3:** Owner payouts can never add up to more than the buyer's quote (proof: `tests/unit/scheduler.test.ts (property test)`)
- [x] **Phase 4:** The app asks for work (no inbound ports), stops outside the night window and on pause (proof: `agent/tests/test_runner.py (pause, window, finish the current piece first)`)
- [x] **Phase 4:** Every task signed by us and checked by the app; unsigned tasks refused (proof: `agent/tests/test_trust.py, tests/live/agent-preview.ts`)
- [x] **Phase 4:** Locked container: no internet, no file access, memory and time limits, deleted after each piece (proof: `agent/tests/test_sandbox_docker.py (real containers), agent/tests/test_sandbox.py`)
- [ ] **Phase 4:** Benchmark on join, normalised so an RTX 3060 scores 1000 (Time-Bank weighting depends on it)
- [x] **Phase 4:** CPU mode for laptops without an NVIDIA GPU (proof: `agent/tests/test_runner.py (CPU mode), tests/live/agent-preview.ts (CPU node)`)
- [x] **Phase 5:** Invoices (PDF) show the deadline refund line automatically (proof: `tests/unit/pdf.test.ts, tests/integration/dashboard.test.ts (refund line), tests/e2e/dashboard.spec.ts`)
- [x] **Phase 5:** Owner earnings show electricity as its own line; owners see every piece their PC ran (proof: `tests/integration/dashboard.test.ts (ownerPieces, earningsByNode), tests/e2e/dashboard.spec.ts`)
- [x] **Phase 5:** Dashboard: download your data and delete your account; ledger keeps records without your email (proof: `tests/integration/account.test.ts, tests/e2e/dashboard.spec.ts`)
- [ ] **Phase 6:** About 1 piece in 10 re-run on a second PC; trust scores; bad PCs paused
- [ ] **Phase 6:** Only work that passes checks earns Time-Bank credits
- [ ] **Phase 7:** Time-Bank wallet (demo): earn and spend credits; no cash-out, sale or transfer
- [ ] **Phase 7:** GPU-on-EMI simulator (demo only, no lending)
- [ ] **Phase 8:** Sentry error reports with personal details removed

Done: 17 of 23.

**Still open from you:** set `CONTACT_EMAIL` in Vercel so the privacy page can show a real address.

---

## Everywhere

- Demo banner: This is a working prototype. Payments, payouts and EMI are simulated (demo mode). No real money moves.
- Footer: Idle GPUs, pooled overnight for AI jobs. / Built by a small student team in India. / Demo mode: payments, UPI payouts and GPU EMI are simulated.
- When no contact email is set: We'll add a contact email before public launch.

## Home (`/`)

_Search description:_ NightShift pools idle gaming PCs and college lab GPUs at night. Fixed price, set finish time, and ₹0 if we miss it.

# Your GPU earns while you sleep.

NightShift joins idle gaming PCs, cyber café machines and college lab GPUs into one pool. People with AI jobs get a fixed price and a finish time before the job starts. If we miss the time, they pay ₹0.

Buttons: "Join the waitlist", "See how pricing works"

### Four things we do differently

- **A fixed price and a finish time, up front.** You see the full price and the time it will be done before you confirm. Sample quote: 14 GPU-hours on RTX 4070 PCs at our default owner rate of ₹25 an hour comes to ₹552, done by 6:00 AM. If the job isn't done by then, you pay ₹0.
- **The owner's electricity is paid first.** Every price covers the power bill before anything else. At ₹9 a unit, an RTX 4070 PC uses about ₹3.15 of electricity an hour. The owner gets that on top of their own rate.
- **Time-Bank for students.** Your hostel PC works through the night and earns credits. In hackathon or exam week, spend them on several GPUs at once.
- **GPU on EMI, as a simulator.** See how a new GPU's earnings on the network could pay off its EMI month by month. It's a demo. We don't lend money.

### How a night on NightShift goes

1. **Owners set a window.** For example, 11 PM to 7 AM. Outside that window, your PC is yours.
2. **Someone submits a job.** They pick a job type, upload their data and get a quote with a finish time.
3. **We split it up.** The job becomes small pieces. Each piece goes to a PC that is free and fast enough.
4. **We check the answers.** About 1 piece in 10 runs again on a second PC. If the answers don't match, we find out which PC was wrong.
5. **Everyone gets paid.** Owners get their rate plus electricity. The buyer downloads the results.

### Who is building this

We're a small student team in India. Most of us have a gaming PC that does nothing from midnight to morning, and friends who pay too much for cloud GPUs.

NightShift is a prototype. We test it on our own machines first. Nothing on this site is a user count, a testimonial or a partner logo, because we don't have those yet.

## How it works (`/how-it-works`)

_Search description:_ How NightShift splits a job across idle PCs, checks the results and keeps your deadline.

# How it works

A job is split into small pieces, run on PCs that are free tonight, checked, and put back together before the finish time.

### Your PC asks us for work

The NightShift app on your PC checks in with us every few seconds and asks if there is work. We never connect to your PC. You don't open any ports on your router.

Outside your night window, or when you press pause, the app stops asking.

### Only approved job types run

Buyers can't send code. They pick one of our job types and send data and settings. Right now there are two: batch text embeddings and batch image captioning or resizing.

Each job type is a fixed program that we build, version and sign. Your PC checks our signature before it runs anything.

### Each piece runs in a locked box

Every piece runs inside a container with no internet, no access to your files, a memory limit and a time limit. When the piece is done, the container is deleted.

### We check the answers

About 1 piece in 10 runs again on a different PC and we compare the results. A PC that keeps giving wrong answers loses trust, and if it's bad enough we pause it.

The 12% verification buffer in every price pays for these checks.

### We protect the finish time

If a PC goes offline, its piece goes to another PC. If a piece is running slow close to the deadline, we start a copy on a second PC and use whichever finishes first.

If the job still isn't done on time, the buyer pays ₹0. Owners are still paid for the work their PCs finished. We take the loss.

### What a PC can see

A PC sees the piece of data it is working on, in plain form. It never sees the whole job. That's why we say: don't send data you couldn't show a stranger.

Job data is encrypted when stored, and we delete inputs and results after 7 days.

## For GPU owners (`/owners`)

_Search description:_ Let your gaming PC, cyber café or college lab earn at night. You set the hours and the rate. Electricity is paid on top.

# Put your idle GPU to work at night

If your PC sits idle while you sleep, it can run small AI jobs for people who need them. You pick the hours and your hourly rate. We pay your electricity on top.

### You stay in control

Set a night window, for example 11 PM to 7 AM. Press pause any time, and the app finishes or hands back its current piece and stops.

You set your own hourly rate. You can see every piece your PC ran and what it earned.

### Electricity is paid first

Your earnings show electricity as its own line, so you can see your power bill is covered. At the default ₹9 a unit: about ₹2.88 an hour for an RTX 3060 PC, ₹3.15 for an RTX 4070 PC and ₹5.40 for an RTX 4090 PC.

Pay a different rate for power? Set your own tariff. Once the app has measured your PC's real power draw, we use that instead of the defaults.

### What runs on your PC

Only our approved job types, inside a locked container with no internet and no access to your files. Never code from a buyer. The app checks our signature on every task and refuses anything that isn't signed.

### What you need

A Windows or Linux PC with an NVIDIA GPU, Docker, and a steady internet connection at night. For the demo, a laptop without an NVIDIA GPU can join in CPU mode, but it earns much less.

### Cyber cafés and college labs

Got 20 PCs that sit idle after closing time? Each one can join as its own machine, all under one account.

### Getting paid

Payouts will go to your UPI ID. In this prototype, payouts are simulated: you see the amounts, but no money moves.

### GPU on EMI (simulator)

Thinking of buying a GPU on EMI? The simulator shows how much of each month's EMI your network earnings could cover, based on your rate and hours. It's a demo. We don't lend money or arrange loans.

Button: "Join the waitlist as an owner"

## For AI builders (`/builders`)

_Search description:_ Batch embeddings and image jobs at a fixed price with a finish time. Miss the time and you pay ₹0.

# Batch AI jobs at a fixed price

Send your data, pick a job type, and get a price and a finish time before anything runs. If we miss the time, you pay ₹0.

### What you can run today

Batch text embeddings with a small sentence-transformers model. Good for search, clustering and deduplication.

Batch image captioning or resizing.

That's the full list for now. We add job types one at a time, because each one has to be safe to run on someone else's PC.

### You send data, not code

You choose a job type and its settings, then upload your files. You can't send scripts, and that rule is what keeps owners safe.

### The quote

Before you confirm, you see the total and every line in it: the owners' pay, their electricity, the verification buffer and our fee. Sample quote: 14 GPU-hours on RTX 4070 PCs at our default owner rate of ₹25 an hour comes to ₹552, done by 6:00 AM.

Miss the finish time and the job is free. The refund shows up on your invoice without you asking.

### Be careful with private data

Your job is split into pieces, and each PC only sees its own piece. But it does see that piece in plain form while it works on it. Don't send passwords, medical records or anything you couldn't show a stranger.

Inputs and results are deleted after 7 days.

### Good fit, bad fit

Good fit: research datasets, college projects, and batch jobs that can finish overnight.

Bad fit: live chatbots, anything that must answer in under a second, training large models, and secret data.

Button: "Join the waitlist as a builder"

## Pricing (`/pricing`)

_Search description:_ Every line of a NightShift price, with a calculator. Electricity is covered first, then the owner's rate, then our fee.

# What a job costs, line by line

We start with the owner's electricity, add their hourly rate, add 12% to pay for checking the results, then add our 25% fee. The total is rounded up to the next rupee.

### Try it

Owners start at our default rate of ₹25 an hour, and each owner can set their own. Payments are simulated in this prototype.

Calculator labels: GPU class; GPU hours (Total GPU time across all pieces of the job.); Electricity tariff (₹ per unit) (₹9 is our default. Use your own if you know it.); Owner's rate (₹ per hour) (₹25 is our default. Owners can change it.)

Breakdown lines: Owner's pay / Owner's electricity / Verification buffer (12%) / NightShift fee (25%, plus round-up) / Total you pay

Under the breakdown: The owner receives {ownerReceives}, and {electricity} of that is their electricity. That's {perHour} per GPU-hour, all in.

Errors: Enter hours as a number, like 10 or 2.5. / Enter rupees as a number, like 9 or 9.50. / That number is outside what the calculator handles.

### All-in price per GPU-hour

What one GPU-hour costs you with everything included: the owner's rate (₹25), their electricity at ₹9 a unit, the 12% verification buffer and our 25% fee.

RTX 3060 PC ₹39.04, RTX 4070 PC ₹39.42, RTX 4090 PC ₹42.57 per GPU-hour, all in.

A job's total is this rate × its GPU-hours, rounded up to the next rupee. For example, 14 GPU-hours on an RTX 4070 PC comes to ₹552.

### The formula

1. Electricity per hour = the PC's power draw in kW × the tariff per unit (kWh)
2. Owner cost per hour = electricity per hour + the owner's hourly rate
3. Job cost = GPU hours × owner cost per hour, added up over every piece
4. With checks = job cost + 12% verification buffer
5. Price = with checks + 25% NightShift fee, rounded up to the rupee

### Default power draw

RTX 3060 PC 0.32 kW (₹2.88/hour), RTX 4070 PC 0.35 kW (₹3.15/hour), RTX 4090 PC 0.60 kW (₹5.40/hour), at ₹9 a unit.

These are whole-PC numbers while the GPU is busy. Once the app measures your real draw, we use that.

### Things to know

- If the job isn't done by the finish time on your quote, you pay ₹0.
- The fee line includes the round-up to the next rupee, so it can be a few paise above 25%.
- Prices are worked out in paise, with whole-number maths. Nothing is lost to rounding, and every line in the breakdown adds up to the total.

## Time-Bank (`/time-bank`)

_Search description:_ Students lend their GPU at night and earn credits, in standard GPU-hours, to spend on several GPUs at once later.

# Lend your GPU now, borrow several later

Time-Bank is for students. Your PC works for the network at night and earns credits. Later, you spend them on a short-lived cluster of several GPUs.

### Earning credits

Credits are counted in standard GPU-hours. One standard GPU-hour is one hour of work on an RTX 3060.

Faster GPUs earn more per hour. When your PC joins, the app runs a short benchmark, and your credits are weighted by that score compared with an RTX 3060. For example, a GPU that benchmarks twice as fast earns 2 standard GPU-hours for each hour it works.

Your hostel RTX 3060 running from midnight to 6 AM earns 6 standard GPU-hours.

### Spending credits

When you need a lot of compute at once, book a temporary cluster. Spending uses the same weights: for example, 4 RTX 3060-class GPUs for 3 hours during a hackathon cost 12 standard GPU-hours. Faster GPUs in your cluster cost more per hour.

Your booking runs on the same approved job types as everyone else's.

### The rules

Credits aren't money. You can't cash them out, sell them or give them to someone else.

One GPU can earn at most 10 standard GPU-hours per hour, however high its benchmark.

In this prototype, credits are tracked in a demo wallet.

Button: "Join the waitlist"

## FAQ (`/faq`)

_Search description:_ Straight answers about safety, payments, deadlines and what runs on your machine.

# Questions people ask us

**Can a buyer run their own code on my PC?**

No. Buyers pick from our approved job types and send data and settings only. Your PC refuses any task that isn't signed by us.

**Can a job see my files or use my internet?**

No. Each piece runs in a container with no internet and no access to your files, with limits on memory and time.

**Do I need to open ports on my router?**

No. The app on your PC asks us for work. We never connect to your PC.

**Will it slow down my PC?**

It only runs inside the night window you set, and you can pause it any time. While a piece is running, the GPU is busy, so don't plan to game during your window.

**How much will I earn?**

It depends on your rate, your hours, and whether there are jobs that night. We don't promise a number.

You always get your electricity on top of your rate.

**What happens if the job is late?**

The buyer pays ₹0. Owners are still paid for the work their PCs finished. NightShift takes the loss.

**Is my job data private?**

Partly. Each PC sees only its own piece of your job, but it does see that piece in plain form while it works on it. Don't send anything you couldn't show a stranger.

We encrypt stored data and delete inputs and results after 7 days.

**Is real money involved?**

Not yet. This is a prototype. Payments, UPI payouts and EMI are all simulated.

**Can I join with a laptop?**

For the demo, yes. Laptops without an NVIDIA GPU run in CPU mode. They're much slower and earn much less.

**How do I delete my account?**

From your dashboard. You can also download a copy of your data there first. Financial records stay in our ledger, without your email attached.

## Waitlist (`/waitlist`)

_Search description:_ Join the NightShift waitlist as a GPU owner, an AI builder, or both.

# Join the waitlist

We'll email you when NightShift is ready for more people. That's the only thing we'll use your email for.

Fields: Email; I want to: Earn with my GPU / Run AI jobs / Both; checkbox: Email me about NightShift. I can ask you to delete my email any time.

Button: "Join the waitlist". After sending: Done. If that email wasn't already on the list, it is now. We'll write when there's a spot for you.

Errors: That email address doesn't look right. / Pick one option. / Tick the box so we're allowed to email you. / Too many tries from your network. Wait an hour and try again. / Something went wrong on our side. Try again in a minute.

## Privacy (`/privacy`)

_Search description:_ What NightShift collects, why, how long we keep it, and how to get it deleted.

# Privacy

This is how the NightShift prototype handles your data. We follow India's Digital Personal Data Protection Act, 2023 (DPDP), and we collect as little as we can.

### What we collect

Your email address, to log you in. If you log in with Google, we only ask Google for your email. We don't store your name or photo.

If you're an owner: your PC's GPU model, benchmark score, power draw, online times and earnings.

If you're a buyer: the job settings and files you upload, and your job history.

A scrambled (hashed) version of your IP address in our security log, so we can spot abuse. We don't store the IP itself.

### Why we collect it

To log you in, run your jobs, pay owners, keep the network safe, and email you about NightShift if you asked us to. We don't sell data and we don't show ads.

### Who else sees it

PCs on the network see the piece of a job they work on, in plain form, while they work on it.

Our service providers store or process data for us: Vercel (hosting), Neon (database), Upstash (rate limiting), Resend (login emails) and Sentry (error reports, with personal details removed).

### How long we keep it

Job inputs and results: 7 days, then deleted.

Your account: until you delete it.

Ledger records of payments and payouts are kept after deletion, because money records have to be. Your email is removed from them.

### Your rights

You can download your data and delete your account from your dashboard. You can also ask us to correct your data, or complain if you think we got something wrong.

Write to us at {email}. (or, with no CONTACT_EMAIL set: "We'll add a contact email before public launch.")

### Changes

This is a prototype, and this page will change before we take real payments. We'll show the date of the last change at the top when it does.

## Terms (`/terms`)

_Search description:_ The rules for using the NightShift prototype.

# Terms

These are the rules for using the NightShift prototype. They will change before we take real payments.

### This is a prototype

Payments, UPI payouts, credits and EMI are simulated. No real money moves. Don't rely on NightShift for anything important yet.

### If you run jobs

Only upload data you have the right to use. No illegal content, nothing that harms people, and no personal data of others without their consent.

Remember that PCs on the network see the piece of data they work on.

### If you share a GPU

Only connect machines you own or are allowed to use. If it's a college lab or a cyber café, get permission from whoever runs it.

You pay your own electricity bill. We add the electricity line to your earnings, but we can't control your tariff or your hardware.

We may pause a machine that gives wrong answers, goes offline often, or looks unsafe.

### Accounts

One person per account. Keep your login email safe, because anyone who can read it can log in. We can suspend accounts that break these rules.

### No promises beyond what we say

We promise what's on your quote: the price, and ₹0 if we miss the finish time. Beyond that, the prototype comes as it is, and we can't promise it will always be up or always be right.
