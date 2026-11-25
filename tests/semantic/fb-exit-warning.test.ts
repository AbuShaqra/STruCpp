/** FB_exit is never called: a warning with or without the feature fb_init. */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

const SOURCE = `FUNCTION_BLOCK FB
VAR_OUTPUT n : INT; END_VAR
METHOD PUBLIC FB_exit : BOOL
VAR_INPUT bInCopyCode : BOOL; END_VAR
n := 99; FB_exit := TRUE;
END_METHOD
n := n + 1;
END_FUNCTION_BLOCK
PROGRAM Main VAR f : FB; END_VAR f(); END_PROGRAM
`;

const WARNING =
  "3:15 FB_exit of 'FB' is never called: an instance is not torn down";

function located(r: ReturnType<typeof compile>): string[] {
  return r.warnings.map((w) => `${w.line}:${w.column} ${w.message}`);
}

describe("FB_exit", () => {
  it("warns under fb_init that it is never called", () => {
    const r = compile(SOURCE, { features: ["+fb_init"] });
    expect(r.errors).toEqual([]);
    expect(located(r)).toEqual([WARNING]);
  });

  it("warns without the feature too", () => {
    const r = compile(SOURCE);
    expect(r.errors).toEqual([]);
    expect(located(r)).toEqual([WARNING]);
  });

  it("matches the name in any case", () => {
    const r = compile(SOURCE.replace(/FB_exit/g, "fb_EXIT"));
    expect(r.errors).toEqual([]);
    expect(located(r)).toEqual([
      "3:15 FB_exit of 'FB' is never called: an instance is not torn down",
    ]);
  });

  it("does not warn at a similar name", () => {
    const r = compile(SOURCE.replace(/FB_exit/g, "FB_exit2"));
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("does not warn at a FUNCTION named FB_exit", () => {
    const r = compile(`FUNCTION FB_exit : BOOL
FB_exit := TRUE;
END_FUNCTION
PROGRAM Main VAR b : BOOL; END_VAR b := FB_exit(); END_PROGRAM
`);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("warns once at the parent when a child inherits it", () => {
    const r = compile(
      SOURCE.replace(
        "PROGRAM Main VAR f : FB; END_VAR",
        `FUNCTION_BLOCK FB_Child EXTENDS FB
END_FUNCTION_BLOCK
PROGRAM Main VAR f : FB_Child; END_VAR`,
      ),
    );
    expect(r.errors).toEqual([]);
    expect(located(r)).toEqual([WARNING]);
  });

  it("warns at an override in the child as well", () => {
    const r = compile(
      SOURCE.replace(
        "PROGRAM Main VAR f : FB; END_VAR",
        `FUNCTION_BLOCK FB_Child EXTENDS FB
METHOD PUBLIC FB_exit : BOOL
VAR_INPUT bInCopyCode : BOOL; END_VAR
FB_exit := TRUE;
END_METHOD
END_FUNCTION_BLOCK
PROGRAM Main VAR f : FB_Child; END_VAR`,
      ),
    );
    expect(r.errors).toEqual([]);
    expect(located(r)).toEqual([
      WARNING,
      "10:15 FB_exit of 'FB_Child' is never called: an instance is not torn down",
    ]);
  });
});
