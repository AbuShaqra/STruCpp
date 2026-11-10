/**
 * A library FUNCTION's named arguments are emitted in its parameter order,
 * and an omitted input with a declared default gets that default, named or
 * positional.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { compile } from "../../src/index.js";
import { discoverStlibs } from "../../src/node/library-loader.js";

const LIBS_DIR = path.resolve(__dirname, "../../libs");
const oscatAvailable = fs.existsSync(path.join(LIBS_DIR, "oscat-basic.stlib"));

describe.skipIf(!oscatAvailable)("library function named arguments", () => {
  const libraries = oscatAvailable ? discoverStlibs(LIBS_DIR) : [];
  const cpp = (body: string): string => {
    const r = compile(
      `PROGRAM Main
VAR l : STRING; s : STRING; r : REAL; d : DWORD; END_VAR
${body}
END_PROGRAM`,
      { libraries },
    );
    expect(r.errors).toEqual([]);
    return r.cppCode;
  };

  it("reorders an in/out named out of order", () => {
    expect(cpp("s := LIST_GET(SEP := 44, LIST := l, POS := 2);")).toContain(
      "S = LIST_GET(44, 2, L);",
    );
  });

  it("reorders inputs and fills an omitted default", () => {
    expect(
      cpp("r := AIN(LOW := 0.0, BITS := 12, IN := 4095, HIGH := 5.0);"),
    ).toContain("R = AIN(4095, 12, 255, 0.0, 5.0);");
  });

  it("fills a trailing default left out of a positional call", () => {
    expect(cpp("d := AOUT(1.0, 12, 255, 0.0);")).toContain(
      "D = AOUT(1.0, 12, 255, 0.0, 10.0);",
    );
  });

  it("leaves a complete positional call alone", () => {
    expect(cpp("r := AIN(4095, 12, 255, 0.0, 10.0);")).toContain(
      "R = AIN(4095, 12, 255, 0.0, 10.0);",
    );
  });
});
