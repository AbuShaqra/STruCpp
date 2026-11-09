# Dialect Profiles

A dialect profile names the language features beyond IEC 61131-3 that a compile accepts. The compiler
has one built-in profile, `iec`; every other profile is input data given on the command line (or as an
object through the library API). A vendor profile is input data and is not shipped here.

## Selecting a dialect

| Given                                       | Features in effect                                          |
| ------------------------------------------- | ----------------------------------------------------------- |
| no `--dialect`, no `--dialect-file`         | the default set: `pointer_to`, `reference_to`, `ref_assign` |
| `--dialect iec`                             | none                                                        |
| `--dialect <id>`                            | the profile's features plus those it inherits               |
| one `--dialect-file <path>`, no `--dialect` | that file's profile                                         |

The default set is the compiler's behaviour before profiles existed, so a build with no dialect flag
behaves exactly as before. `iec` is the strict profile: it enables no feature.

`--dialect <id>` looks the id up in this order: the built-in `iec`, the `--dialect-file` profiles, then
`<dir>/<id>.json` in each `--dialect-path` folder in the order given. `--feature +id`, `--feature -id`
(and a bare `--feature id`, the same as `+id`) are applied in order after the profile.

`--print-dialect` prints the result and exits without compiling:

```bash
$ strucpp --print-dialect
{"id":null,"features":["pointer_to","ref_assign","reference_to"]}
$ strucpp --dialect iec --feature +program_methods --print-dialect
{"id":"iec","features":["program_methods"]}
```

## Profile format

```json
{
  "id": "vendor-a",
  "name": "Vendor A",
  "extends": "iec",
  "features": ["program_methods", "pointer_to", "reference_to", "ref_assign"],
  "semantics": {}
}
```

| Key         | Required | Meaning                                                                                  |
| ----------- | -------- | ---------------------------------------------------------------------------------------- |
| `id`        | yes      | The profile's id; in a `--dialect-path` folder it must equal the file name (`<id>.json`) |
| `name`      | no       | A display name (defaults to the id)                                                      |
| `extends`   | no       | A parent profile id (`iec` or another loaded profile); its features are inherited        |
| `features`  | no       | Feature ids from the table below                                                         |
| `semantics` | no       | Reserved: no key is defined yet, so it must be empty                                     |

The effective features of a profile are its own plus every feature its `extends` chain gives; `iec` is
the root. A profile without `extends` has only its own features.

## Features

| Feature           | Enables                                    |
| ----------------- | ------------------------------------------ |
| `program_methods` | `METHOD` inside a `PROGRAM`                |
| `pointer_to`      | `POINTER TO`, `ADR()` and `^` on a pointer |
| `reference_to`    | `REFERENCE TO`                             |
| `ref_assign`      | the reference assignment `REF=`            |

## Refusals

When a feature is off the compile fails with an error at the construct's own line and column:

| Construct                                   | Feature           | Message                                                 |
| ------------------------------------------- | ----------------- | ------------------------------------------------------- |
| `POINTER TO <type>` (variable, type, field) | `pointer_to`      | `POINTER TO needs the feature pointer_to`               |
| `ADR(x)`                                    | `pointer_to`      | `ADR needs the feature pointer_to`                      |
| `REFERENCE TO <type>` and `REFERENCE_TO`    | `reference_to`    | `REFERENCE TO needs the feature reference_to`           |
| `r REF= x`                                  | `ref_assign`      | `REF= needs the feature ref_assign`                     |
| `METHOD` inside a `PROGRAM`                 | `program_methods` | `METHOD in a PROGRAM needs the feature program_methods` |

When profiles were loaded and some have the feature, the message ends with `(profiles: a, b)`.
`POINTER TO` and `REFERENCE TO` are refused wherever a type is written, CONFIGURATION `VAR_GLOBAL` blocks
included, and `ADR` both in statements and in a declaration's initial value. IEC
`REF_TO`, `REF()`, `^`, `THIS^` and `SUPER^` need no feature. `--test` files are analysed with the default
set, so they are not refused under `iec`.

`program_methods` is not in the default set: a `METHOD` in a `PROGRAM` is refused with no dialect flag too
(before profiles it did not parse at all). `--strict` does not change any feature. A refused method is still
registered and checked, so a call to it adds no second error. Program methods go before the body, interleaved with the VAR blocks
as in a FUNCTION_BLOCK; ABSTRACT and OVERRIDE are refused on them (a PROGRAM has no inheritance), and a
PROGRAM takes no PROPERTY. They may be called only inside their program (its body and its methods):
`MAIN.Name()`, or `p.Name()` through a variable `p : MAIN`, from any other POU is refused with
`the methods and actions of PROGRAM MAIN can be called only inside MAIN`. In the generated C++ each program
method is a plain (non-virtual) member function of `Program_<NAME>`, declared after `run()`, so the class's
vtable is the same as without methods. It sees the program's VARs and reaches its `VAR_EXTERNAL`s exactly as
`run()` does; `Name()` and `MAIN.Name()` inside MAIN both call it on the same instance.

`ACTION` blocks need no feature, in a `PROGRAM` or a `FUNCTION_BLOCK`, under every dialect: an action is
lowered to a parameterless method of its owner that is exempt from `program_methods`, and the same
inside-the-program rule applies to a program's actions.

## Checks

Profiles are input, not trusted code. Every profile read (each `--dialect-file`, and every `*.json` in each
`--dialect-path` folder) is checked when the compiler starts, whether or not it is selected. Each problem
is one line on stderr, `error: <message>`, and exit code 1:

- `dialect file <path>: <JSON parse message>`
- `dialect file <path>: id '<x>' does not match the file name` (`--dialect-path` only)
- `dialect file <path>: semantics key '<k>' is not known`
- `unknown feature '<id>' in <where> (known: program_methods, pointer_to, reference_to, ref_assign)`
- `unknown dialect '<id>' (known: iec, ...)`
- `dialect '<id>': extends '<p>', which is not loaded`
- `dialect '<id>': extends cycle <a> -> <b> -> <a>`

Unknown top-level keys and wrongly typed values are refused the same way.

## Library API

`compile()` and `compileStlib()` take `dialect` (an id or a profile object), `dialectFiles`, `dialectPath`,
`features` and `dialectIO`. The core never reads files: pass `nodeDialectIO` from `strucpp/node` (or your
own `{readFile, listDir}`) with `dialectFiles` or `dialectPath`. A bad profile is a compile error
(line 0). `resolveDialect()` and `profilesWithFeature()` are exported for callers that resolve themselves.

## Language server

The Node language server (`vscode-extension/server`) reads two keys of the `strucpp` workspace
configuration, at start-up and on `workspace/didChangeConfiguration`:

- `dialect`: a profile object, or `null`/absent for the compiler's default;
- `features`: an array of `+id`, `-id` or `id` overrides, or `null`/absent.

The server reads no profile files. Diagnostics of open, workspace and library documents and the
compile, build, debug-build, library and test requests all use the selection. A change re-analyses the
open documents. A rejected value keeps the previous selection and shows
`STruC++: dialect profile rejected: <message>`. The browser server has no configuration channel.

```json
{
  "dialect": {
    "id": "test-pointers",
    "name": "Pointers",
    "extends": "iec",
    "features": ["pointer_to"],
    "semantics": {}
  },
  "features": ["+program_methods"]
}
```
