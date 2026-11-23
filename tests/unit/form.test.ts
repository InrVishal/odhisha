import { describe, expect, it } from "vitest";
import { formField } from "@/lib/form";

describe("formField", () => {
  it("reads a field from real form data", () => {
    const f = new FormData();
    f.set("email", "a@b.in");
    expect(formField(f, "email")).toBe("a@b.in");
    expect(formField(f, "missing")).toBeNull();
  });

  // ZAP's integer-overflow probe sent a number where the form goes: the
  // action must see "no fields" (and fail validation), not crash with a 500.
  it.each([2147483647, "2147483647", null, undefined, { get: () => "x" }, ["email"]])("treats %j as no form at all", (bogus) => {
    expect(formField(bogus, "email")).toBeNull();
  });
});
