// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * The parameters a library FUNCTION exports in its manifest.
 *
 * Only VAR_INPUT, VAR_OUTPUT and VAR_IN_OUT are parameters. A function's VAR
 * and VAR_TEMP blocks are its locals: listing them would make a caller pass
 * them, and a local without an initial value would read as a mandatory input.
 */

import { describe, it, expect } from "vitest";
import { compileStlib } from "../../src/library/library-compiler.js";
import { compile } from "../../src/index.js";

const LIB_SOURCE = `
  FUNCTION MAKE_CHR : STRING(1)
    VAR_INPUT
      C : BYTE;
    END_VAR
    VAR
      PT : POINTER TO BYTE;
      N : INT;
    END_VAR
    VAR_TEMP
      T : INT;
    END_VAR
    VAR CONSTANT
      K : INT := 3;
    END_VAR
    PT := ADR(MAKE_CHR);
    PT^ := C;
    N := K;
    T := N;
  END_FUNCTION

  FUNCTION ALL_DIRS : INT
    VAR_INPUT a : INT; b : INT := 2; END_VAR
    VAR_IN_OUT io : INT; END_VAR
    VAR_OUTPUT q : INT; END_VAR
    VAR loc : INT; END_VAR
    loc := a + b;
    io := loc;
    q := loc;
    ALL_DIRS := loc;
  END_FUNCTION
`;

function buildLib() {
  const result = compileStlib([{ source: LIB_SOURCE, fileName: "lib.st" }], {
    name: "locals-lib",
    version: "1.0.0",
    namespace: "locals_lib",
  });
  expect(result.errors).toEqual([]);
  expect(result.success).toBe(true);
  return result.archive!;
}

function paramsOf(fnName: string) {
  const fn = buildLib().manifest.functions.find((f) => f.name === fnName);
  expect(fn).toBeDefined();
  return fn!.parameters.map((p) => ({ name: p.name, direction: p.direction }));
}

describe("library manifest: FUNCTION parameters", () => {
  it("omits VAR, VAR_TEMP and VAR CONSTANT locals", () => {
    expect(paramsOf("MAKE_CHR")).toEqual([{ name: "C", direction: "input" }]);
  });

  it("keeps inputs, in-outs and outputs in declaration order", () => {
    expect(paramsOf("ALL_DIRS")).toEqual([
      { name: "A", direction: "input" },
      { name: "B", direction: "input" },
      { name: "IO", direction: "inout" },
      { name: "Q", direction: "output" },
    ]);
  });

  it("lets a caller omit a library function's locals", () => {
    const result = compile(
      `
      PROGRAM Main
        VAR s : STRING(1); x : INT; y : INT; r : INT; END_VAR
        s := MAKE_CHR(65);
        r := ALL_DIRS(a := 1, io := x, q => y);
      END_PROGRAM
    `,
      { libraries: [buildLib()] },
    );
    expect(result.errors).toEqual([]);
    expect(result.success).toBe(true);
  });
});
