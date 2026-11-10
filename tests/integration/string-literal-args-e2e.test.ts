// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * E2E: the standard STRING / WSTRING functions called with string literals,
 * alone or mixed with variables (`INSERT('ABC', 'XY', 1)`,
 * `CONCAT(s, 'a', 'b')`, `REPLACE(w, "x", 1, 1)`). Built with g++ and run.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

describe.skipIf(!hasGpp)(
  "string functions with literal arguments — g++ e2e",
  () => {
    let tempDir: string;
    let pchPath: string;
    beforeAll(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-strlit-"));
      pchPath = createPCH(tempDir);
    });
    afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    function run(testName: string, source: string, fields: string[]): string {
      const result = compile(source, { headerFileName: "generated.hpp" });
      expect(result.errors.map((e) => `${e.line}: ${e.message}`)).toEqual([]);
      const prints = fields
        .map(
          (f) =>
            `std::cout << p.${f}.get()${f.startsWith("B") || f.startsWith("N") ? "" : ".c_str()"} << "|";`,
        )
        .join("\n  ");
      return compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName,
        mainCode: `#include <iostream>
int main() {
  using namespace strucpp;
  Program_MAIN p;
  p.run();
  ${prints}
  std::cout << std::endl;
  return 0;
}
`,
      });
    }

    it("STRING functions with only literal arguments", () => {
      const out = run(
        "str_all_literal",
        `
      PROGRAM Main
      VAR ins : STRING; cat2 : STRING; cat3 : STRING; rep : STRING;
        lft : STRING; rgt : STRING; md : STRING; del : STRING;
        nfind : INT; nlen : INT; END_VAR
        ins := INSERT('ABC', 'XY', 1);
        cat2 := CONCAT('AB', 'CD');
        cat3 := CONCAT('AB', 'CD', 'EF');
        rep := REPLACE('ABCDE', 'XY', 2, 2);
        lft := LEFT('ABCDE', 2);
        rgt := RIGHT('ABCDE', 2);
        md := MID('ABCDE', 2, 2);
        del := DELETE('ABCDE', 2, 2);
        nfind := FIND('ABCDE', 'CD');
        nlen := LEN('ABCDE');
      END_PROGRAM
      `,
        [
          "INS",
          "CAT2",
          "CAT3",
          "REP",
          "LFT",
          "RGT",
          "MD",
          "DEL",
          "NFIND",
          "NLEN",
        ],
      );
      expect(out).toBe("AXYBC|ABCD|ABCDEF|AXYDE|AB|DE|BC|ADE|3|5|");
    });

    it("STRING functions mixing literals and variables", () => {
      const out = run(
        "str_mixed_literal",
        `
      PROGRAM Main
      VAR s : STRING := 'q'; s10 : STRING(10) := 'qq';
        cat3a : STRING; cat3b : STRING; cat3c : STRING; ins : STRING; ins10 : STRING;
        rep : STRING; END_VAR
        cat3a := CONCAT(s, 'a', 'b');
        cat3b := CONCAT('a', s, 'b');
        cat3c := CONCAT(s, s10, s);
        ins := INSERT('ABC', s, 1);
        ins10 := INSERT('ABC', s10, 3);
        rep := REPLACE('ABC', s, 1, 2);
      END_PROGRAM
      `,
        ["CAT3A", "CAT3B", "CAT3C", "INS", "INS10", "REP"],
      );
      expect(out).toBe("qab|aqb|qqqq|AqBC|ABCqq|AqC|");
    });

    it("WSTRING functions with literal arguments", () => {
      const out = run(
        "wstr_literal",
        `
      PROGRAM Main
      VAR w : WSTRING := "q";
        bIns : BOOL; bCat2 : BOOL; bCat3 : BOOL; bRep : BOOL; bLeft : BOOL;
        bRight : BOOL; bMid : BOOL; bDel : BOOL; bInsW : BOOL; bRepW : BOOL;
        bInsL : BOOL; bCat3W : BOOL;
        nFind : INT; nLen : INT; nFindW : INT; END_VAR
        bIns := INSERT("ABC", "XY", 1) = "AXYBC";
        bCat2 := CONCAT("AB", "CD") = "ABCD";
        bCat3 := CONCAT("AB", "CD", "EF") = "ABCDEF";
        bRep := REPLACE("ABCDE", "XY", 2, 2) = "AXYDE";
        bLeft := LEFT("ABCDE", 2) = "AB";
        bRight := RIGHT("ABCDE", 2) = "DE";
        bMid := MID("ABCDE", 2, 2) = "BC";
        bDel := DELETE("ABCDE", 2, 2) = "ADE";
        nFind := FIND("ABCDE", "CD");
        nLen := LEN("ABCDE");
        bInsW := INSERT(w, "x", 1) = "qx";
        bRepW := REPLACE(w, "xy", 1, 1) = "xy";
        bInsL := INSERT("ABC", w, 1) = "AqBC";
        bCat3W := CONCAT(w, "a", "b") = "qab";
        nFindW := FIND(w, "q");
      END_PROGRAM
      `,
        [
          "BINS",
          "BCAT2",
          "BCAT3",
          "BREP",
          "BLEFT",
          "BRIGHT",
          "BMID",
          "BDEL",
          "NFIND",
          "NLEN",
          "BINSW",
          "BREPW",
          "BINSL",
          "BCAT3W",
          "NFINDW",
        ],
      );
      expect(out).toBe("1|1|1|1|1|1|1|1|3|5|1|1|1|1|1|");
    });
  },
);
