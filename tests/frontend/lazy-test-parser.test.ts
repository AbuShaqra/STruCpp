/**
 * The test-file parser is built on first use, not at module load: each
 * parser construction runs chevrotain's self-analysis, which dominates a
 * cold start that never parses a test file.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { CstParser } from "chevrotain";

describe("lazy test parser", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("constructs only the source parser when the module loads", async () => {
    vi.resetModules();
    const analysis = vi.spyOn(
      CstParser.prototype as unknown as { performSelfAnalysis(): void },
      "performSelfAnalysis",
    );
    const mod = await import("../../src/frontend/parser.js");
    expect(analysis).toHaveBeenCalledTimes(1);

    mod.parse("PROGRAM P\nEND_PROGRAM\n");
    expect(analysis).toHaveBeenCalledTimes(1);

    const result = mod.parseTestSource('TEST "t"\nEND_TEST\n');
    expect(result.errors).toHaveLength(0);
    expect(analysis).toHaveBeenCalledTimes(2);
  });

  it("reuses one test parser across calls", async () => {
    const { getTestParser, parseTestSource } =
      await import("../../src/frontend/parser.js");
    const first = getTestParser();
    parseTestSource("TEST 'a'\nEND_TEST\n");
    expect(getTestParser()).toBe(first);
  });
});
