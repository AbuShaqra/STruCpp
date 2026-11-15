/**
 * Every standard function that takes arguments, called with none or one too
 * few, gets a diagnostic and no exception, in a body and in an initial value
 * (initial values had no argument count check, and LOWER_BOUND() threw in
 * codegen).
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import { StdFunctionRegistry } from "../../src/semantic/std-function-registry.js";

const SHAPES: Array<[string, (call: string) => string]> = [
  [
    "body",
    (c) =>
      `PROGRAM Main\nVAR i : DINT; x : DINT; END_VAR\nx := ${c};\nEND_PROGRAM\n`,
  ],
  [
    "global initial value",
    (c) =>
      `VAR_GLOBAL i : DINT; x : DINT := ${c}; END_VAR\nPROGRAM Main\nEND_PROGRAM\n`,
  ],
  [
    "local initial value",
    (c) =>
      `PROGRAM Main\nVAR i : DINT; x : DINT := ${c}; END_VAR\nEND_PROGRAM\n`,
  ],
  [
    "FB member initial value",
    (c) =>
      `FUNCTION_BLOCK FB\nVAR i : DINT; x : DINT := ${c}; END_VAR\nEND_FUNCTION_BLOCK\nPROGRAM Main\nVAR f : FB; END_VAR\nEND_PROGRAM\n`,
  ],
];

const MODES: Array<[string, Parameters<typeof compile>[1]]> = [
  ["no dialect", {}],
  ["iec-3", { dialect: "iec-3" }],
  ["strict", { strict: true }],
];

/** The calls short of arguments: none, and one for a function of more inputs. */
function shortCalls(): string[] {
  const calls: string[] = [];
  for (const fn of new StdFunctionRegistry().getAll()) {
    const needed = fn.isVariadic
      ? (fn.minArgs ?? fn.params.length)
      : fn.params.length;
    if (needed > 0) calls.push(`${fn.name}()`);
    if (needed > 1) calls.push(`${fn.name}(i)`);
  }
  return calls;
}

describe("standard functions called short of arguments", () => {
  for (const [mode, options] of MODES) {
    for (const [shape, source] of SHAPES) {
      it(`${mode}, ${shape}: a diagnostic, no exception`, () => {
        const silent: string[] = [];
        for (const call of shortCalls()) {
          let errors: string[];
          try {
            errors = compile(source(call), options).errors.map(
              (e) => e.message,
            );
          } catch (e) {
            errors = [];
            silent.push(`${call} threw: ${(e as Error).message}`);
            continue;
          }
          if (errors.length === 0) silent.push(`${call} accepted`);
        }
        expect(silent).toEqual([]);
      });
    }
  }
});
