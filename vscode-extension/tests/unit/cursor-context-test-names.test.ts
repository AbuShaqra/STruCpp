// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
import { describe, it, expect } from "vitest";
import { getCursorContext } from "../../server/src/cursor-context.js";

describe("cursor context in a TEST block", () => {
  const scopeName = (source: string, line: number): string | undefined => {
    const ctx = getCursorContext({ errors: [], warnings: [] } as never, "t.st", line, 3, source);
    return ctx.kind === "top-level" ? undefined : ctx.pouScope.name;
  };

  it("names the scope by the decoded TEST name, in either quotes", () => {
    expect(scopeName("TEST 'it$'s a test'\n  x\nEND_TEST\n", 2)).toBe("it's a test");
    expect(scopeName('TEST "say $"hi$""\n  x\nEND_TEST\n', 2)).toBe('say "hi"');
    expect(scopeName("TEST 'plain'\n  x\nEND_TEST\n", 2)).toBe("plain");
  });
});
