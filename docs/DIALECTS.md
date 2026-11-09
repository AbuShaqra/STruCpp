# Dialect Profiles

A dialect profile names the language features beyond IEC 61131-3 that a compile accepts. The compiler
has one built-in profile, `iec-3` (IEC 61131-3 Ed. 3, 2013); every other profile is input data given on
the command line (or as an object through the library API). A vendor profile is input data and is not
shipped here.

## Selecting a dialect

| Given                                       | Features in effect                                          |
| ------------------------------------------- | ----------------------------------------------------------- |
| no `--dialect`, no `--dialect-file`         | the default set: `pointer_to`, `reference_to`, `ref_assign` |
| `--dialect iec-3`                           | none                                                        |
| `--dialect <id>`                            | the profile's features plus those it inherits               |
| one `--dialect-file <path>`, no `--dialect` | that file's profile                                         |

The default set is the compiler's behaviour before profiles existed, so a build with no dialect flag
behaves exactly as before. `iec-3` is the strict profile: it enables no feature. The default is not
`iec-3`: it selects no profile, so `--print-dialect` and `--check --json` report its id as `null`.

The id `iec` is reserved and is not an alias: `--dialect iec`, a profile with `"extends": "iec"` and a
profile whose own `id` is `iec` (file, `--dialect-path` entry or object) are refused with an error that
names `iec-3`.

`--dialect <id>` looks the id up in this order: the built-in `iec-3`, the `--dialect-file` profiles, then
`<dir>/<id>.json` in each `--dialect-path` folder in the order given. `--feature +id`, `--feature -id`
(and a bare `--feature id`, the same as `+id`) are applied in order after the profile.

`--print-dialect` prints the result and exits without compiling:

```bash
$ strucpp --print-dialect
{"id":null,"features":["pointer_to","ref_assign","reference_to"]}
$ strucpp --dialect iec-3 --feature +program_methods --print-dialect
{"id":"iec-3","features":["program_methods"]}
```

`--check` (analysis only, see [CLI.md](CLI.md#check)) resolves the dialect the same way. Its JSON report
names the resolved id in `dialect`, and a bad profile exits 2.

## Profile format

```json
{
  "id": "vendor-a",
  "name": "Vendor A",
  "extends": "iec-3",
  "features": ["program_methods", "pointer_to", "reference_to", "ref_assign"],
  "semantics": {}
}
```

| Key         | Required | Meaning                                                                                  |
| ----------- | -------- | ---------------------------------------------------------------------------------------- |
| `id`        | yes      | The profile's id; in a `--dialect-path` folder it must equal the file name (`<id>.json`) |
| `name`      | no       | A display name (defaults to the id)                                                      |
| `extends`   | no       | A parent profile id (`iec-3` or another loaded profile); its features are inherited      |
| `features`  | no       | Feature ids from the table below                                                         |
| `semantics` | no       | Reserved: no key is defined yet, so it must be empty                                     |

The effective features of a profile are its own plus every feature its `extends` chain gives; `iec-3` is
the root. A profile without `extends` has only its own features.

## Features

| Feature              | Enables                                                      |
| -------------------- | ------------------------------------------------------------ |
| `program_methods`    | `METHOD` inside a `PROGRAM`                                  |
| `pointer_to`         | `POINTER TO`, `ADR()` and `^` on a pointer                   |
| `reference_to`       | `REFERENCE TO`                                               |
| `ref_assign`         | the reference assignment `REF=`                              |
| `self_caret`         | `THIS^.member` and `THIS^.M()`                               |
| `property`           | `PROPERTY` prototypes in an `INTERFACE`                      |
| `postfix_enum_base`  | an enumeration base type after the value list, `(A, B) DINT` |
| `named_global_lists` | a global qualified by its list name, `GVL_A.x`               |

## Refusals

When a feature is off the compile fails with an error at the construct's own line and column:

| Construct                                   | Feature              | Message                                                                              |
| ------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------ |
| `POINTER TO <type>` (variable, type, field) | `pointer_to`         | `POINTER TO needs the feature pointer_to`                                            |
| `ADR(x)`                                    | `pointer_to`         | `ADR needs the feature pointer_to`                                                   |
| `REFERENCE TO <type>` and `REFERENCE_TO`    | `reference_to`       | `REFERENCE TO needs the feature reference_to`                                        |
| `r REF= x`                                  | `ref_assign`         | `REF= needs the feature ref_assign`                                                  |
| `METHOD` inside a `PROGRAM`                 | `program_methods`    | `METHOD in a PROGRAM needs the feature program_methods`                              |
| `THIS^.member`, `THIS^.M()`                 | `self_caret`         | `THIS^.member needs the feature self_caret`                                          |
| `PROPERTY` inside an `INTERFACE`            | `property`           | `PROPERTY in an INTERFACE needs the feature property`                                |
| `TYPE E : (A, B) DINT;` (base after list)   | `postfix_enum_base`  | `an enum base type written after the value list needs the feature postfix_enum_base` |
| `GVL_A.x` (list-qualified global)           | `named_global_lists` | `Global variable list access 'GVL_A.X' needs the feature named_global_lists`         |

When profiles were loaded and some have the feature, the message ends with `(profiles: a, b)`.
`POINTER TO` and `REFERENCE TO` are refused wherever a type is written, CONFIGURATION `VAR_GLOBAL` blocks
included, and `ADR` both in statements and in a declaration's initial value. IEC
`REF_TO`, `REF()` and `^` need no feature. `--test` files are analysed with the default set, so they are
not refused under `iec-3`.

`self_caret` is in neither the default set nor `iec-3`. IEC writes THIS and SUPER with a dot: `THIS.x`,
`THIS.M()`, `SUPER.x` and `SUPER.M()` need no feature, and `SUPER.M()` reaches the nearest base that
declares `M`. `THIS^.x` means the same as `THIS.x`. `REF=` on a THIS member (`THIS.r REF= x`) needs
`ref_assign`, and `self_caret` as well when written `THIS^.r`. Bare `THIS^` and the forms `SUPER^.M()`,
`SUPER^.x` and `SUPER^()` are not IEC either, but they were accepted before profiles and still are, in every
dialect.

`property` is in neither the default set nor `iec-3`: IEC 61131-3 Ed. 3 has no PROPERTY, and its interfaces
hold method prototypes only. A `PROPERTY` in a `FUNCTION_BLOCK` (with GET/SET bodies) needs no feature and is
accepted in every dialect. In an `INTERFACE`, a property prototype names its accessors explicitly, with no
bodies:

```
INTERFACE ISetpoint
PROPERTY Value : INT
GET END_GET
END_PROPERTY
PROPERTY Target : INT
GET END_GET
SET END_SET
END_PROPERTY
END_INTERFACE
```

With the feature on:

- A prototype with neither GET nor SET is an error (`Property 'X' in INTERFACE 'I' declares no accessor:
  declare GET and/or SET`), and so is an accessor with a body.
- A non-ABSTRACT FB that implements the interface (directly, or through an interface that EXTENDS it)
  provides each property, as its own or from a base FB, with the same type and at least the accessors the
  interface declares (it may add the other one). A missing property is reported at the FB; a different
  type or a missing GET or SET at the FB's property.
- Through an interface variable, `x := itf.Value` calls the instance's GET and `itf.Target := v` its SET
  (also through a member chain, `a.itf.Target`), dispatched to the instance's FB. Writing a property the
  interface declares without SET, or reading one it declares without GET, is an error at the access.
- In C++ the interface gets pure virtual `get_X()`/`set_X()` members that the FB's accessors override.

`postfix_enum_base` is in neither the default set nor `iec-3`. IEC writes the optional base type of an
enumeration before its value list; this feature also accepts it after the list, with or without member values
and an optional default. The refusal is reported at the base type. With the feature on, the declaration means
the same as the base-first form, and the generated C++ is identical (the base is the C++ underlying type):

```
TYPE
  Mode : (Idle := 0, Run := 1) DINT := Idle; (* postfix_enum_base *)
  Same : DINT (Idle := 0, Run := 1) := Idle; (* IEC: base first, every dialect *)
END_TYPE
```

The postfix form is accepted in a `TYPE` declaration only, not in an anonymous enumeration inside a variable
declaration.

`named_global_lists` is in neither the default set nor `iec-3`: in IEC 61131-3 Ed. 3 global variables
live in CONFIGURATION, RESOURCE and PROGRAM, and a namespace holds no variables, so a global list name is
not IEC. The top-level `VAR_GLOBAL` blocks of one source file (outside any CONFIGURATION) form a global
variable list. Its name is the file's stem (`GVL_A.st` and `dir/GVL_A.st` give `GVL_A`), or what the caller
gives: `globalListName` on the compile options (the primary source) or on an `additionalSources` entry, and
`--global-list <file>=<name>` on the CLI. A list name compares case-insensitively; a stem that is not an
identifier names no list. With the feature on:

```
(* GVL_A.st *)
VAR_GLOBAL x : INT := 1; fb : FB_Add; arr : ARRAY[1..3] OF INT; END_VAR
(* GVL_B.st *)
VAR_GLOBAL x : INT := 2; END_VAR
(* main.st *)
PROGRAM Main
VAR x : REAL; END_VAR
GVL_A.x := GVL_B.x + 1;       (* two globals named x, one per list *)
x := 2.5;                     (* the local *)
GVL_A.arr[2] := GVL_A.fb.out; (* member, subscript and dereference chains *)
GVL_A.fb.M();                 (* a method through the list *)
END_PROGRAM
```

- `LIST.var` reads and writes the global `var` of that list, followed by any chain of members, subscripts
  and dereferences, in POU bodies (programs, functions, FBs, methods, property accessors). It types and
  generates exactly like the unqualified access to that global. Initial values, CONFIGURATION entries and
  `--test` files do not take the qualified form.
- Unqualified access keeps working: qualifying is not enforced.
- A list name is consulted last. When the name before the dot is anything else in that body (a local,
  member or global variable, a POU, a type, an enum value, a function or method name, THIS/SUPER), that
  wins and the access means what it meant before. So a variable `GVL_A : ST_Pair` makes `GVL_A.x` its field.
- A local or member `x` hides the global `x` for plain `x` only: `GVL_A.x` still reaches the global.
- Two lists may declare the same name: `GVL_A.x` and `GVL_B.x` are distinct variables with their own
  initial values. A plain `x` there is an error at the use, `'X' is declared in lists GVL_A and GVL_B;
  qualify it as GVL_A.X or GVL_B.X`, unless a local `x` hides both; so is a `VAR_EXTERNAL x`. With the
  feature off the second declaration is still `Symbol 'X' already defined in scope 'global'`.
- `GVL_A.nope` is `'NOPE' is not a variable of global variable list 'GVL_A'`; two files with the same list
  name are an error at the second file's first block.
- In C++ a global no other list declares keeps its name. A global two lists declare is emitted as
  `LIST__NAME` (`GVL_A__X`), and a global reached as `GVL_A.x` where a local `x` hides it gets a reference
  `inline T& GVL_A__X = X;` (`const` for a constant) after its definition. Messages, hover and the symbol
  table show `GVL_A.X`; the language server's completion lists neither form. The lexer accepts `__` in an
  identifier, so a program declaring `GVL_A__X` itself makes that access an error naming the clash.
  Top-level globals are not in the debug table.
- With the feature off, `GVL_A.x` is refused at the access only where `GVL_A` names a list and nothing
  else; an unknown name is still `Undeclared variable 'GVL_A'`.

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

Pragmas `{...}` (IEC 61131-3 Ed. 3, 6.2) are not a feature: every profile, `iec-3` included, accepts them
wherever whitespace may appear and skips them with a `Pragma ignored: {...}` warning at the pragma's line
and column (listed by `--check --json`, exit 0). Their contents are not interpreted, apart from
`{external ...}`. Conditional-compilation pragmas (`{IF ...}`, `{ELSIF ...}`, `{ELSE}`, `{END_IF}`,
`{define ...}`, `{undefine ...}`, any case) are an error, `Conditional compilation pragmas are not
supported: {...}`, because skipping them would compile every branch. A pragma ends at the first `}`; an
unclosed `{` is the error `Unterminated pragma: '{' has no closing '}'`.

## Checks

Profiles are input, not trusted code. Every profile read (each `--dialect-file`, and every `*.json` in each
`--dialect-path` folder) is checked when the compiler starts, whether or not it is selected. Each problem
is one line on stderr, `error: <message>`, and exit code 1:

- `dialect file <path>: <JSON parse message>`
- `dialect file <path>: id '<x>' does not match the file name` (`--dialect-path` only)
- `dialect file <path>: semantics key '<k>' is not known`
- `unknown feature '<id>' in <where> (known: program_methods, pointer_to, reference_to, ref_assign)`
- `unknown dialect '<id>' (known: iec-3, ...)`
- `dialect '<id>': extends '<p>', which is not loaded`
- either of the two above for the id `iec` ends with `; the IEC 61131-3 Ed. 3 profile is 'iec-3'`
- `<where>: the id 'iec' is reserved; the IEC 61131-3 Ed. 3 profile is 'iec-3'`
- `dialect '<id>': extends cycle <a> -> <b> -> <a>`

Unknown top-level keys and wrongly typed values are refused the same way.

## Library API

`compile()` and `compileStlib()` take `dialect` (an id or a profile object), `dialectFiles`, `dialectPath`,
`features` and `dialectIO`. `compile()` and `analyze()` also take `globalListName` (and the same key on each
`additionalSources` entry) for `named_global_lists`; a name that is not an identifier throws a `TypeError`. The core never reads files: pass `nodeDialectIO` from `strucpp/node` (or your
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
    "extends": "iec-3",
    "features": ["pointer_to"],
    "semantics": {}
  },
  "features": ["+program_methods"]
}
```
