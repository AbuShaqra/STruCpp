/**
 * A library archive lists each function block's properties, VAR_TEMP members
 * and base. A consumer reads and writes the properties, refuses a write to one
 * without SET and a member or method the block does not have. An archive
 * without the lists keeps the old, unchecked behaviour.
 */
import { describe, it, expect } from "vitest";
import { compile, compileStlib } from "../../src/index.js";
import type { StlibArchive } from "../../src/library/library-manifest.js";

const LIB = `FUNCTION_BLOCK FB_Prop
VAR_INPUT k : INT := 1; END_VAR
VAR _v : INT := 7; END_VAR
VAR_TEMP t : INT; END_VAR
METHOD Twice : INT
Twice := _v * 2;
END_METHOD
PROPERTY Val : INT
GET
  Val := _v;
END_GET
SET
  _v := Val;
END_SET
END_PROPERTY
PROPERTY RO : INT
GET
  RO := _v * 2;
END_GET
END_PROPERTY
PROPERTY Name : STRING(20)
GET
  Name := 'abc';
END_GET
END_PROPERTY
t := _v + k;
_v := t;
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_Der EXTENDS FB_Prop
PROPERTY Own : INT
GET
  Own := 100;
END_GET
END_PROPERTY
END_FUNCTION_BLOCK`;

function library(): StlibArchive {
  const lib = compileStlib([{ source: LIB, fileName: "prop.st" }], {
    name: "prop-lib",
    version: "1.0.0",
    namespace: "strucpp",
  });
  expect(lib.success).toBe(true);
  return lib.archive!;
}

/** The archive as a compiler without the lists would have written it. */
function oldArchive(): StlibArchive {
  const lib = library();
  return {
    ...lib,
    manifest: {
      ...lib.manifest,
      functionBlocks: lib.manifest.functionBlocks.map((fb) => {
        const { properties, temps, extends: base, ...rest } = fb;
        void properties;
        void temps;
        void base;
        return rest;
      }),
    },
  };
}

type Options = Parameters<typeof compile>[1];
const MODES: Array<[string, Options]> = [
  ["no dialect", {}],
  ["iec-3", { dialect: "iec-3" }],
  ["strict", { strict: true }],
];

const errors = (body: string, options: Options, lib = library()) =>
  compile(
    `PROGRAM Main
VAR p : FB_Prop; d : FB_Der; a : INT; END_VAR
${body}
END_PROGRAM`,
    { ...options, libraries: [lib] },
  ).errors.map((e) => e.message);

describe("library FB properties", () => {
  it("lists properties, temps and the base in the manifest", () => {
    const fbs = library().manifest.functionBlocks;
    const prop = fbs.find((f) => f.name === "FB_PROP")!;
    expect(prop.properties).toEqual([
      { name: "VAL", type: { name: "VAL", type: "INT" }, get: true, set: true },
      { name: "RO", type: { name: "RO", type: "INT" }, get: true },
      {
        name: "NAME",
        type: expect.objectContaining({ name: "NAME" }) as unknown,
        get: true,
      },
    ]);
    expect(prop.temps).toEqual([{ name: "T", type: "INT" }]);
    expect(prop.extends).toBeUndefined();
    const der = fbs.find((f) => f.name === "FB_DER")!;
    expect(der.extends).toBe("FB_PROP");
    expect(der.temps).toBeUndefined();
  });

  for (const [label, options] of MODES) {
    describe(label, () => {
      it("accepts properties, temps, base members and methods", () => {
        expect(
          errors(
            "a := p.Val; p.Val := 3; a := d.Val + d.RO + d.Own + d.t + d.k + d.Twice();",
            options,
          ),
        ).toEqual([]);
      });

      it("refuses a write to a property without SET, own or inherited", () => {
        expect(errors("p.RO := 1;", options)).toEqual([
          "Property 'RO' of 'FB_PROP' is read-only (no SET accessor).",
        ]);
        expect(errors("d.RO := 1;", options)).toEqual([
          "Property 'RO' of 'FB_DER' is read-only (no SET accessor).",
        ]);
      });

      it("refuses a member or method the block does not have", () => {
        expect(errors("a := d.Nope;", options)).toEqual([
          "Function block 'FB_DER' has no member 'NOPE'",
        ]);
        expect(errors("a := p.Nope();", options)).toEqual([
          "Function block 'FB_PROP' has no method 'NOPE'",
        ]);
      });

      it("leaves an archive without the lists unchecked", () => {
        const lib = oldArchive();
        expect(
          errors("a := d.Nope; a := p.Nope(); p.RO := 1;", options, lib),
        ).toEqual([]);
      });
    });
  }
});
