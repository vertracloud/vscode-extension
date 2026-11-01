import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { planLabel } from "../src/domains";

describe("planLabel", () => {
  it("turns plan slugs into readable names", () => {
    assert.equal(planLabel("starter-1"), "Starter 1");
    assert.equal(planLabel("starter-2"), "Starter 2");
    assert.equal(planLabel("pro-4"), "Pro 4");
    assert.equal(planLabel("business-12"), "Business 12");
    assert.equal(planLabel("enterprise-32"), "Enterprise 32");
  });
});
