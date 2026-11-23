// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * DT - DT, TOD - TOD and DATE - DATE are durations whether each side is a
 * variable or a typed literal (IEC 61131-3 Table 30): the result is stored
 * in a TIME (an LTIME for a long operand) and holds the difference in ms.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { discoverStlibs } from "../../src/node/library-loader.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const LIBS_DIR = path.resolve(__dirname, "../../libs");
const libsAvailable = fs.existsSync(
  path.join(LIBS_DIR, "iec-standard-fb.stlib"),
);

const SOURCE = `PROGRAM MAIN
VAR
  d1 : DT := DT#2000-01-02-00:00:00;
  t1 : TOD := TOD#12:00:01;
  da : DATE := D#2000-01-02;
  r1, r2, r3, r4, r5, r6 : TIME;
  l1, l2 : LTIME;
  u1, u2, u3, u4, u5, u6 : UDINT;
  m1, m2 : ULINT;
END_VAR
r1 := d1 - DT#2000-01-01-00:00:00;
r2 := DT#2000-01-02-00:01:00 - d1;
r3 := TOD#12:00:01 - TOD#12:00:00;
r4 := t1 - TOD#11:00:00;
r5 := D#2000-01-03 - da;
r6 := DT#2000-01-01-00:00:10 - DT#2000-01-01-00:00:00;
l1 := LDT#2000-01-01-00:00:02 - DT#2000-01-01-00:00:00;
l2 := LTOD#12:00:01 - TOD#12:00:00;
u1 := TIME_TO_UDINT(r1); u2 := TIME_TO_UDINT(r2); u3 := TIME_TO_UDINT(r3);
u4 := TIME_TO_UDINT(r4); u5 := TIME_TO_UDINT(r5); u6 := TIME_TO_UDINT(r6);
m1 := LTIME_TO_ULINT(l1); m2 := LTIME_TO_ULINT(l2);
END_PROGRAM
`;

describe.skipIf(!hasGpp || !libsAvailable)(
  "instant minus a typed literal at run time",
  () => {
    let tempDir: string;
    let pchPath: string;
    beforeAll(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-dtdiff-"));
      pchPath = createPCH(tempDir);
    });
    afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    it("stores the difference as a duration", () => {
      const r = compile(SOURCE, {
        headerFileName: "generated.hpp",
        libraries: discoverStlibs(LIBS_DIR),
      });
      expect(r.errors).toEqual([]);
      const out = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: r.headerCode,
        cppCode: r.cppCode,
        testName: "dtdiff_literal",
        mainCode: `#include <iostream>
int main() {
  using namespace strucpp;
  static Program_MAIN p; p.run();
  std::cout << p.U1.get() << " " << p.U2.get() << " " << p.U3.get() << " "
            << p.U4.get() << " " << p.U5.get() << " " << p.U6.get() << " "
            << p.M1.get() << " " << p.M2.get() << "\\n";
  return 0;
}
`,
      });
      // TIME in ms; LTIME in ns.
      expect(out.trim()).toBe(
        "86400000 60000 1000 3601000 86400000 10000 2000000000 1000000000",
      );
    });
  },
);
