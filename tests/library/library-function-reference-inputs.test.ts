/**
 * A REFERENCE TO input of a library FUNCTION is recorded in the manifest and
 * bound to its argument by a consumer; an archive without the field keeps
 * the old reading.
 */
import { describe, it, expect } from "vitest";
import { compile, compileStlib } from "../../src/index.js";
import { libraryFunctionDeclaration } from "../../src/library/library-methods.js";
import type { LibraryFunctionEntry } from "../../src/library/library-manifest.js";

const LIB_SOURCE = `FUNCTION Bump : INT
VAR_INPUT r : REFERENCE TO INT; d : INT; p : POINTER TO INT; END_VAR
r := r + d;
Bump := r;
END_FUNCTION`;

function lib() {
  const built = compileStlib([{ source: LIB_SOURCE, fileName: "bump.st" }], {
    name: "bump-lib",
    version: "1.0.0",
    namespace: "strucpp",
  });
  expect(built.success).toBe(true);
  return built.archive!;
}

type Options = Parameters<typeof compile>[1];
const MODES: Array<[string, Options]> = [
  ["no dialect", {}],
  ["iec-3", { dialect: "iec-3" }],
  ["strict", { strict: true }],
  [
    "strict, vendor features",
    {
      strict: true,
      dialect: "iec-3",
      features: ["+pointer_to", "+reference_to"],
    },
  ],
];

describe("library FUNCTION REFERENCE TO inputs", () => {
  it("records the reference kind of the input only", () => {
    const fn = lib().manifest.functions.find((f) => f.name === "BUMP")!;
    expect(fn.parameters).toEqual([
      {
        name: "R",
        type: "INT",
        direction: "input",
        referenceKind: "reference_to",
      },
      { name: "D", type: "INT", direction: "input" },
      { name: "P", type: "INT", direction: "input" },
    ]);
  });

  it("rebuilds the declaration with the reference, and without it for an old entry", () => {
    const entry: LibraryFunctionEntry = {
      name: "BUMP",
      returnType: "INT",
      parameters: [
        {
          name: "R",
          type: "INT",
          direction: "input",
          referenceKind: "reference_to",
        },
      ],
    };
    const decl = libraryFunctionDeclaration(entry)!;
    expect(decl.varBlocks[0]!.declarations[0]!.type.referenceKind).toBe(
      "reference_to",
    );
    const old = libraryFunctionDeclaration({
      ...entry,
      parameters: [{ name: "R", type: "INT", direction: "input" }],
    })!;
    expect(old.varBlocks[0]!.declarations[0]!.type.referenceKind).toBe("none");
  });

  for (const [label, options] of MODES) {
    describe(label, () => {
      const run = (body: string) =>
        compile(
          `PROGRAM Main
VAR x, y : INT := 1; r : REAL; a : ARRAY[0..1] OF INT; END_VAR
${body}
END_PROGRAM
`,
          { ...options, libraries: [lib()] },
        );

      it("binds the input to its argument, positional or named", () => {
        const r = run(
          "y := Bump(x, 5, 0); y := Bump(d := 10, r := x, p := 0); y := Bump(a[1], 1, 0);",
        );
        expect(r.errors).toEqual([]);
        expect(r.cppCode).toContain("BUMP(ref_bind(X), 5, ");
        expect(r.cppCode).toContain("BUMP(ref_bind(X), 10, ");
      });

      it("refuses an expression or a variable of another type", () => {
        expect(
          run("y := Bump(x + 1, 5, 0);").errors.map((e) => e.message),
        ).toEqual([
          "REFERENCE TO input 'R' needs a variable to refer to, not an expression",
        ]);
        expect(run("y := Bump(r, 5, 0);").errors.map((e) => e.message)).toEqual(
          ["REFERENCE TO INT cannot refer to a REAL variable"],
        );
      });
    });
  }
});
