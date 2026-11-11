/**
 * Runs the C++ runtime's GoogleTest suite (src/runtime/tests) from npm test.
 *
 * Configures src/runtime/CMakeLists.txt in a temporary build directory, builds
 * runtime_tests and runs ctest. Skips, with the reason printed, when cmake or a
 * C++ compiler is missing, or when googletest is neither installed nor
 * fetchable (offline). Any other configure, build or test failure fails.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const RUNTIME_DIR = path.resolve(__dirname, "../../src/runtime");
const TESTS_DIR = path.join(RUNTIME_DIR, "tests");
const CMAKE_LISTS = path.join(RUNTIME_DIR, "CMakeLists.txt");

const STEP_TIMEOUT_MS = 15 * 60 * 1000;

interface StepResult {
  ok: boolean;
  output: string;
}

function run(cmd: string, args: string[], cwd: string): StepResult {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    timeout: STEP_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? `\n${r.error.message}` : ""}`;
  return { ok: r.status === 0 && !r.error, output };
}

function works(cmd: string): boolean {
  const r = spawnSync(cmd, ["--version"], { stdio: "ignore", timeout: 30000 });
  return r.status === 0 && !r.error;
}

const hasCmake = works("cmake");
const cxx = [process.env.CXX, "g++", "clang++", "c++"].find(
  (c): c is string => typeof c === "string" && c.length > 0 && works(c),
);

const toolchainMissing = !hasCmake
  ? "cmake not found on PATH"
  : cxx === undefined
    ? "no C++ compiler found (CXX, g++, clang++, c++)"
    : undefined;

if (toolchainMissing !== undefined) {
  console.warn(`[runtime-cpp-tests] skipped: ${toolchainMissing}`);
}

/** True when a configure failure is googletest being unavailable, not a project error. */
function isGtestUnavailable(output: string): boolean {
  if (!/googletest/i.test(output)) return false;
  return /failed to clone|could not resolve host|unable to access|failed to connect|connection (refused|timed out|reset)|build step for googletest failed|network is unreachable/i.test(
    output,
  );
}

describe("C++ runtime unit tests (GoogleTest)", () => {
  it("registers every runtime test source in CMakeLists.txt", () => {
    const cmake = fs.readFileSync(CMAKE_LISTS, "utf8");
    const sources = fs.readdirSync(TESTS_DIR).filter((f) => f.endsWith(".cpp"));
    expect(sources.length).toBeGreaterThan(0);
    const unregistered = sources.filter((f) => !cmake.includes(`tests/${f}`));
    expect(unregistered).toEqual([]);
  });

  describe.skipIf(toolchainMissing !== undefined)("build and run", () => {
    let buildDir = "";
    let configure: StepResult = { ok: false, output: "" };
    let gtestUnavailable = false;

    beforeAll(() => {
      buildDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-runtime-"));
      const args = [
        "-S",
        RUNTIME_DIR,
        "-B",
        buildDir,
        "-DCMAKE_BUILD_TYPE=Debug",
      ];
      if (cxx !== undefined) args.push(`-DCMAKE_CXX_COMPILER=${cxx}`);
      const gtestSrc = process.env.STRUCPP_GTEST_SOURCE_DIR;
      if (gtestSrc)
        args.push(`-DFETCHCONTENT_SOURCE_DIR_GOOGLETEST=${gtestSrc}`);
      configure = run("cmake", args, buildDir);
      gtestUnavailable = !configure.ok && isGtestUnavailable(configure.output);
    }, STEP_TIMEOUT_MS);

    afterAll(() => {
      if (buildDir) fs.rmSync(buildDir, { recursive: true, force: true });
    });

    it(
      "builds runtime_tests and passes ctest",
      (ctx) => {
        if (gtestUnavailable) {
          console.warn(
            "[runtime-cpp-tests] skipped: googletest is not installed and could not be fetched " +
              "(offline?). Install it, or set STRUCPP_GTEST_SOURCE_DIR to a googletest checkout.",
          );
          ctx.skip();
          return;
        }
        expect(
          configure.ok,
          `cmake configure failed:\n${configure.output}`,
        ).toBe(true);

        const jobs = String(Math.max(1, os.cpus().length));
        const build = run(
          "cmake",
          ["--build", buildDir, "--parallel", jobs],
          buildDir,
        );
        expect(build.ok, `cmake build failed:\n${build.output}`).toBe(true);

        const ctest = run(
          "ctest",
          ["--output-on-failure", "-j", jobs],
          buildDir,
        );
        expect(ctest.ok, `ctest failed:\n${ctest.output}`).toBe(true);
        expect(ctest.output).toMatch(/100% tests passed/);
      },
      STEP_TIMEOUT_MS,
    );
  });
});
