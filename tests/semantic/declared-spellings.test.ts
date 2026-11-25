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
import {
  respellDiagnostics,
  withDeclaredSpelling,
} from "../../src/semantic/declared-spellings.js";

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

describe("names in messages: what is not re-spelled", () => {
  it("leaves the members of a library block and the parameters of a standard function", () => {
    const r = compile(
      `FUNCTION_BLOCK Fb_Q
VAR_INPUT q : BOOL; et : INT; In : BOOL; END_VAR
END_FUNCTION_BLOCK
PROGRAM Main
VAR t : TON; i : INT; END_VAR
t.Q := TRUE;
i := LEN(5);
END_PROGRAM
`,
      { libraries: discoverStlibs("libs") },
    );
    expect(r.errors.map((e) => e.message)).toEqual([
      "'Q' is a VAR_OUTPUT of FUNCTION_BLOCK 'TON'; from outside it can be read, not written",
      "Argument 'IN' of 'LEN' expects ANY_STRING, got INT",
    ]);
  });

  it("leaves the body of a typed literal", () => {
    const r = compile(`FUNCTION_BLOCK Motor
VAR_INPUT Speed : INT; END_VAR
END_FUNCTION_BLOCK
PROGRAM Main
VAR c : CHAR := CHAR#'MOTOR'; END_VAR
END_PROGRAM
`);
    expect(r.errors.map((e) => e.message)).toEqual([
      "A CHAR literal holds exactly one character; CHAR#'MOTOR' holds 5",
    ]);
  });

  it("takes a parse error's identifier from the source at its position", () => {
    const r = compile(`PROGRAM Main\nVAR Foo : INT; END_VAR\nFoo := 1 FOO;\nEND_PROGRAM\n`);
    for (const e of r.errors) {
      if (e.message.includes("identifier `")) {
        expect(e.message).toContain("identifier `FOO`");
      }
    }
  });

  it("takes time in proportion to the diagnostics", () => {
    const n = 40000;
    const lines: string[] = [];
    for (let i = 0; i < n; i++) lines.push(`x${i} := undeclared_Thing${i} + 1;`);
    const diags = lines.map((_l, i) => ({
      message: `Undeclared variable 'UNDECLARED_THING${i}'`,
      line: i + 1,
      column: 7,
      file: "f.st",
      severity: "error" as const,
    }));
    const start = performance.now();
    respellDiagnostics(
      diags,
      { spellings: () => new Map(), isLibraryPou: () => false },
      new Map([["f.st", lines.join("\n")]]),
    );
    expect(performance.now() - start).toBeLessThan(5000);
    expect(diags[n - 1]!.message).toBe(
      `Undeclared variable 'undeclared_Thing${n - 1}'`,
    );
  });
});
