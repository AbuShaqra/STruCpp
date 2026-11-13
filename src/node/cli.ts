#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * STruC++ Command Line Interface
 *
 * Usage:
 *   strucpp <input.st> [input2.st ...] -o <output.cpp> [options]
 *   strucpp --compile-lib <input.st|.cpp|.py> [...] -o <dir> --lib-name <name> [options]
 *   strucpp --check [--json] <input.st> [input2.st ...] [options]
 *
 * Options:
 *   -o, --output <file>       Output file path or directory
 *   -d, --debug               Enable debug mode
 *   --strict                  Reject code that strict IEC compilers (matiec) reject
 *   --dialect <id>            Compile under a dialect profile (built-in: iec-3)
 *   --dialect-file <path>     Load a dialect profile file (repeatable)
 *   --dialect-path <dir>      Load every *.json profile in a folder (repeatable)
 *   --feature <+id|-id>       Enable or disable a feature (repeatable)
 *   --global-list <f>=<name>  Name the global variable list of input <f> (repeatable)
 *   --pragma-define N[=V]     A conditional-pragma define only, never a constant (repeatable)
 *   --file-define <f>=N[=V]   A conditional-pragma define of input <f> only (repeatable)
 *   --print-dialect           Print the resolved dialect as JSON and exit
 *   --check                   Parse and analyse only; write nothing (exit 0/1/2)
 *   --json                    With --check: print one JSON report on stdout
 *   --no-line-mapping         Disable line mapping
 *   --line-directives         Include #line directives
 *   --source-comments         Include ST source as comments
 *   -O, --optimize <level>    Optimization level (0, 1, 2)
 *   --build                   Compile to executable binary with interactive REPL
 *   --gpp <path>              Custom g++ path (default: g++)
 *   --cc <path>               Custom C compiler path (default: cc)
 *   --cxx-flags <flags>       Extra C++ compiler flags
 *   -L, --lib-path <path>     Library search path (repeatable)
 *   --compile-lib             Compile sources into a library
 *   --lib-name <name>         Library name (required with --compile-lib)
 *   --lib-version <version>   Library version (default: "1.0.0")
 *   --lib-namespace <ns>      C++ namespace (default: derived from lib-name)
 *   -v, --version             Show version
 *   -h, --help                Show help
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  existsSync,
  statSync,
} from "fs";
import { resolve, basename, dirname, join, relative, sep } from "path";
import { tmpdir, platform } from "os";
import { execFileSync } from "child_process";
import { analyze, compile, getVersion, compileStlib } from "../index.js";
import {
  DEFAULT_FEATURES,
  DialectError,
  KNOWN_FEATURES,
  resolveDialect,
} from "../dialect.js";
import { isGlobalListName } from "../semantic/global-lists.js";
import { isPragmaDefineName } from "../frontend/conditional-pragmas.js";
import { nodeDialectIO } from "./dialect-io.js";
import {
  formatDiagnostic,
  buildSourceMap,
  type DiagnosticSource,
} from "../diagnostic-formatter.js";
import { discoverStlibs, loadStlibFromFile } from "./library-loader.js";
import { discoverSTFiles } from "./library-utils.js";
import { generateReplMain } from "../backend/repl-main-gen.js";
import { parseTestFile } from "../testing/test-parser.js";
import {
  generateTestMain,
  buildPOUInfoFromAST,
} from "../backend/test-main-gen.js";
import { analyzeTestFile } from "../semantic/analyzer.js";
import {
  getCxxEnv,
  splitCxxFlags,
  isCompilerAvailable,
  findRuntimeIncludeDir,
  findBundledLibsDir,
} from "./build-utils.js";
import type { CompileError, CompileOptions } from "../types.js";
import type { LibraryCompileError } from "../library/library-manifest.js";
import { importCodesysLibraryFromBytes } from "../library/codesys-import/index.js";

interface CLIOptions {
  inputs: string[];
  output?: string;
  debug: boolean;
  strict: boolean;
  dialect?: string;
  dialectFiles: string[];
  dialectPath: string[];
  features: string[];
  /** `--global-list <file>=<name>` entries, in order. */
  globalLists: Array<{ file: string; name: string }>;
  printDialect: boolean;
  check: boolean;
  json: boolean;
  lineMapping: boolean;
  lineDirectives: boolean;
  sourceComments: boolean;
  optimizationLevel: 0 | 1 | 2;
  showHelp: boolean;
  showVersion: boolean;
  build: boolean;
  gpp: string;
  cc: string;
  cxxFlags: string;
  libraryPaths: string[];
  noDefaultLibs: boolean;
  compileLib: boolean;
  libName?: string;
  libVersion: string;
  libNamespace?: string;
  noSource: boolean;
  builtin: boolean;
  decompileLib?: string;
  importLib?: string;
  test: string[];
  defines: Record<string, number>;
  /** `-D` names for conditional pragmas: name → value (`''` for a bare name). */
  pragmaDefines: Record<string, string>;
  /** `--file-define <file>=NAME[=VALUE]` entries: defines of one input file. */
  fileDefines: Array<{ file: string; name: string; value: string }>;
}

/**
 * Print one or more diagnostics to stdout/stderr with a blank line
 * between entries. Builds the source map once and reuses it across
 * the loop. Used by every CLI mode that surfaces compile/parse/analyze
 * errors so the formatting (and the spacing) stays consistent.
 */
/** CLI-time color decision: TTY-attached stderr without NO_COLOR. */
const enableColor =
  process.env.NO_COLOR === undefined && process.stderr.isTTY === true;

/** `--cxx-flags` defines STRUCPP_THREADED: the C++ is built threaded. */
function definesThreaded(cxxFlags: string): boolean {
  return splitCxxFlags(cxxFlags).some((f) =>
    /^-DSTRUCPP_THREADED(=|$)/.test(f),
  );
}

function printDiagnostics(
  errors: ReadonlyArray<CompileError>,
  sources: DiagnosticSource[],
  stream: "error" | "warn" = "error",
): void {
  const map = buildSourceMap(sources);
  const out = stream === "warn" ? console.warn : console.error;
  for (const err of errors) {
    out(formatDiagnostic(err, map, { enableColor }));
    out("");
  }
}

/**
 * Coerce a stlib-compile error (optional line/column/file) into the
 * CompileError shape `printDiagnostics` consumes. `column` defaults to 1.
 */
function toDiagnostic(err: LibraryCompileError): CompileError {
  return {
    message: err.message,
    line: err.line ?? 0,
    column: err.column ?? 1,
    severity: "error",
    ...(err.file ? { file: err.file } : {}),
  };
}

function parseArgs(args: string[]): CLIOptions {
  const options: CLIOptions = {
    inputs: [],
    debug: false,
    strict: false,
    dialectFiles: [],
    dialectPath: [],
    features: [],
    globalLists: [],
    printDialect: false,
    check: false,
    json: false,
    lineMapping: true,
    lineDirectives: false,
    sourceComments: false,
    optimizationLevel: 0,
    showHelp: false,
    showVersion: false,
    build: false,
    gpp: "g++",
    cc: process.platform === "win32" ? "gcc" : "cc",
    cxxFlags: "",
    libraryPaths: [],
    noDefaultLibs: false,
    compileLib: false,
    libVersion: "1.0.0",
    noSource: false,
    builtin: false,
    test: [],
    defines: {},
    pragmaDefines: {},
    fileDefines: [],
  };

  // Usage errors exit 2 in check mode, 1 otherwise.
  const usageExit = args.includes("--check") ? 2 : 1;
  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === "-h" || arg === "--help") {
      options.showHelp = true;
    } else if (arg === "-v" || arg === "--version") {
      options.showVersion = true;
    } else if (arg === "-d" || arg === "--debug") {
      options.debug = true;
    } else if (arg === "--strict") {
      options.strict = true;
    } else if (
      arg === "--dialect" ||
      arg === "--dialect-file" ||
      arg === "--dialect-path" ||
      arg === "--feature"
    ) {
      i++;
      const nextArg = args[i];
      if (nextArg === undefined) {
        console.error(`error: ${arg} needs a value`);
        process.exit(usageExit);
      }
      if (arg === "--dialect") options.dialect = nextArg;
      else if (arg === "--dialect-file") options.dialectFiles.push(nextArg);
      else if (arg === "--dialect-path") options.dialectPath.push(nextArg);
      else options.features.push(nextArg);
    } else if (arg === "--global-list") {
      i++;
      const spec = args[i] ?? "";
      const eq = spec.lastIndexOf("=");
      const file = spec.slice(0, Math.max(eq, 0));
      const name = spec.slice(eq + 1);
      if (eq <= 0 || !isGlobalListName(name)) {
        console.error(
          `error: --global-list needs <file>=<name> with an identifier name, got '${spec}'`,
        );
        process.exit(usageExit);
      }
      options.globalLists.push({ file, name });
    } else if (arg === "--print-dialect") {
      options.printDialect = true;
    } else if (arg === "--check") {
      options.check = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--no-line-mapping") {
      options.lineMapping = false;
    } else if (arg === "--line-directives") {
      options.lineDirectives = true;
    } else if (arg === "--source-comments") {
      options.sourceComments = true;
    } else if (arg === "-o" || arg === "--output") {
      i++;
      const nextArg = args[i];
      if (nextArg !== undefined) {
        options.output = nextArg;
      }
    } else if (arg === "-O" || arg === "--optimize") {
      i++;
      const level = parseInt(args[i] ?? "0", 10);
      if (level >= 0 && level <= 2) {
        options.optimizationLevel = level as 0 | 1 | 2;
      }
    } else if (arg === "--build") {
      options.build = true;
    } else if (arg === "--gpp") {
      i++;
      const nextArg = args[i];
      if (nextArg !== undefined) {
        options.gpp = nextArg;
      }
    } else if (arg === "--cc") {
      i++;
      const nextArg = args[i];
      if (nextArg !== undefined) {
        options.cc = nextArg;
      }
    } else if (arg === "--cxx-flags") {
      i++;
      const nextArg = args[i];
      if (nextArg !== undefined) {
        options.cxxFlags = nextArg;
      }
    } else if (arg === "-L" || arg === "--lib-path") {
      i++;
      const nextArg = args[i];
      if (nextArg !== undefined) {
        options.libraryPaths.push(nextArg);
      }
    } else if (arg === "--no-default-libs") {
      options.noDefaultLibs = true;
    } else if (arg === "--compile-lib") {
      options.compileLib = true;
    } else if (arg === "--lib-name") {
      i++;
      const nextArg = args[i];
      if (nextArg !== undefined) {
        options.libName = nextArg;
      }
    } else if (arg === "--lib-version") {
      i++;
      const nextArg = args[i];
      if (nextArg !== undefined) {
        options.libVersion = nextArg;
      }
    } else if (arg === "--lib-namespace") {
      i++;
      const nextArg = args[i];
      if (nextArg !== undefined) {
        options.libNamespace = nextArg;
      }
    } else if (arg === "--no-source") {
      options.noSource = true;
    } else if (arg === "--builtin") {
      options.builtin = true;
    } else if (arg === "--decompile-lib") {
      i++;
      const nextArg = args[i];
      if (nextArg !== undefined) {
        options.decompileLib = nextArg;
      }
    } else if (arg === "--import-lib") {
      i++;
      const nextArg = args[i];
      if (nextArg !== undefined) {
        options.importLib = nextArg;
      }
    } else if (
      arg === "--define" ||
      (arg !== undefined && arg.startsWith("-D"))
    ) {
      // --define NAME[=VALUE], -D NAME[=VALUE] or -DNAME[=VALUE]
      const inline = arg === "--define" ? "" : arg.substring(2);
      let spec: string | undefined = inline;
      if (inline.length === 0) {
        i++;
        spec = args[i];
      }
      if (spec === undefined) {
        console.error(`error: ${arg} needs a value`);
        process.exit(usageExit);
      }
      const problem = parseDefine(spec, options.defines, options.pragmaDefines);
      if (problem !== undefined) {
        console.error(`error: ${problem}`);
        process.exit(usageExit);
      }
    } else if (arg === "--pragma-define") {
      // A conditional-pragma define only: never a global constant
      i++;
      const spec = args[i];
      const problem =
        spec === undefined
          ? `${arg} needs a value`
          : parsePragmaDefine(spec, arg, options.pragmaDefines);
      if (problem !== undefined) {
        console.error(`error: ${problem}`);
        process.exit(usageExit);
      }
    } else if (arg === "--file-define") {
      // --file-define <file>=NAME[=VALUE]: a define of one input file only
      i++;
      const spec = args[i] ?? "";
      const eq = spec.indexOf("=");
      const file = spec.slice(0, Math.max(eq, 0));
      const one: Record<string, string> = {};
      const problem =
        eq <= 0
          ? `--file-define needs <file>=NAME[=VALUE], got '${spec}'`
          : parsePragmaDefine(spec.slice(eq + 1), arg, one);
      if (problem !== undefined) {
        console.error(`error: ${problem}`);
        process.exit(usageExit);
      }
      for (const [name, value] of Object.entries(one)) {
        options.fileDefines.push({ file, name, value });
      }
    } else if (arg === "--test") {
      // Collect all following arguments that don't start with '-' as test files
      i++;
      while (
        i < args.length &&
        args[i] !== undefined &&
        !args[i]!.startsWith("-")
      ) {
        options.test.push(args[i]!);
        i++;
      }
      // Back up one so the outer loop increment doesn't skip anything
      i--;
    } else if (arg !== undefined && !arg.startsWith("-")) {
      options.inputs.push(arg);
    }

    i++;
  }

  for (const { file } of options.fileDefines) {
    const path = resolve(file);
    const problem = options.compileLib
      ? "cannot be used with --compile-lib"
      : !options.inputs.some((input) => resolve(input) === path)
        ? "is not an input file"
        : undefined;
    if (problem !== undefined) {
      console.error(`error: --file-define file '${file}' ${problem}`);
      process.exit(usageExit);
    }
  }

  const listFiles = new Set<string>();
  for (const { file } of options.globalLists) {
    const path = resolve(file);
    let problem: string | undefined;
    if (listFiles.has(path)) problem = "is given twice";
    else if (!options.inputs.some((input) => resolve(input) === path)) {
      problem = "is not an input file";
    }
    if (problem !== undefined) {
      console.error(`error: --global-list file '${file}' ${problem}`);
      process.exit(usageExit);
    }
    listFiles.add(path);
  }

  return options;
}

/** The `--global-list` name given for input file `input`, if any. */
function globalListNameFor(
  options: CLIOptions,
  input: string,
): string | undefined {
  const path = resolve(input);
  return options.globalLists.find((g) => resolve(g.file) === path)?.name;
}

/** The `--file-define` defines given for input file `input`, in order. */
function fileDefinesFor(
  options: CLIOptions,
  input: string,
): Record<string, string> | undefined {
  const path = resolve(input);
  const hits = options.fileDefines.filter((d) => resolve(d.file) === path);
  if (hits.length === 0) return undefined;
  return Object.fromEntries(hits.map((d) => [d.name, d.value]));
}

/**
 * `entry` with the `--global-list` name and the `--file-define` defines of
 * `input` added when given: as `pragmaDefines` of an additional source, or
 * `filePragmaDefines` for the primary one (`primary`).
 */
function withGlobalListName<T extends object>(
  options: CLIOptions,
  input: string,
  entry: T,
  primary = false,
): T & {
  globalListName?: string;
  pragmaDefines?: Record<string, string>;
  filePragmaDefines?: Record<string, string>;
} {
  const name = globalListNameFor(options, input);
  const defines = fileDefinesFor(options, input);
  return {
    ...entry,
    ...(name !== undefined ? { globalListName: name } : {}),
    ...(defines === undefined
      ? {}
      : primary
        ? { filePragmaDefines: defines }
        : { pragmaDefines: defines }),
  };
}

/** Help column of option descriptions, and the width they wrap at. */
const HELP_INDENT = 28;
const HELP_WIDTH = 80;

/** `text` word-wrapped into the help's description column (no lead indent). */
function wrapHelp(text: string): string {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (
      line !== "" &&
      HELP_INDENT + line.length + 1 + word.length > HELP_WIDTH
    ) {
      lines.push(line);
      line = word;
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
  }
  lines.push(line);
  return lines.join(`\n${" ".repeat(HELP_INDENT)}`);
}

function showHelp(): void {
  console.log(`
STruC++ - IEC 61131-3 Structured Text to C++ Compiler

Usage:
  strucpp <input.st> [input2.st ...] -o <output.cpp> [options]
  strucpp --compile-lib <input.st|.cpp|.py|dir> [...] -o <dir> --lib-name <name> [options]
  strucpp --check [--json] <input.st> [input2.st ...] [options]

Options:
  -o, --output <file>       Output file path (default: <input>.cpp)
  -d, --debug               Enable debug mode
  --strict                  Reject code that strict IEC compilers (matiec)
                            reject: implicit conversions, BOOL/bit-string
                            arithmetic, reserved names, duplicate CASE labels...
  --dialect <id>            Compile under a dialect profile: the built-in iec-3,
                            ${wrapHelp(`a --dialect-file profile or <dir>/<id>.json in a --dialect-path folder (default: no profile, the features ${[...DEFAULT_FEATURES].join(", ")})`)}
  --dialect-file <path>     Load a dialect profile (repeatable); one file and
                            no --dialect selects it
  --dialect-path <dir>      Load and check every *.json profile in a folder
                            (repeatable)
  --feature <+id|-id>       ${wrapHelp(`Enable (+id or id) or disable (-id) a feature after the profile (repeatable): ${KNOWN_FEATURES.join(", ")}`)}
  --global-list <file>=<name>
                            Name the global variable list of input <file>
                            (default: its file stem; repeatable). Used by
                            the feature named_global_lists
  --print-dialect           Print the resolved dialect as JSON and exit
  --check                   Parse and analyse only: no C++ output, no g++.
                            Exit 0 = no errors, 1 = errors, 2 = usage,
                            unreadable file or dialect problem
  --json                    With --check: print one JSON report on stdout
  --no-line-mapping         Disable line mapping
  --line-directives         Include #line directives in output
  --source-comments         Include ST source as comments
  -O, --optimize <level>    Optimization level (0, 1, 2)
  --build                   Compile to executable with interactive REPL
  --gpp <path>              Custom g++ path (default: g++)
  --cc <path>               Custom C compiler path (default: cc)
  --cxx-flags <flags>       Extra C++ compiler flags
  -L, --lib-path <path>     Library search path (repeatable)
  --no-default-libs         Do not auto-add bundled library paths
  -D, --define NAME[=VALUE] Define a name for conditional pragmas (feature
                            conditional_pragmas); an integer VALUE also
                            defines a global constant (repeatable)
  --pragma-define NAME[=VALUE]
                            Define a name for conditional pragmas only, never
                            a global constant, whatever VALUE is (repeatable)
  --file-define <file>=NAME[=VALUE]
                            Define a name for the conditional pragmas of input
                            <file> only, on top of the project's defines: seen
                            by defined() and hasvalue() (over a project define
                            of the same name), not by project_defined()
                            (repeatable; not with --compile-lib)
  -v, --version             Show version
  -h, --help                Show this help

Library compilation:
  --compile-lib             Compile sources into a .stlib library archive
  --lib-name <name>         Library name (required with --compile-lib)
  --lib-version <version>   Library version (default: "1.0.0")
  --lib-namespace <ns>      C++ namespace (default: derived from lib-name)
  --no-source               Omit ST source from .stlib archive (closed-source).
                            C/C++ and Python bodies are always kept: they are
                            not compiled, so their source is the deliverable.
  --decompile-lib <path>    Extract ST sources from a .stlib archive

CODESYS import:
  --import-lib <path>       Import a CODESYS V2.3 (.lib) or V3 (.library) file
                            Requires --lib-name; -o sets output dir (default: cwd)

Testing:
  --test <file> [file2...]   Run tests from test file(s) against source files
                             (must come after -o if used)

Examples:
  strucpp program.st -o program.cpp
  strucpp program.st utils.st -o program.cpp
  strucpp program.st -o program.cpp -L ./libs/
  strucpp program.st -o program.cpp --debug --line-directives
  strucpp program.st -o program.cpp --build
  strucpp --check --json program.st utils.st --dialect iec-3
  strucpp --compile-lib math.st -o mathlib/ --lib-name math-lib
  strucpp --compile-lib src/mylib/ -o out/ --lib-name my-lib
  strucpp counter.st --test test_counter.st
  strucpp --decompile-lib mylib.stlib -o extracted/
  strucpp --import-lib oscat.lib -o libs/ --lib-name oscat-basic -L libs/

For more information, visit: https://github.com/Autonomy-Logic/STruCpp
`);
}

/** The dialect flags and `-D` pragma defines as compile options (empty when none is given). */
function dialectCompileOptions(
  options: CLIOptions,
): Pick<
  CompileOptions,
  | "dialect"
  | "dialectFiles"
  | "dialectPath"
  | "features"
  | "dialectIO"
  | "pragmaDefines"
> {
  const out: Pick<
    CompileOptions,
    | "dialect"
    | "dialectFiles"
    | "dialectPath"
    | "features"
    | "dialectIO"
    | "pragmaDefines"
  > = {};
  if (options.dialect !== undefined) out.dialect = options.dialect;
  if (options.dialectFiles.length > 0) out.dialectFiles = options.dialectFiles;
  if (options.dialectPath.length > 0) out.dialectPath = options.dialectPath;
  if (options.features.length > 0) out.features = options.features;
  if (out.dialectFiles || out.dialectPath) out.dialectIO = nodeDialectIO;
  if (Object.keys(options.pragmaDefines).length > 0) {
    out.pragmaDefines = options.pragmaDefines;
  }
  return out;
}

/**
 * Check the dialect flags before any mode runs: a bad profile prints one
 * `error:` line and exits 1; `--print-dialect` prints the result and exits 0.
 */
function checkDialect(options: CLIOptions): void {
  const req = dialectCompileOptions(options);
  if (Object.keys(req).length === 0 && !options.printDialect) return;
  try {
    const d = resolveDialect(
      req,
      nodeDialectIO.readFile,
      nodeDialectIO.listDir,
    );
    if (options.printDialect) {
      console.log(
        JSON.stringify({ id: d.id, features: [...d.features].sort() }),
      );
      process.exit(0);
    }
  } catch (e) {
    if (!(e instanceof DialectError)) throw e;
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
}

/**
 * Parse a `-D` value, `NAME` or `NAME=VALUE`. Every name is a conditional
 * pragma define (`''` for a bare name); a VALUE that parses as an integer
 * also defines a global constant. Returns a usage message for a bad name.
 */
function parseDefine(
  input: string,
  defines: Record<string, number>,
  pragmaDefines: Record<string, string>,
): string | undefined {
  const eqIdx = input.indexOf("=");
  const name = eqIdx >= 0 ? input.substring(0, eqIdx) : input;
  if (!isPragmaDefineName(name)) {
    return `-D needs NAME or NAME=VALUE with an identifier name, got '${input}'`;
  }
  if (eqIdx < 0) {
    pragmaDefines[name] = "";
    return undefined;
  }
  const text = input.substring(eqIdx + 1);
  pragmaDefines[name] = text;
  const value = parseInt(text, 10);
  if (!isNaN(value)) {
    defines[name] = value;
  }
  return undefined;
}

/**
 * Parse a `--pragma-define` / `--file-define` value, `NAME` or `NAME=VALUE`,
 * into `pragmaDefines` only: whatever the value, it is no global constant.
 * Returns a usage message for a bad name.
 */
function parsePragmaDefine(
  input: string,
  option: string,
  pragmaDefines: Record<string, string>,
): string | undefined {
  const eqIdx = input.indexOf("=");
  const name = eqIdx >= 0 ? input.substring(0, eqIdx) : input;
  if (!isPragmaDefineName(name)) {
    return `${option} needs NAME or NAME=VALUE with an identifier name, got '${input}'`;
  }
  pragmaDefines[name] = eqIdx >= 0 ? input.substring(eqIdx + 1) : "";
  return undefined;
}

/**
 * Check whether winget is available on Windows.
 */
function hasWinget(): boolean {
  try {
    execFileSync("winget", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Print platform-specific compiler installation instructions and exit.
 */
function printCompilerNotFound(compiler: string, flag: string): never {
  console.error(
    `\nError: ${compiler === "g++" || compiler === "clang++" ? "C++" : "C"} compiler '${compiler}' not found.\n`,
  );

  const os = platform();
  if (os === "win32") {
    console.error(
      "To compile on Windows you need a C/C++ toolchain (MinGW-w64).\n",
    );
    if (hasWinget()) {
      console.error("  Install via winget (recommended):");
      console.error(
        "    winget install -e --id BrechtSanders.WinLibs.POSIX.UCRT\n",
      );
      console.error(
        "  Then reopen your terminal so the PATH update takes effect.\n",
      );
    }
    console.error("  Or download standalone MinGW-w64 (GCC) from:");
    console.error("    https://winlibs.com\n");
    console.error("  Extract it and add the bin/ folder to your PATH.");
  } else if (os === "darwin") {
    console.error("  Install the Xcode Command Line Tools:\n");
    console.error("    xcode-select --install");
  } else {
    console.error("  Install a C/C++ toolchain:\n");
    console.error("    Ubuntu/Debian:  sudo apt install build-essential");
    console.error("    Fedora/RHEL:    sudo dnf install gcc-c++");
    console.error("    Arch Linux:     sudo pacman -S base-devel");
  }

  console.error(`\n  Or specify a custom compiler with --${flag} <path>`);
  process.exit(1);
}

/**
 * Verify that the required compilers are available before attempting compilation.
 * Called early in --build and --test flows to fail fast with helpful messages.
 */
function ensureCompilersAvailable(options: CLIOptions, needsCC: boolean): void {
  if (!isCompilerAvailable(options.gpp)) {
    printCompilerNotFound(options.gpp, "gpp");
  }
  if (needsCC && !isCompilerAvailable(options.cc)) {
    printCompilerNotFound(options.cc, "cc");
  }
}

/**
 * Build the effective list of library search paths.
 * Prepends the bundled libs directory (like gcc's default system lib paths)
 * unless --no-default-libs is specified.
 */
function getEffectiveLibraryPaths(options: CLIOptions): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();

  if (!options.noDefaultLibs) {
    const bundledDir = findBundledLibsDir();
    if (bundledDir) {
      const resolved = resolve(bundledDir);
      seen.add(resolved);
      paths.push(resolved);
    }
  }

  for (const p of options.libraryPaths) {
    const resolved = resolve(p);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      paths.push(resolved);
    }
  }
  return paths;
}

/**
 * Library compilation mode: compile ST sources into a single .stlib archive.
 */
function compileLibraryMode(options: CLIOptions): void {
  if (!options.libName) {
    console.error("Error: --lib-name is required with --compile-lib");
    process.exit(1);
  }

  if (options.inputs.length === 0) {
    console.error("Error: No input files specified");
    process.exit(1);
  }

  const outputDir = options.output ? resolve(options.output) : process.cwd();
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const libNamespace =
    options.libNamespace ?? options.libName.replace(/[^a-zA-Z0-9_]/g, "_");

  // Collect input files — if an input is a directory, discover .st files
  // recursively. Each entry remembers its discovery root so we can later
  // derive a category from the path relative to that root: a file at
  // `<dir>/some_category/foo.st` ends up tagged `some_category` in the
  // manifest. Files passed directly (not via a directory) carry no
  // category — they're treated as flat root-level inputs.
  const filePaths: Array<{ path: string; rootDir?: string }> = [];
  for (const input of options.inputs) {
    const inputPath = resolve(input);
    try {
      const stat = statSync(inputPath);
      if (stat.isDirectory()) {
        const discovered = discoverSTFiles(inputPath);
        if (discovered.length === 0) {
          console.error(
            `Error: No .st, .il, .cpp or .py files found in directory: ${inputPath}`,
          );
          process.exit(1);
        }
        for (const p of discovered)
          filePaths.push({ path: p, rootDir: inputPath });
      } else {
        filePaths.push({ path: inputPath });
      }
    } catch {
      console.error(`Error: Cannot read input: ${inputPath}`);
      process.exit(1);
    }
  }

  // Read all source files
  const sources: Array<{
    source: string;
    fileName: string;
    category?: string;
  }> = [];
  for (const { path: filePath, rootDir } of filePaths) {
    try {
      const entry: { source: string; fileName: string; category?: string } = {
        source: readFileSync(filePath, "utf-8"),
        fileName: basename(filePath),
      };
      if (rootDir) {
        const rel = relative(rootDir, filePath);
        const parts = rel.split(sep);
        if (parts.length > 1) {
          entry.category = parts.slice(0, -1).join("/");
        }
      }
      sources.push(entry);
    } catch {
      console.error(`Error: Cannot read input file: ${filePath}`);
      process.exit(1);
    }
  }

  if (sources.length === 0) {
    console.error("Error: No input files specified");
    process.exit(1);
  }

  console.log(
    `Compiling library "${options.libName}" from ${sources.length} source file(s)...`,
  );

  // Load dependency libraries from explicit -L paths only.
  // Unlike normal compilation, library compilation should not auto-add
  // bundled system libraries as dependencies — only user-specified paths.
  const dependencies: import("../library/library-manifest.js").StlibArchive[] =
    [];
  for (const libPath of options.libraryPaths) {
    try {
      dependencies.push(...discoverStlibs(libPath));
    } catch (e) {
      console.error(
        `Warning: Could not load libraries from ${libPath}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  const stlibOpts: Parameters<typeof compileStlib>[1] = {
    name: options.libName,
    version: options.libVersion,
    namespace: libNamespace,
    noSource: options.noSource,
    builtin: options.builtin,
    strict: options.strict,
    ...dialectCompileOptions(options),
  };
  if (dependencies.length > 0) {
    stlibOpts.dependencies = dependencies;
  }
  if (Object.keys(options.defines).length > 0) {
    stlibOpts.globalConstants = options.defines;
  }
  const result = compileStlib(sources, stlibOpts);

  if (!result.success) {
    console.error("\nLibrary compilation failed:\n");
    printDiagnostics(result.errors.map(toDiagnostic), sources);
    process.exit(1);
  }

  // Write single .stlib archive
  const stlibPath = resolve(outputDir, `${options.libName}.stlib`);
  writeFileSync(stlibPath, JSON.stringify(result.archive, null, 2), "utf-8");
  console.log(`Library archive written to ${stlibPath}`);
  console.log("Library compilation successful!");
}

/**
 * Test runner mode: compile source, parse tests, generate + compile + run test binary.
 */
function runTestMode(options: CLIOptions): void {
  ensureCompilersAvailable(options, false);

  if (options.inputs.length === 0) {
    console.error("Error: No source files specified for testing");
    console.error("Usage: strucpp <source.st> --test <test.st>");
    process.exit(1);
  }

  // 1. Read and compile all source files
  const primaryInput = options.inputs[0]!;
  const inputPath = resolve(primaryInput);
  let source: string;
  try {
    source = readFileSync(inputPath, "utf-8");
  } catch {
    console.error(`Error: Cannot read source file: ${inputPath}`);
    process.exit(1);
  }

  const additionalSources: Array<{
    source: string;
    fileName: string;
    globalListName?: string;
  }> = [];
  for (const extra of options.inputs.slice(1)) {
    const extraPath = resolve(extra);
    try {
      additionalSources.push(
        withGlobalListName(options, extra, {
          source: readFileSync(extraPath, "utf-8"),
          fileName: basename(extraPath),
        }),
      );
    } catch {
      console.error(`Error: Cannot read source file: ${extraPath}`);
      process.exit(1);
    }
  }

  const effectiveLibPaths = getEffectiveLibraryPaths(options);
  const compileOptions: Partial<CompileOptions> = {
    headerFileName: "generated.hpp",
    fileName: basename(inputPath),
    isTestBuild: true,
    ...(definesThreaded(options.cxxFlags) ? { threaded: true } : {}),
    strict: options.strict,
    ...dialectCompileOptions(options),
    ...withGlobalListName(options, primaryInput, {}, true),
  };
  if (additionalSources.length > 0) {
    compileOptions.additionalSources = additionalSources;
  }
  if (effectiveLibPaths.length > 0) {
    compileOptions.libraries = effectiveLibPaths.flatMap((p) =>
      discoverStlibs(p),
    );
  }
  if (Object.keys(options.defines).length > 0) {
    compileOptions.globalConstants = options.defines;
  }

  const result = compile(source, compileOptions);
  if (!result.success) {
    console.error("Error compiling source files:\n");
    const sourceDiagSources = [
      { fileName: basename(inputPath), source },
      ...additionalSources,
    ];
    printDiagnostics(result.errors, sourceDiagSources);
    printDiagnostics(result.warnings, sourceDiagSources, "warn");
    process.exit(1);
  }

  // 2. Build POU info from the compiled AST
  const { pous } = result.ast ? buildPOUInfoFromAST(result.ast) : { pous: [] };

  // 3. Parse test files
  const testFiles: import("../testing/test-model.js").TestFile[] = [];
  const testSources: DiagnosticSource[] = [];
  for (const testPath of options.test) {
    const resolvedPath = resolve(testPath);
    let testSource: string;
    try {
      testSource = readFileSync(resolvedPath, "utf-8");
    } catch {
      console.error(`Error: Cannot read test file: ${resolvedPath}`);
      process.exit(1);
    }
    testSources.push({ fileName: basename(testPath), source: testSource });

    const parseResult = parseTestFile(
      testSource,
      basename(testPath),
      dialectCompileOptions(options),
    );
    if (parseResult.errors.length > 0) {
      console.error(`Error parsing ${basename(testPath)}:\n`);
      printDiagnostics(parseResult.errors, testSources);
      process.exit(1);
    }
    if (parseResult.testFile) {
      testFiles.push(parseResult.testFile);
    }
  }

  if (testFiles.length === 0) {
    console.error("Error: No test cases found in test files");
    process.exit(1);
  }

  // 3b. Semantic analysis of test files
  if (result.symbolTables) {
    let hasTestErrors = false;
    for (const tf of testFiles) {
      const analysisResult = analyzeTestFile(
        tf,
        result.symbolTables,
        result.ast,
      );
      if (analysisResult.errors.length > 0) {
        hasTestErrors = true;
        console.error(`Error in test file '${tf.fileName}':\n`);
        printDiagnostics(analysisResult.errors, testSources);
      }
    }
    if (hasTestErrors) {
      process.exit(1);
    }
  }

  // 4. Generate test_main.cpp
  const testMainOpts: import("../backend/test-main-gen.js").TestMainGenOptions =
    {
      headerFileName: "generated.hpp",
      pous,
      isTestBuild: true,
    };
  if (result.ast) {
    testMainOpts.ast = result.ast;
  }
  if (result.resolvedLibraries) {
    testMainOpts.libraryArchives = result.resolvedLibraries;
  }
  const testMainCpp = generateTestMain(testFiles, testMainOpts);

  // 5. Write to temp directory
  const tempDir = mkdtempSync(join(tmpdir(), "strucpp-test-"));
  try {
    writeFileSync(join(tempDir, "generated.hpp"), result.headerCode, "utf-8");
    writeFileSync(join(tempDir, "generated.cpp"), result.cppCode, "utf-8");
    writeFileSync(join(tempDir, "test_main.cpp"), testMainCpp, "utf-8");

    // 6. Find runtime include directory
    const runtimeIncludeDir = findRuntimeIncludeDir(options.cxxFlags);
    if (!runtimeIncludeDir) {
      console.error(
        "Error: Could not locate runtime include directory.\n" +
          '  Use --cxx-flags "-I/path/to/runtime/include" to specify it.',
      );
      process.exit(1);
    }

    // Test runtime header directory
    const testRuntimeDir = resolve(dirname(runtimeIncludeDir), "test");

    // 7. Compile with g++
    const binaryPath = join(
      tempDir,
      process.platform === "win32" ? "test_runner.exe" : "test_runner",
    );

    try {
      execFileSync(
        options.gpp,
        [
          "-std=c++14",
          // Pointer punning is valid IEC; the runtime marks its types
          // may_alias, and this covers anything it cannot mark.
          "-fno-strict-aliasing",
          `-I${runtimeIncludeDir}`,
          `-I${testRuntimeDir}`,
          `-I${tempDir}`,
          ...splitCxxFlags(options.cxxFlags),
          join(tempDir, "test_main.cpp"),
          join(tempDir, "generated.cpp"),
          "-o",
          binaryPath,
        ],
        { stdio: ["pipe", "pipe", "pipe"], env: getCxxEnv() },
      );
    } catch (err: unknown) {
      const execErr = err as {
        status?: number;
        stderr?: Buffer | string;
        stdout?: Buffer | string;
      };
      const stderr = execErr.stderr
        ? typeof execErr.stderr === "string"
          ? execErr.stderr
          : execErr.stderr.toString()
        : "";
      console.error("Error: C++ compilation failed:");
      if (stderr) console.error(stderr);
      process.exit(1);
    }

    // 8. Execute test binary and display results
    let exitCode = 0;
    try {
      const output = execFileSync(binaryPath, [], {
        encoding: "utf-8",
        timeout: 30000,
      });
      process.stdout.write(output);
    } catch (err: unknown) {
      const execErr = err as {
        status?: number;
        stdout?: string;
        stderr?: string;
        signal?: string;
      };
      if (execErr.stdout) {
        process.stdout.write(execErr.stdout);
      }
      if (execErr.signal) {
        console.error(
          `Error: Test binary crashed with signal ${execErr.signal}`,
        );
      }
      exitCode = execErr.status ?? 1;
    }

    // 9. Exit with test result code
    process.exit(exitCode);
  } finally {
    // 10. Cleanup temp directory
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Decompile mode: extract ST source files from a .stlib archive.
 *
 * If the archive carries `category` metadata on its source entries, each
 * file is written under that subfolder (`outputDir/<category>/<file.st>`),
 * recreating the folder hierarchy the library was compiled from.
 * Categoryless entries land at the output root, so flat archives extract
 * exactly the same way they did before hierarchy support was added.
 */
function decompileLibMode(options: CLIOptions): void {
  let archive: import("../library/library-manifest.js").StlibArchive;
  try {
    archive = loadStlibFromFile(resolve(options.decompileLib!));
  } catch (e) {
    console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  if (!archive.sources || archive.sources.length === 0) {
    console.error(
      "Error: This .stlib archive has no embedded sources (compiled with --no-source).",
    );
    process.exit(1);
  }

  const outputDir = options.output ? resolve(options.output) : process.cwd();
  mkdirSync(outputDir, { recursive: true });

  for (const src of archive.sources) {
    // Normalize forward-slash category paths to platform separators and
    // ensure the destination folder exists before writing.
    const subdir = src.category
      ? join(outputDir, ...src.category.split("/"))
      : outputDir;
    mkdirSync(subdir, { recursive: true });
    const outPath = join(subdir, src.fileName);
    writeFileSync(outPath, src.source, "utf-8");
    console.log(`  ${outPath}`);
  }
  console.log(
    `Extracted ${archive.sources.length} file(s) from ${archive.manifest.name} v${archive.manifest.version}`,
  );
  if (archive.pragmaDefines !== undefined) {
    const flags = Object.entries(archive.pragmaDefines).map(([name, value]) =>
      value === ""
        ? `-D ${name}`
        : `-D ${name}=${/[\s"'\\$]/.test(value) ? JSON.stringify(value) : value}`,
    );
    console.log(
      "Compiled with conditional pragmas (feature conditional_pragmas)" +
        (flags.length > 0 ? `; defines: ${flags.join(" ")}` : "; no defines"),
    );
  }
}

/**
 * Import mode: convert a CODESYS .lib/.library file into a .stlib archive.
 * Extracts ST source from the binary, then compiles via compileStlib().
 */
async function importLibMode(options: CLIOptions): Promise<void> {
  if (!options.libName) {
    console.error("Error: --lib-name is required with --import-lib");
    process.exit(1);
  }

  const outputDir = options.output ? resolve(options.output) : process.cwd();
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  console.log(`Importing CODESYS library: ${options.importLib!}`);

  const libPath = resolve(options.importLib!);
  const libBytes = readFileSync(libPath);
  const importResult = await importCodesysLibraryFromBytes(libBytes);

  if (!importResult.success) {
    for (const err of importResult.errors) {
      console.error(`Error: ${err}`);
    }
    process.exit(1);
  }

  for (const w of importResult.warnings) {
    console.warn(`  warning: ${w}`);
  }

  const { metadata } = importResult;
  console.log(`  Format: CODESYS ${metadata.format === "v23" ? "V2.3" : "V3"}`);
  console.log(`  Extracted ${metadata.pouCount} items:`);
  for (const [type, count] of Object.entries(metadata.counts).sort()) {
    console.log(`    ${type}: ${count}`);
  }
  if (metadata.guid) {
    console.log(`  GUID: ${metadata.guid}`);
  }

  // Now compile the extracted sources into a .stlib archive
  const libNamespace =
    options.libNamespace ?? options.libName.replace(/[^a-zA-Z0-9_]/g, "_");

  // Load dependency libraries from explicit -L paths only
  const dependencies: import("../library/library-manifest.js").StlibArchive[] =
    [];
  for (const libPath of options.libraryPaths) {
    try {
      dependencies.push(...discoverStlibs(libPath));
    } catch (e) {
      console.error(
        `Warning: Could not load libraries from ${libPath}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  console.log(
    `\nCompiling library "${options.libName}" from ${importResult.sources.length} extracted source(s)...`,
  );

  const stlibOpts: Parameters<typeof compileStlib>[1] = {
    name: options.libName,
    version: options.libVersion,
    namespace: libNamespace,
    noSource: options.noSource,
    strict: options.strict,
    ...dialectCompileOptions(options),
  };
  if (dependencies.length > 0) {
    stlibOpts.dependencies = dependencies;
  }
  // Forward the constants promoted from VAR_GLOBAL CONSTANT blocks (e.g. OSCAT's
  // STRING_LENGTH) so the dropped GVL's values are still available as constexpr
  // template parameters; explicit -D defines win over the imported values.
  const mergedConstants = {
    ...importResult.globalConstants,
    ...options.defines,
  };
  if (Object.keys(mergedConstants).length > 0) {
    stlibOpts.globalConstants = mergedConstants;
  }
  const result = compileStlib(importResult.sources, stlibOpts);

  if (!result.success) {
    console.error("\nLibrary compilation failed:\n");
    printDiagnostics(result.errors.map(toDiagnostic), importResult.sources);
    console.error(
      "Note: Extracted ST sources may need manual adjustments for compilation.",
    );
    process.exit(1);
  }

  const stlibPath = resolve(outputDir, `${options.libName}.stlib`);
  writeFileSync(stlibPath, JSON.stringify(result.archive, null, 2), "utf-8");
  console.log(`\nLibrary archive written to ${stlibPath}`);
  console.log("Import successful!");
}

/** One diagnostic in the `--check --json` report. */
type CheckDiagnostic = Omit<CompileError, "file"> & { file: string | null };

/** The one JSON document `--check --json` prints. */
interface CheckReport {
  dialect: string | null;
  files: string[];
  diagnostics: CheckDiagnostic[];
  summary: { errors: number; warnings: number };
}

/** A `--check` diagnostic with `file` first and null when unknown. */
function toCheckDiagnostic(err: CompileError): CheckDiagnostic {
  const { file, line, column, severity, message, ...rest } = err;
  return { file: file ?? null, line, column, severity, message, ...rest };
}

/**
 * Order diagnostics by input file (in argument order, unknown files last),
 * then line and column. The sort is stable, so ties keep analysis order.
 */
function sortForCheck(
  diags: CompileError[],
  files: ReadonlyArray<string>,
): CompileError[] {
  const rank = (f: string | undefined): number => {
    const i = f === undefined ? -1 : files.indexOf(f);
    return i < 0 ? files.length : i;
  };
  return [...diags].sort(
    (a, b) =>
      rank(a.file) - rank(b.file) || a.line - b.line || a.column - b.column,
  );
}

/**
 * `--check` mode: parse and analyse the inputs as compile mode would,
 * write no files, and exit 0 (no errors), 1 (errors) or 2 (the check
 * could not run: usage, unreadable file, dialect problem).
 * Diagnostics name each file by the path given on the command line.
 */
function checkMode(options: CLIOptions): never {
  let dialectId: string | null = null;
  const files = options.inputs;

  const report = (diags: CompileError[]): CheckReport => ({
    dialect: dialectId,
    files: [...files],
    diagnostics: diags.map(toCheckDiagnostic),
    summary: {
      errors: diags.filter((d) => d.severity === "error").length,
      warnings: diags.filter((d) => d.severity === "warning").length,
    },
  });

  /** Report a problem that stopped the check and exit 2. */
  const cannotRun = (message: string, file?: string): never => {
    if (options.json) {
      const err: CompileError = {
        message,
        line: 0,
        column: 0,
        severity: "error",
      };
      if (file !== undefined) err.file = file;
      console.log(JSON.stringify(report([err]), null, 2));
    }
    console.error(`error: ${message}`);
    process.exit(2);
  };

  const conflicts: Array<[boolean, string]> = [
    [options.build, "--build"],
    [options.compileLib, "--compile-lib"],
    [options.test.length > 0, "--test"],
    [options.decompileLib !== undefined, "--decompile-lib"],
    [options.importLib !== undefined, "--import-lib"],
    [options.output !== undefined, "-o/--output"],
  ];
  for (const [present, flag] of conflicts) {
    if (present) cannotRun(`--check cannot be combined with ${flag}`);
  }
  if (files.length === 0) cannotRun("--check needs at least one input file");

  const dialectOptions = dialectCompileOptions(options);
  try {
    dialectId = resolveDialect(
      dialectOptions,
      nodeDialectIO.readFile,
      nodeDialectIO.listDir,
    ).id;
  } catch (e) {
    if (!(e instanceof DialectError)) throw e;
    cannotRun(e.message);
  }

  const sources: DiagnosticSource[] = [];
  for (const file of files) {
    try {
      sources.push({
        fileName: file,
        source: readFileSync(resolve(file), "utf-8"),
      });
    } catch {
      cannotRun(`Cannot read input file: ${file}`, file);
    }
  }

  let diags: CompileError[];
  try {
    const analyzeOptions: Partial<CompileOptions> = {
      strict: options.strict,
      ...dialectOptions,
      fileName: sources[0]!.fileName,
      ...withGlobalListName(options, files[0]!, {}, true),
    };
    if (sources.length > 1) {
      analyzeOptions.additionalSources = sources
        .slice(1)
        .map((src, i) => withGlobalListName(options, files[i + 1]!, src));
    }
    const libPaths = getEffectiveLibraryPaths(options);
    if (libPaths.length > 0) {
      analyzeOptions.libraries = libPaths.flatMap((p) => discoverStlibs(p));
    }
    if (Object.keys(options.defines).length > 0) {
      analyzeOptions.globalConstants = options.defines;
    }
    const result = analyze(sources[0]!.source, analyzeOptions);
    diags = sortForCheck([...result.errors, ...result.warnings], files);
  } catch (e) {
    return cannotRun(
      `check failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const out = report(diags);
  if (options.json) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    printDiagnostics(diags, sources);
    console.log(
      `${out.summary.errors} error(s), ${out.summary.warnings} warning(s)`,
    );
  }
  process.exit(out.summary.errors > 0 ? 1 : 0);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const options = parseArgs(args);

  if (options.showVersion) {
    console.log(`STruC++ version ${getVersion()}`);
    process.exit(0);
  }

  if (options.showHelp || args.length === 0) {
    showHelp();
    process.exit(options.showHelp ? 0 : 1);
  }

  if (options.check && !options.printDialect) {
    checkMode(options);
  }
  if (options.json && !options.check) {
    console.error("error: --json is only valid with --check");
    process.exit(1);
  }

  checkDialect(options);

  // Decompile mode
  if (options.decompileLib) {
    decompileLibMode(options);
    return;
  }

  // Import CODESYS library mode
  if (options.importLib) {
    await importLibMode(options);
    return;
  }

  // Library compilation mode
  if (options.compileLib) {
    compileLibraryMode(options);
    return;
  }

  // Test mode
  if (options.test.length > 0) {
    runTestMode(options);
    return;
  }

  if (options.inputs.length === 0) {
    console.error("Error: No input file specified");
    console.error('Run "strucpp --help" for usage information');
    process.exit(1);
  }

  const primaryInput = options.inputs[0]!;
  const inputPath = resolve(primaryInput);
  const outputPath = options.output
    ? resolve(options.output)
    : inputPath.replace(/\.(st|il)$/i, ".cpp");

  // Derive header filename from output path for correct #include directive
  const headerFileName = basename(outputPath).replace(/\.cpp$/i, ".hpp");

  let source: string;
  try {
    source = readFileSync(inputPath, "utf-8");
  } catch {
    console.error(`Error: Cannot read input file: ${inputPath}`);
    process.exit(1);
  }

  // Read additional source files
  const additionalSources: Array<{
    source: string;
    fileName: string;
    globalListName?: string;
  }> = [];
  for (const extra of options.inputs.slice(1)) {
    const extraPath = resolve(extra);
    try {
      additionalSources.push(
        withGlobalListName(options, extra, {
          source: readFileSync(extraPath, "utf-8"),
          fileName: basename(extraPath),
        }),
      );
    } catch {
      console.error(`Error: Cannot read input file: ${extraPath}`);
      process.exit(1);
    }
  }

  const effectiveLibPaths = getEffectiveLibraryPaths(options);
  const compileOptions: Partial<CompileOptions> = {
    debug: options.debug,
    strict: options.strict,
    ...dialectCompileOptions(options),
    lineMapping: options.lineMapping,
    lineDirectives: options.lineDirectives,
    sourceComments: options.sourceComments,
    optimizationLevel: options.optimizationLevel,
    headerFileName,
    cppFileName: basename(outputPath),
    fileName: basename(inputPath),
    ...(options.build && definesThreaded(options.cxxFlags)
      ? { threaded: true }
      : {}),
    ...withGlobalListName(options, primaryInput, {}, true),
  };
  if (additionalSources.length > 0) {
    compileOptions.additionalSources = additionalSources;
  }
  if (effectiveLibPaths.length > 0) {
    compileOptions.libraries = effectiveLibPaths.flatMap((p) =>
      discoverStlibs(p),
    );
  }
  if (Object.keys(options.defines).length > 0) {
    compileOptions.globalConstants = options.defines;
  }

  const fileLabel =
    options.inputs.length > 1
      ? `${options.inputs.length} files`
      : basename(inputPath);
  console.log(`Compiling ${fileLabel}...`);

  const result = compile(source, compileOptions);

  const diagSources: DiagnosticSource[] = [
    { fileName: basename(inputPath), source },
    ...additionalSources,
  ];

  if (!result.success) {
    console.error("\nCompilation failed:\n");
    printDiagnostics(result.errors, diagSources);
    printDiagnostics(result.warnings, diagSources, "warn");
    process.exit(1);
  }

  printDiagnostics(result.warnings, diagSources, "warn");

  try {
    writeFileSync(outputPath, result.cppCode, "utf-8");
    console.log(`Output written to ${outputPath}`);

    if (result.headerCode) {
      const headerPath = outputPath.replace(/\.cpp$/i, ".hpp");
      writeFileSync(headerPath, result.headerCode, "utf-8");
      console.log(`Header written to ${headerPath}`);
    }
  } catch {
    console.error(`Error: Cannot write output file: ${outputPath}`);
    process.exit(1);
  }

  console.log("Compilation successful!");

  // --build: generate main.cpp and invoke g++
  if (options.build) {
    ensureCompilersAvailable(options, true);

    if (!result.ast || !result.projectModel) {
      console.error("Error: AST/ProjectModel not available for --build");
      process.exit(1);
    }

    const outputDir = dirname(outputPath);
    const mainCppPath = resolve(outputDir, "main.cpp");

    // Resolve runtime include dir (auto-discovery + --cxx-flags fallback)
    const runtimeIncludeDir = findRuntimeIncludeDir(options.cxxFlags);
    if (!runtimeIncludeDir) {
      console.error(
        "Error: Could not locate runtime include directory.\n" +
          '  Use --cxx-flags "-I/path/to/runtime/include" to specify it.',
      );
      process.exit(1);
    }

    // Derive repl dir as sibling of include dir (runtime/include -> runtime/repl)
    const replDir = resolve(dirname(runtimeIncludeDir), "repl");
    if (!existsSync(resolve(replDir, "isocline.h"))) {
      console.error(
        `Error: REPL runtime not found at ${replDir}\n` +
          "  Expected runtime/repl/ as sibling of runtime/include/.",
      );
      process.exit(1);
    }

    console.log("Generating REPL harness...");
    const mainCppCode = generateReplMain(result.ast, result.projectModel, {
      headerFileName,
      stSource: source,
      cppCode: result.cppCode,
      headerCode: result.headerCode,
      lineMap: result.lineMap,
      headerLineMap: result.headerLineMap,
    });
    writeFileSync(mainCppPath, mainCppCode, "utf-8");
    console.log(`REPL main written to ${mainCppPath}`);

    // Derive binary output path (strip .cpp extension)
    let binaryPath = outputPath.replace(/\.cpp$/i, "");
    if (process.platform === "win32") binaryPath += ".exe";
    const isoclineObjPath = resolve(outputDir, "isocline.o");

    // Step 1: Compile isocline.c as C (uses execFileSync to avoid shell injection)
    console.log("Compiling isocline...");
    try {
      execFileSync(
        options.cc,
        [
          "-c",
          "-std=c11",
          `-I${replDir}`,
          resolve(replDir, "isocline.c"),
          "-o",
          isoclineObjPath,
        ],
        { stdio: "inherit" },
      );
    } catch (err: unknown) {
      const exitCode = (err as { status?: number }).status;
      console.error(
        `Error: C compilation of isocline failed (exit code ${exitCode ?? "unknown"}).`,
      );
      console.error(
        "Ensure a C compiler is available or specify one with --cc.",
      );
      process.exit(1);
    }

    // Step 2: Compile C++ and link with isocline.o (uses execFileSync to avoid shell injection)
    const gppArgs = [
      "-std=c++14",
      // Pointer punning is valid IEC; the runtime marks its types
      // may_alias, and this covers anything it cannot mark.
      "-fno-strict-aliasing",
      `-I${runtimeIncludeDir}`,
      `-I${replDir}`,
      `-I${outputDir}`,
      ...splitCxxFlags(options.cxxFlags),
      mainCppPath,
      outputPath,
      isoclineObjPath,
      "-o",
      binaryPath,
    ];

    console.log(`Building binary: ${basename(binaryPath)}`);
    try {
      execFileSync(options.gpp, gppArgs, {
        stdio: "inherit",
        env: getCxxEnv(),
      });
      console.log(`Binary built: ${binaryPath}`);
      console.log(`Run it with: ${binaryPath}`);
    } catch (err: unknown) {
      const exitCode = (err as { status?: number }).status;
      console.error(
        `Error: g++ compilation failed (exit code ${exitCode ?? "unknown"}).`,
      );
      console.error("Check the compiler output above for details.");
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error(
    err instanceof Error ? (err.stack ?? err.message) : String(err),
  );
  process.exit(1);
});
