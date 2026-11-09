/**
 * Chained comparisons in the analysis: a comparison yields BOOL, so a chain
 * compares that BOOL with the next operand. The chained form must be
 * checked exactly like the same expression written with the Annex A
 * grouping in explicit parentheses, under no dialect and `iec-3`, with and
 * without `--strict`. Errors inside a chain are positioned on their operand.
 */
import { describe, it, expect } from "vitest";
import { analyze, compile } from "../../src/index.js";
import type { AssignmentStatement } from "../../src/frontend/ast.js";

type Options = Parameters<typeof compile>[1];

const MODES: { name: string; options: Options }[] = [
  { name: "no dialect", options: {} },
  { name: "iec-3", options: { dialect: "iec-3" } },
  { name: "no dialect, strict", options: { strict: true } },
  { name: "iec-3, strict", options: { dialect: "iec-3", strict: true } },
];

const VARS =
  "VAR a, b, c, i : INT; x, y, z : BOOL; s : STRING; t : TIME; END_VAR";

function program(target: string, expr: string): string {
  return `PROGRAM P\n${VARS}\n${target} := ${expr};\nEND_PROGRAM\n`;
}

function errors(source: string, options: Options): string[] {
  return analyze(source, options).errors.map(
    (e) => `${e.line}:${e.column} ${e.message}`,
  );
}

/** Chained form, and the same expression with the Annex A grouping explicit. */
const PAIRS: [string, string][] = [
  ["a < b < 5", "(a < b) < 5"],
  ["a < b = TRUE", "(a < b) = TRUE"],
  ["a < b = c", "(a < b) = c"],
  ["a = b < c", "a = (b < c)"],
  ["x = y = z", "(x = y) = z"],
  ["a < b < c", "(a < b) < c"],
  ["s = 'q' = x", "(s = 'q') = x"],
  ["t < T#1s = x", "(t < T#1s) = x"],
  ["a <> b >= x", "a <> (b >= x)"],
  ["a < b = c > i", "(a < b) = (c > i)"],
  ["x <> a + 1 <= b * 2", "x <> ((a + 1) <= (b * 2))"],
];

describe("chained comparisons: analysis", () => {
  for (const mode of MODES) {
    describe(mode.name, () => {
      for (const [chained, grouped] of PAIRS) {
        for (const target of ["x", "i"]) {
          it(`${target} := ${chained}  matches  ${grouped}`, () => {
            const got = errors(program(target, chained), mode.options);
            const want = errors(program(target, grouped), mode.options);
            expect(got).toEqual(want);
          });
        }
      }

      it("types the chain as BOOL", () => {
        const result = analyze(program("x", "a < b = c < i"), mode.options);
        expect(result.errors).toEqual([]);
        const stmt = result.ast!.programs[0]!.body[0] as AssignmentStatement;
        const type = stmt.value.resolvedType;
        expect(type?.typeKind).toBe("elementary");
        expect(type && "name" in type ? type.name : undefined).toBe("BOOL");
      });

      it("positions an undeclared operand inside a chain", () => {
        const got = errors(program("x", "a < b = nope"), mode.options);
        expect(got.length).toBeGreaterThan(0);
        expect(got[0]).toMatch(/^3:14 .*NOPE/i);
      });
    });
  }

  it("strict refuses a chain assigned to INT, at the assignment", () => {
    expect(errors(program("i", "a < b < c"), { strict: true })).toEqual([
      "3:6 Implicit conversion from BOOL to INT is not allowed; use BOOL_TO_INT",
    ]);
  });

  it("is accepted in every mode where it was a parse error before", () => {
    for (const mode of MODES) {
      expect(errors(program("x", "a < b < c"), mode.options)).toEqual([]);
      expect(errors(program("x", "x = y = z"), mode.options)).toEqual([]);
    }
  });
});
