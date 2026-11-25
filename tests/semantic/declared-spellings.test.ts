// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * Messages name a declared name as it is declared (`Fb_Motor`, not
 * `FB_MOTOR`); a name not declared at all, in an undeclared-variable or
 * no-member message, as written where it is reported. Elementary types,
 * keywords, library names and names declared in two spellings are left.
 */
import { describe, it, expect } from "vitest";
import { compile, analyze } from "../../src/index.js";
import { discoverStlibs } from "../../src/node/library-loader.js";
import { withDeclaredSpelling } from "../../src/semantic/declared-spellings.js";

const messages = (src: string, opts = {}): string[] => {
  const r = compile(src, opts);
  return [...r.errors, ...r.warnings].map((e) => e.message);
};

describe("names in messages as declared", () => {
  const SOURCE = `FUNCTION_BLOCK Fb_Motor
VAR nCount : INT; END_VAR
METHOD FB_exit : BOOL
VAR_INPUT bInCopyCode : BOOL; END_VAR
FB_exit := TRUE;
END_METHOD
nCount := nCount + 1;
END_FUNCTION_BLOCK
PROGRAM Main
VAR myFb : Fb_Motor; END_VAR
myFb();
myFb.nCnt := 1;
undeclaredVar := 3;
myFb.nCount := 2;
END_PROGRAM
`;

  it("re-spells the analyzer's and the type checker's names", () => {
    expect(messages(SOURCE)).toEqual([
      "Function block 'Fb_Motor' has no member 'nCnt'",
      "'nCount' is an internal variable of FUNCTION_BLOCK 'Fb_Motor' and cannot be accessed from outside",
      "Undeclared variable 'undeclaredVar'",
      "FB_exit of 'Fb_Motor' is never called: an instance is not torn down",
    ]);
  });

  it("does the same in analyze()", () => {
    const r = analyze(SOURCE);
    expect(r.errors.map((e) => e.message)).toContain(
      "Undeclared variable 'undeclaredVar'",
    );
  });

  it("re-spells a name in a parse error", () => {
    const r = compile(`PROGRAM Main\nVAR r2 : INT; END_VAR\nr2 r2;\nEND_PROGRAM\n`);
    expect(r.errors.map((e) => e.message).join("\n")).toContain(
      "identifier `r2`",
    );
  });

  it("reads an undefined type's name where it is written, over a variable of that name", () => {
    const r = compile(`PROGRAM Main
VAR pedState : PedState; END_VAR
END_PROGRAM
`);
    expect(r.errors.map((e) => e.message)).toEqual([
      "Undefined type 'PedState' in PROGRAM 'Main'",
    ]);
  });

  it("leaves a name declared in two spellings as it is", () => {
    const r = messages(`VAR_GLOBAL CNT : INT; END_VAR
PROGRAM Main
VAR cnt : INT; q : Missing; END_VAR
cnt.x := 1;
END_PROGRAM
`);
    expect(r.join("\n")).not.toMatch(/'cnt'|'Cnt'/);
  });

  it("leaves elementary type names, keywords and library names", () => {
    const spellings = new Map<string, string | null>([["MOTOR", "Motor"]]);
    expect(withDeclaredSpelling("'INT' and 'MOTOR.SPEED'", spellings)).toBe(
      "'INT' and 'Motor.SPEED'",
    );
    expect(
      withDeclaredSpelling("in 'A[MOTOR].MOTOR'", spellings),
    ).toBe("in 'A[MOTOR].Motor'");
    const r = messages(
      `PROGRAM Main
VAR ton : INT; t : TON; END_VAR
t.Nope := 1;
END_PROGRAM
`,
      { libraries: discoverStlibs("libs") },
    );
    expect(r.join("\n")).toContain("'TON'");
  });
});
