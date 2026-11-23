/**
 * Every word of public site copy lives here. Pages render from this file and
 * `npm run copy:export` writes COPY.md from it, so the two never drift.
 *
 * Copy rules (docs/BUILD_BRIEF.md §4): short sentences, plain words, specific
 * numbers, Indian context, "you" and "we". No claims that aren't true for
 * the prototype. Examples are labelled as examples. `npm run copy:check`
 * fails the build on banned words.
 *
 * Numbers that come from the pricing engine are written as {placeholders}
 * and filled in at render time, so the copy can never disagree with the maths.
 */

export interface Section {
  heading: string;
  body: string[];
}

export interface Step {
  title: string;
  body: string;
}

export interface Faq {
  q: string;
  a: string[];
}

export interface PageMeta {
  path: string;
  /** Short name for nav and the browser tab. */
  name: string;
  /** Under 160 characters, for search results. */
  description: string;
}

export const site = {
  name: "NightShift",
  tagline: "Idle GPUs, pooled overnight for AI jobs.",
  footer: {
    team: "Built by a small student team in India.",
    demo: "Demo mode: payments, UPI payouts and GPU EMI are simulated.",
    contactMissing: "We'll add a contact email before public launch.",
  },
  skipLink: "Skip to content",
  menu: "Menu",
  /** Header link. Signed-in visitors are sent straight on to their dashboard. */
  login: "Log in",
};

export const nav: PageMeta[] = [
  { path: "/how-it-works", name: "How it works", description: "How NightShift splits a job across idle PCs, checks the results and keeps your deadline." },
  { path: "/owners", name: "For GPU owners", description: "Let your gaming PC, cyber café or college lab earn at night. You set the hours and the rate. Electricity is paid on top." },
  { path: "/builders", name: "For AI builders", description: "Batch embeddings and image jobs at a fixed price with a finish time. Miss the time and you pay ₹0." },
  { path: "/pricing", name: "Pricing", description: "Every line of a NightShift price, with a calculator. Electricity is covered first, then the owner's rate, then our fee." },
  { path: "/time-bank", name: "Time-Bank", description: "Students lend their GPU at night and earn credits, in standard GPU-hours, to spend on several GPUs at once later." },
  { path: "/faq", name: "FAQ", description: "Straight answers about safety, payments, deadlines and what runs on your machine." },
];

export const footerNav: PageMeta[] = [
  { path: "/waitlist", name: "Waitlist", description: "Join the NightShift waitlist as a GPU owner, an AI builder, or both." },
  { path: "/privacy", name: "Privacy", description: "What NightShift collects, why, how long we keep it, and how to get it deleted." },
  { path: "/terms", name: "Terms", description: "The rules for using the NightShift prototype." },
];

// ─── Home ───────────────────────────────────────────────────────────────────

export const home = {
  meta: { path: "/", name: "Home", description: "NightShift pools idle gaming PCs and college lab GPUs at night. Fixed price, set finish time, and ₹0 if we miss it." },
  hero: {
    heading: "Your GPU earns while you sleep.",
    body: "NightShift joins idle gaming PCs, cyber café machines and college lab GPUs into one pool. People with AI jobs get a fixed price and a finish time before the job starts. If we miss the time, they pay ₹0.",
    primaryCta: "Join the waitlist",
    secondaryCta: "See how pricing works",
  },
  pillarsHeading: "Four things we do differently",
  pillars: [
    {
      title: "A fixed price and a finish time, up front",
      body: "You see the full price and the time it will be done before you confirm. Sample quote: {sampleQuote}. If the job isn't done by then, you pay ₹0.",
    },
    {
      title: "The owner's electricity is paid first",
      body: "Every price covers the power bill before anything else. At ₹9 a unit, an RTX 4070 PC uses about {power4070} of electricity an hour. The owner gets that on top of their own rate.",
    },
    {
      title: "Time-Bank for students",
      body: "Your hostel PC works through the night and earns credits. In hackathon or exam week, spend them on several GPUs at once.",
    },
    {
      title: "GPU on EMI, as a simulator",
      body: "See how a new GPU's earnings on the network could pay off its EMI month by month. It's a demo. We don't lend money.",
    },
  ] satisfies Step[],
  flowHeading: "How a night on NightShift goes",
  flow: [
    { title: "Owners set a window", body: "For example, 11 PM to 7 AM. Outside that window, your PC is yours." },
    { title: "Someone submits a job", body: "They pick a job type, upload their data and get a quote with a finish time." },
    { title: "We split it up", body: "The job becomes small pieces. Each piece goes to a PC that is free and fast enough." },
    { title: "We check the answers", body: "About 1 piece in 10 runs again on a second PC. If the answers don't match, we find out which PC was wrong." },
    { title: "Everyone gets paid", body: "Owners get their rate plus electricity. The buyer downloads the results." },
  ] satisfies Step[],
  teamHeading: "Who is building this",
  team: [
    "We're a small student team in India. Most of us have a gaming PC that does nothing from midnight to morning, and friends who pay too much for cloud GPUs.",
    "NightShift is a prototype. We test it on our own machines first. Nothing on this site is a user count, a testimonial or a partner logo, because we don't have those yet.",
  ],
};

// ─── How it works ──────────────────────────────────────────────────────────

export const howItWorks = {
  meta: nav[0]!,
  heading: "How it works",
  intro: "A job is split into small pieces, run on PCs that are free tonight, checked, and put back together before the finish time.",
  sections: [
    {
      heading: "Your PC asks us for work",
      body: [
        "The NightShift app on your PC checks in with us every few seconds and asks if there is work. We never connect to your PC. You don't open any ports on your router.",
        "Outside your night window, or when you press pause, the app stops asking.",
      ],
    },
    {
      heading: "Only approved job types run",
      body: [
        "Buyers can't send code. They pick one of our job types and send data and settings. Right now there are two: batch text embeddings and batch image captioning or resizing.",
        "Each job type is a fixed program that we build, version and sign. Your PC checks our signature before it runs anything.",
      ],
    },
    {
      heading: "Each piece runs in a locked box",
      body: [
        "Every piece runs inside a container with no internet, no access to your files, a memory limit and a time limit. When the piece is done, the container is deleted.",
      ],
    },
    {
      heading: "We check the answers",
      body: [
        "About 1 piece in 10 runs again on a different PC and we compare the results. A PC that keeps giving wrong answers loses trust, and if it's bad enough we pause it.",
        "The 12% verification buffer in every price pays for these checks.",
      ],
    },
    {
      heading: "We protect the finish time",
      body: [
        "If a PC goes offline, its piece goes to another PC. If a piece is running slow close to the deadline, we start a copy on a second PC and use whichever finishes first.",
        "If the job still isn't done on time, the buyer pays ₹0. Owners are still paid for the work their PCs finished. We take the loss.",
      ],
    },
    {
      heading: "What a PC can see",
      body: [
        "A PC sees the piece of data it is working on, in plain form. It never sees the whole job. That's why we say: don't send data you couldn't show a stranger.",
        "Job data is encrypted when stored, and we delete inputs and results after 7 days.",
      ],
    },
  ] satisfies Section[],
};

// ─── Owners ────────────────────────────────────────────────────────────────

export const owners = {
  meta: nav[1]!,
  heading: "Put your idle GPU to work at night",
  intro: "If your PC sits idle while you sleep, it can run small AI jobs for people who need them. You pick the hours and your hourly rate. We pay your electricity on top.",
  sections: [
    {
      heading: "You stay in control",
      body: [
        "Set a night window, for example 11 PM to 7 AM. Press pause any time, and the app finishes or hands back its current piece and stops.",
        "You set your own hourly rate. You can see every piece your PC ran and what it earned.",
      ],
    },
    {
      heading: "Electricity is paid first",
      body: [
        "Your earnings show electricity as its own line, so you can see your power bill is covered. At the default ₹9 a unit: about {power3060} an hour for an RTX 3060 PC, {power4070} for an RTX 4070 PC and {power4090} for an RTX 4090 PC.",
        "Pay a different rate for power? Set your own tariff. Once the app has measured your PC's real power draw, we use that instead of the defaults.",
      ],
    },
    {
      heading: "What runs on your PC",
      body: [
        "Only our approved job types, inside a locked container with no internet and no access to your files. Never code from a buyer. The app checks our signature on every task and refuses anything that isn't signed.",
      ],
    },
    {
      heading: "What you need",
      body: [
        "A Windows or Linux PC with an NVIDIA GPU, Docker, and a steady internet connection at night. For the demo, a laptop without an NVIDIA GPU can join in CPU mode, but it earns much less.",
      ],
    },
    {
      heading: "Cyber cafés and college labs",
      body: [
        "Got 20 PCs that sit idle after closing time? Each one can join as its own machine, all under one account.",
      ],
    },
    {
      heading: "Getting paid",
      body: [
        "Payouts will go to your UPI ID. In this prototype, payouts are simulated: you see the amounts, but no money moves.",
      ],
    },
    {
      heading: "GPU on EMI (simulator)",
      body: [
        "Thinking of buying a GPU on EMI? The simulator shows how much of each month's EMI your network earnings could cover, based on your rate and hours. It's a demo. We don't lend money or arrange loans.",
      ],
    },
  ] satisfies Section[],
  cta: "Join the waitlist as an owner",
};

// ─── Builders ──────────────────────────────────────────────────────────────

export const builders = {
  meta: nav[2]!,
  heading: "Batch AI jobs at a fixed price",
  intro: "Send your data, pick a job type, and get a price and a finish time before anything runs. If we miss the time, you pay ₹0.",
  sections: [
    {
      heading: "What you can run today",
      body: [
        "Batch text embeddings with a small sentence-transformers model. Good for search, clustering and deduplication.",
        "Batch image captioning or resizing.",
        "That's the full list for now. We add job types one at a time, because each one has to be safe to run on someone else's PC.",
      ],
    },
    {
      heading: "You send data, not code",
      body: [
        "You choose a job type and its settings, then upload your files. You can't send scripts, and that rule is what keeps owners safe.",
      ],
    },
    {
      heading: "The quote",
      body: [
        "Before you confirm, you see the total and every line in it: the owners' pay, their electricity, the verification buffer and our fee. Sample quote: {sampleQuote}.",
        "Miss the finish time and the job is free. The refund shows up on your invoice without you asking.",
      ],
    },
    {
      heading: "Be careful with private data",
      body: [
        "Your job is split into pieces, and each PC only sees its own piece. But it does see that piece in plain form while it works on it. Don't send passwords, medical records or anything you couldn't show a stranger.",
        "Inputs and results are deleted after 7 days.",
      ],
    },
    {
      heading: "Good fit, bad fit",
      body: [
        "Good fit: research datasets, college projects, and batch jobs that can finish overnight.",
        "Bad fit: live chatbots, anything that must answer in under a second, training large models, and secret data.",
      ],
    },
  ] satisfies Section[],
  cta: "Join the waitlist as a builder",
};

// ─── Pricing ───────────────────────────────────────────────────────────────

export const pricing = {
  meta: nav[3]!,
  heading: "What a job costs, line by line",
  intro: "We start with the owner's electricity, add their hourly rate, add 12% to pay for checking the results, then add our 25% fee. The total is rounded up to the next rupee, and every job costs at least {minJob}.",
  formulaHeading: "The formula",
  formula: [
    "Electricity per hour = the PC's power draw in kW × the tariff per unit (kWh)",
    "Owner cost per hour = electricity per hour + the owner's hourly rate",
    "Job cost = GPU hours × owner cost per hour, added up over every piece",
    "With checks = job cost + 12% verification buffer",
    "Price = with checks + 25% NightShift fee, rounded up to the rupee",
    "Minimum price per job: {minJob}",
  ],
  drawHeading: "Default power draw",
  drawNote: "These are whole-PC numbers while the GPU is busy. Once the app measures your real draw, we use that.",
  calculatorHeading: "Try it",
  calculatorNote: "Owners start at our default rate of {defaultRate} an hour, and each owner can set their own. Payments are simulated in this prototype.",
  perHourHeading: "All-in price per GPU-hour",
  perHourIntro: "What one GPU-hour costs you with everything included: the owner's rate ({defaultRate}), their electricity at ₹9 a unit, the 12% verification buffer and our 25% fee.",
  perHourNote: "A job's total is this rate × its GPU-hours, rounded up to the next rupee. For example, 14 GPU-hours on an RTX 4070 PC comes to {sample14Total}.",
  perHourColumns: { pc: "PC", perHour: "All-in per GPU-hour" },
  calculator: {
    gpuLabel: "GPU class",
    hoursLabel: "GPU hours",
    hoursHint: "Total GPU time across all pieces of the job.",
    tariffLabel: "Electricity tariff (₹ per unit)",
    tariffHint: "₹9 is our default. Use your own if you know it.",
    rateLabel: "Owner's rate (₹ per hour)",
    rateHint: "{defaultRate} is our default. Owners can change it.",
    invalidHours: "Enter hours as a number, like 10 or 2.5.",
    invalidRupees: "Enter rupees as a number, like 9 or 9.50.",
    outOfRange: "That number is outside what the calculator handles.",
    breakdownHeading: "Breakdown",
    lines: {
      ownerPay: "Owner's pay",
      electricity: "Owner's electricity",
      buffer: "Verification buffer (12%)",
      fee: "NightShift fee (25%, plus round-up and any top-up to the minimum)",
      total: "Total you pay",
    },
    ownerGets: "The owner receives {ownerReceives}, and {electricity} of that is their electricity.",
    perHour: "That's {perHour} per GPU-hour, all in.",
  },
  notesHeading: "Things to know",
  notes: [
    "If the job isn't done by the finish time on your quote, you pay ₹0.",
    "The fee line includes the round-up to the next rupee, so it can be a few paise above 25%.",
    "Every job costs at least {minJob}. A smaller job is topped up to {minJob}, and the top-up goes on our fee line: owners are paid exactly the same.",
    "Prices are worked out in paise, with whole-number maths. Nothing is lost to rounding, and every line in the breakdown adds up to the total.",
  ],
};

// ─── Time-Bank ─────────────────────────────────────────────────────────────

export const timeBank = {
  meta: nav[4]!,
  heading: "Lend your GPU now, borrow several later",
  intro: "Time-Bank is for students. Your PC works for the network at night and earns credits. Later, you spend them on a job of your own that runs on several GPUs at once.",
  sections: [
    {
      heading: "Earning credits",
      body: [
        "Switch your PC to earn credits in your dashboard. Its pieces of other people's jobs then earn credits instead of pay for GPU time. Your electricity is still paid back in rupees.",
        "Credits count the work your PC does, not the hours it takes. They're in standard GPU-hours: one is the work an RTX 3060 does in an hour. So a faster GPU earns more in a night, a slower one less, and the same work always earns the same.",
        "An RTX 3060 working from midnight to 6 AM earns about {tbHostel}.",
        "New credits wait until the work is verified. Either its check matched; or nobody else's PC could check it and your PC then passed a known-answer test; or it wasn't picked for a check and a day has passed with your PC in good standing.",
      ],
    },
    {
      heading: "Spending credits",
      body: [
        "Pick \"Pay with Time-Bank credits\" on a quote. Your job's pieces run in parallel on as many GPUs as are free, so a big batch finishes fast. That's your temporary cluster.",
        "A job costs the work in it, in standard GPU-hours, plus the 12% verification buffer. For example, a job with 12 standard GPU-hours of work during a hackathon (4 GPUs for 3 hours) costs {tbCluster}.",
        "Your job runs on the same approved job types as everyone else's.",
      ],
    },
    {
      heading: "The rules",
      body: [
        "Credits aren't money. You can't cash them out, sell them or give them to someone else.",
        "Credits expire 6 months after you earn them. The oldest are spent first.",
        "If work turns out wrong, or its check can't run before the job's data is deleted, its credits are taken back. The same goes for unverified credits of a PC that's quarantined.",
        "In this prototype, credits are tracked in a demo wallet.",
      ],
    },
  ] satisfies Section[],
  cta: "Join the waitlist",
};

// ─── FAQ ───────────────────────────────────────────────────────────────────

export const faq = {
  meta: nav[5]!,
  heading: "Questions people ask us",
  items: [
    {
      q: "Can a buyer run their own code on my PC?",
      a: ["No. Buyers pick from our approved job types and send data and settings only. Your PC refuses any task that isn't signed by us."],
    },
    {
      q: "Can a job see my files or use my internet?",
      a: ["No. Each piece runs in a container with no internet and no access to your files, with limits on memory and time."],
    },
    {
      q: "Do I need to open ports on my router?",
      a: ["No. The app on your PC asks us for work. We never connect to your PC."],
    },
    {
      q: "Will it slow down my PC?",
      a: ["It only runs inside the night window you set, and you can pause it any time. While a piece is running, the GPU is busy, so don't plan to game during your window."],
    },
    {
      q: "How much will I earn?",
      a: [
        "It depends on your rate, your hours, and whether there are jobs that night. We don't promise a number.",
        "You always get your electricity on top of your rate.",
      ],
    },
    {
      q: "What happens if the job is late?",
      a: ["The buyer pays ₹0. Owners are still paid for the work their PCs finished. NightShift takes the loss."],
    },
    {
      q: "Is my job data private?",
      a: [
        "Partly. Each PC sees only its own piece of your job, but it does see that piece in plain form while it works on it. Don't send anything you couldn't show a stranger.",
        "We encrypt stored data and delete inputs and results after 7 days.",
      ],
    },
    {
      q: "Is real money involved?",
      a: ["Not yet. This is a prototype. Payments, UPI payouts and EMI are all simulated."],
    },
    {
      q: "Can I join with a laptop?",
      a: ["For the demo, yes. Laptops without an NVIDIA GPU run in CPU mode. They're much slower and earn much less."],
    },
    {
      q: "How do I delete my account?",
      a: ["From your dashboard. You can also download a copy of your data there first. Financial records stay in our ledger, without your email attached."],
    },
  ] satisfies Faq[],
};

// ─── Waitlist ──────────────────────────────────────────────────────────────

export const waitlist = {
  meta: footerNav[0]!,
  heading: "Join the waitlist",
  intro: "We'll email you when NightShift is ready for more people. That's the only thing we'll use your email for.",
  emailLabel: "Email",
  interestLabel: "I want to",
  interests: {
    owner: "Earn with my GPU",
    buyer: "Run AI jobs",
    both: "Both",
  },
  consentLabel: "Email me about NightShift. I can ask you to delete my email any time.",
  submit: "Join the waitlist",
  submitting: "Adding you...",
  done: "Done. If that email wasn't already on the list, it is now. We'll write when there's a spot for you.",
  errors: {
    email: "That email address doesn't look right.",
    interest: "Pick one option.",
    consent: "Tick the box so we're allowed to email you.",
    rateLimited: "Too many tries from your network. Wait an hour and try again.",
    generic: "Something went wrong on our side. Try again in a minute.",
  },
};

// ─── Privacy ───────────────────────────────────────────────────────────────

export const privacy = {
  meta: footerNav[1]!,
  heading: "Privacy",
  intro: "This is how the NightShift prototype handles your data. We follow India's Digital Personal Data Protection Act, 2023 (DPDP), and we collect as little as we can.",
  sections: [
    {
      heading: "What we collect",
      body: [
        "Your email address, to log you in. If you log in with Google, we only ask Google for your email. We don't store your name or photo.",
        "If you're an owner: your PC's GPU model, speed score, power draw, online times and earnings, and your payout UPI ID (we keep a scrambled copy to make sure it's on one account only, plus a masked version to show you).",
        "A scrambled (hashed) ID of each PC's device and the network it connects from, so we can spot one person running many fake accounts. We don't store the raw ID or IP.",
        "If you're a buyer: the job settings and files you upload, and your job history.",
        "A scrambled (hashed) version of your IP address in our security log, so we can spot abuse. We don't store the IP itself.",
      ],
    },
    {
      heading: "Why we collect it",
      body: [
        "To log you in, run your jobs, pay owners, keep the network safe, and email you about NightShift if you asked us to. We don't sell data and we don't show ads.",
      ],
    },
    {
      heading: "Who else sees it",
      body: [
        "PCs on the network see the piece of a job they work on, in plain form, while they work on it.",
        "To check that PCs are honest, a piece of your job may be run again on one or two other PCs. Once it's checked, it may also go to one more PC as a known-answer test. Both only happen while your job's data still exists (up to 7 days after it ends). You can turn the known-answer reuse off when you quote a job.",
        "Our service providers store or process data for us: Vercel (hosting), Neon (database), Upstash (rate limiting), Resend (login emails) and Sentry (error reports, with personal details removed).",
      ],
    },
    {
      heading: "How long we keep it",
      body: [
        "Job inputs and results: 7 days, then deleted.",
        "Your account: until you delete it.",
        "Ledger records of payments and payouts are kept after deletion, because money records have to be. Your email is removed from them.",
      ],
    },
    {
      heading: "Your rights",
      body: [
        "You can download your data and delete your account from your dashboard. You can also ask us to correct your data, or complain if you think we got something wrong.",
        "{contact}",
      ],
    },
    {
      heading: "Changes",
      body: ["This is a prototype, and this page will change before we take real payments. We'll show the date of the last change at the top when it does."],
    },
  ] satisfies Section[],
  contactLine: "Write to us at {email}.",
};

// ─── Terms ─────────────────────────────────────────────────────────────────

export const terms = {
  meta: footerNav[2]!,
  heading: "Terms",
  intro: "These are the rules for using the NightShift prototype. They will change before we take real payments.",
  sections: [
    {
      heading: "This is a prototype",
      body: [
        "Payments, UPI payouts, credits and EMI are simulated. No real money moves. Don't rely on NightShift for anything important yet.",
      ],
    },
    {
      heading: "If you run jobs",
      body: [
        "Only upload data you have the right to use. No illegal content, nothing that harms people, and no personal data of others without their consent.",
        "Remember that PCs on the network see the piece of data they work on.",
      ],
    },
    {
      heading: "If you share a GPU",
      body: [
        "Only connect machines you own or are allowed to use. If it's a college lab or a cyber café, get permission from whoever runs it.",
        "You pay your own electricity bill. We add the electricity line to your earnings, but we can't control your tariff or your hardware.",
        "We may pause a machine that gives wrong answers, goes offline often, or looks unsafe.",
      ],
    },
    {
      heading: "Accounts",
      body: [
        "One person per account. Keep your login email safe, because anyone who can read it can log in. We can suspend accounts that break these rules.",
      ],
    },
    {
      heading: "No promises beyond what we say",
      body: [
        "We promise what's on your quote: the price, and ₹0 if we miss the finish time. Beyond that, the prototype comes as it is, and we can't promise it will always be up or always be right.",
      ],
    },
  ] satisfies Section[],
};

export const allPages = [home.meta, ...nav, ...footerNav] as const;
