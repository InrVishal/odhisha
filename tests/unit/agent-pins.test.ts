import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WORKLOAD_TYPES, WORKLOADS } from "@/lib/coordinator/workloads";

/**
 * The coordinator signs `image` into every task, and the agent refuses any
 * task whose image isn't exactly the digest pinned in its own whitelist. The
 * two lists live in two languages, so this test keeps them identical.
 */
function agentWhitelist(): Record<string, string> {
  const src = readFileSync(path.resolve("agent/src/nightshift_agent/trust.py"), "utf8");
  const block = /WHITELIST: dict\[str, WorkloadPin\] = \{([\s\S]*?)\n\}/.exec(src)?.[1] ?? "";
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/"(\w+)":\s*WorkloadPin\(\s*image="([^"]+)"/g)) out[m[1]!] = m[2]!;
  return out;
}

const DIGEST = /^[a-z0-9./_-]+@sha256:[0-9a-f]{64}$/;

describe("workload image pins", () => {
  const agent = agentWhitelist();

  it("every pinned image is a digest, never a tag", () => {
    for (const t of WORKLOAD_TYPES) {
      const img = WORKLOADS[t].image;
      if (img !== null) expect(img, t).toMatch(DIGEST);
    }
    for (const [t, img] of Object.entries(agent)) expect(img, t).toMatch(DIGEST);
  });

  it("the coordinator and the agent pin exactly the same images", () => {
    const server = Object.fromEntries(WORKLOAD_TYPES.filter((t) => WORKLOADS[t].image).map((t) => [t, WORKLOADS[t].image]));
    expect(agent).toEqual(server);
  });

  it("the agent only whitelists workloads the coordinator knows", () => {
    for (const t of Object.keys(agent)) expect(WORKLOAD_TYPES as readonly string[]).toContain(t);
  });
});
