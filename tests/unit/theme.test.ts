import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/** WCAG 2.x relative luminance and contrast ratio. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) =>
    c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  ) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const css = readFileSync(path.resolve(import.meta.dirname, "../../app/globals.css"), "utf8");
const token = (name: string): string => {
  const m = new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css);
  if (!m) throw new Error(`missing --color-${name}`);
  return m[1]!;
};

describe("theme", () => {
  it("uses the brief's brand colours", () => {
    expect(token("navy").toLowerCase()).toBe("#2a508d");
    expect(token("deep").toLowerCase()).toBe("#16264a");
    expect(token("lavender").toLowerCase()).toBe("#dde1ff");
    expect(token("orange").toLowerCase()).toBe("#ffa629");
  });

  // Every text-on-background pair the components use. 4.5:1 is WCAG AA for body text.
  it.each([
    ["lavender", "night"],
    ["lavender", "deep"],
    ["lavender", "navy"],
    ["mist", "night"],
    ["mist", "deep"],
    ["orange", "night"],
    ["orange", "deep"],
    ["deep", "orange"],
    ["danger", "night"],
    ["danger", "deep"],
  ])("%s text on %s passes WCAG AA (4.5:1)", (fg, bg) => {
    expect(contrast(token(fg), token(bg))).toBeGreaterThanOrEqual(4.5);
  });
});
