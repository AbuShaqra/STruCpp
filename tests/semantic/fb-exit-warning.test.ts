/** FB_exit is never called: a warning under the feature fb_init, none without it. */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

const SOURCE = `FUNCTION_BLOCK FB
VAR_OUTPUT n : INT; END_VAR
METHOD FB_exit : BOOL
VAR_INPUT bInCopyCode : BOOL; END_VAR
n := 99; FB_exit := TRUE;
END_METHOD
n := n + 1;
END_FUNCTION_BLOCK
PROGRAM Main VAR f : FB; END_VAR f(); END_PROGRAM
`;

describe("FB_exit", () => {
  it("warns under fb_init that it is never called", () => {
    const r = compile(SOURCE, { features: ["+fb_init"] });
    expect(r.errors).toEqual([]);
    expect(r.warnings.map((w) => `${w.line}:${w.column} ${w.message}`)).toEqual(
      ["3:1 FB_exit of 'FB' is never called: an instance is not torn down"],
    );
  });

  it("gives no warning without the feature", () => {
    const r = compile(SOURCE);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });
});
