# IEC 61131-3 Compliance

STruC++ implements the Structured Text (ST) language from IEC 61131-3. This document lists supported features and known gaps. The compiler also supports common CODESYS extensions where noted.

## Data Types

| Type | Status | Notes |
|------|--------|-------|
| BOOL | Supported | |
| BYTE, WORD, DWORD, LWORD | Supported | |
| SINT, INT, DINT, LINT | Supported | |
| USINT, UINT, UDINT, ULINT | Supported | |
| REAL, LREAL | Supported | |
| TIME | Supported | Nanosecond precision, int64_t storage |
| DATE | Supported | |
| TIME_OF_DAY | Supported | |
| DATE_AND_TIME | Supported | |
| LTIME, LDATE, LTOD, LDT | Supported | 64-bit time types with nanosecond precision |
| STRING | Supported | Parameterized length: STRING(N), default 254 |
| WSTRING | Supported | Parameterized length: WSTRING(N) |
| CHAR, WCHAR | Supported | |

### Derived Types

| Type | Status | Notes |
|------|--------|-------|
| TYPE ... END_TYPE | Supported | Type aliases. An alias of a STRUCT or UNION (`TYPE T_A : ST_A;`, also chained) names the same type: assignment both ways, VAR_INPUT and VAR_IN_OUT arguments and initialisers accept it in every dialect; a derived STRUCT (EXTENDS) stays a different type |
| STRUCT ... END_STRUCT | Supported | With nested structs. A field may be a function block instance (a user FB or a library FB such as `TON`), directly, as an `ARRAY OF` one, or through another STRUCT, in any declaration order. Call it with or without arguments (`s.tmr(IN := x)`, `s.tmr();`). A STRUCT inheriting another's fields (`TYPE ST_B EXTENDS ST_A : STRUCT`) is an extension (IEC 61131-3 `Struct_Type_Decl` takes no EXTENDS): the feature `struct_extends` (refused with no dialect flag and under `--dialect iec-3`). The derived STRUCT holds the base fields, then its own; per 6.4.4.6 it is not assignment-compatible with its base in either direction, see [DIALECTS.md](DIALECTS.md) |
| Enumerations | Supported | With optional base type before the value list, `DINT (A, B)`. The base written after the list, `(A, B) DINT`, is a vendor ordering: the feature `postfix_enum_base` (refused with no dialect flag and under `--dialect iec-3`), same meaning and C++ as the base-first form. A type default (`(A, B) := B` or `:= E#B`) must be one of the type's own values |
| Initialized type declarations | Supported | A type may carry its own default (`Setpoint : REAL := 25.0;`, `Origin : Point := (x := 0.0);`), inherited by every declaration of the type that has no initializer |
| ARRAY (1D) | Supported | Arbitrary bounds: ARRAY[1..10] OF INT |
| ARRAY (2D) | Supported | ARRAY[1..3, 1..4] OF REAL |
| ARRAY (3D) | Supported | ARRAY[1..3, 1..4, 1..5] OF INT |
| ARRAY OF function block | Supported | Declaration, member access, and element invocation (`units[i](step := 1.0)`). A named TYPE of one (`BeltPair : ARRAY[0..1] OF FB_Belt`) may be a member, a STRUCT field, a global, or a method or interface method parameter. A method call on an element (`units[0].M()`) works like any method call through a member chain (see Method call) |
| ARRAY[*] (VLA) | Supported | Variable-length array parameters |
| Subranges | Supported | Runtime validation |
| REF_TO | Supported | IEC reference type (explicit dereference). `REF(x)` and `r REF= x` of an elementary, STRING, WSTRING, enumeration, STRUCT, ARRAY or function block variable or STRUCT field; `r^.field`, `r^.M()`. `REF()`, `ADR()` and `REF=` of a CONFIGURATION global refer to its storage, outside its lock: the compiler warns that under `STRUCPP_THREADED` accesses through the result are not serialized with other tasks. Not yet: `REF()` of an element of an ARRAY OF an enumeration, and `REF_TO STRING(n)` / `WSTRING(n)` of a length other than the default |
| REFERENCE_TO | Supported | Vendor reference type (implicit dereference); a vendor spelling: the feature `reference_to`, refused under `--dialect iec-3`. A `REFERENCE TO` VAR_INPUT of a function block, function or method is bound to its argument at the call (named or positional), so reads and writes through it reach the argument; an FB input keeps its binding until the next call that passes it. The argument must be a variable (a local, global, member, array element, STRUCT field, `p^` or another `REFERENCE TO`) of the referenced type or an alias of it: an expression, a constant, another type or a subrange variable is an error. A `REFERENCE TO` a STRUCT or function block reaches its members and methods (`rf.a`, `rr.M()`). Reading or writing an unbound `REFERENCE TO` raises the null-reference fault, as a NULL REF_TO dereference does. Not supported yet at compile: binding a `REFERENCE TO` (input or `REF=`) to a variable of an alias type |
| POINTER TO | Supported | Vendor pointer type with dereference via ^; a vendor spelling: the feature `pointer_to`, refused under `--dialect iec-3` |

### Partially Implemented

| Type | Notes |
|------|-------|
| UNION | An extension (IEC 61131-3 Ed. 3 has no UNION; its overlay form is `STRUCT OVERLAP`, 6.4.4.7, not supported): the feature `union` (refused with no dialect flag and under `--dialect iec-3`). Parsed, analysed and compiled to C++ as one shared storage (host byte order, little-endian assumed). Members must be data and take no initial value in the declaration; an initial value of a UNION names one member, `(f := 1.0)`, written into zeroed storage; a UNION is assignment-compatible only with itself. Not supported yet at compile: REF/REF= of a member, a REFERENCE TO stored in a UNION, a library STRUCT member, RETAIN; members cannot be forced and the debug table leaves a UNION out, see [DIALECTS.md](DIALECTS.md) |

## Program Organization Units

| POU | Status | Notes |
|-----|--------|-------|
| PROGRAM | Supported | With CONFIGURATION/RESOURCE/TASK structure |
| FUNCTION | Supported | With return type, all parameter modes |
| FUNCTION_BLOCK | Supported | Instantiation, invocation, member access. A named argument of an invocation (`fb(a := 1)`, `inst.fb(a := 1)`, `a.b.fb(a := 1)`) that names no variable, method, property or action of a function block declared in the compile is an error; one naming a VAR local binds it. Under `--strict` only inputs, outputs and in/outs may be named |
| INTERFACE | Supported | Method prototypes. PROPERTY prototypes (explicit `GET END_GET` / `SET END_SET`) are not in Ed. 3, where an interface holds method prototypes only: a vendor extension, the feature `property` (refused with no dialect flag and under `--dialect iec-3`; see [DIALECTS.md](DIALECTS.md)) |
| ACTION | Supported | ACTION blocks of PROGRAMs and FUNCTION_BLOCKs, called as Name() inside the owner and inst.Name() on an instance; no SFC action qualifiers. Extensions: calling an action directly from ST, and the top-level `ACTION Owner.Name` form; IEC declares actions inside the POU and controls them from SFC steps. Both forms parse (`ACTION Name[:]` after the body, `ACTION Owner.Name[:]` at top level; `ACTION` is contextual, `END_ACTION` reserved); each action is lowered to a parameterless PUBLIC method of its owner, needs no dialect feature, cannot override or be overridden, and never implements an INTERFACE method. A program's actions can be called only inside the program, or by its name from any POU with the feature `program_methods` |

## Variable Declarations

| Feature | Status | Notes |
|---------|--------|-------|
| VAR | Supported | Local variables |
| VAR_INPUT | Supported | Input parameters |
| VAR_OUTPUT | Supported | Output parameters |
| VAR_IN_OUT | Supported | Passed by reference (6.6.1.4, 6.6.3.4.2): the parameter refers to the caller's variable, so the callee reads and writes that variable itself and sees any other write to it during the call (through VAR_EXTERNAL, or a second in-out bound to the same variable). A FUNCTION or METHOD takes it as a C++ reference. A FUNCTION_BLOCK holds it as `IEC_INOUT<T>`, bound by each call that assigns it (named or positional; inherited in-outs included) and kept until the next one; an ARRAY[*] in-out is a view of the caller's array, an interface in-out refers to the caller's instance. A binding whose target lives only for the call (a FUNCTION or METHOD parameter or local, a VAR_TEMP, or another in-out passed on) is released after the call. Reaching an in-out that no call has bound, or that was released, raises the null-reference fault. Reading `inst.x` from outside reads through the binding. A CONFIGURATION global bound to an in-out is referred to directly (`g->value`), outside its lock: the compiler warns that under `STRUCPP_THREADED` accesses through the in-out are not serialized with other tasks. The argument must be a variable: a literal, an expression, a bit (`w.3`), an enumeration value or a constant is an error. Without a dialect and under a vendor profile, these forms are warnings, and errors under `--dialect iec-3`: an argument of another type (an alias of an elementary type, another length of STRING, another elementary type; passed by copy-in/copy-out; an alias of a STRUCT or UNION is the same type and binds by reference), an omitted in-out (an FB call keeps the previous binding; a FUNCTION or METHOD gets a temporary), a write to `inst.x` from outside the block (it goes to the variable the last call bound), and a caller's VAR_INPUT as the argument. A UNION member is passed by copy-in/copy-out. A VAR_OUTPUT bound to a composite CONFIGURATION global is written back under its lock after the call. The debug table lists no leaf for an FB's in-out. A library FB from an archive built before in-outs were bound by reference is called with copy-in/copy-out and a warning to rebuild the library |
| VAR_EXTERNAL | Supported | References either a CONFIGURATION or a file-level VAR_GLOBAL |
| VAR_GLOBAL | Supported | Global variables (CONFIGURATION-scoped or file-level). A file-level VAR_GLOBAL may hold a function block instance (or a STRUCT or ARRAY holding one). A CONFIGURATION VAR_GLOBAL may not: it is refused at its declaration (`VAR_GLOBAL <name> in a CONFIGURATION cannot hold a FUNCTION_BLOCK (<type>)`), since its storage is a shared, lock-guarded global. Access qualified by a file's global variable list name (`GVL_A.x`) is a vendor extension: the feature `named_global_lists` (refused with no dialect flag and under `--dialect iec-3`), see [DIALECTS.md](DIALECTS.md) |
| CONSTANT | Supported | Compile-time constants |
| RETAIN | Supported | Allowed on `VAR`, `VAR_INPUT`, `VAR_OUTPUT` and `VAR_GLOBAL`, per IEC 61131-3. Rejected on `VAR_IN_OUT` / `VAR_TEMP` / `VAR_EXTERNAL`, and inside a `FUNCTION` or `METHOD` (no instance, nothing to retain) |
| PERSISTENT | Partial | Accepted and treated as `RETAIN`. CODESYS also keeps a PERSISTENT value across a program download; that is not implemented, so the weaker shared guarantee is what is claimed |
| NON_RETAIN | Supported | Accepted and treated as the default (a plain `VAR` is already non-retained). Rejected when combined with `RETAIN` or `CONSTANT` |
| AT %IX0.0 | Supported | Located variables (I/Q/M areas, X/B/W/D/L sizes) |
| Multiple names | Supported | `a, b, c : INT := 0;` |
| Initialization | Supported | `:= expression` |
| Array initialization | Supported | `:= [1, 2, 3]` and the bracket-less `:= 1, 2, 3`. Multi-dimensional arrays take either a flat row-major list or a nested one (`:= [[1, 2], [3, 4]]`), where each inner list fills one row from its own bound. Nesting depth and value count are validated against the declared dimensions |
| Array repetition | Supported | `:= [10(0)]`, `:= [3(1), 2(5)]`, `:= [7, 4(2), 9]`. The repeated value may be a structure initializer. Max count 65536 |
| Structure initialization | Supported | `:= (x := 1.0, y := 2.0)`; nested, in array literals, and for FB instances (IEC 6.6.3.3, needs no feature; init arguments after the type, `fb : FB_A(p := 1)`, are the feature `fb_init`). Omitted elements keep their own declared default. Only valid as a declaration's initial value, as in the standard — one written inside a statement is rejected |
| STRUCT element defaults | Supported | Scalar, array-literal and structure-initializer defaults on a STRUCT element all carry their values |

### Initialization gaps

| Form | Notes |
|------|-------|
| Repetition with no value | `:= [10()]` (ten copies of the element default) — write `:= [10(0)]`, or omit the elements entirely. Matches matiec and CODESYS, which also require a value |

## Operators and Expressions

| Category | Operators | Status |
|----------|-----------|--------|
| Arithmetic | `+`, `-`, `*`, `/`, `MOD`, `**` | Supported |
| Comparison | `=`, `<>`, `<`, `>`, `<=`, `>=` | Supported. `=` and `<>` on two STRUCT values compare field by field (a nested STRUCT field by field, an ARRAY member element by element); IEC 61131-3 Ed. 3 types the comparison functions on elementary values only, so this is not Ed. 3. It is accepted in every dialect, `--dialect iec-3` included, as it was before it compiled; whether iec-3 should refuse it is left to the iec-3 audit, see [DIALECTS.md](DIALECTS.md) |
| Logical | `AND`, `OR`, `XOR`, `NOT` | Supported |
| Bitwise | `AND`, `OR`, `XOR`, `NOT` (on bit types) | Supported |
| Bit shift | `SHL`, `SHR`, `ROL`, `ROR` | Supported |
| Assignment | `:=` | Supported |
| Reference assign | `REF=` | Supported; a vendor spelling: the feature `ref_assign`, refused under `--dialect iec-3` |
| Dereference | `^`, `DREF()` | Supported |
| Reference | `REF()` | Supported |
| Parentheses | `( )` | Supported |
| Operator precedence | Highest to lowest: `( )`, function call, unary `-` `+` `NOT`, `**`, `*` `/` `MOD`, `+` `-`, `<` `>` `<=` `>=`, `=` `<>`, `AND` `&`, `XOR`, `OR` | Supported. The comparison levels follow the Annex A grammar: `<`, `>`, `<=`, `>=` bind tighter than `=` and `<>`, and both levels repeat left-associatively, so chained comparisons parse in every dialect: `a < b < c` is `(a < b) < c`, `a = b = c` is `(a = b) = c`, `a = b < c` is `a = (b < c)`. Table 71 puts all six comparison operators on one level, which would read `a = b < c` as `(a = b) < c`; the two disagree and Annex A is followed. A comparison yields BOOL, and a chain compares that BOOL with the next operand under the usual comparison rules |
| Function call | `name(args)` | Supported (positional + named) |
| Method call | `obj.method(args)` | Supported. Named arguments (`obj.m(b := 2, a := 1)`, `out => v`) bind by name, in any order, to VAR_INPUT, VAR_IN_OUT and VAR_OUTPUT in declaration order; a missing input takes its default. Also for `THIS.m`, `SUPER.m`, a bare `m(...)` and a program method. Through a member chain in every dialect: `a.b.m()`, `a.b.c.m()`, an FB held in a STRUCT field (`s.fb.m()`) or an ARRAY element (`arr[i].m()`, `a.arr[i].fb.m()`), `THIS.f.m()` and `SUPER.f.m()`, as an expression or a statement. The method is resolved on the chain's final type, base FBs included; a chain ending at a non-FB value, an unknown method, an unknown named argument or too many arguments is an error, and a PRIVATE or PROTECTED method is callable through a chain only inside its declaring FB. A FB held in a STRUCT field is not named by the standard's invocation production; it is accepted because an FB instance in a struct is still an FB instance. A global-list prefix (`GVL_A.fb.m()`) needs the feature `named_global_lists`. Through a dereference (`p^.m()`, `q^.m()`) and a REFERENCE TO (`rr.m()`), the method of the object referred to is called; so is the body (`pf^(v := 4)`, `rr(v := 2)`). An FB instance held in a member is invoked through the chain at any depth, with or without arguments (`inst.fb(k := 1)`, `a.b.fb()`, `a.s.arr[i].fb(k := 1)`, `THIS.b.fb()`) |
| Array access | `arr[i]`, `arr[i, j]` | Supported — the index count is validated against the declared rank |
| Field access | `struct.field` | Supported |
| Typed literals | `INT#5`, `DINT#42`, `REAL#3.14`, `INT#-123`, `T#-14ms` | Supported. A sign after the prefix (Table 5 feature 9, Table 8) is taken by a decimal integer or real payload and by a duration, in every dialect; a signed integer outside its prefix type (`SINT#-129`, `USINT#-1`) is an error, and each type's minimum (`LINT#-9223372036854775808`) lowers without overflow. A typed literal is also a CASE label. Not yet: an unsigned payload outside its type (`SINT#200`) is not range-checked, and `LT#`/`LTIME#` literals |
| Integer literals | `9223372036854775807`, `16#FF`, `1_000` | Supported — the full 64-bit LINT/ULINT range is preserved exactly; a value wider than ULINT is rejected |
| NEW | `__NEW(type)`, `__NEW(type, size)` | Supported |
| DELETE | `__DELETE(ptr)` | Supported |

## Control Structures

| Structure | Status | Notes |
|-----------|--------|-------|
| IF / ELSIF / ELSE / END_IF | Supported | |
| FOR / TO / BY / DO / END_FOR | Supported | With optional BY (step) |
| WHILE / DO / END_WHILE | Supported | |
| REPEAT / UNTIL / END_REPEAT | Supported | |
| CASE / OF / END_CASE | Supported | Integer, bit, and enum selectors |
| EXIT | Supported | Break from loop |
| CONTINUE | Supported | Next loop iteration; contextual, so `Continue` stays usable as a name |
| RETURN | Supported | Early return from POU |

## OOP Extensions

| Feature | Status | Notes |
|---------|--------|-------|
| Methods | Supported | On FUNCTION_BLOCK, with return types. On a PROGRAM: a vendor extension, the feature `program_methods` (refused with no dialect flag and under `--dialect iec-3`); parsed and checked, callable inside the program; with the feature, a program's methods, actions, variables and body are reached by its name from any POU, the program itself included (`PRG_A.x` inside PRG_A is its own `x`) (an extension: Ed. 3 6.6.4 gives programs no such access), on its one shared instance; generated as non-virtual members of the program class |
| Properties (GET/SET) | Supported | Virtual getter/setter methods in C++. Not in Ed. 3; a FUNCTION_BLOCK PROPERTY is accepted in every dialect. `GET` and `SET` are keywords only as a PROPERTY's accessors, in every dialect; elsewhere they are names (a METHOD, variable, ACTION, POU, enumeration member or field called `Get` or `Set`). In an INTERFACE: the feature `property`, with the IMPLEMENTS contract checked and access through an interface variable dispatched to the instance |
| Inheritance (EXTENDS) | Supported | Single inheritance |
| Interfaces (IMPLEMENTS) | Supported | Multiple interfaces, generates C++ abstract classes. An interface may EXTEND several interfaces; an interface reached through two inheritance paths (a shared base) is a virtual C++ base, so the instance holds it once |
| Interface-typed variables | Supported | In every dialect. A variable of interface type (local, FB member, VAR_INPUT, VAR_OUTPUT, VAR_GLOBAL; FB, method and FUNCTION) refers to an instance of an implementing FB and starts as NULL; in C++ it is a non-owning nullable reference (`IEC_ITF<I>`). It takes an instance of an FB that implements the interface (directly, through an extending interface or through a base FB), bare `THIS`, another interface variable of the same or an extending interface, or NULL (also as an input argument: `fb(c := inst)`, `F(inst)`); anything else is an error at the value, e.g. `Cannot assign FB_X to I_A: FB_X does not implement I_A`. `=` and `<>` compare the referenced instance, also with NULL; comparing with `0` (`itf = 0`, `itf <> 0`) is accepted in every dialect and means NULL. Storing `0` (`itf := 0`, `itf : I_A := 0`, `F(0)`) is a vendor extension, the feature `interface_zero` (refused with no dialect flag and under `--dialect iec-3`; see [DIALECTS.md](DIALECTS.md)); any other integer is an error in every dialect. `itf.M()` (also through a member chain, `a.itf.M()`) dispatches to the instance's method; a call through NULL raises the null-reference fault, as a NULL REF_TO dereference does. The only initializer is NULL (or `0` with `interface_zero`). A VAR_IN_OUT of interface type binds the instance itself (no copy-back). Properties through an interface variable: see Properties. Not yet: ARRAY OF an interface, a STRUCT field of interface type |
| ABSTRACT | Supported | Abstract FB (no instantiation) and abstract methods (pure virtual) |
| FINAL | Supported | Sealed FB and methods |
| OVERRIDE | Supported | Method override with C++ override specifier |
| PUBLIC/PRIVATE/PROTECTED | Supported | Access modifiers |
| THIS | Supported | Self-reference in methods: `THIS.member`, `THIS.m()`, and `THIS.r REF= x` (the feature `ref_assign`). `THIS^.member` and `THIS^.m()` are a vendor extension, the feature `self_caret` (refused with no dialect flag and under `--dialect iec-3`). Bare `THIS^` (the own instance) is a vendor form that is still accepted in every dialect. Bare `THIS` refers to the own instance, e.g. passed into an interface-typed input |
| FB_init | Supported | An extension (IEC 61131-3 Ed. 3 has no initialisation method): the feature `fb_init` (refused with no dialect flag and under `--dialect iec-3`). A METHOD FB_init runs once per instance at start-up, global instances first, members before their holder, every FB_init of an EXTENDS chain base first, with the flags `bInitRetains` and `bInCopyCode` FALSE; init arguments `fb : FB_A(p := 1)` set its inputs. With the feature off, a declared FB_init gets a warning that it is not run. Not yet: instances local to a FUNCTION or METHOD, in VAR_TEMP or held in a STRUCT, and init arguments on a library FB (refused by compile). See [DIALECTS.md](DIALECTS.md) |
| SUPER | Supported | `SUPER.m()` and `SUPER.member` reach the base FB's method or member, through any number of EXTENDS levels, in every dialect. The caret forms `SUPER^.m()`, `SUPER^.member` and `SUPER^()` are vendor forms that are still accepted in every dialect |

## Standard Functions

All IEC 61131-3 standard functions are implemented in the C++ runtime:

| Category | Functions |
|----------|-----------|
| Numeric | ABS, SQRT, LN, LOG, EXP, EXPT |
| Trigonometric | SIN, COS, TAN, ASIN, ACOS, ATAN, ATAN2 |
| Selection | SEL, MIN, MAX, LIMIT, MUX |
| Comparison | GT, GE, EQ, LE, LT, NE |
| Bitwise | AND, OR, XOR, NOT, MOVE |
| Bit Shift | SHL, SHR, ROL, ROR |
| Type Conversion | *_TO_* (INT_TO_REAL, DINT_TO_STRING, etc.); TRUNC, TRUNC_* and *_TRUNC_* (TRUNC_INT, REAL_TRUNC_DINT, etc.) |
| String | LEN, LEFT, RIGHT, MID, CONCAT, FIND, REPLACE, INSERT, DELETE, UPPER, LOWER, TRIM. LEN, LEFT, RIGHT, MID, CONCAT, FIND, REPLACE, INSERT and DELETE also take WSTRING values of any length, as do `=`, `<>`, `<`, `<=`, `>`, `>=` between WSTRINGs; on STRING and WSTRING, INSERT and WINSERT put IN2 after the first P characters, as the standard's INSERT example does. Any STRING or WSTRING argument of these nine may be a literal (`INSERT('ABC', 'XY', 1)`), and CONCAT takes three or more arguments of any mix of literals and variables |
| System | ADR, SIZEOF |

**REAL/LREAL to integer.** `REAL_TO_*` and `LREAL_TO_*` to an integer type round to nearest (half away from
zero), saturate at the target's range and give 0 for NaN, instead of the undefined behaviour of a plain C++
cast. `*_TO_BOOL` still rounds first (0.4 is FALSE). `TRUNC` returns an integer, as the standard says: DINT for
REAL and LINT for LREAL (truncating toward zero, saturating). Under `--strict` an assignment of `TRUNC(r)` to an
INT needs `DINT_TO_INT`; without it the narrowing is accepted, as library code expects. The extension
feature `trunc_dint` (off by default and under `iec-3`) makes `TRUNC` of an LREAL a DINT as well (saturating
at the DINT range); see [DIALECTS.md](DIALECTS.md).

**Typed truncation** (IEC 61131-3 Ed. 3, Table 22) is supported in every dialect for every ANY_REAL x ANY_INT
pair: `TRUNC_<int>` (e.g. `TRUNC_INT`) takes a REAL or an LREAL, `REAL_TRUNC_<int>` and `LREAL_TRUNC_<int>`
(e.g. `REAL_TRUNC_SINT`, `LREAL_TRUNC_ULINT`) take that type; `<int>` is SINT, INT, DINT, LINT, USINT, UINT,
UDINT or ULINT and is the result type. They truncate toward zero (`TRUNC_INT(-2.7)` is -2), saturate at the
target's range (`TRUNC_SINT(1000.0)` is 127, `TRUNC_UINT(-1.5)` is 0) and give 0 for NaN, as `TRUNC` does. An
LREAL argument to a `REAL_TRUNC_*` is narrowed (a warning; an error under `--strict`). A user or library
FUNCTION of the same name keeps its own meaning.

## Standard Function Blocks

Bundled as a compiled `.stlib` library (`libs/iec-standard-fb.stlib`):

| FB | Description |
|----|-------------|
| TON | On-delay timer |
| TOF | Off-delay timer |
| TP | Pulse timer |
| CTU | Count-up counter |
| CTD | Count-down counter |
| CTUD | Up/down counter |
| R_TRIG | Rising edge detector |
| F_TRIG | Falling edge detector |
| SR | Set-dominant bistable |
| RS | Reset-dominant bistable |

Both counting inputs are sampled on the rising edge, as IEC 61131-3 declares them
(`CU : BOOL R_EDGE`, `CD : BOOL R_EDGE`). A count is registered on the scan where
the input goes FALSE to TRUE, for `CD` exactly as for `CU`.

The counting range follows CODESYS rather than the standard's `PVmin`/`PVmax`:
counting up stops at `PV`, which CODESYS documents as the "upper limit for
incrementing", and counting down stops at 0, which it decrements towards "as long
as `CV` is greater than 0". CODESYS reaches that range by typing `CV` and `PV` as
`WORD`, a deviation from IEC that it documents; these blocks keep the IEC types
and express the same range through the `PV` and 0 guards.

`CTUD` keeps the standard's `IF NOT (CU AND CD)` guard, so simultaneous rising
edges on `CU` and `CD` leave `CV` unchanged. CODESYS does not document that case.

## Project Structure

| Feature | Status | Notes |
|---------|--------|-------|
| CONFIGURATION | Supported | |
| RESOURCE ... ON | Supported | |
| TASK ... WITH INTERVAL | Supported | |
| Program instances | Supported | `name : programType` with task assignment |
| VAR_GLOBAL in configuration | Supported | Not of a function block type, nor of a STRUCT or ARRAY holding one (refused at the declaration; declare it in a global variable list or a PROGRAM) |
| Library namespace | Supported | Set when compiling a library (`--lib-namespace`, `namespace` in the library API); no pragma sets it |

## Language Extensions

| Feature | Status | Notes |
|---------|--------|-------|
| Nested comments `(* (* *) *)` | Supported | Arbitrary nesting depth |
| Pragmas `{...}` (6.2, Table 4) | Supported | Lexed wherever whitespace may appear (not in string literals or comments) and skipped with a `Pragma ignored: {...}` warning, in every dialect; no pragma is interpreted except `{external}`. Conditional-compilation pragmas are errors (see Not Yet Implemented). A pragma ends at the first `}` (no nesting); an unclosed `{` is an error |
| Inline C++ | Supported | `{external ...}` as a statement in a POU body (braces inside it may nest); refused elsewhere, e.g. in a VAR block |
| Global constants (`-D`) | Supported | CLI `-D NAME=VALUE`, emits `constexpr` |
| Dynamic memory | Supported | `__NEW(type)`, `__DELETE(ptr)` |
| POINTER TO, `ADR()` | Supported | Full pointer type with dereference; `p := ADR(x)` takes the address of a variable of any type, a STRUCT, UNION, ARRAY or FB instance included, into a POINTER TO it (`p^.field` reads and writes through it); the feature `pointer_to` (`ADR` and `POINTER TO` are refused under `--dialect iec-3`; IEC `REF_TO`, `REF()` and `^` stay accepted, as do the vendor forms bare `THIS^` and `SUPER^`) |
| Typed literals | Supported | `INT#5`, `DINT#42`, `REAL#3.14` |
| Dialect profiles | Supported | `--dialect`, `--dialect-file`, `--dialect-path`, `--feature`: named feature sets; `iec-3` enables none, no flag keeps the default set (see [DIALECTS.md](DIALECTS.md)) |

## Not Yet Implemented

| Feature | Notes |
|---------|-------|
| UNION (parts) | Member initial values in the UNION declaration, an initial value other than one named member, forcing and debugging of members, RETAIN, REF/REF= of a member, REFERENCE TO members (see above) |
| FB_exit | Destructor lifecycle method (FB_init is supported with the feature `fb_init`, see above) |
| __QUERYINTERFACE | Runtime interface query |
| Bit access (var.%X0) | Individual bit addressing |
| TRY/CATCH/FINALLY | Exception handling |
| Generics | Parameterized types |
| Conditional compilation | The pragmas `{IF}`, `{ELSIF}`, `{ELSE}`, `{END_IF}`, `{define}`, `{undefine}` (any case) are errors, since skipping them would compile every branch |
