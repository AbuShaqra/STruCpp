/**
 * E2E for the feature call_result_access: a program reading members, elements
 * and bits of function and method results is compiled through the CLI with a
 * profile file, built with g++ and run. Each call runs once per access.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const CLI_PATH = path.resolve(__dirname, "../../dist/node/cli.js");

const PROGRAM = `TYPE ST_I : STRUCT v : DINT; END_STRUCT END_TYPE
TYPE ST_R : STRUCT nCode : INT; inner : ST_I; END_STRUCT END_TYPE
TYPE A3 : ARRAY[1..3] OF ST_I; END_TYPE
INTERFACE I_Run
METHOD Run : INT
END_METHOD
END_INTERFACE
VAR_GLOBAL calls : INT; END_VAR
FUNCTION MkR : ST_R
VAR_INPUT a : INT; END_VAR
calls := calls + 1;
MkR.nCode := a;
MkR.inner.v := a * 100;
END_FUNCTION
FUNCTION MkA : A3
VAR_INPUT a : DINT; END_VAR
calls := calls + 1;
MkA[2].v := a;
END_FUNCTION
FUNCTION_BLOCK FB_W IMPLEMENTS I_Run
VAR_OUTPUT q : INT; END_VAR
VAR n : INT; END_VAR
METHOD Run : INT
q := q + 1;
Run := q;
END_METHOD
METHOD Bump : ST_R
n := n + 1;
Bump.nCode := n;
END_METHOD
END_FUNCTION_BLOCK
VAR_GLOBAL gw : FB_W; END_VAR
FUNCTION GetI : I_Run
GetI := gw;
END_FUNCTION
PROGRAM Main
VAR
  field : INT;
  nested : DINT;
  element : DINT;
  bumps : INT;
  bit : BOOL;
  runs : INT;
  callCount : INT;
  w : FB_W;
END_VAR
field := MkR(4).nCode;
nested := MkR(5).inner.v;
element := MkA(7)[2].v;
bumps := w.Bump().nCode + w.Bump().nCode;
bit := MkR(2).nCode.1;
runs := GetI().Run();
runs := runs + GetI().Run();
callCount := calls;
END_PROGRAM
`;

const MAIN = `
#include <iostream>
int main() {
    strucpp::Program_MAIN prog;
    prog.run();
    std::cout << static_cast<long>(prog.FIELD) << " "
              << static_cast<long>(prog.NESTED) << " "
              << static_cast<long>(prog.ELEMENT) << " "
              << static_cast<long>(prog.BUMPS) << " "
              << (prog.BIT ? 1 : 0) << " " << static_cast<long>(prog.RUNS) << " "
              << static_cast<long>(prog.CALLCOUNT) << std::endl;
    return 0;
}
`;

describe.skipIf(!hasGpp)("member access on a call result end to end", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-cra-e2e-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  function compileWith(profileFeatures: string[]): {
    status: "ok" | "failed";
    output: string;
    dir: string;
  } {
    if (!fs.existsSync(CLI_PATH)) throw new Error(`CLI not built: ${CLI_PATH}`);
    const dir = fs.mkdtempSync(path.join(tempDir, "cli-"));
    const src = path.join(dir, "main.st");
    const profile = path.join(dir, "vendor-cra.json");
    fs.writeFileSync(src, PROGRAM);
    fs.writeFileSync(
      profile,
      JSON.stringify({
        id: "vendor-cra",
        extends: "iec-3",
        features: profileFeatures,
      }),
    );
    try {
      const output = execFileSync(
        "node",
        [
          CLI_PATH,
          src,
          "-o",
          path.join(dir, "generated.cpp"),
          "--dialect-file",
          profile,
        ],
        {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 120000,
        },
      );
      return { status: "ok", output, dir };
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string };
      return {
        status: "failed",
        output: `${e.stdout ?? ""}${e.stderr ?? ""}`,
        dir,
      };
    }
  }

  it("builds and runs with the feature on, evaluating each call once", () => {
    const compiled = compileWith(["call_result_access"]);
    expect(compiled.output).toContain("Compilation successful");
    const stdout = compileAndRunStandalone({
      tempDir: compiled.dir,
      pchPath,
      headerCode: fs.readFileSync(
        path.join(compiled.dir, "generated.hpp"),
        "utf-8",
      ),
      cppCode: fs.readFileSync(
        path.join(compiled.dir, "generated.cpp"),
        "utf-8",
      ),
      testName: "cra_cli",
      mainCode: MAIN,
    });
    // MkR, MkR, MkA and MkR run once each: calls = 4.
    expect(stdout).toBe("4 500 7 3 1 3 4");
  });

  it("the same profile without the feature refuses the program at the selector", () => {
    const compiled = compileWith([]);
    expect(compiled.status).toBe("failed");
    expect(compiled.output).toContain(
      "main.st:47:16: error: Member access on a call result needs the feature call_result_access; assign the result to a variable first",
    );
  });
});
