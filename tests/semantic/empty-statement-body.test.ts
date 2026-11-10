/**
 * An empty statement (`;`) is a statement, so `FOR ... DO ; END_FOR` has a
 * body in every profile, --strict included. --strict still refuses a FOR
 * loop with no statement at all. WHILE, REPEAT, IF and CASE take either.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

const MODES: Array<[string, Parameters<typeof compile>[1]]> = [
  ["no flags", {}],
  ["iec-3", { dialect: "iec-3" }],
  ["strict", { strict: true }],
  ["strict iec-3", { strict: true, dialect: "iec-3" }],
  [
    "strict vendor profile",
    {
      strict: true,
      dialect: {
        id: "vendor-x",
        name: "Vendor X",
        extends: "iec-3",
        features: ["pointer_to", "reference_to", "ref_assign"],
        semantics: {},
      },
    },
  ],
];

function source(body: string): string {
  return `PROGRAM Main\nVAR k, n : INT; b : BOOL; END_VAR\n${body}\nEND_PROGRAM\n`;
}

function messages(
  body: string,
  options: Parameters<typeof compile>[1],
): string[] {
  const result = compile(source(body), options);
  return [...result.errors, ...result.warnings].map((e) => e.message);
}

describe("an empty statement as a loop body", () => {
  it.each(MODES)("FOR takes ';' as its body (%s)", (_name, options) => {
    expect(messages("FOR k := 1 TO 3 DO ; END_FOR;", options)).toEqual([]);
    expect(messages("FOR k := 1 TO 3 DO ;; END_FOR;", options)).toEqual([]);
    expect(messages("FOR k := 1 TO 3 DO\n  ;\nEND_FOR;", options)).toEqual([]);
  });

  it.each(MODES)(
    "WHILE, REPEAT, IF and CASE take ';' (%s)",
    (_name, options) => {
      const body = `WHILE b DO ; END_WHILE;
REPEAT ; UNTIL TRUE END_REPEAT;
IF b THEN ; ELSE ; END_IF;
CASE n OF 1: ; ELSE ; END_CASE;
;`;
      expect(messages(body, options)).toEqual([]);
    },
  );

  it("--strict still refuses a FOR loop with no statement", () => {
    const body = "FOR k := 1 TO 3 DO END_FOR;";
    for (const [name, options] of MODES) {
      expect(messages(body, options)).toEqual(
        name.startsWith("strict") ? ["A FOR loop must have a body"] : [],
      );
    }
  });

  it("generates the same C++ in every mode", () => {
    const src = source("FOR k := 1 TO 3 DO ; END_FOR;");
    const plain = compile(src, {});
    for (const [, options] of MODES) {
      const result = compile(src, options);
      expect(result.errors).toEqual([]);
      expect(result.cppCode).toBe(plain.cppCode);
    }
  });
});
