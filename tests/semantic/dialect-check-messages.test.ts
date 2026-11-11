/**
 * The messages of the profile and `--feature` checks, as DIALECTS.md
 * ("Checks") lists them: every one is printed exactly so.
 */
import { describe, it, expect } from "vitest";
import { resolveDialect } from "../../src/dialect.js";
import { KNOWN_FEATURES } from "../../src/dialect.js";

const KNOWN = KNOWN_FEATURES.join(", ");

/** The message resolveDialect throws for one profile file holding `text`. */
function fileError(text: string, path = "p.json"): string {
  try {
    resolveDialect({ dialectFiles: [path] }, () => text);
  } catch (e) {
    return (e as Error).message;
  }
  return "";
}

describe("dialect check messages", () => {
  it("names an empty --feature id", () => {
    for (const spec of ["+", "-", ""]) {
      expect(() => resolveDialect({ features: [spec] })).toThrow(
        `--feature '${spec}' names no feature: write +id, -id or id (known: ${KNOWN})`,
      );
    }
    expect(() => resolveDialect({ features: ["+nope"] })).toThrow(
      `unknown feature 'nope' in --feature (known: ${KNOWN})`,
    );
  });

  it("prints each profile problem as listed", () => {
    expect(fileError("[1]")).toBe(
      "dialect file p.json: a profile must be a JSON object",
    );
    expect(fileError('{"id":"a","x":1}')).toBe(
      "dialect file p.json: key 'x' is not known",
    );
    expect(fileError('{"id":""}')).toBe(
      "dialect file p.json: 'id' must be a non-empty string",
    );
    expect(fileError('{"id":"a","name":3}')).toBe(
      "dialect file p.json: 'name' must be a string",
    );
    expect(fileError('{"id":"a","extends":""}')).toBe(
      "dialect file p.json: 'extends' must be a non-empty string",
    );
    expect(fileError('{"id":"a","features":"union"}')).toBe(
      "dialect file p.json: 'features' must be an array of strings",
    );
    expect(fileError('{"id":"a","semantics":[]}')).toBe(
      "dialect file p.json: 'semantics' must be an object",
    );
    expect(fileError('{"id":"a","semantics":{"k":1}}')).toBe(
      "dialect file p.json: semantics key 'k' is not known",
    );
  });

  it("prints a read error with the file or folder", () => {
    expect(() =>
      resolveDialect({ dialectFiles: ["gone.json"] }, () => {
        throw new Error("ENOENT");
      }),
    ).toThrow("dialect file gone.json: ENOENT");
    expect(() =>
      resolveDialect(
        { dialectPath: ["gone"] },
        () => "",
        () => {
          throw new Error("ENOENT");
        },
      ),
    ).toThrow("dialect path gone: ENOENT");
  });
});
