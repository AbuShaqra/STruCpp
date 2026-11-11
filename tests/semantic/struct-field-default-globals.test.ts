/**
 * A STRUCT field default is a constant expression: a VAR_GLOBAL CONSTANT it
 * names (declared before or after the type, plain or list-qualified) is
 * folded to its value; a global variable is an error. A POINTER TO, REF_TO
 * or REFERENCE TO field takes no address or reference as its default.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

type Options = Parameters<typeof compile>[1];
const MODES: Array<[string, Options]> = [
  ["no dialect", {}],
  ["iec-3", { dialect: "iec-3" }],
  ["strict", { strict: true }],
];

const errors = (source: string, options: Options): string[] =>
  compile(source, options).errors.map((e) => e.message);

const program = (decls: string): string => `${decls}
PROGRAM Main
VAR l : ST; END_VAR
END_PROGRAM
`;

describe("STRUCT field defaults naming globals", () => {
  for (const [label, options] of MODES) {
    describe(label, () => {
      it("folds CONSTANT globals declared before or after the type", () => {
        const before = compile(
          program(`VAR_GLOBAL CONSTANT K : INT := 4; END_VAR
TYPE ST : STRUCT a : INT := K * 2; b : INT := a; END_STRUCT END_TYPE`),
          { ...options, headerFileName: "generated.hpp" },
        );
        expect(before.errors).toEqual([]);
        expect(before.headerCode).toContain("IEC_INT A = (4) * 2;");
        expect(before.headerCode).toContain("IEC_INT B = A;");
        const after = compile(
          program(`TYPE ST : STRUCT a : INT := K + J; END_STRUCT END_TYPE
VAR_GLOBAL CONSTANT K : INT := J * 2; J : INT := 3; END_VAR`),
          { ...options, headerFileName: "generated.hpp" },
        );
        expect(after.errors).toEqual([]);
        expect(after.headerCode).toContain("IEC_INT A = ((3) * 2) + (3);");
      });

      it("refuses a global variable", () => {
        expect(
          errors(
            program(`TYPE ST : STRUCT a : INT := G + 1; END_STRUCT END_TYPE
VAR_GLOBAL G : INT := 5; END_VAR`),
            options,
          ),
        ).toEqual([
          "The default of STRUCT field 'ST.A' must be a constant expression: 'G' is a global variable, not a constant",
        ]);
      });

      it("refuses a REF_TO or REFERENCE TO default, keeps REF_TO := NULL", () => {
        expect(
          errors(
            program(`VAR_GLOBAL G : INT; END_VAR
TYPE ST : STRUCT r : REF_TO INT := REF(G); END_STRUCT END_TYPE`),
            options,
          ),
        ).toEqual([
          "REF_TO initializers are not supported in a STRUCT; assign 'ST.R' in the body instead",
        ]);
        expect(
          errors(
            program(
              `TYPE ST : STRUCT r : REF_TO INT := NULL; END_STRUCT END_TYPE`,
            ),
            options,
          ),
        ).toEqual([]);
      });
    });
  }

  it("refuses a REFERENCE TO default", () => {
    expect(
      errors(
        program(`VAR_GLOBAL G : INT; END_VAR
TYPE ST : STRUCT r : REFERENCE TO INT := REF(G); END_STRUCT END_TYPE`),
        {},
      ),
    ).toEqual([
      "REFERENCE TO initializers are not supported in a STRUCT; assign 'ST.R' in the body instead",
    ]);
  });

  it("folds a list-qualified constant", () => {
    const result = compile(
      program(
        `TYPE ST : STRUCT a : INT := GVL_C.cDefault + 1; END_STRUCT END_TYPE`,
      ),
      {
        headerFileName: "generated.hpp",
        additionalSources: [
          {
            source: "VAR_GLOBAL CONSTANT cDefault : INT := 41; END_VAR\n",
            fileName: "gvl_c.st",
            globalListName: "GVL_C",
          },
        ],
        features: ["+named_global_lists"],
      },
    );
    expect(result.errors).toEqual([]);
    expect(result.headerCode).toContain("IEC_INT A = (41) + 1;");
  });
});
