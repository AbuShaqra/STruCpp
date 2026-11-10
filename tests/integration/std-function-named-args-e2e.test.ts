/**
 * Named arguments of standard functions were passed in the order written, so
 * MID(IN := s, P := 2, L := 3) ran as MID(s, 2, 3) and LIMIT(IN := 50,
 * MN := 0, MX := 10) gave 50. They bind by the IEC names now; g++ runs it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const SOURCE = `PROGRAM Main
VAR
  s : STRING := 'ABCDEFG';
  w : WSTRING := "ABCDEFG";
  init : STRING := MID(P := 2, L := 3, IN := 'XYZWV');
  r1, r2, r3, r4, r5, r6 : STRING;
  i1, i2, i3, i4, i5, i6, i7, i8 : INT;
  on, ok : BOOL;
END_VAR
r1 := MID(IN := s, P := 2, L := 3);
r2 := MID(L := 3, IN := s, P := 2);
r3 := INSERT(P := 2, IN2 := 'xy', IN1 := s);
r4 := DELETE(P := 2, L := 3, IN := s);
r5 := REPLACE(P := 2, L := 3, IN2 := 'z', IN1 := s);
r6 := CONCAT(IN2 := 'b', IN3 := 'c', IN1 := 'a');
i1 := LIMIT(IN := 50, MN := 0, MX := 10);
i2 := SEL(IN1 := 7, G := TRUE, IN0 := 3);
i3 := MUX(IN2 := 30, K := 2, IN0 := 10, IN1 := 20);
i4 := FIND(IN2 := 'CD', IN1 := s);
i5 := LEN(MID(L := 2, P := 3, IN := w));
i6 := ADD(IN3 := 100, IN1 := 1, IN2 := 10);
on := TRUE;
i7 := LIMIT(EN := on, MX := 10, IN := -5, MN := 0, ENO => ok);
i8 := LIMIT(0, MX := 10, IN := 15);
END_PROGRAM
`;

describeIfGpp("standard function named arguments run in IEC order", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-stdnamed-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("binds MID, LIMIT, SEL, MUX and the string functions by name", () => {
    const result = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors).toEqual([]);
    const strings = ["INIT", "R1", "R2", "R3", "R4", "R5", "R6"]
      .map((v) => `std::cout << p.${v}.get().c_str() << '|';`)
      .join(" ");
    const ints = ["I1", "I2", "I3", "I4", "I5", "I6", "I7", "I8", "OK"]
      .map((v) => `std::cout << p.${v}.get() << '|';`)
      .join(" ");
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "std_named",
      mainCode: `#include <iostream>\nint main() {\n using namespace strucpp;\n Program_MAIN p;\n p.run();\n ${strings}\n ${ints}\n std::cout << std::endl;\n return 0;\n}\n`,
    });
    expect(out).toBe(
      "YZW|BCD|BCD|ABxyCDEFG|AEFG|AzEFG|abc|10|7|30|3|2|111|0|10|1|",
    );
  });
});
