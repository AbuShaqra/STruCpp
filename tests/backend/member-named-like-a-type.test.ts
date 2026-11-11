/**
 * A member (or a local of a FUNCTION, METHOD or accessor) named like a user
 * type is renamed NAME_, as one named like its own type already was: the
 * C++ name would otherwise hide the type for the rest of the class or body.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

type Options = Parameters<typeof compile>[1];
const MODES: Array<[string, Options]> = [
  ["no dialect", {}],
  ["iec-3", { dialect: "iec-3" }],
  ["strict", { strict: true }],
  ["vendor features", { strict: true, features: ["+property"] }],
];

describe("members named like a user type", () => {
  for (const [label, options] of MODES) {
    describe(label, () => {
      it("renames a PROGRAM member, its uses, and keeps the type usable", () => {
        const r = compile(
          `TYPE S3 : STRING(3); END_TYPE
PROGRAM Main
VAR s3 : STRING(3) := 'ab'; a : S3; i : INT; END_VAR
i := LEN(s3);
END_PROGRAM
`,
          options,
        );
        expect(r.errors).toEqual([]);
        expect(r.headerCode).toContain("IECStringVar<3> S3_;");
        expect(r.headerCode).toContain("S3 A;");
        expect(r.cppCode).toContain("I = LEN(S3_);");
      });

      it("renames an FB member and a FUNCTION local", () => {
        const r = compile(
          `TYPE MyInt : INT; END_TYPE
FUNCTION_BLOCK F2
VAR myint : MyInt; END_VAR
VAR_OUTPUT o : INT; END_VAR
myint := 2; o := myint;
END_FUNCTION_BLOCK
FUNCTION F : INT
VAR myint : INT := 4; a : MyInt; END_VAR
F := myint;
END_FUNCTION
PROGRAM Main
VAR f2 : F2; i : INT; END_VAR
f2(); i := f2.o + F();
END_PROGRAM
`,
          options,
        );
        expect(r.errors).toEqual([]);
        expect(r.headerCode).toContain("MYINT MYINT_");
        expect(r.cppCode).toContain("MYINT_ = 2;");
        expect(r.cppCode).toMatch(/IEC_INT MYINT_ = 4;/);
        expect(r.cppCode).toContain("F_result = MYINT_;");
      });

      it("leaves a parameter named like a type as written", () => {
        const r = compile(
          `TYPE S3 : STRING(3); END_TYPE
FUNCTION F : INT
VAR_INPUT s3 : INT; END_VAR
F := s3;
END_FUNCTION
PROGRAM Main
VAR i : INT; END_VAR
i := F(2);
END_PROGRAM
`,
          options,
        );
        expect(r.errors).toEqual([]);
        expect(r.cppCode).toContain("F_result = S3;");
      });
    });
  }
});
