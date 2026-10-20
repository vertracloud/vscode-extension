import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { APIApplicationDomain } from "@vertracloud/api-types/v1";
import { domainLabel, planLabel, primaryDomain } from "../src/domains";

function domain(overrides: Partial<APIApplicationDomain>): APIApplicationDomain {
  return {
    id: "d1",
    hostname: "example.com",
    apex: true,
    companion_of: null,
    redirect_to: null,
    redirect_status: 308,
    path_prefix: null,
    port: 80,
    status: "active",
    ssl_status: "active",
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("primaryDomain", () => {
  it("returns undefined for an empty or missing list", () => {
    assert.equal(primaryDomain([]), undefined);
    assert.equal(primaryDomain(undefined), undefined);
  });

  it("skips companions and redirects", () => {
    const list = [
      domain({ id: "w", hostname: "www.example.com", companion_of: "d1" }),
      domain({ id: "r", hostname: "old.example.com", redirect_to: "d1" }),
      domain({ id: "d1", hostname: "example.com" }),
    ];
    assert.equal(primaryDomain(list)?.id, "d1");
  });

  it("returns undefined when every entry is a companion or redirect", () => {
    assert.equal(primaryDomain([domain({ companion_of: "x" })]), undefined);
  });
});

describe("domainLabel", () => {
  it("adds port and prefix only when they differ from the default", () => {
    assert.equal(domainLabel(domain({})), "example.com");
    assert.equal(domainLabel(domain({ port: 8080, path_prefix: "/api" })), "example.com:8080/api");
  });
});

describe("planLabel", () => {
  it("formats the plan slug", () => {
    assert.equal(planLabel("pro"), "Pro");
    assert.equal(planLabel("enterprise-8"), "Enterprise 8");
  });
});
