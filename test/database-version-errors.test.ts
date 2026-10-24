import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { describeError } from "../src/l10n";

describe("describeError for the database version codes", () => {
  it("translates both codes without echoing the server text", () => {
    for (const code of ["INVALID_DATABASE_VERSION", "SNAPSHOT_VERSION_NEWER"]) {
      const text = describeError({ code, message: "RAW-SERVER-TEXT" });
      assert.ok(text.length > 0 && !text.includes("RAW-SERVER-TEXT") && !text.includes(code), code);
    }
  });
});
