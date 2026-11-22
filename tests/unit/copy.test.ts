import { describe, expect, it } from "vitest";
import { copyValues, fill } from "@/content/derived";
import * as content from "@/content/site";
import { BANNED, collectStrings, countEmDashes, findBanned, findEmojiInHeadings, htmlToText } from "@/lib/copy/banned";

describe("banned-word matcher", () => {
  it.each([
    "A seamless experience",
    "We leverage idle GPUs",
    "Leveraging the network",
    "Unlock your potential",
    "This will revolutionise compute",
    "cutting edge GPUs",
    "State-of-the-art results",
    "A robust system",
    "a real game-changer",
    "Harness the power",
    "Elevate your workflow",
    "Let's delve into it",
    "Supercharged training",
    "Unleash your GPU",
    "next-gen compute",
    "Effortless setup",
    "a transformative idea",
    "pure synergy",
    "a holistic view",
    "In today’s fast-paced world, compute matters",
    "Whether you're a student or a startup",
    "It's not just a GPU, it's a business",
    "Say goodbye to cloud bills",
    "Look no further",
    "The future of compute",
    "At the intersection of AI and energy",
  ])("catches: %s", (text) => {
    expect(findBanned(text, "t").length).toBeGreaterThan(0);
  });

  it.each([
    "Your GPU earns while you sleep.",
    "We pay your electricity on top.",
    "A locked container with no internet.",
    "The futures market", // "the future of" only
    "Not just yet.",
  ])("leaves plain copy alone: %s", (text) => {
    expect(findBanned(text, "t")).toEqual([]);
  });

  it("covers every item in the brief's list", () => {
    expect(BANNED).toHaveLength(26);
  });
});

describe("heading and dash checks", () => {
  it("finds emoji in headings only", () => {
    expect(findEmojiInHeadings("<h2>Pricing 🚀</h2><p>ok 🚀</p>", "t")).toHaveLength(1);
    expect(findEmojiInHeadings("<h1 class='x'>Pricing</h1><p>🚀</p>", "t")).toHaveLength(0);
  });
  it("counts em dashes", () => {
    expect(countEmDashes("a — b — c - d")).toBe(2);
  });
  it("strips scripts, styles and tags", () => {
    expect(htmlToText("<p>Hi&nbsp;<b>there</b></p><script>leverage()</script><style>.robust{}</style>")).toBe("Hi there");
  });
});

describe("site copy", () => {
  const strings = [...collectStrings(content), ...collectStrings(copyValues)];

  it("contains no banned words", () => {
    expect(strings.flatMap(({ path, text }) => findBanned(text, path))).toEqual([]);
  });

  it("has no em dashes at all in source copy", () => {
    expect(strings.filter(({ text }) => text.includes("—")).map((s) => s.path)).toEqual([]);
  });

  it("every {placeholder} has a value", () => {
    for (const { path, text } of strings) {
      if (/{(contact|email|ownerReceives|perHour)}/.test(text)) continue; // filled at runtime
      expect(() => fill(text), path).not.toThrow();
    }
  });

  it("search descriptions are under 160 characters", () => {
    for (const p of content.allPages) expect(p.description.length, p.path).toBeLessThanOrEqual(160);
  });

  it("the sample quote and power numbers come from the pricing engine", () => {
    expect(copyValues.power4070).toBe("₹3.15");
    expect(copyValues.power3060).toBe("₹2.88");
    expect(copyValues.power4090).toBe("₹5.40");
    expect(copyValues.sampleQuote).toMatch(/^14 GPU-hours on RTX 4070 PCs .* ₹25 an hour comes to ₹552/);
    expect(copyValues.perHour4070).toBe("₹39.42");
    expect(copyValues.tbHostel).toBe("6 standard GPU-hours");
    expect(copyValues.tbDouble).toBe("2 standard GPU-hours");
    expect(copyValues.tbCluster).toBe("12 standard GPU-hours");
    expect(copyValues.sampleQuote).toContain("6:00 AM");
  });

  it("marks examples as examples", () => {
    expect(content.home.pillars[0]!.body).toMatch(/Sample quote/);
    expect(content.builders.sections.find((s) => s.heading === "The quote")!.body[0]).toMatch(/Sample quote/);
    expect(content.timeBank.sections[0]!.body.join(" ")).toMatch(/For example/);
    expect(content.timeBank.sections[1]!.body.join(" ")).toMatch(/for example/);
  });

  it("says demo mode where money is involved", () => {
    expect(content.site.demoBanner).toMatch(/simulated/);
    expect(content.owners.sections.find((s) => s.heading === "Getting paid")!.body.join(" ")).toMatch(/simulated/);
    expect(content.pricing.calculatorNote).toMatch(/simulated/);
  });

  it("says Time-Bank credits are standard GPU-hours, benchmark-weighted, and not cashable", () => {
    const tb = content.timeBank.sections.flatMap((s) => s.body).join(" ");
    expect(tb).toMatch(/standard GPU-hours/);
    expect(tb).toMatch(/One standard GPU-hour is one hour of work on an RTX 3060/);
    expect(tb).toMatch(/benchmark/);
    expect(tb).toMatch(/can.t cash them out/);
    expect(tb).not.toMatch(/credit-hour/);
  });

  it("names the team without a city", () => {
    expect(content.site.footer.team).toBe("Built by a small student team in India.");
    expect(strings.map((s) => s.text).join(" ")).not.toMatch(/Hyderabad/);
  });

  it("makes no social-proof claims", () => {
    const all = strings.map((s) => s.text).join("\n");
    expect(all).not.toMatch(/trusted by|as seen in|our customers|\b\d[\d,]*\+? (users|customers|owners|machines|PCs) (use|trust|have joined|are on)/i);
  });
});
