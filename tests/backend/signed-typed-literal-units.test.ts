// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * Unit coverage for the helpers behind signed typed literals: the duration
 * parser's sign, the INT64_MIN lowering, and the integer type ranges.
 */

import { describe, it, expect } from "vitest";
import { parseTimeLiteral } from "../../src/project-model.js";
import { formatIntegerLiteral } from "../../src/backend/codegen-utils.js";
import { integerTypeRange } from "../../src/literal-utils.js";

describe("signed typed literal helpers", () => {
  it("parseTimeLiteral honours a sign after the prefix", () => {
    expect(parseTimeLiteral("T#-14ms").nanoseconds).toBe(-14_000_000);
    expect(parseTimeLiteral("TIME#+1s").nanoseconds).toBe(1_000_000_000);
    expect(parseTimeLiteral("T#-1h2m").nanoseconds).toBe(-3_720_000_000_000);
    expect(parseTimeLiteral("T#14ms").nanoseconds).toBe(14_000_000);
  });

  it("formatIntegerLiteral lowers signed payloads and INT64_MIN without overflow", () => {
    expect(formatIntegerLiteral("-128", -128)).toBe("-128");
    expect(formatIntegerLiteral("+5", 5)).toBe("5");
    expect(formatIntegerLiteral("-9223372036854775807", 0)).toBe(
      "-9223372036854775807",
    );
    expect(formatIntegerLiteral("-9223372036854775808", 0)).toBe(
      "(-9223372036854775807LL - 1)",
    );
  });

  it("integerTypeRange gives each integer type's bounds", () => {
    expect(integerTypeRange("SINT")).toEqual({ min: -128n, max: 127n });
    expect(integerTypeRange("usint")).toEqual({ min: 0n, max: 255n });
    expect(integerTypeRange("LINT")).toEqual({
      min: -9223372036854775808n,
      max: 9223372036854775807n,
    });
    expect(integerTypeRange("ULINT")?.max).toBe(18446744073709551615n);
    expect(integerTypeRange("REAL")).toBeUndefined();
  });
});
