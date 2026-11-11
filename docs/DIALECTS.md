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
| `program_methods`    | `METHOD` inside a `PROGRAM`; a program reached by name, `P.M()` |
| `pointer_to`         | `POINTER TO`, `ADR()` and `^` on a pointer                   |
| `reference_to`       | `REFERENCE TO`                                               |
| `ref_assign`         | the reference assignment `REF=`                              |
| `self_caret`         | `THIS^.member` and `THIS^.M()`                               |
| `property`           | `PROPERTY` prototypes in an `INTERFACE`                      |
| `postfix_enum_base`  | an enumeration base type after the value list, `(A, B) DINT` |
| `named_global_lists` | a global qualified by its list name, `GVL_A.x`               |
| `struct_extends`     | a STRUCT that inherits another's fields, `ST_B EXTENDS ST_A` |
| `union`              | a UNION type, `TYPE U_A : UNION ... END_UNION END_TYPE`      |
| `fb_init`            | init arguments `fb : FB_A(p := 1)`, and FB_init at start-up  |
| `trunc_dint`         | `TRUNC(x)` returns DINT for an LREAL too (not only a REAL)   |
| `interface_zero`     | `itf := 0` stores NULL in an interface variable              |
| `end_semicolon_optional` | under `--strict`, `END_IF` and the like need no `;`      |
| `conditional_pragmas` | `{IF}`/`{ELSIF}`/`{ELSE}`/`{END_IF}` with `defined()`, `project_defined()`, `hasvalue()`, `AND`/`OR`/`NOT`; defines from `-D` ([below](#conditional-pragmas)) |

## Refusals

When a feature is off the compile fails with an error at the construct's own line and column:

| Construct                                   | Feature              | Message                                                                              |
| ------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------ |
| `POINTER TO <type>` (variable, type, field) | `pointer_to`         | `POINTER TO needs the feature pointer_to`                                            |
| `ADR(x)`                                    | `pointer_to`         | `ADR needs the feature pointer_to`                                                   |
| `REFERENCE TO <type>` and `REFERENCE_TO`    | `reference_to`       | `REFERENCE TO needs the feature reference_to`                                        |
| `r REF= x`                                  | `ref_assign`         | `REF= needs the feature ref_assign`                                                  |
| `METHOD` inside a `PROGRAM`                 | `program_methods`    | `METHOD in a PROGRAM needs the feature program_methods`                              |
| `PRG_A(...)` from another POU               | `program_methods`    | `a call of PROGRAM PRG_A from another POU needs the feature program_methods`         |
| `THIS^.member`, `THIS^.M()`                 | `self_caret`         | `THIS^.member needs the feature self_caret`                                          |
| `PROPERTY` inside an `INTERFACE`            | `property`           | `PROPERTY in an INTERFACE needs the feature property`                                |
| `TYPE E : (A, B) DINT;` (base after list)   | `postfix_enum_base`  | `an enum base type written after the value list needs the feature postfix_enum_base` |
| `GVL_A.x` (list-qualified global)           | `named_global_lists` | `Global variable list access 'GVL_A.X' needs the feature named_global_lists`         |
| `TYPE ST_B EXTENDS ST_A : STRUCT`           | `struct_extends`     | `EXTENDS on a STRUCT needs the feature struct_extends`                               |
| `TYPE U_A : UNION ... END_UNION`            | `union`              | `UNION type 'U_A' needs the feature union`                                           |
| `fb : FB_A(p := 1);` (init arguments)       | `fb_init`            | `The init argument list of 'FB' needs the feature fb_init` (at `(`)                  |
| `itf := 0` (interface variable)             | `interface_zero`     | `Assigning 0 to interface I_A needs the feature interface_zero` (at the `0`)         |
| `{IF ...}`, `{ELSIF ...}`, `{ELSE}`, `{END_IF}`, `{define ...}`, `{undefine ...}` | `conditional_pragmas` | `Conditional compilation pragmas are not supported: {IF ...}; they need the feature conditional_pragmas` (at each directive). `{define}`/`{undefine}` stay refused with the feature on ([below](#conditional-pragmas)) |

When profiles were loaded and some have the feature, the message ends with `(profiles: a, b)`.
`POINTER TO` and `REFERENCE TO` are refused wherever a type is written, CONFIGURATION `VAR_GLOBAL` blocks
included, and `ADR` both in statements and in a declaration's initial value. IEC
`REF_TO`, `REF()` and `^` need no feature. `--test` files are analysed with the default set, so they are
not refused under `iec-3`. The one exception is `conditional_pragmas`: `--test` resolves the dialect flags
and `-D` for the test files too, so their conditional pragmas follow the same profile as the sources.

A `REFERENCE TO` VAR_INPUT is bound to its argument at the call. Where `reference_to` is on, these
arguments are errors: an expression (`REFERENCE TO input 'R' needs a variable to refer to, not an
expression`), a constant (`... not a constant`), a variable of another type, a REF_TO or a subrange
(`REFERENCE TO INT cannot refer to a DINT variable`; for a subrange the message adds that writes through the
reference would not be checked against the subrange). A variable of an alias of the referenced type passes
the check, and compile refuses it as not supported yet (`binding a REFERENCE TO INT to a variable of alias
type 'MYINT' is not supported yet`), as it does for `r REF= x` with `x` of an alias type.

`self_caret` is in neither the default set nor `iec-3`. IEC writes THIS and SUPER with a dot: `THIS.x`,
`THIS.M()`, `SUPER.x` and `SUPER.M()` need no feature, and `SUPER.M()` reaches the nearest base that
declares `M`. `THIS^.x` means the same as `THIS.x`. `REF=` on a THIS member (`THIS.r REF= x`) needs
`ref_assign`, and `self_caret` as well when written `THIS^.r`. Bare `THIS^` and the forms `SUPER^.M()`,
`SUPER^.x` and `SUPER^()` are not IEC either, but they were accepted before profiles and still are, in every
dialect.

`=` and `<>` on two STRUCT values (compared field by field) are not IEC 61131-3 Ed. 3 either, whose
comparison functions take elementary values. They were accepted by analysis before they compiled and still
are, in every dialect, `iec-3` included; refusing them under `iec-3` is a candidate for the iec-3 audit.

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
  and dereferences, in POU bodies (programs, functions, FBs, methods, property accessors) and in
  declarations: an initial value (`n : INT := GVL_A.k;`, array literals included) and the init argument
  list of an FB instance (`fb : FB_A(ref := GVL_A.x);`, feature `fb_init`), in a PROGRAM, FUNCTION,
  FUNCTION_BLOCK, METHOD or top-level `VAR_GLOBAL`. It types and generates exactly like the unqualified
  access to that global. STRUCT field defaults, CONFIGURATION entries and `--test` files do not take the
  qualified form.
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

`struct_extends` is in neither the default set nor `iec-3`: IEC 61131-3 Ed. 3 `Struct_Type_Decl` takes no
EXTENDS, and 3.46 limits inheritance to classes, function block types and interfaces. With the feature on, a
STRUCT declared in a `TYPE` block may name a base STRUCT:

```
TYPE
  ST_A : STRUCT a1 : INT := 10; a2 : BOOL; END_STRUCT;
  ST_B EXTENDS ST_A : STRUCT b1 : INT; END_STRUCT;
  ST_C EXTENDS ST_B : STRUCT c1 : REAL; END_STRUCT;
END_TYPE
```

- The derived STRUCT holds the base's fields first (with their initial values), then its own; chains of any
  length work, in any declaration order. `c.a1` reaches an inherited field, and a structure initializer
  sets inherited fields too: `c : ST_C := (a1 := 1, b1 := 2, c1 := 0.5);`.
- The refusal with the feature off is reported at `EXTENDS`; the STRUCT is still given the base's fields,
  so its uses add no second error.
- IEC 61131-3 Ed. 3 6.4.4.6: two structured variables are assignment-compatible only when they have the same
  type. So neither `a := b` (derived to base) nor `b := a` is accepted: `Cannot assign ST_B to ST_A: a
  structured variable is assignment-compatible only with the same type (ST_B EXTENDS ST_A)`. The same holds
  for an argument bound to a `VAR_INPUT` or `VAR_IN_OUT`, positional or named: `Cannot assign ST_B to
  parameter 'X' of type ST_A: ...`; an argument of any other STRUCT type is refused there when either
  type is a derived STRUCT. Some implementations accept derived-to-base assignment; that is not
  supported here (a possible later feature). Copy fields one by one instead.
- Errors at the base name: `Undefined type 'ST_X' in EXTENDS clause of STRUCT 'ST_B'`; `STRUCT 'ST_B'
  cannot extend 'FB_X', a FUNCTION_BLOCK: the base must be a STRUCT` (also an INTERFACE, FUNCTION,
  PROGRAM, enumeration, alias, ARRAY, subrange or elementary type); `Circular EXTENDS in STRUCT 'ST_A':
  ST_A EXTENDS ST_B EXTENDS ST_A` (reported for each STRUCT of the cycle; a STRUCT extending itself too).
  At a field: `Field 'A1' of STRUCT 'ST_C' is already inherited from 'ST_A'` (names compare
  case-insensitively). At EXTENDS: `EXTENDS on TYPE 'T' needs a STRUCT definition`.
- Limit: the base must be declared in the compiled sources. A STRUCT from a library is refused (`STRUCT
  'ST_B' cannot extend 'ST_LIB', a STRUCT from a library: the base must be declared in the compiled
  sources`), since a library exports its fields' names and types but not their initial values.
- A library built from sources that declare a derived STRUCT exports it with all its fields, as a plain
  STRUCT; its consumers need no feature.
- In C++ the derived STRUCT is a plain struct holding every field, the same as the struct written out in
  full; it does not derive from the base's C++ struct. Initial values, arrays of it, FB and STRUCT members
  of its type and the debug table therefore work as for any STRUCT, and the two types stay unrelated in C++
  too. Inherited fields keep the base declaration's source position, so diagnostics and hover point there;
  the language server's outline lists each STRUCT's own fields.

`union` is in neither the default set nor `iec-3`: IEC 61131-3 Ed. 3 has no UNION (its overlay form is
`STRUCT OVERLAP`, 6.4.4.7, not supported yet). With the feature on, a `TYPE` may be a UNION, whose members
share one storage:

```
TYPE
  U_A : UNION
    f : REAL;
    d : DWORD;
    arr : ARRAY[0..3] OF BYTE;
  END_UNION;
END_TYPE
```

- Code generation lowers a UNION to one storage shared by all members: a zero-initialised byte buffer
  sized and aligned for the largest member's plain value (`REAL` as a 4-byte float, the same size as the
  wrapper a STRUCT field has). Writing one member and reading another reinterprets the bytes in the host
  byte order; the supported targets are little-endian, so `u.f := 1.0` reads back as `u.d = 16#3F800000`
  and `u.arr[0]` is the low byte of `u.d`. A STRUCT member is laid out as its plain C++ struct (natural
  alignment, padding bytes are not written), arrays are contiguous, and a `STRING(n)` / `WSTRING(n)`
  member is a plain NUL-terminated `char[n+1]` / UTF-16 `char16_t[n+1]`: a read stops at the first NUL or
  after `n` characters, so bytes written through another member never give a longer string. `SIZEOF` of
  a UNION is the size of that storage.
- Members are not forceable, and the debug table leaves a UNION out (also inside a STRUCT, an FB or an
  array): the build warns `<path> is not debuggable: UNION U_A: its members share one storage, ...`.
  `ADR(u.f)` is the address of the member's bytes; a member bound to a `VAR_IN_OUT` or `VAR_OUTPUT` of a
  function block, function or method is copied in before the call and written back after it.
- Not supported yet, refused by a compile (and a library build) while `--check` accepts the code:
  `REF()`, `REF_LINK()` or `REF=` of a member (`REF of a UNION member is not supported yet`, `REF= on a
  UNION member is not supported yet`); a `REFERENCE TO` stored in a UNION (`Member 'R' stored in UNION
  'U_R' is a REFERENCE TO: a REFERENCE TO in a UNION is not supported yet`); a member of a library STRUCT
  type; a `RETAIN` or `PERSISTENT` variable that is or holds a UNION (`RETAIN of a UNION is not supported
  yet: 'U' is or holds UNION 'U_A'`). `POINTER TO` and `REF_TO` members are supported.
- A library exports a UNION in its manifest as `kind: "union"` with its members, and a consumer uses it
  like its own.
- Members are reached and type-checked like STRUCT fields (`u.f`, `u.arr[1]`, `w.u.d`), and a UNION may be
  a variable, an FB or STRUCT member, an array element, a `VAR_INPUT` and a `VAR_IN_OUT`.
- `UNION` and `END_UNION` are not keywords. A UNION is recognised only right after the `:` of a `TYPE`,
  when `UNION` is followed by a member (or `END_UNION`) and `END_UNION` comes before the next `END_TYPE`.
  Everywhere else, and in every dialect, they stay ordinary names: a variable `union`, an enumeration
  member `Union`, a STRUCT named `UNION` and its alias `T : Union;` mean what they meant before.
- The refusal with the feature off is reported at `UNION`, once per type; the type is still a UNION, so
  its uses add no second error.
- A UNION is assignment-compatible only with the same UNION (or an alias of it): `Cannot assign U_B to
  U_A`, also from or to a STRUCT or an elementary type. An argument for a UNION `VAR_INPUT` or
  `VAR_IN_OUT` must have the same UNION type, and a UNION is refused for an elementary or STRUCT input:
  `Cannot assign U_B to parameter 'P' of type U_A`.
- Each member must be data: an elementary type (`STRING` and `WSTRING` included), an enumeration,
  subrange or alias, a fixed-size ARRAY, STRUCT or UNION of such members, or any `POINTER TO`, `REF_TO`
  or `REFERENCE TO`. Refused at the member's type: `Member 'FB' of UNION 'U_A' is of FUNCTION_BLOCK type
  'FB_X': a UNION member must be data, not a function block, interface or program instance` (a library
  FB such as `TON` too, and also through an ARRAY or a STRUCT: `... is of type 'ST_H', which holds
  FUNCTION_BLOCK type 'FB_X': ...`); `Member 'V' of UNION 'U_A' is a variable-length ARRAY[*]: the
  members of a UNION share one storage, so each must have a fixed size`.
- Other errors: `Duplicate member 'F' in UNION 'U_A'` (names compare case-insensitively); `UNION 'U_E'
  declares no members: a UNION needs at least one`; at EXTENDS, `UNION 'U_X' cannot use EXTENDS: only a
  STRUCT may extend another type`; and a STRUCT cannot extend a UNION: `STRUCT 'ST_Y' cannot extend
  'U_A', a UNION: the base must be a STRUCT`.
- An initial value that sets a UNION (a variable's, a STRUCT field's, a TYPE default, an FB input's, also
  inside a structure initializer or an array literal) is a structure initializer naming one member,
  `u : U_A := (f := 1.0);`: the storage is zeroed and that member written into it, so the other bytes stay
  zero. More than one member is an error (`The initial value for UNION 'U_A' names 2 members: a UNION
  initial value sets one member`), as are an unknown member (`UNION 'U_A' has no member 'ZZ'`) and any
  other value, such as another UNION variable (`An initial value for UNION 'U_A' is not supported yet:
  name one member, as in (F := value)`). A member's initial value in the UNION declaration itself is not
  supported yet: `Member 'F' of UNION 'U_A' has an initial value: initial values in a UNION are not
  supported yet`.
- The language server outlines a UNION with the detail `UNION` and shows `UNION ... END_UNION` on hover.

`fb_init` is in neither the default set nor `iec-3`. IEC 61131-3 Ed. 3 initialises an instance with `:=`
followed by a parenthesised list that sets its inputs, outputs or public variables (6.6.3.3, Table 41,
Annex A `FB_Decl_Init`): `fb : FB_A := (p := 3);` needs no feature and is unchanged in every dialect. Ed. 3
has no initialisation method. With the feature on, an instance declaration may pass init arguments after
its type, and a METHOD named FB_init on a FUNCTION_BLOCK runs at start-up:

```
FUNCTION_BLOCK FB_A
VAR v : INT; END_VAR
METHOD FB_init : BOOL
VAR_INPUT bInitRetains : BOOL; bInCopyCode : BOOL; p : INT; END_VAR
v := p;
END_METHOD
END_FUNCTION_BLOCK

VAR_GLOBAL g : FB_A(p := 1); END_VAR
PROGRAM Main
VAR f : FB_A(p := 2) := (v := 0); arr : ARRAY[0..2] OF FB_A(p := 3); END_VAR
END_PROGRAM
```

- With the feature off, init arguments are refused at `(` (see Refusals), and every FB_init of a
  FUNCTION_BLOCK gets the warning `FB_init is not run unless the feature fb_init is on` at its name. The
  method is still compiled as an ordinary method; only the warning is new.
- FB_init's inputs are the two BOOL flags `bInitRetains` and `bInCopyCode` plus the VAR_INPUTs it
  declares. A flag it does not declare is declared for it (a BOOL VAR_INPUT before its own); a declared
  flag must be a BOOL VAR_INPUT: `'BINITRETAINS' of FB_init must be a BOOL VAR_INPUT`. Both flags are
  always FALSE: this compiler has no warm start and no online change. FB_init returns BOOL or nothing
  (the value is ignored): `FB_init must return BOOL or nothing, not INT`. It declares no VAR_OUTPUT or
  VAR_IN_OUT: `FB_init cannot declare VAR_OUTPUT: nothing is passed to it or read from it at start-up`.
- Init arguments set FB_init inputs by name, `:=` only, and are type-checked like an assignment (`Cannot
  assign STRING to INT`, at the value). An input no argument sets takes its declared initial value. They
  are evaluated where the instance is declared: constants, globals and, for a member of a FUNCTION_BLOCK,
  the holder's variables and the inputs of the holder's FB_init (any level of its chain). Any other name
  is `Undeclared variable 'Q'`.
- **Passing on the holder's inputs (this compiler's rule).** A member's init argument that names an input
  of its holder's FB_init gets the value the holder was given: the holder's own init argument, or that
  input's declared initial value. So `inner : FB_Inner(itf := itfIn)` in FB_Outer, with
  `outer : FB_Outer(itfIn := impl)`, gives inner's FB_init `impl`, through any number of levels. An
  FB_init input shadows a holder variable or a global of the same name, as it does in the FB_init body.
  The flags cannot be passed on.
- A holder variable, in contrast, still has its initial value when a member's FB_init runs, because the
  holder's FB_init runs after its members. When a member's init argument reads a holder variable that an
  FB_init of the holder's chain assigns directly (`x := ...` in its body; calls are not followed), the
  analysis warns at the read: `INNER's FB_init runs before FB_OUTER.FB_init, so 'ITFSTORED' still has its
  initial value here`. Errors: `'FB_A' has no FB_init input 'X'`, `'FB_Z' has
  no FB_init method to take init arguments`, `'BINITRETAINS' is set by the compiler and cannot be an init
  argument`, `Duplicate init argument 'P'`, `Init arguments must be named: write 'input := value'`,
  `Init argument 'P' must use ':=': init arguments set FB_init inputs`, `Init arguments need a
  FUNCTION_BLOCK instance, but 'I' is of type 'INT'`, and `Init arguments are not allowed in VAR_IN_OUT`
  (or `VAR_EXTERNAL`). An array of instances passes the same arguments to every element. `fb : FB_A(p :=
  1) := (v := 0)` is allowed: the IEC initial values are set first.
- **Start-up order (this compiler's rule).** FB_init runs once per instance, after every variable has its
  initial value and before the first cycle. Global instances run first, in declaration order (sources in
  input order); then each PROGRAM instance's instances, in the order the programs are constructed, which
  for a CONFIGURATION is the order of its PROGRAM declarations. Within an instance, its member instances
  (VAR, VAR_INPUT and VAR_OUTPUT, in declaration order, the bases' members first) run before it, and array
  elements run in index order (row-major). An explicit call `fb.FB_init(...)` in a body is an ordinary
  method call.
- **Inheritance (this compiler's rule).** For an instance of a derived FB, every FB_init of its EXTENDS
  chain runs once, base first, like constructors; a level without its own FB_init is skipped. An init
  argument sets the input of that name in every FB_init of the chain that declares one; it must name an
  input of at least one of them. Because the base's FB_init runs on its own, an FB_init that calls
  `SUPER.FB_init(...)` (or `SUPER^.FB_init(...)`) is refused by compile: `FB_init of the base runs
  automatically; remove the explicit call SUPER.FB_init`.
- Not supported yet (refused by compile only, so `--check` accepts them): an instance whose type has
  FB_init work (an FB_init in it or in a member) when it is local to a FUNCTION or METHOD (`FB_init of
  'L' is not supported yet: it is local to FUNCTION 'F_X'`), in VAR_TEMP (`... it is in VAR_TEMP`), held
  in a STRUCT (`... it is held in STRUCT 'ST_S'`, also for init arguments on a STRUCT field: `... it is a
  field of STRUCT 'ST_S'`), and init arguments on a library FB, whose FB_init is not known (`FB_init of
  'T' is not supported yet: 'TON' comes from a library`). `__NEW` does not run FB_init. A CONFIGURATION
  `VAR_GLOBAL` cannot hold a FUNCTION_BLOCK, as before.
- In the generated C++, the global instances' work is the once-only `__fb_init_globals()`, which every
  PROGRAM constructor calls first; a FUNCTION_BLOCK with member work gets `__fb_init_members(...)`, whose parameters are its chain's
  FB_init inputs, called with the values the instance's FB_init then receives; each level
  of the chain is called non-virtually (`x.FB_B0::FB_INIT(false, false, ...)`). Code without FB_init and
  init arguments generates the same C++ as before.

`trunc_dint` is in neither the default set nor `iec-3`, and refuses nothing: it changes a result type.
IEC 61131-3 Ed. 3 gives `TRUNC` of a REAL a DINT and of an LREAL a LINT, and so does the compiler without
the feature. With it, `TRUNC(x)` returns DINT for every ANY_REAL argument: `d : DINT := TRUNC(lr)` passes
`--strict`, `l : LINT := TRUNC(lr)` still passes as a widening, and `f : INT := TRUNC(lr)` keeps its
narrowing warning, which then names DINT instead of LINT (under `--strict` the error asks for
`DINT_TO_INT` instead of `LINT_TO_INT`). The value is truncated toward zero and saturated at the DINT range
(`TRUNC(LREAL#3.0E10)` is 2147483647), as `TRUNC_DINT` does. A REAL argument is unchanged, and the typed
forms (`TRUNC_LINT`, `LREAL_TRUNC_LINT`) keep their own result types.

`interface_zero` is in neither the default set nor `iec-3`: in IEC 61131-3 Ed. 3 an interface variable is
cleared with `NULL`. With the feature, an untyped integer literal `0` stored in an interface variable is
NULL: in an assignment (`itf := 0`, `fb.itf := 0`), as an initial value (`itf : I_A := 0;`) and as the
argument of an interface input of a FUNCTION, FB or METHOD (`F(0)`, `fb(i := 0)`, `fb.M(x := 0)`); the C++
gets `IEC_NULL`. Without it each of these is refused with the message above, at the `0`. Any other integer
(`itf := 1`, `INT#0`) is refused in every dialect as before (`Cannot assign INT to I_A`). Comparing an
interface with `0` (`itf = 0`, `itf <> 0`) needs no feature and is accepted in every dialect, as before
profiles.

`end_semicolon_optional` is in neither the default set nor `iec-3`, and refuses nothing. It relaxes one
`--strict` check: see [Strict checks a feature relaxes](#strict-checks-a-feature-relaxes).

`program_methods` is not in the default set: a `METHOD` in a `PROGRAM` is refused with no dialect flag too
(before profiles it did not parse at all). `--strict` does not change any feature. A refused method is still
registered and checked, so a call to it adds no second error. Program methods go before the body, interleaved with the VAR blocks
as in a FUNCTION_BLOCK; ABSTRACT and OVERRIDE are refused on them (a PROGRAM has no inheritance), and a
PROGRAM takes no PROPERTY. Without the feature a program's actions may be called only inside their program
(its body and its methods): `MAIN.Name()`, or `p.Name()` through a variable `p : MAIN`, from any other POU
is refused with `the methods and actions of PROGRAM MAIN can be called only inside MAIN`. In the generated C++ each program
method is a plain (non-virtual) member function of `Program_<NAME>`, declared after `run()`, so the class's
vtable is the same as without methods. It sees the program's VARs and reaches its `VAR_EXTERNAL`s exactly as
`run()` does; `Name()` and `MAIN.Name()` inside MAIN both call it on the same instance.

`ACTION` blocks need no feature, in a `PROGRAM` or a `FUNCTION_BLOCK`, under every dialect: an action is
lowered to a parameterless method of its owner that is exempt from `program_methods`, and the same
inside-the-program rule applies to a program's actions.

### A program reached by name

A PROGRAM has one instance. With `program_methods` its name reaches that instance from any other POU
(PROGRAM, FUNCTION_BLOCK and its methods and properties, FUNCTION). IEC 61131-3 Ed. 3 has no such access
(6.5.2.2, 6.6.4; outside a program only access paths, 6.8, reach its variables), so without the feature each
form stays refused:

| Form                    | With `program_methods`                                                  | Without (message)                                                                  |
| ----------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `PRG_A.M(...)`          | calls method or action `M`; a PRIVATE or PROTECTED one is refused        | `the methods and actions of PROGRAM PRG_A can be called only inside PRG_A`          |
| `PRG_A.x`               | reads `x`; writes it when `x` is a VAR_INPUT or a VAR                    | `Cannot access members of program 'PRG_A' directly — declare a variable ...`       |
| `PRG_A(inp := 1, q => v)` | runs the body (as a statement): `:=` sets a VAR_INPUT, `=>` reads a VAR_OUTPUT, positional arguments fill the VAR_INPUTs in order | `a call of PROGRAM PRG_A from another POU needs the feature program_methods` |

The variable rule: a VAR_INPUT is read and written (Ed. 3 6.6.3.4 lets an input be set apart from the call),
a VAR_OUTPUT is only read (6.6.3.4: outputs are read, not modified, from outside), a plain VAR is read and
written (unlike a function block instance, whose VAR is internal unless its section is `VAR PUBLIC`), a CONSTANT is only
read; VAR_TEMP, VAR_IN_OUT and VAR_EXTERNAL are not reachable. A write is an assignment, a `REF=` target or a
`=>` capture. Other errors: `PROGRAM PRG_A has no variable 'X'`, `PROGRAM PRG_A has no method or action 'M'`,
`VAR_OUTPUT 'Q' of PROGRAM PRG_A is read-only outside PRG_A`, `PROGRAM PRG_A has no result: call it as a
statement`. A local variable named `PRG_A` shadows the program. A program calling its own body
(`PRG_A();` inside PRG_A) is refused under every dialect: `PROGRAM PRG_A cannot call itself` (it used to
pass `--check` and fail in g++).

Inside PRG_A itself (its body, methods and actions) `PRG_A.x` is the program's own member `x`, also in a
method that declares a local `x`: the plain `x` there is the local, `PRG_A.x` the member. A name the
program does not declare is `PROGRAM PRG_A has no variable 'ZZ'`.

Because the program has one instance, once it is reached by name a variable of its type
(`VAR p : PRG_A; END_VAR`) and a second CONFIGURATION instance of it are refused:
`PROGRAM PRG_A has one instance, reached by name from other POUs; ...`. A program nobody reaches keeps
both, and its generated C++ is unchanged.

In the C++, a reached program gets one header object, `inline Program_PRG_A __program_PRG_A;` (its
VAR_EXTERNAL globals as arguments), after its class. Being an inline header object, it is initialised before
any later static of every translation unit that includes the header, and its address is a constant. The
configuration holds it by reference (`Program_PRG_A& PA;`), so the task runs the same instance; the debug
table addresses `__program_PRG_A`, the REPL harness binds `prog_PRG_A` to it, and a test's variable of the
type binds to it (so its state carries from one test to the next, as globals do). Its constructor still runs
`__fb_init_globals()` first. A program run by a task and also called by name is the same instance, so its
body runs once more per cycle for each call: that is what the call asks for. Calls from a POU of another task
are not synchronised with the task that runs the program.

Pragmas `{...}` (IEC 61131-3 Ed. 3, 6.2) are not a feature: every profile, `iec-3` included, accepts them
wherever whitespace may appear and skips them with a `Pragma ignored: {...}` warning at the pragma's line
and column (listed by `--check --json`, exit 0). Their contents are not interpreted, apart from
`{external ...}` and, under `conditional_pragmas`, the conditional ones. Without that feature
conditional-compilation pragmas (`{IF ...}`, `{ELSIF ...}`, `{ELSE}`, `{END_IF}`, `{define ...}`,
`{undefine ...}`, any case) are an error, `Conditional compilation pragmas are not supported: {...}; they
need the feature conditional_pragmas`, because skipping them would compile every branch. `compile()`,
`analyze()`, the CLI, the language server, `parse()` and `parseTestFile()` all give that text (`parse()`
and `parseTestFile()` without options under the default dialect); only the raw lexer entry points
`tokenize()` and `tokenizeTest()` report the bare `Conditional compilation pragmas are not supported: {...}`.
A pragma ends at the first `}`; an unclosed `{` is the error `Unterminated pragma: '{' has no closing '}'`.

## Conditional pragmas

Conditional compilation is a CODESYS / vendor-toolchain extension; IEC 61131-3 has no conditional
compilation. `conditional_pragmas` is in neither the default set nor `iec-3`: a vendor profile lists it,
or `--feature +conditional_pragmas` turns it on. `--strict` changes no feature, so `--strict` alone refuses
these pragmas and `--strict` with a profile that lists the feature accepts them.

```
PROGRAM Main
VAR
{IF defined(SIM)}
  x : INT := 1;
{ELSIF hasvalue(MODE, 'fast')}
  x : INT := 2;
{ELSE}
  x : INT := 3;
{END_IF}
END_VAR
...
END_PROGRAM
```

```bash
strucpp main.st -o main.cpp --dialect-file vendor.json -D SIM
strucpp main.st -o main.cpp --feature +conditional_pragmas -D MODE=fast
```

- **Directives.** `{IF <cond>}`, `{ELSIF <cond>}`, `{ELSE}` and `{END_IF}`, any case, nestable, anywhere
  whitespace may appear: in declaration sections, in bodies, between POUs. The first branch whose condition
  holds is compiled; the others are not. A directive inside a comment, a string or `{external ...}` is not
  a directive.
- **Conditions.** `or := and (OR and)*`, `and := not (AND not)*`, `not := NOT not | primary`,
  `primary := '(' or ')' | call`. Keywords and operator names are case-insensitive.

  | Operator | True when |
  | --- | --- |
  | `defined(NAME)` | `NAME` is defined |
  | `project_defined(NAME)` | the same as `defined(NAME)` here (an inference, see below) |
  | `hasvalue(NAME, 'text')` | `NAME` is defined and its value is exactly `text`; a bare `-D NAME` has the value `''` |

- **Defines.** `-D NAME` (or `-DNAME`, `--define NAME`) defines `NAME` with the value `''`; `-D NAME=VALUE`
  defines it with the value `VALUE`, and an integer `VALUE` is also a global constant, as before. A name must
  be an identifier. Through the library API the defines are `pragmaDefines`, a name → string map, kept
  separate from `globalConstants`: a library's or the caller's global constants never make a name
  `defined()`.
- **Refused operators.** `defined(variable:x)`, `defined(type:T)`, `defined(pou:P)`, `hasattribute`,
  `hastype`, `hasconstantvalue` and `hasconstanttype` are errors, `Conditional pragma operator '<op>' is not
  supported`, at the operator. Their answer depends on the symbols a compile sees, which differ between the
  CLI, the language server and the library compiler. Any other name is `unknown operator '<x>' in a
  conditional pragma`; a syntax error is `Malformed conditional pragma expression: expected ...` at the
  offending character.
- **Not supported.** `{define ...}` and `{undefine ...}` are errors, `{define} is not supported; pass
  defines with -D`.
- **Structure errors**, each at its directive: `{END_IF} without a matching {IF}`, `{ELSIF} without a
  matching {IF}`, `{ELSE} without a matching {IF}`, `{ELSIF} after {ELSE}`, `second {ELSE} in one {IF}`,
  and `{IF} has no matching {END_IF}` at the `{IF}` (the block is then closed at the end of the file).
- **Every condition is checked**, inactive branches included, so the errors do not depend on the defines.
  Conditions are only evaluated to choose a branch.
- **Line-preserving.** Every directive and every inactive branch is replaced by spaces, line breaks kept
  (`\r\n`, `\n` and `\r`), before anything else reads the file (IL included). The pass itself moves no
  line or column, so diagnostics, `#line` directives and debug positions keep the ones they would have
  without it. That is the original position everywhere except in and after IL bodies, whose transpilation
  does not yet keep lines (a known limit, with or without pragmas). In `--check --json` a body's
  `bodyLine` counts from its leading directive and inactive lines, so it is the same whatever the defines.
- **Strings across lines.** A string literal holding a raw line break that starts with a directive (an
  unbalanced quote in an inactive branch, typically) is the error `Conditional pragma directive inside a
  string literal that spans lines` at that directive, instead of silently swallowing it.
- **Inactive code is not checked.** It is not lexed, parsed or analysed, so it may hold code that does not
  compile; its `{attribute ...}` pragmas give no warning and its `{external ...}` blocks are dropped.
- **Limits.** A pragma ends at the first `}`, so a `hasvalue` text cannot contain `}`; strings take no
  escapes.
- **Test files.** `parseTestFile(source, fileName, options)` takes the dialect fields and `pragmaDefines`
  (a bad map throws a `TypeError`, as in `compile()`); without `options` it uses the default dialect and so
  refuses conditional pragmas. `--test` passes the dialect flags and `-D`.
- **Libraries.** `compileStlib` takes `pragmaDefines`. When the dialect has `conditional_pragmas`, the
  archive records `pragmaDefines` (empty when no define was given); otherwise it has no such key. A reader of
  the archive's sources resolves them the same way: `--decompile-lib` prints the recorded defines as `-D`
  flags, and the language server analyses and searches a library's sources with the feature on and the
  archive's own defines, not the workspace's. `resolveConditionalPragmas(source, pragmaDefines)` is exported
  for other tools that show such sources.
- **Not verified against the vendor toolchains** (inferences): define names compare case-insensitively;
  `project_defined` is treated as `defined`; `hasvalue` compares the text exactly, with single quotes.

## Strict checks a feature relaxes

`--strict` and the dialect are separate: `--strict` adds checks, and by itself a feature never removes
one. These features are the exceptions. Each relaxes exactly one `--strict` check when it is on, and
changes nothing without `--strict`:

| Feature                  | `--strict` check it relaxes                                                   |
| ------------------------ | ----------------------------------------------------------------------------- |
| `end_semicolon_optional` | `Missing ';' after END_IF` (also END_CASE, END_FOR, END_WHILE and END_REPEAT) |

Without `--strict` the `;` is optional in every dialect, `iec-3` included, as it was before profiles. With
`--strict`, alone or with `--dialect iec-3`, a missing `;` is an error at the END keyword. A profile that
lists `end_semicolon_optional`, or `--feature end_semicolon_optional`, accepts it under `--strict` too; the
generated C++ is the same as with the `;` written.

## Checks

Profiles are input, not trusted code. Every profile read (each `--dialect-file`, and every `*.json` in each
`--dialect-path` folder) is checked when the compiler starts, whether or not it is selected. Each problem
is one line on stderr, `error: <message>`, and exit code 1:

- `dialect file <path>: <JSON parse message>`
- `dialect file <path>: id '<x>' does not match the file name` (`--dialect-path` only)
- `dialect file <path>: semantics key '<k>' is not known`
- `unknown feature '<id>' in <where> (known: <every feature in the table above>)`
- `unknown dialect '<id>' (known: iec-3, ...)`
- `dialect '<id>': extends '<p>', which is not loaded`
- either of the two above for the id `iec` ends with `; the IEC 61131-3 Ed. 3 profile is 'iec-3'`
- `<where>: the id 'iec' is reserved; the IEC 61131-3 Ed. 3 profile is 'iec-3'`
- `dialect '<id>': extends cycle <a> -> <b> -> <a>`

Unknown top-level keys and wrongly typed values are refused the same way.

## Library API

`compile()` and `compileStlib()` take `dialect` (an id or a profile object), `dialectFiles`, `dialectPath`,
`features`, `dialectIO` and `pragmaDefines` (a name → string map for conditional pragmas; a key that is not
an identifier or a value that is not a string throws a `TypeError`; `validatePragmaDefines()` and
`isPragmaDefineName()` are exported with that one rule). `compile()` and `analyze()` also take `globalListName` (and the same key on each
`additionalSources` entry) for `named_global_lists`; a name that is not an identifier throws a `TypeError`. The core never reads files: pass `nodeDialectIO` from `strucpp/node` (or your
own `{readFile, listDir}`) with `dialectFiles` or `dialectPath`. A bad profile is a compile error
(line 0). `resolveDialect()` and `profilesWithFeature()` are exported for callers that resolve themselves.

## Language server

The Node language server (`vscode-extension/server`) reads three keys of the `strucpp` workspace
configuration, at start-up and on `workspace/didChangeConfiguration`:

- `dialect`: a profile object, or `null`/absent for the compiler's default;
- `features`: an array of `+id`, `-id` or `id` overrides, or `null`/absent;
- `pragmaDefines`: a name → string map for conditional pragmas (like `-D`), or `null`/absent.

The server reads no profile files. A library's own sources (`strucpp-lib:` documents) are the exception
to `pragmaDefines`: they use the defines recorded in the archive ([above](#conditional-pragmas)).
Diagnostics of open, workspace and library documents and the
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
