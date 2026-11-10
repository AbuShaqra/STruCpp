// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
import { describe, it, expect } from "vitest";
import {
  transformStExpression,
  isIECVarType,
  extractSimpleValue,
  looksLikeIECVarChildren,
  forceExpressions,
  unforceExpression,
  forceCallError,
  type DAPVariable,
} from "../../client/src/debug-utils.js";

describe("transformStExpression", () => {
  it("uppercases simple identifiers", () => {
    expect(transformStExpression("my_var")).toBe("MY_VAR");
  });

  it("uppercases dotted paths", () => {
    expect(transformStExpression("tick_timer.in")).toBe("TICK_TIMER.IN");
  });

  it("uppercases multi-level dotted paths", () => {
    expect(transformStExpression("fb.member.sub")).toBe("FB.MEMBER.SUB");
  });

  it("preserves C++ boolean literals", () => {
    expect(transformStExpression("true")).toBe("true");
    expect(transformStExpression("false")).toBe("false");
  });

  it("preserves nullptr", () => {
    expect(transformStExpression("nullptr")).toBe("nullptr");
  });

  it("preserves IECVar methods", () => {
    expect(transformStExpression("my_var.force(42)")).toBe("MY_VAR.force(42)");
    expect(transformStExpression("my_var.unforce()")).toBe("MY_VAR.unforce()");
    expect(transformStExpression("x.is_forced()")).toBe("X.is_forced()");
  });

  it("preserves value_ member access", () => {
    expect(transformStExpression("my_var.value_")).toBe("MY_VAR.value_");
  });

  it("preserves numeric literals", () => {
    expect(transformStExpression("x + 42")).toBe("X + 42");
  });

  it("handles empty string", () => {
    expect(transformStExpression("")).toBe("");
  });

  it("is idempotent for already-uppercase expressions", () => {
    const expr = "TICK_TIMER.IN.force(42)";
    expect(transformStExpression(expr)).toBe(expr);
  });

  it("handles mixed case with operators", () => {
    expect(transformStExpression("a > 10 && b")).toBe("A > 10 && B");
  });

  it("handles sizeof preservation", () => {
    expect(transformStExpression("sizeof(x)")).toBe("sizeof(X)");
  });
});

describe("isIECVarType", () => {
  it("returns false for undefined", () => {
    expect(isIECVarType(undefined)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isIECVarType("")).toBe(false);
  });

  it("matches IEC_ elementary aliases", () => {
    expect(isIECVarType("IEC_BOOL")).toBe(true);
    expect(isIECVarType("IEC_INT")).toBe(true);
    expect(isIECVarType("IEC_REAL")).toBe(true);
    expect(isIECVarType("IEC_TIME")).toBe(true);
    expect(isIECVarType("IEC_SINT")).toBe(true);
    expect(isIECVarType("IEC_LREAL")).toBe(true);
  });

  it("matches namespace-qualified IEC_ types", () => {
    expect(isIECVarType("strucpp::IEC_BOOL")).toBe(true);
    expect(isIECVarType("strucpp::IEC_INT")).toBe(true);
    expect(isIECVarType("strucpp::IEC_TIME")).toBe(true);
  });

  it("matches IECVar<T> templates", () => {
    expect(isIECVarType("IECVar<short>")).toBe(true);
    expect(isIECVarType("IECVar<int>")).toBe(true);
    expect(isIECVarType("IECVar<bool>")).toBe(true);
  });

  it("matches namespace-qualified IECVar<T>", () => {
    expect(isIECVarType("strucpp::IECVar<short>")).toBe(true);
  });

  it("matches IECStringVar and IECWStringVar", () => {
    expect(isIECVarType("IECStringVar<254>")).toBe(true);
    expect(isIECVarType("IECWStringVar<100>")).toBe(true);
    expect(isIECVarType("strucpp::IECStringVar<254>")).toBe(true);
  });

  it("matches IEC_ENUM types", () => {
    expect(isIECVarType("IEC_ENUM_Var<TrafficLight>")).toBe(true);
    expect(isIECVarType("strucpp::IEC_ENUM_Var<TrafficLight>")).toBe(true);
  });

  it("rejects non-IEC types", () => {
    expect(isIECVarType("int")).toBe(false);
    expect(isIECVarType("std::string")).toBe(false);
    expect(isIECVarType("TON")).toBe(false);
    expect(isIECVarType("MyStruct")).toBe(false);
  });

  it("rejects IEC_ with only one uppercase letter", () => {
    // IEC_x wouldn't match — needs at least two uppercase letters
    expect(isIECVarType("IEC_a")).toBe(false);
  });
});

describe("extractSimpleValue", () => {
  it("extracts integer from struct display", () => {
    expect(extractSimpleValue("{value_ = 42}")).toBe("42");
  });

  it("extracts boolean from struct display", () => {
    expect(extractSimpleValue("{value_ = true, forced_ = false, forced_value_ = false}")).toBe("true");
  });

  it("extracts float from struct display", () => {
    expect(extractSimpleValue("{value_ = 3.14, forced_ = false, forced_value_ = 0}")).toBe("3.14");
  });

  it("returns undefined for undefined input", () => {
    expect(extractSimpleValue(undefined)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(extractSimpleValue("")).toBeUndefined();
  });

  it("returns undefined for string without value_", () => {
    expect(extractSimpleValue("some random text")).toBeUndefined();
  });

  it("returns undefined for nested struct value", () => {
    // If value_ starts with '{', it's a complex nested type — should return undefined
    expect(extractSimpleValue("{value_ = {x = 1, y = 2}, forced_ = false}")).toBeUndefined();
  });

  it("extracts negative numbers", () => {
    expect(extractSimpleValue("{value_ = -10, forced_ = false, forced_value_ = 0}")).toBe("-10");
  });
});

describe("looksLikeIECVarChildren", () => {
  function makeVar(name: string): DAPVariable {
    return { name, value: "0", variablesReference: 0 };
  }

  it("matches the single value_ member", () => {
    expect(looksLikeIECVarChildren([makeVar("value_")])).toBe(true);
  });

  it("matches with extra base class child", () => {
    // Some debuggers add an entry for the wrapper type
    const vars = [makeVar("IECVar<short>"), makeVar("value_")];
    expect(looksLikeIECVarChildren(vars)).toBe(true);
  });

  it("rejects no variables", () => {
    expect(looksLikeIECVarChildren([])).toBe(false);
  });

  it("rejects too many variables", () => {
    const vars = [makeVar("value_"), makeVar("IECVar<short>"), makeVar("extra")];
    expect(looksLikeIECVarChildren(vars)).toBe(false);
  });

  it("rejects non-IECVar children", () => {
    const vars = [makeVar("x"), makeVar("y")];
    expect(looksLikeIECVarChildren(vars)).toBe(false);
  });

  it("rejects a value_ beside a user member", () => {
    const vars = [makeVar("value_"), makeVar("OTHER")];
    expect(looksLikeIECVarChildren(vars)).toBe(false);
  });
});

describe("force expressions", () => {
  it("writes the value through value_, then captures it in the force table", () => {
    expect(forceExpressions("strucpp::g.INSTANCE0.X", "42")).toEqual([
      "strucpp::g.INSTANCE0.X.value_ = 42",
      "strucpp_force_capture((void*)&(strucpp::g.INSTANCE0.X), sizeof(strucpp::g.INSTANCE0.X.value_))",
    ]);
  });

  it("unforces through the force table", () => {
    expect(unforceExpression("X")).toBe("strucpp_unforce((void*)&(X))");
  });

  it("explains a refused force and accepts success", () => {
    expect(forceCallError("0")).toBeUndefined();
    expect(forceCallError(" 0 ")).toBeUndefined();
    expect(forceCallError("1")).toMatch(/full/);
    expect(forceCallError("2")).toMatch(/too large/);
    expect(forceCallError("3")).toMatch(/cannot be forced/);
    expect(forceCallError("5")).toMatch(/busy/);
    expect(forceCallError("<error>")).toMatch(/unexpected/);
  });
});
