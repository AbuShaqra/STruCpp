// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * A sign after the type prefix of a typed literal (IEC 61131-3 Ed. 3 Table 5
 * feature 9, Table 8 features 2a/2b; Annex A `Int_Literal`, `Real_Literal`,
 * `Duration`): `INT#-123`, `LREAL#-0.9`, `DINT#+5`, `T#-14ms`.
 *
 * Covered here: the analyzer accepts it and range-checks a signed integer
 * against its prefix type, codegen lowers it to the source value (the most
 * negative value of every signed type included, without overflow), and g++
 * builds and runs the result under `-pedantic-errors`.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

function errorsOf(source: string, dialect?: "iec-3"): string[] {
  const r = compile(source, dialect ? { dialect } : {});
  return r.errors.map((e) => e.message);
}

describe("signed typed literals — analysis and codegen", () => {
  it("accepts a sign after INT/DINT/LREAL/REAL/TIME prefixes in every dialect", () => {
    const src = `
      PROGRAM Main
      VAR
        a : INT := INT#-123;
        b : LREAL := LREAL#-0.9;
        c : DINT := DINT#+5;
        d : TIME := T#-14ms;
        e : TIME := TIME#+1s;
        f : REAL := REAL#-1;
      END_VAR
        a := INT#-7;
        CASE a OF
          INT#-7: c := 1;
        END_CASE;
      END_PROGRAM`;
    expect(errorsOf(src)).toEqual([]);
    expect(errorsOf(src, "iec-3")).toEqual([]);
  });

  it("lowers the signed value, and each type's minimum without overflow", () => {
    const r = compile(`
      PROGRAM Main
      VAR
        a : INT := INT#-123;
        c : DINT := DINT#+5;
        s : SINT := SINT#-128;
        i : INT := INT#-32768;
        di : DINT := DINT#-2147483648;
        l : LINT := LINT#-9223372036854775808;
        r : LREAL := LREAL#-0.9;
        t : TIME := T#-14ms;
      END_VAR
      END_PROGRAM`);
    expect(r.errors).toEqual([]);
    expect(r.cppCode).toContain("static_cast<IEC_INT>(-123)");
    expect(r.cppCode).toContain("static_cast<IEC_DINT>(5)");
    expect(r.cppCode).toContain("static_cast<IEC_SINT>(-128)");
    expect(r.cppCode).toContain(
      "static_cast<IEC_LINT>((-9223372036854775807LL - 1))",
    );
    expect(r.cppCode).toContain("static_cast<IEC_LREAL>(-0.9)");
    expect(r.cppCode).toContain("-14000000LL");
  });

  it("refuses a signed integer outside its prefix type's range", () => {
    for (const lit of ["SINT#-129", "USINT#-1", "UDINT#-5", "INT#+32768", "LINT#-9223372036854775809"]) {
      const errs = errorsOf(`
        PROGRAM Main
        VAR x : ${lit.slice(0, lit.indexOf("#"))}; END_VAR
          x := ${lit};
        END_PROGRAM`);
      expect(errs.length, lit).toBe(1);
      expect(errs[0], lit).toMatch(/outside the range of/);
    }
  });

  it("refuses a negative task INTERVAL", () => {
    const errs = errorsOf(`
      PROGRAM Main VAR x : INT; END_VAR x := 1; END_PROGRAM
      CONFIGURATION Cfg
        RESOURCE Res ON PLC
          TASK T1(INTERVAL := T#-10ms, PRIORITY := 1);
          PROGRAM P1 WITH T1 : Main;
        END_RESOURCE
      END_CONFIGURATION`);
    expect(errs).toEqual(["Task 'T1' INTERVAL must not be negative"]);
  });

  it("keeps an unsigned typed literal without a sign as before", () => {
    // Pre-existing behaviour, pinned: no range check on an unsigned payload.
    expect(errorsOf(`
      PROGRAM Main
      VAR a : SINT := SINT#127; b : USINT := USINT#+0; END_VAR
      END_PROGRAM`)).toEqual([]);
  });
});

describe.skipIf(!hasGpp)("signed typed literals — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-signedlit-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("runs with the source values, minima included", () => {
    const result = compile(`
      TYPE ST_Lim :
      STRUCT
        lo : LINT := LINT#-9223372036854775808;
        neg : DINT := DINT#-42;
      END_STRUCT
      END_TYPE

      FUNCTION Twice : DINT
        VAR_INPUT v : DINT; END_VAR
        Twice := v * 2;
      END_FUNCTION

      PROGRAM Main
      VAR
        a : INT := INT#-123;
        c : DINT := DINT#+5;
        s : SINT := SINT#-128;
        i : INT := INT#-32768;
        di : DINT := DINT#-2147483648;
        l : LINT := LINT#-9223372036854775808;
        r : LREAL := LREAL#-0.9;
        t : TIME := T#-14ms;
        st : ST_Lim;
        tw : DINT;
        tms : DINT;
        hit : INT;
      END_VAR
        tw := Twice(DINT#-21);
        tms := TIME_TO_DINT(t);
        CASE a OF
          INT#-123: hit := 1;
        ELSE
          hit := 2;
        END_CASE;
      END_PROGRAM
    `, { headerFileName: "generated.hpp" });
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "signed_typed_literal",
      extraFlags: ["-pedantic-errors"],
      mainCode: `
#include <iostream>
int main() {
    strucpp::Program_MAIN prog;
    prog.run();
    std::cout << prog.A.get() << " " << prog.C.get() << " "
              << static_cast<int>(prog.S.get()) << " " << prog.I.get() << " "
              << prog.DI.get() << " " << static_cast<long long>(prog.L.get()) << " "
              << prog.R.get() << " " << prog.TMS.get() << " " << prog.TW.get() << " "
              << static_cast<long long>(prog.ST.LO.get()) << " " << prog.ST.NEG.get() << " "
              << prog.HIT.get() << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe(
      "-123 5 -128 -32768 -2147483648 -9223372036854775808 -0.9 -14 -42 " +
        "-9223372036854775808 -42 1",
    );
  });
});
