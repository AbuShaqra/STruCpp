// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: a date or time value converted to STRING gives its canonical IEC
 * literal (T#1h2m3s4ms, D#2024-03-05, TOD#12:34:56.789, DT#...), long forms too.
 * TIME, DATE, TOD and DT are 32-bit: no sign, DT in whole seconds, TOD in ms.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `PROGRAM Main
VAR t : TIME := T#1h2m3s4ms; lt : LTIME := LTIME#1d2h; d : DATE := D#2024-03-05; tod : TOD := TOD#12:34:56.789;
  dt : DT := DT#2024-03-05-12:34:56; b : BOOL := TRUE; ld : LDATE := LDATE#2024-03-05; z : TIME := T#0s;
  ng : LTIME := LTIME#-1500ms; ltod : LTOD := LTOD#01:02:03.000456; ldt : LDT := LDT#2000-01-01-00:00:00.5;
  old : DATE := D#1970-01-01;
  s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, s11, s12, s13, s14, s15 : STRING; END_VAR
s1 := TIME_TO_STRING(t); s2 := LTIME_TO_STRING(lt); s3 := DATE_TO_STRING(d); s4 := TOD_TO_STRING(tod);
s5 := DT_TO_STRING(dt); s6 := BOOL_TO_STRING(b); s7 := LDATE_TO_STRING(ld); s8 := TIME_TO_STRING(z);
s9 := TO_STRING(ng); s10 := LTOD_TO_STRING(ltod); s11 := LDT_TO_STRING(ldt); s12 := DATE_TO_STRING(old);
s13 := BOOL_TO_STRING(TRUE); s14 := TO_STRING(FALSE); s15 := TIME_TO_STRING(T#1h2m3s4ms);
END_PROGRAM
`;

describe.skipIf(!hasGpp)("date and time to STRING — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-temporal-text-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  for (const [label, options] of [
    ["no dialect", {}],
    ["iec-3", { dialect: "iec-3" }],
    ["strict", { strict: true }],
  ] as const) {
    it(`gives the canonical literal (${label})`, () => {
      const result = compile(SOURCE, {
        ...options,
        headerFileName: "generated.hpp",
      });
      expect(result.errors).toEqual([]);
      const names = [
        "S1",
        "S2",
        "S3",
        "S4",
        "S5",
        "S6",
        "S7",
        "S8",
        "S9",
        "S10",
        "S11",
        "S12",
        "S13",
        "S14",
        "S15",
      ];
      const stdout = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: `temporal_text_${label.replace(/\W/g, "_")}`,
        mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    ${names.map((n) => `std::cout << p.${n}.get().c_str() << "|";`).join("\n    ")}
    std::cout << std::endl;
    return 0;
}
`,
      });
      expect(stdout).toBe(
        "T#1h2m3s4ms|LTIME#1d2h|D#2024-03-05|TOD#12:34:56.789|DT#2024-03-05-12:34:56|TRUE|LDATE#2024-03-05|T#0ms|LTIME#-1s500ms|LTOD#01:02:03.000456|LDT#2000-01-01-00:00:00.5|D#1970-01-01|TRUE|FALSE|T#1h2m3s4ms|",
      );
    });
  }

  it("reads its own text back: a negative LTIME and a fraction of a second of an LDT", () => {
    const result = compile(
      `PROGRAM Main
VAR t : TIME := T#1s500ms; lt : LTIME := LTIME#-1d1ns; dt : DT := DT#2024-03-05-12:34:56;
  ldt : LDT := LDT#2000-01-01-00:00:00.000000001; p : TIME := T#1h2m3s4ms;
  rt, rp : TIME; rl : LTIME; rdt : DT; rldt : LDT; a, b, c, d, e : STRING; END_VAR
rt := STRING_TO_TIME(TIME_TO_STRING(t)); a := TIME_TO_STRING(rt);
rl := STRING_TO_LTIME(LTIME_TO_STRING(lt)); b := LTIME_TO_STRING(rl);
rdt := STRING_TO_DT(DT_TO_STRING(dt)); c := DT_TO_STRING(rdt);
rldt := STRING_TO_LDT(LDT_TO_STRING(ldt)); d := LDT_TO_STRING(rldt);
rp := STRING_TO_TIME(TIME_TO_STRING(p)); e := TIME_TO_STRING(rp);
END_PROGRAM
`,
      { headerFileName: "generated.hpp" },
    );
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "temporal_round_trip",
      mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.A.get().c_str() << "|" << p.B.get().c_str() << "|" << p.C.get().c_str() << "|"
              << p.D.get().c_str() << "|" << p.E.get().c_str() << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe(
      "T#1s500ms|LTIME#-1d1ns|DT#2024-03-05-12:34:56|LDT#2000-01-01-00:00:00.000000001|T#1h2m3s4ms",
    );
  });

  it("reads back the LTIME and LDT minimum with no overflow", () => {
    const result = compile(
      `PROGRAM Main
VAR s : STRING := 'LTIME#-106751d23h47m16s854ms775us808ns'; r : LTIME; a : LDT; t, b, c : STRING; END_VAR
r := STRING_TO_LTIME(s); b := LTIME_TO_STRING(r);
a := LDT#2262-04-11-23:47:16.854775807; a := a - LTIME#106751d23h47m16s854ms775us807ns;
a := a - LTIME#106751d23h47m16s854ms775us807ns; a := a - LTIME#1ns;
t := LDT_TO_STRING(a); c := LDT_TO_STRING(STRING_TO_LDT(t));
END_PROGRAM
`,
      { headerFileName: "generated.hpp" },
    );
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "temporal_minimum",
      extraFlags: ["-fsanitize=undefined", "-fno-sanitize-recover=undefined"],
      mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.B.get().c_str() << "|" << p.T.get().c_str() << "|" << p.C.get().c_str() << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe(
      "LTIME#-106751d23h47m16s854ms775us808ns|LDT#1677-09-21-00:12:43.145224192|LDT#1677-09-21-00:12:43.145224192",
    );
  });

  it("reads malformed and out-of-range text with no undefined behaviour, and TOD fractions exactly", () => {
    const result = compile(
      `PROGRAM Main
VAR a, b, c, d, e, f, g, h, i, j : STRING;
  sa : STRING := 'DT#2000-01-01-99999999999:00:00'; sb : STRING := 'T#1.5e30s'; sc : STRING := 'T#.'; sd : STRING := 'T#5';
  se : STRING := ''; sf : STRING := 'DT#'; sg : STRING := 'LTOD#10:38:42.129794059'; sh : STRING := 'TOD#22:38:44.511365';
  si : STRING := 'T#1.5s'; sj : STRING := 'DT#99999999999999999999-99999999999-99999999999'; END_VAR
a := DT_TO_STRING(STRING_TO_DT(sa)); b := TIME_TO_STRING(STRING_TO_TIME(sb)); c := TIME_TO_STRING(STRING_TO_TIME(sc));
d := TIME_TO_STRING(STRING_TO_TIME(sd)); e := DT_TO_STRING(STRING_TO_DT(se)); f := DT_TO_STRING(STRING_TO_DT(sf));
g := LTOD_TO_STRING(STRING_TO_LTOD(sg)); h := TOD_TO_STRING(STRING_TO_TOD(sh)); i := TIME_TO_STRING(STRING_TO_TIME(si));
j := DT_TO_STRING(STRING_TO_DT(sj));
END_PROGRAM
`,
      { headerFileName: "generated.hpp" },
    );
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "temporal_malformed",
      extraFlags: [
        "-fsanitize=address,undefined,float-cast-overflow",
        "-fno-sanitize-recover=all",
      ],
      mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    for (auto* s : {&p.A, &p.B, &p.C, &p.D, &p.E, &p.F, &p.G, &p.H, &p.I, &p.J}) std::cout << s->get().c_str() << "|";
    std::cout << std::endl;
    return 0;
}
`,
    });
    expect(stdout.split("|").filter((l) => l !== "")).toEqual([
      // A 32-bit DT, TIME or TOD takes the text truncated to its unit
      // (s, ms) and modulo 2^32
      "DT#2061-03-28-22:07:56",
      "T#30s1ms",
      "T#0ms",
      "T#5ms",
      "DT#1970-01-01-00:00:00",
      "DT#1970-01-01-00:00:00",
      "LTOD#10:38:42.129794059",
      "TOD#22:38:44.511",
      "T#1s500ms",
      "DT#1988-12-29-20:03:13",
    ]);
  });
});
