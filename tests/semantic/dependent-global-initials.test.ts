/** A global's initial value reading a non-CONSTANT global: ordered with no flag, refused under iec-3 and --strict. */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

const SOURCE = `VAR_GLOBAL CONSTANT K : INT := 5; END_VAR
VAR_GLOBAL a : INT := b + 1; b : INT := K * 2; c, d : INT := K; END_VAR
PROGRAM Main VAR x : INT; END_VAR x := a; END_PROGRAM
`;

describe("dependent global initial values", () => {
  it("are ordered with no dialect flag", () => {
    expect(compile(SOURCE).errors).toEqual([]);
  });
  for (const [label, options] of [
    ["iec-3", { dialect: "iec-3" }],
    ["strict", { strict: true }],
  ] as const) {
    it(`are refused (${label})`, () => {
      expect(
        compile(SOURCE, options).errors.map(
          (e) => `${e.line}:${e.column} ${e.message}`,
        ),
      ).toEqual([
        "2:23 The initial value of global 'A' reads global 'B', which is no CONSTANT: an initial value is a constant expression",
      ]);
    });

    it(`accept REF and SIZEOF of a global (${label})`, () => {
      expect(
        compile(
          `VAR_GLOBAL g : INT := 3; p : REF_TO INT := REF(g); s : UDINT := SIZEOF(g); END_VAR
PROGRAM Main VAR x : INT; END_VAR x := p^; END_PROGRAM
`,
          options,
        ).errors,
      ).toEqual([]);
    });

    it(`refuse a CONFIGURATION global reading a top-level global (${label})`, () => {
      expect(
        compile(
          `VAR_GLOBAL t : INT := 4; END_VAR
VAR_GLOBAL CONSTANT tk : INT := 4; END_VAR
CONFIGURATION C
VAR_GLOBAL u : INT := t; v : INT := tk; w : INT := z; z : INT := 2; END_VAR
RESOURCE R ON PLC
TASK T(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM I WITH T : Main;
END_RESOURCE
END_CONFIGURATION
PROGRAM Main VAR_EXTERNAL u : INT; END_VAR VAR x : INT; END_VAR x := u; END_PROGRAM
`,
          options,
        ).errors.map((e) => `${e.line}:${e.column} ${e.message}`),
      ).toEqual([
        "4:23 The initial value of global 'U' reads global 'T', which is no CONSTANT: an initial value is a constant expression",
        "4:52 The initial value of global 'W' reads global 'Z', which is no CONSTANT: an initial value is a constant expression",
      ]);
    });
  }
});
