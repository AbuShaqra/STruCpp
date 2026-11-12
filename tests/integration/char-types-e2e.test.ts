// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: CHAR and WCHAR values, literals, STRING indexing, ordering by
 * Windows-1252 code and the character conversions build and run under g++;
 * an index past the string's length raises the out-of-bounds error.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `PROGRAM Main
VAR
  c : CHAR := CHAR#'A';
  e : CHAR := CHAR#'€';
  w : WCHAR := WCHAR#"$20AC";
  s : STRING := 'häl';
  ws : WSTRING := "a☃";
  x : CHAR; y : WCHAR; b : BYTE; n : INT; lt : BOOL; eq : BOOL;
  s2 : STRING; ws2 : WSTRING; ce : CHAR; wc : WCHAR; i : INT := 4; bad : CHAR;
END_VAR
x := s[2];
s[3] := CHAR#'L';
y := ws[2];
b := CHAR_TO_BYTE(e);
n := CHAR_TO_INT(x);
lt := c < e;
eq := x = CHAR#'ä';
s2 := CHAR_TO_STRING(c);
ws2 := WCHAR_TO_WSTRING(y);
wc := CHAR_TO_WCHAR(e);
ce := WCHAR_TO_CHAR(w);
END_PROGRAM
`;

describe.skipIf(!hasGpp)("CHAR and WCHAR — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-char-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  for (const [label, options] of [
    ["no dialect", {}],
    ["iec-3", { dialect: "iec-3" }],
    ["strict", { strict: true }],
  ] as const) {
    it(`builds and runs (${label})`, () => {
      const result = compile(SOURCE, {
        ...options,
        headerFileName: "generated.hpp",
      });
      expect(result.errors).toEqual([]);
      const stdout = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: `char_${label.replace(/\W/g, "_")}`,
        mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    const auto code = [](char ch) { return int(static_cast<unsigned char>(ch)); };
    std::cout << code(p.X.get()) << " " << int(p.Y.get()) << " " << int(p.B.get())
              << " " << p.N.get() << " " << p.LT.get() << " " << p.EQ.get() << " "
              << code(p.S.get().c_str()[2]) << " " << p.S2.get().c_str() << " "
              << int(p.WS2.get().c_str()[0]) << " " << int(p.WC.get()) << " "
              << code(p.CE.get());
    try {
        p.BAD = p.S.at(p.I.get());
        std::cout << " no-error";
    } catch (const std::out_of_range&) {
        std::cout << " out-of-range";
    }
    std::cout << std::endl;
    return 0;
}
`,
      });
      expect(stdout).toBe(
        "228 9731 128 228 1 1 76 A 9731 8364 128 out-of-range",
      );
    });
  }
});
