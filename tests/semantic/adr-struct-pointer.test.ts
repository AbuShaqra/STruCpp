/**
 * `p := ADR(x)` where `p` is a POINTER TO a STRUCT, UNION, ARRAY or FB type:
 * the address (__XWORD) is accepted under the default features. A STRUCT
 * variable that is not a pointer still refuses an address, and POINTER TO /
 * ADR stay refused under `--dialect iec-3`.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

const DECLS = `
  TYPE ST_A : STRUCT x : INT; y : REAL; END_STRUCT END_TYPE
  TYPE U_A : UNION i : DINT; f : REAL; END_UNION END_TYPE
  TYPE ST_H : STRUCT p : POINTER TO ST_A; END_STRUCT END_TYPE
  FUNCTION_BLOCK FB_A
  VAR_INPUT v : INT; END_VAR
  END_FUNCTION_BLOCK
`;

function errorsIn(body: string, dialect?: "iec-3"): string[] {
  return compile(
    `${DECLS}
    PROGRAM Main
    VAR s : ST_A; u : U_A; arr : ARRAY[0..1] OF ST_A; h : ST_H; fb : FB_A;
      p : POINTER TO ST_A; pu : POINTER TO U_A; pf : POINTER TO FB_A;
      pa : POINTER TO ARRAY[0..1] OF ST_A; END_VAR
      ${body}
    END_PROGRAM`,
    { ...(dialect ? { dialect } : {}), features: ["union"] },
  ).errors.map((e) => e.message);
}

describe("ADR into POINTER TO a structured type", () => {
  it("accepts ADR of a STRUCT, UNION, ARRAY and FB variable", () => {
    expect(
      errorsIn("p := ADR(s); pu := ADR(u); pa := ADR(arr); pf := ADR(fb);"),
    ).toEqual([]);
  });

  it("accepts ADR of an element or field, and into a STRUCT field of pointer type", () => {
    expect(errorsIn("p := ADR(arr[1]); h.p := ADR(arr[0]); p := h.p; p^.x := 1;")).toEqual([]);
  });

  it("still refuses an address into a STRUCT variable that is not a pointer", () => {
    expect(errorsIn("s := ADR(u);")).toEqual(["Cannot assign __XWORD to ST_A"]);
  });

  it("still refuses POINTER TO and ADR under iec-3", () => {
    const errs = errorsIn("p := ADR(s);", "iec-3");
    expect(errs).toContain("POINTER TO needs the feature pointer_to");
  });
});
