// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * Runtime: the standard string functions and comparisons take WSTRING
 * values and variables of any length. Built with g++ and run.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

describe.skipIf(!hasGpp)("WSTRING functions in the runtime", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-wstrfn-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("computes LEN, LEFT, RIGHT, MID, CONCAT, INSERT, DELETE, REPLACE, FIND", () => {
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: "",
      cppCode: "",
      testName: "wstring_functions_runtime",
      mainCode: `
int main() {
    using namespace strucpp;
    IEC_WSTRING a(u"ABC");
    IECWStringVar<10> x(u"XY");
    IECWString<20> c(u"ABCDE");
    std::cout << LEN(a) << LEN(x) << LEN(c)
              << (CONCAT(a, x) == u"ABCXY") << (CONCAT(x, c, a) == u"XYABCDEABC")
              << (LEFT(a, 2) == u"AB") << (RIGHT(c, 2) == u"DE")
              << (MID(c, 2, 2) == u"BC") << (INSERT(a, x, 2) == u"ABXYC")
              << (DELETE_STR(c, 2, 3) == u"ABE") << (REPLACE(c, x, 2, 3) == u"ABXYE")
              << FIND(c, IEC_WSTRING(u"CD")) << FIND(a, x)
              << (a == u"ABC") << (a != x) << (x < a) << (a == c) << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("32511111111301100");
  });
});
