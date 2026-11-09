/**
 * Chained comparisons end to end through g++. Each chain is chosen so that
 * the Annex A grouping (relational operators bind tighter than `=` and `<>`,
 * both levels left-associative) gives a different truth value from a single
 * left-associative level for all six operators, or from a right-associative
 * reading. The program runs and prints the values the Annex A grouping gives.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

/*
 * With bt = TRUE, bf = FALSE, i1 = 1, k3 = 3, j5 = 5:
 *   chain                         Annex A           one level, left
 *   R1 bt = 2 > 1                 T = (T)  -> 1     (T = 2) > 1 -> 0
 *   R2 i1 = j5 >= k3              1 = (T)  -> 1     (1 = 5) >= 3 -> 0
 *   R3 bf <> 4 > 3                F <> (T) -> 1     (F <> 4) > 3 -> 0
 *   R4 bf OR j5 = k3 < i1         5 = (F)  -> 0     (5 = 3) < 1 -> 1
 *   R5 k3 > j5 = bf               (F) = F  -> 1     same
 *   R6 j5 > k3 > i1               (T) > 1  -> 0     same (a math chain gives 1)
 *   R7 bt = j5 = j5               (F) = 5  -> 0     same (right-assoc gives 1)
 *   R8 i1 < j5 = bt AND k3 <> j5 >= i1   (T = T) AND (3 <> T) -> 1
 *   R9 IF j5 > k3 > i1 THEN 10 ELSE 20   -> 20
 *   R10 initial value 3 > 2 > 1           (T) > 1 -> 0
 */
const SOURCE = `PROGRAM MAIN
VAR
  bt : BOOL := TRUE;
  bf : BOOL := FALSE;
  i1 : INT := 1;
  k3 : INT := 3;
  j5 : INT := 5;
  R1, R2, R3, R4, R5, R6, R7, R8 : BOOL;
  R9 : INT;
  R10 : BOOL := 3 > 2 > 1;
END_VAR
  R1 := bt = 2 > 1;
  R2 := i1 = j5 >= k3;
  R3 := bf <> 4 > 3;
  R4 := bf OR j5 = k3 < i1;
  R5 := k3 > j5 = bf;
  R6 := j5 > k3 > i1;
  R7 := bt = j5 = j5;
  R8 := i1 < j5 = bt AND k3 <> j5 >= i1;
  IF j5 > k3 > i1 THEN
    R9 := 10;
  ELSE
    R9 := 20;
  END_IF;
END_PROGRAM
`;

const FIELDS = ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9", "R10"];
const EXPECTED = "1 1 1 0 1 0 0 1 20 0";

describeIfGpp("chained comparisons end to end", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-chaincmp-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function run(name: string, options: Parameters<typeof compile>[1]): string {
    const result = compile(SOURCE, {
      headerFileName: "generated.hpp",
      ...options,
    });
    expect(result.errors.map((e) => `${e.line}: ${e.message}`)).toEqual([]);
    const print = ` Program_MAIN p;\n p.run();\n std::cout << ${FIELDS.map((v) => `p.${v}.get()`).join(' << " " << ')} << std::endl;`;
    return compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: name,
      mainCode: `#include <iostream>\nint main() {\n using namespace strucpp;\n${print}\n return 0;\n}\n`,
    });
  }

  it("runs the Annex A grouping under iec-3", () => {
    expect(run("chaincmp_iec", { dialect: "iec-3" })).toBe(EXPECTED);
  });

  it("runs the Annex A grouping with no dialect flag", () => {
    expect(run("chaincmp_default", {})).toBe(EXPECTED);
  });
});

describe("chained comparisons: generated C++", () => {
  it("parenthesises a comparison nested in a comparison", () => {
    const result = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors).toEqual([]);
    expect(result.cppCode).toContain("BT == (2 > 1)");
    expect(result.cppCode).toContain("(J5 > K3) > I1");
    expect(result.cppCode).toContain("(BT == J5) == J5");
    expect(result.cppCode).toContain("(I1 < J5) == BT");
  });
});
