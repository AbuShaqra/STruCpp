/**
 * Runs the C++ runtime's GoogleTest suite (src/runtime/tests) from npm test.
 *
 * Configures src/runtime/CMakeLists.txt in a temporary build directory, builds
 * runtime_tests and runs ctest. Skips, with the reason printed, when cmake or a
 * C++ compiler is missing, or when googletest is neither installed nor
 * fetchable (offline). Any other configure, build or test failure fails.
 *
 * STRUCPP_REQUIRE_RUNTIME_TESTS=1 turns every skip into a failure (used by CI).
 * STRUCPP_RUNTIME_TEST_JOBS overrides the build/ctest parallelism.
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

const REQUIRE_RUNTIME_TESTS = process.env.STRUCPP_REQUIRE_RUNTIME_TESTS === "1";

/** Half the cores, capped at 4: other Vitest workers run g++ suites meanwhile. */
function jobCount(): string {
  const override = Number.parseInt(
    process.env.STRUCPP_RUNTIME_TEST_JOBS ?? "",
    10,
  );
  if (Number.isInteger(override) && override > 0) return String(override);
  return String(Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2))));
}

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

if (toolchainMissing !== undefined && !REQUIRE_RUNTIME_TESTS) {
  console.warn(`[runtime-cpp-tests] skipped: ${toolchainMissing}`);
}

const NETWORK_FAILURE =
  /could not resolve host|unable to access|failed to connect|connection (refused|timed out|reset)|network is unreachable/i;

/**
 * True only when the googletest clone itself failed for a network reason; a
 * wrong tag, a missing git or a bad local source dir is a real failure.
 */
export function isGtestUnavailable(output: string): boolean {
  const cloneFailed =
    /Failed to clone repository: 'https:\/\/github\.com\/google\/googletest/i.test(
      output,
    ) || /googletest-populate/i.test(output);
  return cloneFailed && NETWORK_FAILURE.test(output);
}

/** The tests/*.cpp sources listed in add_executable(runtime_tests ...), comments ignored. */
export function registeredTestSources(cmake: string): Set<string> {
  const uncommented = cmake
    .split("\n")
    .map((line) => line.replace(/#.*$/, ""))
    .join("\n");
  const block = /add_executable\(\s*runtime_tests\b([^)]*)\)/.exec(uncommented);
  const listed = new Set<string>();
  if (block === null) return listed;
  for (const m of block[1].matchAll(/(?:^|\s)tests\/([^\s)]+\.cpp)(?=\s|$)/g)) {
    listed.add(m[1]);
  }
  return listed;
}

describe("C++ runtime unit tests (GoogleTest)", () => {
  it("registers every runtime test source in CMakeLists.txt", () => {
    const listed = registeredTestSources(fs.readFileSync(CMAKE_LISTS, "utf8"));
    const sources = fs
      .readdirSync(TESTS_DIR)
      .filter((f) => f.endsWith(".cpp"))
      .sort();
    expect(sources.length).toBeGreaterThan(0);
    expect([...listed].sort()).toEqual(sources);
  });

  it("parses the add_executable block and ignores commented-out sources", () => {
    const cmake = [
      "# tests/in_comment.cpp",
      "add_executable(runtime_tests",
      "    tests/a.cpp  # tests/trailing.cpp",
      "    # tests/disabled.cpp",
      "    tests/b.cpp",
      ")",
      "add_executable(other tests/c.cpp)",
    ].join("\n");
    expect([...registeredTestSources(cmake)].sort()).toEqual([
      "a.cpp",
      "b.cpp",
    ]);
  });

  it("treats only a network failure of the googletest clone as unavailable", () => {
    const clone =
      "Failed to clone repository: 'https://github.com/google/googletest.git'";
    expect(
      isGtestUnavailable(
        `-- googletest: not installed\n${clone}\nfatal: unable to access 'https://github.com/'`,
      ),
    ).toBe(true);
    // A wrong tag fails the clone step without a network error.
    expect(
      isGtestUnavailable(
        `-- googletest: not installed\nCMake Error at googletest-subbuild: build step for googletest failed\nerror: pathspec 'v9.9.9' did not match`,
      ),
    ).toBe(false);
    // The status line alone is not a failure signature.
    expect(
      isGtestUnavailable(
        "-- googletest: not installed, fetching v1.14.0\nCMake Error: syntax",
      ),
    ).toBe(false);
  });

  it("is not skipped when STRUCPP_REQUIRE_RUNTIME_TESTS=1", () => {
    if (REQUIRE_RUNTIME_TESTS && toolchainMissing !== undefined) {
      expect.fail(
        `STRUCPP_REQUIRE_RUNTIME_TESTS=1 but the toolchain is missing: ${toolchainMissing}`,
      );
    }
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
          if (REQUIRE_RUNTIME_TESTS) {
            expect.fail(
              `STRUCPP_REQUIRE_RUNTIME_TESTS=1 but googletest could not be fetched:\n${configure.output}`,
            );
          }
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

        const jobs = jobCount();
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
