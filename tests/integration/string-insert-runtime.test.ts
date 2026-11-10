// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * Runtime: INSERT(IN1, IN2, P) puts IN2 after the first P characters of IN1
 * (IEC 61131-3), for every STRING overload and for WINSERT. Built with g++ and run.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

describe.skipIf(!hasGpp)("STRING INSERT in the runtime", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-strins-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  function run(testName: string, body: string): string {
    return compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: "",
      cppCode: "",
      testName,
      mainCode: `
#include <iostream>
int main() {
    using namespace strucpp;
${body}
    std::cout << std::endl;
    return 0;
}
`,
    });
  }

  it("inserts after the first P characters, in front for P = 0 and at the end for P >= LEN", () => {
    const stdout = run(
      "string_insert_position",
      `
    IECString<10> a("ABC");
    IECString<10> x("XY");
    std::cout << INSERT(a, x, 2).c_str() << "|" << INSERT(a, x, 0).c_str() << "|"
              << INSERT(a, x, 1).c_str() << "|" << INSERT(a, x, 3).c_str() << "|"
              << INSERT(a, x, 7).c_str();`,
    );
    expect(stdout).toBe("ABXYC|XYABC|AXYBC|ABCXY|ABCXY");
  });

  it("returns the whole result and cuts it when assigned", () => {
    const stdout = run(
      "string_insert_truncate",
      `
    IECString<5> a("ABC");
    IECString<5> x("XYZ");
    IECWString<5> wa(u"ABC");
    IECWString<5> wx(u"XYZ");
    IECString<5> r5 = INSERT(a, x, 2);
    IECWString<5> wr5 = INSERT(wa, wx, 2);
    std::cout << INSERT(a, x, 2).c_str() << "|" << INSERT(a, x, 0).c_str() << "|"
              << INSERT(a, x, 9).c_str() << "|" << r5.c_str() << "|"
              << (INSERT(wa, wx, 2) == u"ABXYZC") << (INSERT(wa, wx, 0) == u"XYZABC")
              << (INSERT(wa, wx, 9) == u"ABCXYZ") << (wr5 == u"ABXYZ");`,
    );
    expect(stdout).toBe("ABXYZC|XYZABC|ABCXYZ|ABXYZ|1111");
  });

  it("gives the same result through the IECStringVar and const char* overloads", () => {
    const stdout = run(
      "string_insert_overloads",
      `
    IECString<10> a("ABC");
    IECString<10> x("XY");
    IECStringVar<10> va("ABC");
    IECStringVar<10> vx("XY");
    IECStringVar<4> vx4("XY");
    IECVar<IECString<10>> ia(a);
    std::cout << INSERT(va, vx, 2).c_str() << "|" << INSERT(va, x, 2).c_str() << "|"
              << INSERT(a, vx, 2).c_str() << "|" << INSERT(a, "XY", 2).c_str() << "|"
              << INSERT(va, "XY", 2).c_str() << "|" << INSERT(va, vx4, 2).c_str() << "|"
              << INSERT(ia, vx4, 2).c_str() << "|" << INSERT(va, "XY", 0).c_str();`,
    );
    expect(stdout).toBe("ABXYC|ABXYC|ABXYC|ABXYC|ABXYC|ABXYC|ABXYC|XYABC");
  });

  it("WINSERT inserts after the first P characters", () => {
    const stdout = run(
      "wstring_winsert_position",
      `
    IECWString<10> a(u"ABC");
    IECWString<10> x(u"XY");
    std::cout << (WINSERT(a, x, 2) == u"ABXYC") << (WINSERT(a, x, 0) == u"XYABC")
              << (WINSERT(a, x, 3) == u"ABCXY") << (WINSERT(a, x, 7) == u"ABCXY");`,
    );
    expect(stdout).toBe("1111");
  });
});
