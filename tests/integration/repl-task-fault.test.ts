// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: the REPL runner names the running task, so a run-time fault in the
 * second of two tasks reports that task.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { generateReplMain } from "../../src/backend/repl-main-gen.js";
import {
  hasGpp,
  hasCc,
  createPCH,
  precompileIsocline,
  RUNTIME_INCLUDE_PATH,
  REPL_PATH,
  cxxEnv,
  CXX_STD,
} from "./test-helpers.js";

const SOURCE = `FUNCTION_BLOCK FB
VAR_INPUT z : INT; END_VAR
VAR_OUTPUT o : INT; END_VAR
o := 7 / z;
END_FUNCTION_BLOCK
PROGRAM Ok
VAR n : INT; END_VAR
n := n + 1;
END_PROGRAM
PROGRAM Bad
VAR f : FB; END_VAR
f(z := 0);
END_PROGRAM
CONFIGURATION Cfg
RESOURCE Res ON PLC
TASK Fast(INTERVAL := T#10ms, PRIORITY := 1);
TASK Slow(INTERVAL := T#10ms, PRIORITY := 2);
PROGRAM ok1 WITH Fast : Ok;
PROGRAM bad1 WITH Slow : Bad;
END_RESOURCE
END_CONFIGURATION
`;

describe.skipIf(!(hasGpp && hasCc))(
  "REPL runner names the task in a fault",
  () => {
    let tempDir: string;
    beforeAll(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-repl-task-"));
    });
    afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    const build = (source: string, name: string): string => {
      const pchPath = createPCH(tempDir);
      const isoclineObj = precompileIsocline(tempDir);
      const result = compile(source, { headerFileName: "generated.hpp" });
      expect(result.errors).toEqual([]);
      const mainCpp = generateReplMain(result.ast!, result.projectModel!, {
        headerFileName: "generated.hpp",
        stSource: source,
        cppCode: result.cppCode,
        headerCode: result.headerCode,
        lineMap: result.lineMap,
        headerLineMap: result.headerLineMap,
      });
      const dir = path.join(tempDir, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "generated.hpp"), result.headerCode);
      const cppPath = path.join(dir, "generated.cpp");
      const mainPath = path.join(dir, "main.cpp");
      const binPath = path.join(dir, "repl");
      fs.writeFileSync(cppPath, result.cppCode);
      fs.writeFileSync(mainPath, mainCpp);
      execSync(
        `g++ -std=${CXX_STD} -include "${pchPath}" -I"${RUNTIME_INCLUDE_PATH}" -I"${REPL_PATH}" -I"${dir}" "${mainPath}" "${cppPath}" "${isoclineObj}" -o "${binPath}" 2>&1`,
        { encoding: "utf-8", env: cxxEnv },
      );
      return binPath;
    };

    it("reports the faulting task, stops it and keeps the others running", () => {
      const binPath = build(SOURCE, "two");
      const run = spawnSync(binPath, [], {
        input: "run 2\nget OK1.N\nquit\n",
        encoding: "utf-8",
        timeout: 10000,
      });
      const out = `${run.stdout}${run.stderr}`;
      expect(out).toContain("Fault: Division by zero in FB, line 4, task SLOW");
      expect(out).toContain("Stopped task SLOW");
      // FAST still ran both cycles, and the session went on to `get`
      expect(out).toMatch(/OK1\.N : INT = 2/);
      expect(out).not.toContain("terminate called");
      expect(run.status).toBe(1);
    });

    it("ends the cyclic runner with status 1 once every task has faulted", () => {
      const binPath = build(
        SOURCE.replace(/TASK Fast[^\n]*\n/, "").replace(
          /PROGRAM ok1 WITH Fast : Ok;\n/,
          "",
        ),
        "one",
      );
      const run = spawnSync(binPath, ["--cyclic"], {
        encoding: "utf-8",
        timeout: 10000,
      });
      const out = `${run.stdout}${run.stderr}`;
      expect(out).toContain("Fault: Division by zero in FB, line 4, task SLOW");
      expect(out).not.toContain("terminate called");
      expect(run.status).toBe(1);
    });
  },
);
