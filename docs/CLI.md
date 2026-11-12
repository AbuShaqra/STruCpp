# STruC++ CLI Reference

## Installation

Download the latest release for your platform from [GitHub Releases](https://github.com/Autonomy-Logic/STruCpp/releases):

| Platform            | Archive                      |
| ------------------- | ---------------------------- |
| Linux x64           | `strucpp-linux-x64.tar.gz`   |
| Linux ARM64         | `strucpp-linux-arm64.tar.gz` |
| macOS Intel         | `strucpp-darwin-x64.zip`     |
| macOS Apple Silicon | `strucpp-darwin-arm64.zip`   |
| Windows x64         | `strucpp-win32-x64.zip`      |

Extract the archive and add the `strucpp/` directory to your `PATH`:

```bash
# Linux / macOS
tar -xzf strucpp-linux-x64.tar.gz   # or unzip strucpp-darwin-arm64.zip
export PATH="$PWD/strucpp:$PATH"

# Verify
strucpp --version
```

The release contains:

```
strucpp/
  strucpp                  # Standalone binary (strucpp.exe on Windows)
  runtime/
    include/*.hpp          # C++ runtime headers (included automatically)
    repl/                  # REPL line editor sources (for --build)
    test/                  # Test harness sources (for --test)
  libs/
    iec-standard-fb.stlib  # IEC 61131-3 standard function blocks
    oscat-basic.stlib      # OSCAT Basic library
```

## Prerequisites

The `--build` and `--test` modes compile C++ code and require a working toolchain on the host:

- `g++` with C++14 support (GCC 5+ or equivalent)
- `cc` (any C11 compiler, for the REPL line editor)

The default compile mode (ST to C++) has no external dependencies.

## Modes

The CLI operates in one of these mutually exclusive modes, detected by flag presence:

### Compile (default)

Compile Structured Text to C++:

```bash
strucpp input.st -o output.cpp
strucpp file1.st file2.st -o output.cpp    # Multi-file
```

Produces two files: `output.cpp` (implementation) and `output.hpp` (declarations).

### Check

Parse and analyse ST without generating C++, writing any file or needing `g++`:

```bash
strucpp --check main.st utils.st
strucpp --check --json main.st utils.st --dialect iec-3
```

It runs the same parse and semantic analysis as compile mode, with the same libraries (bundled and
`-L`), `-D` defines, `--strict` and dialect flags (`--dialect`, `--dialect-file`, `--dialect-path`,
`--feature`). It accepts several input files. Each diagnostic names its file by the path given on the
command line. It cannot be combined with `-o`, `--build`, `--test`, `--compile-lib`,
`--decompile-lib` or `--import-lib`.

| Exit code | Meaning                                                                  |
| --------- | ------------------------------------------------------------------------ |
| 0         | No errors (warnings may be present)                                      |
| 1         | At least one error                                                       |
| 2         | The check could not run: usage error, unreadable file or dialect problem |

Without `--json`, errors and warnings go to stderr in the [error format](#error-output), ordered by
file (in argument order), line and column, followed by a `N error(s), M warning(s)` line on stdout.

With `--json`, stdout carries exactly one JSON document, also for exit code 2:

```json
{
  "dialect": "iec-3",
  "files": ["main.st", "lib/utils.st"],
  "diagnostics": [
    {
      "file": "main.st",
      "line": 5,
      "column": 6,
      "severity": "error",
      "message": "Undeclared variable 'MISSINGVAR'",
      "pouName": "MAIN",
      "pouKind": "PROGRAM",
      "section": "body",
      "bodyLine": 1
    }
  ],
  "summary": { "errors": 1, "warnings": 0 }
}
```

- `dialect` is the resolved profile id, or `null` without a profile.
- `files` lists the inputs as given.
- Each diagnostic has `file` (`null` when the diagnostic has no file), `line`, `column` (1-based;
  `0` when there is no position), `severity` (`error` or `warning`) and `message`. When known it also
  has `endLine`, `endColumn`, `code`, `suggestion` and the POU context fields `pouName`, `pouKind`,
  `section`, `bodyLine` and `variableName`.
- For exit code 2 the one diagnostic is the reason, with `line` and `column` 0.

The check runs analysis only. A program that passes it can still fail later: in C++ code generation
or in `g++` (for example an interface-typed `VAR_INPUT` today).

### Build

Compile to C++ and produce an interactive REPL binary (see [REPL.md](REPL.md)):

```bash
strucpp input.st -o output.cpp --build
```

Requires `g++` (C++14) and `cc` (C11) on the system. The build process:

1. Compiles ST to C++ (`.cpp` + `.hpp`)
2. Generates a REPL `main.cpp` with embedded source, line maps, and program descriptors
3. Compiles `isocline.c` (bundled line editor) as a C object
4. Links everything into a standalone executable

### Test

Run a test suite against compiled ST source (see [TESTING.md](TESTING.md)):

```bash
strucpp source.st --test tests.st
strucpp source.st --test test1.st test2.st    # Multiple test files
```

Compiles source and test files, generates a C++ test runner, builds and executes it. Exit code reflects test results (0 = all passed).

### Compile Library

Compile ST sources into a `.stlib` archive:

```bash
strucpp --compile-lib math.st -o libs/ --lib-name math-utils
strucpp --compile-lib src/mylib/ -o libs/ --lib-name my-lib    # Directory input
```

Directories are scanned recursively for `.st` files. Produces a single `<lib-name>.stlib` JSON archive. Library mode uses only explicit `-L` paths (bundled libs are not auto-added to avoid self-referencing).

### Decompile Library

Extract ST source files from a `.stlib` archive:

```bash
strucpp --decompile-lib mylib.stlib -o extracted/
```

Fails if the archive was compiled with `--no-source`.

### Import CODESYS Library

Convert a CODESYS V2.3 (`.lib`) or V3 (`.library`) file to `.stlib`:

```bash
strucpp --import-lib oscat.lib -o libs/ --lib-name oscat-basic
strucpp --import-lib project.library -o libs/ --lib-name my-project -L libs/
```

Format is auto-detected. Extracts ST source from the binary/ZIP format, compiles it, and produces a `.stlib` archive.

## Options

### Output

| Flag                  | Description                                             |
| --------------------- | ------------------------------------------------------- |
| `-o, --output <path>` | Output file (compile) or directory (library/test modes) |
| `--line-directives`   | Emit `#line` directives in C++ output                   |
| `--source-comments`   | Include ST source as C++ comments                       |
| `--no-line-mapping`   | Disable ST-to-C++ line mapping                          |
| `-O <level>`          | Optimization level: 0, 1, or 2 (default: 0)             |

With `--line-directives`, each generated body is preceded by `#line N "<file>.st"` lines and followed by a
`#line N "<output>.cpp"` (or `.hpp` in the header) that hands the rest of the file back to the generated file, so a
C++ diagnostic in code after a body points at the generated line, not at the body's last ST line.

### Libraries

| Flag                   | Description                                                    |
| ---------------------- | -------------------------------------------------------------- |
| `-L, --lib-path <dir>` | Add library search path (repeatable)                           |
| `--no-default-libs`    | Do not auto-add bundled `libs/` directory                      |
| `--lib-name <name>`    | Library name (required for `--compile-lib` and `--import-lib`) |
| `--lib-version <ver>`  | Library version (default: `1.0.0`)                             |
| `--lib-namespace <ns>` | C++ namespace (default: sanitized lib name)                    |
| `--no-source`          | Omit ST source from `.stlib` archive                           |

### Compilation

| Flag                  | Description                                                   |
| --------------------- | ------------------------------------------------------------- |
| `--build`             | Build interactive REPL binary after compilation               |
| `--gpp <path>`        | Custom g++ path (default: `g++`)                              |
| `--cc <path>`         | Custom C compiler path (default: `cc`)                        |
| `--cxx-flags <flags>` | Extra flags passed to g++ (supports quoted paths)             |
| `-D NAME[=VALUE]`     | Define a conditional-pragma name (`--define`, `-DNAME`; repeatable; the name is case-sensitive in `defined()`, and `{undefine}` in a source cannot remove it); an integer VALUE also defines a global constant (emits `constexpr size_t`). A name that is not an identifier is a usage error. See [DIALECTS.md](DIALECTS.md#conditional-pragmas) |
| `--pragma-define NAME[=VALUE]` | Define a conditional-pragma name only (repeatable): whatever VALUE is, no global constant. See [DIALECTS.md](DIALECTS.md#conditional-pragmas) |
| `--file-define <file>=NAME[=VALUE]` | Define a conditional-pragma name for input `<file>` only, on top of the project defines (repeatable; not with `--compile-lib`): seen by `defined()` and `hasvalue()` in that file (over a project define of the same name), not by `project_defined()`. See [DIALECTS.md](DIALECTS.md#conditional-pragmas) |
| `-d, --debug`         | Enable debug output                                           |
| `--strict`            | Reject code that strict IEC compilers (matiec) reject; below  |

`--strict` applies in every mode that compiles ST (compile, build, `--test`, `--compile-lib`,
`--import-lib`) and reports each problem at its ST line. It rejects:

- implicit conversions other than those of IEC Ed. 3 Figures 11 and 12 (narrowing, signed to
  unsigned, lossy integer/REAL conversions, BOOL to or from a number, a bit string to or from an
  integer or REAL, a bit string into a narrower one or into BOOL); BOOL or a bit string into a
  wider bit string is accepted; untyped constants such as `-1`, `16#FF` or `1 + 2` take the type
  they are assigned to, and `0`, `1` and `NOT 1` fit a BOOL;
- arithmetic on BOOL or on BYTE/WORD/DWORD/LWORD, and an integer used as TIME;
- the reserved names ON, STEP and MOVE for a variable, POU, method, type, field, enum value,
  configuration, resource, task or program instance (a FUNCTION may still be named MOVE);
- a FOR loop with no statement in its body (an empty statement, `DO ; END_FOR`, is a
  body), a function result that is discarded, a missing `;` after END_IF, END_CASE,
  END_FOR, END_WHILE or END_REPEAT, an FB call naming a parameter the FB lacks, and a
  duplicate or overlapping CASE label.

A dialect feature can relax one of these checks: `end_semicolon_optional` accepts the missing `;`
under `--strict`. See "Strict checks a feature relaxes" in [DIALECTS.md](DIALECTS.md).

### Dialects

| Flag                    | Description                                                                             |
| ----------------------- | --------------------------------------------------------------------------------------- |
| `--dialect <id>`        | Compile under a profile: built-in `iec-3`, a `--dialect-file`/`--dialect-path` profile  |
| `--dialect-file <path>` | Load a profile file (repeatable); one file and no `--dialect` selects it                |
| `--dialect-path <dir>`  | Load and check every `*.json` profile in a folder (repeatable)                          |
| `--feature <+id\|-id>`  | Enable (`+id` or `id`) or disable (`-id`) a feature after the profile (repeatable)      |
| `--global-list <f>=<n>` | Name the global variable list of input file `<f>` (default: its stem; repeatable)      |
| `--print-dialect`       | Print the resolved dialect as JSON (`{"id":...,"features":[...]}`) and exit             |

With no `--dialect` and no `--dialect-file` the compiler runs with the default features
`pointer_to`, `reference_to` and `ref_assign` (its behaviour before profiles). `--dialect iec-3`
enables no feature; `--dialect iec` is refused with an error naming `iec-3`. The flags apply in every mode that compiles ST (compile, build, `--test`,
`--compile-lib`, `--import-lib`, `--check`); a bad profile prints one `error:` line and exits 1
(2 with `--check`). The
profile format and the features are in [DIALECTS.md](DIALECTS.md).

`--global-list <file>=<name>` names the global variable list formed by the top-level `VAR_GLOBAL` blocks of
an input file, for the feature `named_global_lists` (`<name>.var`). Without it a file's list is named by its
stem (`lists/GVL_A.st` → `GVL_A`). `<file>` is matched against the input files by resolved path and the
last `=` splits it from `<name>`, which must be an identifier. It works in compile, `--check` and `--test`
mode. A malformed value, a file that is not an input, or a file given twice is a usage error (exit 2 with
`--check`, 1 otherwise):

```bash
strucpp --check main.st lists/a.st --global-list lists/a.st=GVL_A --feature +named_global_lists
```

```bash
strucpp --dialect iec-3 --print-dialect
strucpp main.st -o main.cpp --dialect-path dialects/ --dialect vendor-a
strucpp main.st -o main.cpp --feature -pointer_to
```

### Info

| Flag            | Description  |
| --------------- | ------------ |
| `-h, --help`    | Show help    |
| `-v, --version` | Show version |

## Library Search Order

When compiling (not in `--compile-lib` mode):

1. Bundled `libs/` directory next to the `strucpp` binary (auto-discovered, unless `--no-default-libs`)
2. Paths from `-L` flags, in order specified
3. Duplicates are removed

All `.stlib` files found in these directories are loaded. Library global constants are merged into the compilation (user `-D` values take priority).

## Error Output

```
Compilation failed:
  filename.st:12:5: error: Undeclared variable 'x'
    Suggestion: Did you mean 'X1'?

  filename.st:20:10: warning: Narrowing conversion from DINT to INT
```

All errors include file, line, column, severity, and message. Compilation aborts on errors but continues on warnings.
Warnings are printed when compilation fails too.

Lexer errors (a character that starts no token) carry the real line and column, and parsing continues
after them, so the rest of the file is still checked. A file with a lexer error never compiles.
A syntax error at the end of the file is placed just after the last token.

## Examples

```bash
# Simple compilation
strucpp counter.st -o counter.cpp

# Multi-file with library
strucpp main.st utils.st -o program.cpp -L libs/

# Build and run interactive REPL
strucpp program.st -o program.cpp --build

# Compile a library from a directory of ST files
strucpp --compile-lib src/mylib/ -o libs/ --lib-name my-lib --lib-version 2.0.0

# Run tests
strucpp counter.st --test test_counter.st

# Import CODESYS library with dependencies
strucpp --import-lib oscat.library -o libs/ --lib-name oscat -L libs/

# Extract sources from a library
strucpp --decompile-lib libs/oscat.stlib -o oscat-src/

# Compile with global constants and debug
strucpp program.st -o out.cpp -D STRING_LENGTH=100 -D MAX_ITEMS=50 --debug
```
