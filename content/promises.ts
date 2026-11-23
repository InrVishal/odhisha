/**
 * Things the public copy promises that the code must deliver. Rendered as a
 * checklist at the top of COPY.md. Each phase sets `done` (and names the
 * test that proves it) for what it ships. A promise is only ticked when a
 * test or a check backs it.
 */
export interface Promise_ {
  text: string;
  phase: number;
  done: boolean;
  /** Where it's proven, once done. */
  proof?: string;
}

export const promises: Promise_[] = [
  // Phase 2
  { text: "Prices follow the published formula in whole paise; electricity is covered first; breakdown lines add up to the total", phase: 2, done: true, proof: "tests/unit/pricing.test.ts" },
  { text: "Default owner rate ₹25/hr; all-in price per GPU-hour shown on the pricing page", phase: 2, done: true, proof: "tests/unit/pricing.test.ts, tests/e2e/site.spec.ts" },
  { text: "Time-Bank maths: credits in standard GPU-hours (RTX 3060 = 1), weighted by benchmark, capped at 10×, rounding never creates credit", phase: 2, done: true, proof: "tests/unit/timebank.test.ts" },
  { text: "Waitlist only used to email about NightShift; same reply for new and existing emails", phase: 2, done: true, proof: "tests/integration/waitlist.test.ts, tests/e2e/site.spec.ts" },

  // Phase 3
  { text: "Quote shows price and finish time before confirming; ₹0 if the job is late, refunded automatically", phase: 3, done: true, proof: "tests/integration/coordinator.test.ts (lifecycle, deadline guarantee)" },
  { text: "Owners are still paid for finished work when a job is late; NightShift takes the loss", phase: 3, done: true, proof: "tests/integration/coordinator.test.ts (deadline guarantee)" },
  { text: "Pieces from offline PCs are re-assigned; a backup copy starts when a piece runs slow near the deadline", phase: 3, done: true, proof: "tests/integration/coordinator.test.ts (timeouts, backups), tests/unit/scheduler.test.ts" },
  { text: "Job data encrypted when stored; inputs and results deleted after 7 days", phase: 3, done: true, proof: "tests/unit/crypto.test.ts, tests/integration/coordinator.test.ts (data at rest and retention)" },
  { text: "Measured watts replace the class default once a node reports them; owners can set their own tariff and rate", phase: 3, done: true, proof: "tests/integration/coordinator.test.ts, tests/unit/scheduler.test.ts" },
  { text: "Owner payouts can never add up to more than the buyer's quote", phase: 3, done: true, proof: "tests/unit/scheduler.test.ts (property test)" },

  // Phase 4
  { text: "The app asks for work (no inbound ports), stops outside the night window and on pause", phase: 4, done: true, proof: "agent/tests/test_runner.py (pause, window, finish the current piece first)" },
  { text: "Every task signed by us and checked by the app; unsigned tasks refused", phase: 4, done: true, proof: "agent/tests/test_trust.py, tests/live/agent-preview.ts" },
  { text: "Locked container: no internet, no file access, memory and time limits, deleted after each piece", phase: 4, done: true, proof: "agent/tests/test_sandbox_docker.py (real containers), agent/tests/test_sandbox.py" },
  { text: "Benchmark on join, normalised so an RTX 3060 scores 1000 (Time-Bank weighting depends on it)", phase: 4, done: false },
  { text: "CPU mode for laptops without an NVIDIA GPU", phase: 4, done: true, proof: "agent/tests/test_runner.py (CPU mode), tests/live/agent-preview.ts (CPU node)" },

  // Phase 5
  { text: "Invoices (PDF) show the deadline refund line automatically", phase: 5, done: true, proof: "tests/unit/pdf.test.ts, tests/integration/dashboard.test.ts (refund line), tests/e2e/dashboard.spec.ts" },
  { text: "Owner earnings show electricity as its own line; owners see every piece their PC ran", phase: 5, done: true, proof: "tests/integration/dashboard.test.ts (ownerPieces, earningsByNode), tests/e2e/dashboard.spec.ts" },
  { text: "Dashboard: download your data and delete your account; ledger keeps records without your email", phase: 5, done: true, proof: "tests/integration/account.test.ts, tests/e2e/dashboard.spec.ts" },

  // Phase 6
  { text: "About 1 piece in 10 re-run on a second PC; trust scores; bad PCs paused", phase: 6, done: true, proof: "tests/unit/verify.test.ts, tests/integration/verification.test.ts, tests/live/agent-preview.ts (second real agent checks the first)" },
  // Credits are earned from phase 7 on; phase 6 already takes back pay for work that fails its check.
  { text: "Only work that passes checks earns Time-Bank credits", phase: 7, done: false },

  // Phase 7
  { text: "Time-Bank wallet (demo): earn and spend credits; no cash-out, sale or transfer", phase: 7, done: false },
  { text: "GPU-on-EMI simulator (demo only, no lending)", phase: 7, done: false },

  // Phase 8
  { text: "Sentry error reports with personal details removed", phase: 8, done: false },
];
