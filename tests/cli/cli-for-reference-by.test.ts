/**
 * A REFERENCE TO FOR control variable with BY steps the variable it is bound
 * to (built and run with g++).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "fs";
import { resolve, join } from "path";
import { tmpdir } from "os";
import { hasGpp } from "../integration/test-helpers.js";

const CLI_PATH = resolve(__dirname, "../../dist/node/cli.js");
let dir: string;

beforeAll(() => {
  if (!existsSync(CLI_PATH)) throw new Error(`CLI not built: ${CLI_PATH}`);
  dir = mkdtempSync(join(tmpdir(), "strucpp-cli-for-reference-by-"));
  writeFileSync(
    join(dir, "src.st"),
    `FUNCTION_BLOCK FbR
VAR_OUTPUT s, x : INT; END_VAR
VAR r : REFERENCE TO INT; END_VAR
r REF= x;
FOR r := 1 TO 10 BY 2 DO s := s + r; END_FOR;
END_FUNCTION_BLOCK
`,
  );
  writeFileSync(
    join(dir, "t.st"),
    `TEST 'by'
VAR f : FbR; END_VAR
f();
ASSERT_EQ(f.s, 25);
ASSERT_EQ(f.x, 11);
END_TEST
`,
  );
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!hasGpp)("FOR over a REFERENCE TO with BY", () => {
  it("builds and steps the bound variable", () => {
    const r = spawnSync(
      "node",
      [CLI_PATH, join(dir, "src.st"), "--test", join(dir, "t.st")],
      { encoding: "utf-8", timeout: 120000 },
    );
    expect(r.stdout).toContain("1 test, 1 passed, 0 failed");
    expect(r.status).toBe(0);
  });
});
