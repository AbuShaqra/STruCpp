// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * `TO_TIME_OF_DAY`, `TO_LTIME_OF_DAY`, `TO_DATE_AND_TIME` and
 * `TO_LDATE_AND_TIME` (IEC 61131-3 Ed. 3, Table 22: `TO_<type>` for every
 * elementary type name) are `TO_TOD`, `TO_LTOD`, `TO_DT` and `TO_LDT`, and a
 * typed `<x>_TO_<long name>` lowers to the short form's runtime function, in
 * every dialect.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import { StdFunctionRegistry } from "../../src/semantic/std-function-registry.js";

type Options = Parameters<typeof compile>[1];
const MODES: Array<[string, Options]> = [
  ["no dialect", {}],
  ["iec-3", { dialect: "iec-3" }],
  ["strict", { strict: true }],
];

// Long name, short name, a literal of the type.
const LONGS: Array<[string, string, string]> = [
  ["TIME_OF_DAY", "TOD", "TOD#12:00:00"],
  ["LTIME_OF_DAY", "LTOD", "LTOD#12:00:00"],
  ["DATE_AND_TIME", "DT", "DT#2000-01-01-00:00:00"],
  ["LDATE_AND_TIME", "LDT", "LDT#2000-01-01-00:00:00"],
];

function errorsOf(body: string, vars: string, options: Options): string[] {
  const src = `PROGRAM MAIN\nVAR\n${vars}\nEND_VAR\n${body}\nEND_PROGRAM\n`;
  return compile(src, options).errors.map((e) => e.message);
}

describe("long date and time conversion names: registry", () => {
  const registry = new StdFunctionRegistry();

  it.each(LONGS)("TO_%s is TO_%s", (long, short) => {
    const desc = registry.lookup(`TO_${long}`);
    const ref = registry.lookup(`TO_${short}`)!;
    expect(desc).toBeDefined();
    expect(desc!.cppName).toBe(ref.cppName);
    expect(desc!.specificReturnType).toBe(ref.specificReturnType);
    expect(desc!.isConversion).toBe(true);
    expect(desc!.params).toEqual(ref.params);
  });

  it.each(LONGS)("<x>_TO_%s lowers to TO_%s", (long, short) => {
    expect(registry.resolveConversion(`DINT_TO_${long}`)!.cppName).toBe(
      `TO_${short}`,
    );
    expect(registry.resolveConversion(`STRING_TO_${long}`)!.cppName).toBe(
      `TO_${short}`,
    );
    expect(registry.resolveConversion(`${long}_TO_DINT`)!.cppName).toBe(
      "TO_DINT",
    );
  });
});

describe.each(MODES)("long date and time conversion names (%s)", (_, opts) => {
  it.each(LONGS)("TO_%s gives a %s", (long, short, lit) => {
    const vars = `a : ${short}; b : ${long}; d : DINT; s : STRING := '${lit}';`;
    expect(
      errorsOf(
        `a := TO_${long}(d); b := TO_${long}(s); a := TO_${long}(IN := a);`,
        vars,
        opts,
      ),
    ).toEqual([]);
    expect(errorsOf(`d := TO_${long}(a);`, vars, opts)).toEqual(
      errorsOf(`d := TO_${short}(a);`, vars, opts),
    );
    expect(errorsOf(`d := TO_${long}(a);`, vars, opts)).toEqual([
      `Cannot assign ${short} to DINT`,
    ]);
  });

  it.each(LONGS)("TO_%s refuses a wrong call as TO_%s does", (long, short) => {
    const vars = `a : ${short};`;
    expect(errorsOf(`a := TO_${long}(1, 2);`, vars, opts)).toEqual([
      `'TO_${long}' requires 1 argument(s), got 2`,
    ]);
    expect(errorsOf(`a := TO_${short}(1, 2);`, vars, opts)).toEqual([
      `'TO_${short}' requires 1 argument(s), got 2`,
    ]);
    expect(errorsOf(`a := TO_${long}();`, vars, opts)).toEqual([
      `'TO_${long}' requires 1 argument(s), got 0`,
    ]);
  });

  it.each(LONGS)("<x>_TO_%s and %s_TO_<x> are typed", (long, short, lit) => {
    const vars = `a : ${short} := ${lit}; d : DINT; s : STRING;`;
    expect(
      errorsOf(
        `a := DINT_TO_${long}(d); d := ${long}_TO_DINT(a); ` +
          `s := ${long}_TO_STRING(a); a := STRING_TO_${long}(s);`,
        vars,
        opts,
      ),
    ).toEqual([]);
    expect(errorsOf(`d := DINT_TO_${long}(d);`, vars, opts)).toEqual([
      `Cannot assign ${long} to DINT`,
    ]);
  });
});

describe("long date and time conversion names: strict argument check", () => {
  it.each(LONGS)("DINT_TO_%s refuses a REAL as DINT_TO_%s", (long, short) => {
    const vars = `a : ${short}; r : REAL;`;
    const expected = [
      "Implicit conversion from REAL to DINT is not allowed; use REAL_TO_DINT",
    ];
    const strict: Options = { strict: true };
    expect(errorsOf(`a := DINT_TO_${short}(r);`, vars, strict)).toEqual(
      expected,
    );
    expect(errorsOf(`a := DINT_TO_${long}(r);`, vars, strict)).toEqual(
      expected,
    );
  });
});

describe("long date and time conversion names: generated C++", () => {
  it.each(LONGS)("TO_%s and its typed forms call TO_%s", (long, short) => {
    const src = `PROGRAM MAIN\nVAR\na : ${short}; d : DINT;\nEND_VAR\na := TO_${long}(d);\na := DINT_TO_${long}(d);\nEND_PROGRAM\n`;
    const r = compile(src, {});
    expect(r.errors).toEqual([]);
    expect(r.cppCode).not.toMatch(
      /\bTO_(TIME_OF_DAY|LTIME_OF_DAY|DATE_AND_TIME|LDATE_AND_TIME)\b/,
    );
    expect(r.cppCode).toContain(`TO_${short}(`);
  });
});
