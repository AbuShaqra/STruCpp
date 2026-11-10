/**
 * E2E: enumeration values typed as their enumeration still build and run in
 * every enumeration use: assignment, arguments, comparison, CASE labels and
 * conversion to an integer.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `
TYPE E2 : (A, B); END_TYPE
TYPE E3 : (B, C, D); END_TYPE
TYPE EV : (X := 5, Y := 10); END_TYPE
TYPE S1 : STRUCT e : E2; END_STRUCT END_TYPE
FUNCTION FE : E2 VAR_INPUT v : E2; END_VAR FE := v; END_FUNCTION
FUNCTION_BLOCK FB VAR_INPUT w : E2; END_VAR VAR_OUTPUT o : INT; END_VAR
  o := TO_INT(w);
END_FUNCTION_BLOCK
PROGRAM Main
VAR
  i, n, k, c : INT; en : E2; en3 : E3; dd : DINT; b1, b2, b3 : BOOL;
  ae : ARRAY[0..1] OF E2; s : S1; fbi : FB;
END_VAR
  en := A; en := E2.B; en3 := B;
  s.e := E2#B; ae[0] := E2#B; ae[1] := A;
  en := FE(A); fbi(w := E2#B);
  b1 := en = A; b2 := E2#A < E2#B; b3 := E2#A <> en AND s.e >= E2#A;
  i := TO_INT(E2#B) + TO_INT(ae[0]);
  dd := TO_DINT(EV#Y) + 1;
  en := MOVE(E2#B);
  CASE en OF A: c := 1; E2#B: c := 2; END_CASE;
  en := E2#A;
  WHILE en < E2#B DO en := E2#B; n := n + 1; END_WHILE;
  FOR k := TO_INT(E2#A) TO TO_INT(E2#B) DO n := n + 10; END_FOR;
END_PROGRAM
`;

describe.skipIf(!hasGpp)("typed enumeration values end to end", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-enumval-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it.each([[undefined], ["iec-3" as const]])(
    "builds and runs (%s)",
    (dialect) => {
      const r = compile(SOURCE, {
        headerFileName: "generated.hpp",
        ...(dialect ? { dialect } : {}),
      });
      expect(r.errors).toEqual([]);
      const out = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: r.headerCode,
        cppCode: r.cppCode,
        testName: `enum_value_type_${dialect ?? "default"}`.replace("-", "_"),
        mainCode: `#include <iostream>
int main() {
  strucpp::Program_MAIN p;
  p.run();
  std::cout << (bool)p.B1 << (bool)p.B2 << (bool)p.B3 << " " << (int)p.I
            << " " << (int)p.DD << " " << (int)p.C << " " << (int)p.N << " "
            << (int)p.FBI.O << " " << p.EN3.get().to_int() << std::endl;
  return 0;
}
`,
      });
      expect(out).toBe("110 2 11 2 21 1 0");
    },
  );
});
