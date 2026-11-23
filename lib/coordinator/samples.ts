import { desc, eq } from "drizzle-orm";
import { benchmarkSamples, nodes } from "@/lib/db/schema";
import { medianScore, SAMPLE_WINDOW } from "./challenge";
import type { Q } from "./lifecycle";

/**
 * Records one timed canary run (lease issued → result in, on the
 * coordinator's clock) and updates the PC's speed score: the median of its
 * last SAMPLE_WINDOW runs, outliers dropped, once there are enough.
 */
export async function recordSample(q: Q, nodeId: string, items: number, millis: number): Promise<number | null> {
  if (items <= 0) return null;
  await q.insert(benchmarkSamples).values({ nodeId, items, millis: Math.max(1, Math.round(millis)) });
  const recent = await q
    .select({ items: benchmarkSamples.items, millis: benchmarkSamples.millis })
    .from(benchmarkSamples)
    .where(eq(benchmarkSamples.nodeId, nodeId))
    .orderBy(desc(benchmarkSamples.createdAt), desc(benchmarkSamples.id))
    .limit(SAMPLE_WINDOW);
  const score = medianScore(recent);
  if (score !== null) await q.update(nodes).set({ benchmarkScore: score }).where(eq(nodes.id, nodeId));
  return score;
}
