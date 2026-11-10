// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: the bundled OSCAT functions that read or write a STRING through a
 * POINTER TO of another shape (ARRAY OF BYTE over a STRING, POINTER TO BYTE
 * into a result) return the right values when a user PROGRAM calls them
 * through the oscat-basic .stlib. They depend on STRING being laid out as on a
 * PLC: NUL-terminated characters, with the length at the terminator.
 *
 * Library functions are called positionally: a named call to a library
 * function is not reordered to its parameter order yet.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { discoverStlibs } from "../../src/node/library-loader.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const LIBS_DIR = path.resolve(__dirname, "../../libs");
const oscatAvailable = fs.existsSync(path.join(LIBS_DIR, "oscat-basic.stlib"));

const SOURCE = `
PROGRAM Main
  VAR
    r_char, r_num, r_nonum, r_ctrl : INT;
    mirrored : STRING;
    real_a, real_b : REAL;
    clean_list : STRING(254) := ',a,,b,';
    cleaned : BOOL;
    get_list : STRING(254) := ',x,y,z';
    got : STRING;
    ins_list : STRING(254) := ',x,y,z';
    inserted : BOOL;
    len_list : STRING(254) := ',x,y,z';
    r_len : INT;
    next_list : STRING(254) := ',x,y,z';
    walker : LIST_NEXT;
    walked : STRING;
    ret_list : STRING(254) := ',x,y,z';
    retrieved : STRING;
    last_list : STRING(254) := ',x,y,z';
    last : STRING;
    buf : ARRAY[0..9] OF BYTE := [16#68, 16#65, 16#6C, 16#6C, 16#6F, 0, 0, 0, 0, 0];
    found, found_ign : INT;
    chr : STRING(1);
    upper : STRING;
    hex : STRING;
    i : INT;
  END_VAR
  r_char := FIND_CHAR('$01$02ab', 1);
  r_num := FIND_NUM('ab1c', 1);
  r_nonum := FIND_NONUM('12a3', 1);
  r_ctrl := FIND_CTRL('ab$0Dc', 1);
  mirrored := MIRROR('abcd');
  real_a := FLOAT_TO_REAL('1.5');
  real_b := FLOAT_TO_REAL('-0.25');
  cleaned := LIST_CLEAN(44, clean_list);
  got := LIST_GET(44, 2, get_list);
  inserted := LIST_INSERT(44, 2, 'q', ins_list);
  r_len := LIST_LEN(44, len_list);
  walker(SEP := 44, RST := TRUE, LIST := next_list);
  walked := walker.LEL;
  FOR i := 1 TO 3 DO
    walker(SEP := 44, RST := FALSE, LIST := next_list);
    IF NOT walker.NUL THEN walked := CONCAT(walked, walker.LEL); END_IF;
  END_FOR;
  retrieved := LIST_RETRIEVE(44, 2, ret_list);
  last := LIST_RETRIEVE_LAST(44, last_list);
  found := BUFFER_SEARCH(ADR(buf), 10, 'lo', 0, FALSE);
  found_ign := BUFFER_SEARCH(ADR(buf), 10, 'LO', 0, TRUE);
  chr := CHR_TO_STRING(65);
  upper := UPPERCASE('abc');
  hex := BYTE_TO_STRH(16#A5);
END_PROGRAM
`;

const MAIN = `
#include <cstdio>
int main() {
    strucpp::Program_MAIN m;
    m.run();
    std::printf("find %d %d %d %d\\n", (int)m.R_CHAR, (int)m.R_NUM,
        (int)m.R_NONUM, (int)m.R_CTRL);
    std::printf("mirror %s | real %g %g\\n", m.MIRRORED.c_str(), (double)m.REAL_A,
        (double)m.REAL_B);
    std::printf("clean %d %s(%u)\\n", (int)m.CLEANED, m.CLEAN_LIST.c_str(),
        (unsigned)m.CLEAN_LIST.length());
    std::printf("get %s | insert %d %s | len %d\\n", m.GOT.c_str(), (int)m.INSERTED,
        m.INS_LIST.c_str(), (int)m.R_LEN);
    std::printf("next %s\\n", m.WALKED.c_str());
    std::printf("retrieve %s %s | last %s %s\\n", m.RETRIEVED.c_str(), m.RET_LIST.c_str(),
        m.LAST.c_str(), m.LAST_LIST.c_str());
    std::printf("buffer %d %d\\n", (int)m.FOUND, (int)m.FOUND_IGN);
    std::printf("chr %s(%u) | upper %s | hex %s\\n", m.CHR.c_str(),
        (unsigned)m.CHR.length(), m.UPPER.c_str(), m.HEX.c_str());
    return 0;
}
`;

const EXPECTED = [
  // first printable, first digit, first non-digit, first control character
  "find 3 3 3 3",
  "mirror dcba | real 1.5 -0.25",
  // the empty element and the trailing separator are removed
  "clean 1 ,a,b(4)",
  "get y | insert 1 ,x,q,y,z | len 3",
  "next xyz",
  // the retrieved element is removed from the list
  "retrieve y ,x,z | last z ,x,y",
  "buffer 3 3",
  "chr A(1) | upper ABC | hex A5",
];

describe.skipIf(!hasGpp || !oscatAvailable)(
  "OSCAT pointer-based string functions called from a user program",
  () => {
    let tempDir: string;
    let pchPath: string;
    beforeAll(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-oscat-ptr-"));
      pchPath = createPCH(tempDir);
    });
    afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    for (const opt of ["-O0", "-O2"]) {
      it(`return PLC results at ${opt}`, () => {
        const result = compile(SOURCE, {
          headerFileName: "generated.hpp",
          libraries: discoverStlibs(LIBS_DIR),
        });
        expect(result.errors.map((e) => e.message)).toEqual([]);
        const out = compileAndRunStandalone({
          tempDir,
          pchPath,
          headerCode: result.headerCode,
          cppCode: result.cppCode,
          testName: `oscat_ptr${opt.replace("-", "_")}`,
          mainCode: MAIN,
          extraFlags: [opt],
        });
        expect(out.split("\n")).toEqual(EXPECTED);
      });
    }
  },
);
