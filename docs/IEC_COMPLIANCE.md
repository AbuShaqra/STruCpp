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
| TYPE ... END_TYPE | Supported | Type aliases |
| STRUCT ... END_STRUCT | Supported | With nested structs. A field may be a function block instance (a user FB or a library FB such as `TON`), directly, as an `ARRAY OF` one, or through another STRUCT, in any declaration order. Call it with no arguments (`s.tmr();`) after setting its inputs on the field: a call with arguments through a selector (`s.tmr(IN := x)`) is not yet supported for any FB |
| Enumerations | Supported | With optional base type |
| Initialized type declarations | Supported | A type may carry its own default (`Setpoint : REAL := 25.0;`, `Origin : Point := (x := 0.0);`), inherited by every declaration of the type that has no initializer |
| ARRAY (1D) | Supported | Arbitrary bounds: ARRAY[1..10] OF INT |
| ARRAY (2D) | Supported | ARRAY[1..3, 1..4] OF REAL |
| ARRAY (3D) | Supported | ARRAY[1..3, 1..4, 1..5] OF INT |
| ARRAY OF function block | Supported | Declaration, member access, and element invocation (`units[i](step := 1.0)`). A named TYPE of one (`BeltPair : ARRAY[0..1] OF FB_Belt`) may be a member, a STRUCT field, a global, or a method or interface method parameter. A *method* call on an element (`units[0].M()`) is not yet parsed |
| ARRAY[*] (VLA) | Supported | Variable-length array parameters |
| Subranges | Supported | Runtime validation |
| REF_TO | Supported | IEC reference type (explicit dereference) |
| REFERENCE_TO | Supported | Vendor reference type (implicit dereference); a vendor spelling: the feature `reference_to`, refused under `--dialect iec` |
| POINTER TO | Supported | Vendor pointer type with dereference via ^; a vendor spelling: the feature `pointer_to`, refused under `--dialect iec` |

### Not Implemented

| Type | Notes |
|------|-------|
| UNION | CODESYS extension |

## Program Organization Units

| POU | Status | Notes |
|-----|--------|-------|
| PROGRAM | Supported | With CONFIGURATION/RESOURCE/TASK structure |
| FUNCTION | Supported | With return type, all parameter modes |
| FUNCTION_BLOCK | Supported | Instantiation, invocation, member access |
| INTERFACE | Supported | Method and property signatures |
| ACTION | Supported | ACTION blocks of PROGRAMs and FUNCTION_BLOCKs, called as Name() inside the owner and inst.Name() on an instance; no SFC action qualifiers. Extensions: calling an action directly from ST, and the top-level `ACTION Owner.Name` form; IEC declares actions inside the POU and controls them from SFC steps. Both forms parse (`ACTION Name[:]` after the body, `ACTION Owner.Name[:]` at top level; `ACTION` is contextual, `END_ACTION` reserved); each action is lowered to a parameterless PUBLIC method of its owner, needs no dialect feature, cannot override or be overridden, and never implements an INTERFACE method. A program's actions can be called only inside the program |

## Variable Declarations

| Feature | Status | Notes |
|---------|--------|-------|
| VAR | Supported | Local variables |
| VAR_INPUT | Supported | Input parameters |
| VAR_OUTPUT | Supported | Output parameters |
| VAR_IN_OUT | Supported | Pass-by-reference parameters. A CONFIGURATION global of a STRUCT or ARRAY type (whole, an element or a field) passed to a VAR_IN_OUT or VAR_OUTPUT of a function block, a method or a FUNCTION is passed by copy-in/copy-out: it is read under its lock into a temporary before the statement, the call works on the temporary with no lock held, and the temporary is written back under the lock after the call (in an IF, ELSIF, WHILE or REPEAT condition, a CASE selector or a FOR bound, around the call itself). So inside the call the callee sees its VAR_IN_OUT, not the global: a write to the same global through VAR_EXTERNAL during the call is overwritten by the copy-out, and the same global passed twice gets two copies, the later write-back winning. Callees from a library and bit accesses (`g.w.3`) are not passed this way |
| VAR_EXTERNAL | Supported | References either a CONFIGURATION or a file-level VAR_GLOBAL |
| VAR_GLOBAL | Supported | Global variables (CONFIGURATION-scoped or file-level). A file-level VAR_GLOBAL may hold a function block instance (or a STRUCT or ARRAY holding one). A CONFIGURATION VAR_GLOBAL may not: it is refused at its declaration (`VAR_GLOBAL <name> in a CONFIGURATION cannot hold a FUNCTION_BLOCK (<type>)`), since its storage is a shared, lock-guarded global |
| CONSTANT | Supported | Compile-time constants |
| RETAIN | Supported | Allowed on `VAR`, `VAR_INPUT`, `VAR_OUTPUT` and `VAR_GLOBAL`, per IEC 61131-3. Rejected on `VAR_IN_OUT` / `VAR_TEMP` / `VAR_EXTERNAL`, and inside a `FUNCTION` or `METHOD` (no instance, nothing to retain) |
| PERSISTENT | Partial | Accepted and treated as `RETAIN`. CODESYS also keeps a PERSISTENT value across a program download; that is not implemented, so the weaker shared guarantee is what is claimed |
| NON_RETAIN | Supported | Accepted and treated as the default (a plain `VAR` is already non-retained). Rejected when combined with `RETAIN` or `CONSTANT` |
| AT %IX0.0 | Supported | Located variables (I/Q/M areas, X/B/W/D/L sizes) |
| Multiple names | Supported | `a, b, c : INT := 0;` |
| Initialization | Supported | `:= expression` |
| Array initialization | Supported | `:= [1, 2, 3]` and the bracket-less `:= 1, 2, 3`. Multi-dimensional arrays take either a flat row-major list or a nested one (`:= [[1, 2], [3, 4]]`), where each inner list fills one row from its own bound. Nesting depth and value count are validated against the declared dimensions |
| Array repetition | Supported | `:= [10(0)]`, `:= [3(1), 2(5)]`, `:= [7, 4(2), 9]`. The repeated value may be a structure initializer. Max count 65536 |
| Structure initialization | Supported | `:= (x := 1.0, y := 2.0)`; nested, in array literals, and for FB instances. Omitted elements keep their own declared default. Only valid as a declaration's initial value, as in the standard — one written inside a statement is rejected |
| STRUCT element defaults | Supported | Scalar, array-literal and structure-initializer defaults on a STRUCT element all carry their values |

### Initialization gaps

| Form | Notes |
|------|-------|
| Repetition with no value | `:= [10()]` (ten copies of the element default) — write `:= [10(0)]`, or omit the elements entirely. Matches matiec and CODESYS, which also require a value |

## Operators and Expressions

| Category | Operators | Status |
|----------|-----------|--------|
| Arithmetic | `+`, `-`, `*`, `/`, `MOD`, `**` | Supported |
| Comparison | `=`, `<>`, `<`, `>`, `<=`, `>=` | Supported |
| Logical | `AND`, `OR`, `XOR`, `NOT` | Supported |
| Bitwise | `AND`, `OR`, `XOR`, `NOT` (on bit types) | Supported |
| Bit shift | `SHL`, `SHR`, `ROL`, `ROR` | Supported |
| Assignment | `:=` | Supported |
| Reference assign | `REF=` | Supported; a vendor spelling: the feature `ref_assign`, refused under `--dialect iec` |
| Dereference | `^`, `DREF()` | Supported |
| Reference | `REF()` | Supported |
| Parentheses | `( )` | Supported |
| Function call | `name(args)` | Supported (positional + named) |
| Method call | `obj.method(args)` | Supported. Named arguments (`obj.m(b := 2, a := 1)`, `out => v`) bind by name, in any order, to VAR_INPUT, VAR_IN_OUT and VAR_OUTPUT in declaration order; a missing input takes its default. Also for `THIS.m`, `SUPER.m`, a bare `m(...)` and a program method |
| Array access | `arr[i]`, `arr[i, j]` | Supported — the index count is validated against the declared rank |
| Field access | `struct.field` | Supported |
| Typed literals | `INT#5`, `DINT#42`, `REAL#3.14` | Supported |
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
| Methods | Supported | On FUNCTION_BLOCK, with return types. On a PROGRAM: a vendor extension, the feature `program_methods` (refused with no dialect flag and under `--dialect iec`); parsed and checked, callable only inside the program; generated as non-virtual members of the program class |
| Properties (GET/SET) | Supported | Virtual getter/setter methods in C++ |
| Inheritance (EXTENDS) | Supported | Single inheritance |
| Interfaces (IMPLEMENTS) | Supported | Multiple interfaces, generates C++ abstract classes |
| ABSTRACT | Supported | Abstract FB (no instantiation) and abstract methods (pure virtual) |
| FINAL | Supported | Sealed FB and methods |
| OVERRIDE | Supported | Method override with C++ override specifier |
| PUBLIC/PRIVATE/PROTECTED | Supported | Access modifiers |
| THIS | Supported | Self-reference in methods |

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
| Type Conversion | *_TO_* (INT_TO_REAL, DINT_TO_STRING, etc.) |
| String | LEN, LEFT, RIGHT, MID, CONCAT, FIND, REPLACE, INSERT, DELETE, UPPER, LOWER, TRIM |
| System | ADR, SIZEOF |

**REAL/LREAL to integer.** `REAL_TO_*` and `LREAL_TO_*` to an integer type round to nearest (half away from
zero), saturate at the target's range and give 0 for NaN, instead of the undefined behaviour of a plain C++
cast. `*_TO_BOOL` still rounds first (0.4 is FALSE). `TRUNC` returns an integer, as the standard says: DINT for
REAL and LINT for LREAL (truncating toward zero, saturating). Under `--strict` an assignment of `TRUNC(r)` to an
INT needs `DINT_TO_INT`; without it the narrowing is accepted, as library code expects.

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
| Namespace configuration | Supported | Via pragmas |

## Language Extensions

| Feature | Status | Notes |
|---------|--------|-------|
| Nested comments `(* (* *) *)` | Supported | Arbitrary nesting depth |
| Pragmas `{...}` | Supported | Including `{external}` for inline C++ |
| Inline C++ | Supported | Via `{external ...}` pragma blocks |
| Inline function calls | Supported | Via `{call ...}` pragma |
| Global constants (`-D`) | Supported | CLI `-D NAME=VALUE`, emits `constexpr` |
| Dynamic memory | Supported | `__NEW(type)`, `__DELETE(ptr)` |
| POINTER TO, `ADR()` | Supported | Full pointer type with dereference; the feature `pointer_to` (`ADR` and `POINTER TO` are refused under `--dialect iec`; IEC `REF_TO`, `REF()`, `^`, `THIS^` and `SUPER^` stay accepted) |
| Typed literals | Supported | `INT#5`, `DINT#42`, `REAL#3.14` |
| Dialect profiles | Supported | `--dialect`, `--dialect-file`, `--dialect-path`, `--feature`: named feature sets; `iec` enables none, no flag keeps the default set (see [DIALECTS.md](DIALECTS.md)) |

## Not Yet Implemented

| Feature | Notes |
|---------|-------|
| UNION | CODESYS union type |
| FB_Init / FB_Exit | Constructor/destructor lifecycle methods |
| __QUERYINTERFACE | Runtime interface query |
| Bit access (var.%X0) | Individual bit addressing |
| TRY/CATCH/FINALLY | Exception handling |
| Generics | Parameterized types |
| Conditional compilation | Preprocessor-style conditionals |
