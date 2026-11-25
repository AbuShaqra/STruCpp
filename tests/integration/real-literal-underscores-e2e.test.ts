// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * A real literal may hold underscores between digits in each of its parts
 * (Ed. 3 Annex A Real_Literal, Table 5): `1_000.5`, `REAL#1_0.2_5`,
 * `1.5E1_0`. Misplaced ones lex too and are refused under iec-3 and --strict.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { tokenize } from "../../src/frontend/lexer.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `
PROGRAM Main
VAR
  a : LREAL := 1_000.5;
  b : LREAL := 2.000_25;
  c : LREAL := 1_0.5E0_2;
  d : REAL := REAL#1_2.5;
  e : LREAL;
END_VAR
e := a + 1_000.25;
END_PROGRAM
`;

describe("real literals with underscores", () => {
  it("lex as one real literal", () => {
    for (const image of ["1_000.5", "2.000_25", "1_0.5E0_2", "1_0E1_0"]) {
      const { tokens, errors } = tokenize(image);
      expect(errors).toEqual([]);
      expect(tokens.map((t) => t.tokenType.name)).toEqual(["RealLiteral"]);
    }
    const typed = tokenize("LREAL#1_2.5_0E1_0");
    expect(typed.tokens.map((t) => t.tokenType.name)).toEqual(["TypedLiteral"]);
  });

  it("keep their value without the underscores", () => {
    const r = compile(SOURCE);
    expect(r.errors).toEqual([]);
    expect(r.cppCode).toContain("1000.25");
    expect(r.headerCode + r.cppCode).toContain("1000.5");
    expect(r.headerCode + r.cppCode).toContain("2.00025");
    expect(r.headerCode + r.cppCode).toContain("1050");
  });

  it("are refused with a misplaced underscore under iec-3 and --strict only", () => {
    const src = `PROGRAM Main
VAR a : LREAL; END_VAR
a := 1_.5 + 1.5_ + 1.0E1_;
END_PROGRAM
`;
    const message = (spelling: string): string =>
      `An underscore in a numeric literal must stand between two digits (IEC 61131-3 Ed. 3): '${spelling}'`;
    const expected = [message("1_.5"), message("1.5_"), message("1.0E1_")];
    expect(compile(src).errors).toEqual([]);
    expect(compile(src, { strict: true }).errors.map((e) => e.message)).toEqual(
      expect.arrayContaining(expected),
    );
    expect(
      compile(src, { dialect: "iec-3" }).errors.map((e) => e.message),
    ).toEqual(expect.arrayContaining(expected));
    expect(compile(SOURCE, { strict: true }).errors).toEqual([]);
  });
});

describe.skipIf(!hasGpp)("real literals with underscores — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-real-us-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("computes with the literal's value", () => {
    const result = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors).toEqual([]);
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "real_underscores",
      mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.E.get() << " " << p.B.get() << " " << p.C.get() << " " << p.D.get() << std::endl;
    return 0;
}
`,
    });
    expect(out).toBe("2000.75 2.00025 1050 12.5");
  });
});
