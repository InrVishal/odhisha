# Calibrating the speed scale on a real RTX 3060

Speed scores are on a scale where an RTX 3060 PC is meant to score **1000**.
Today that anchor is an estimate: `REFERENCE_CHALLENGE_ITEMS_PER_SEC = 50` in
`lib/coordinator/challenge.ts` (items per second on one canary, container
start included). Scores already compare PCs fairly with each other, because
they all use the same anchor. The absolute numbers aren't right until someone
times a real RTX 3060.

While the scale is uncalibrated, Time-Bank credit weighting stays **frozen
at 1.0×** (`CREDIT_WEIGHTING_FROZEN` in `lib/timebank.ts`): every PC earns one
standard GPU-hour per verified hour. Speed is used only to plan work
(finish-time estimates, lease length, matching).

## What you need

- One PC with an RTX 3060 (desktop, 12 GB), a normal mid-range CPU, Docker
  with the NVIDIA container toolkit, and the agent installed from this repo.
- An account on a NightShift deployment you control (a preview is fine).
- Database access to that deployment (read-only is enough).

## Steps

1. **Use the production images.** The agent must run the digest-pinned
   `text_embeddings` image from `lib/coordinator/workloads.ts`. Once GPU
   (CUDA) images replace the CPU builds, calibrate again: the anchor is
   "the image we ship, on an RTX 3060".
2. **Register the PC** as class `rtx3060` and set its window to all day.
3. **Collect at least 20 timed canaries.** A PC gets a canary on its first
   lease, then about 1 lease in 20 (at most hourly). To collect faster on a
   preview, set the PC's `last_canary_at` and `benchmark_score` to NULL in
   the database before each lease (the integration tests do the same). Each
   passed canary adds a row to `benchmark_sample` (items, millis on the
   coordinator's clock).
4. **Keep conditions honest:** no other GPU load, the PC on mains power, a
   normal home connection (the timing includes the network, like everyone
   else's).
5. **Work out the anchor:**

   ```sql
   select percentile_cont(0.5) within group (order by items * 1000.0 / millis) as items_per_sec,
          count(*) as runs,
          stddev_samp(items * 1000.0 / millis) / avg(items * 1000.0 / millis) as cv
   from benchmark_sample
   where node_id = '<the RTX 3060 node id>' and items >= 200;
   ```

   Use only full-size pieces (`items >= 200`): small pieces are dominated by
   container start-up.
6. **Accept the measurement only if** there are at least 20 runs and the
   coefficient of variation (`cv`) is under 0.15. Otherwise find out what's
   noisy first.
7. **Update the constant** to the median, rounded to a whole number, in one
   pull request with the measured numbers in its description. Then recompute
   every PC's score from its samples:

   ```sql
   -- Shown for review; run through a migration, not by hand.
   -- New score per sample = round(1000 * (items * 1000.0 / millis) / <new anchor>).
   ```

   A migration (or a one-off script) recalculates `node.benchmark_score` from
   the last 5 samples of each PC, with the same median-and-outliers rule as
   `medianScore`.
8. **Repeat on a second RTX 3060** if you can. The two medians should be
   within 15% of each other. If they aren't, the anchor isn't stable yet.

## When to unfreeze credit weighting

Only when all of these hold, and in its own pull request:

- the anchor was measured as above;
- at least 50 PCs have a measured score, at least 5 in each GPU class;
- for 90% of those PCs, their last 5 runs have a coefficient of variation
  under 0.2 (the scores are stable, not just measured once);
- no PC's score has moved by more than 2× in the last 30 days without a
  hardware change.

Then set `CREDIT_WEIGHTING_FROZEN = false`. The weighting code (capped at 10×
an RTX 3060) is already written and tested. Update the Time-Bank page copy in
the same pull request, since it says every GPU earns the same.
