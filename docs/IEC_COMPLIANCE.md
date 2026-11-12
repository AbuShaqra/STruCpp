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
| LTIME | Supported | Ed. 3 elementary type (Table 10): a signed 64-bit duration in nanoseconds, in every dialect, stored as TIME is. Literals `LTIME#` and `LT#` take every unit (d, h, m, s, ms, us, ns), a sign, a fraction and underscores (Table 8); one outside the 64-bit range is an error. TIME converts to LTIME implicitly and LTIME to TIME only explicitly (Figures 11 and 12); TIME and LTIME operands mix to an LTIME result. Conversions `TIME_TO_LTIME`, `LTIME_TO_TIME`, `TO_LTIME`, `LTIME_TO_<integer>` and `<integer>_TO_LTIME` (the integer counts nanoseconds), and the arithmetic functions `ADD_LTIME`, `SUB_LTIME`, `MUL_LTIME`, `DIV_LTIME`. The debugger reads an LTIME leaf as TIME (8 bytes, `duration-ns-i64` in `libs/iec-types.json`) |
| LDATE, LTOD (LTIME_OF_DAY), LDT (LDATE_AND_TIME) | Supported | Ed. 3 elementary types (Table 10), in every dialect, stored as DATE, TOD and DT are. Table 10 specifies LDATE as signed 64-bit nanoseconds since 1970-01-01; it is stored as days since then instead, the representation DATE has, an implementation choice that changes no result a program computes (conversions to and from integers count nanoseconds). Literals `LDATE#`/`LD#`, `LTOD#`/`LTIME_OF_DAY#` and `LDT#`/`LDATE_AND_TIME#` take the forms of the short ones (Table 9). DATE, TOD and DT convert implicitly to their long form, not back (Figures 11 and 12). The difference of two long instants of one kind (a short one converting) is an LTIME, and a long instant plus or minus a TIME or LTIME keeps its type; an LDATE moves by the duration's whole days. Conversions between the long and short forms and to and from integers (in nanoseconds, LDATE included), `LDT_TO_LDATE` / `LDT_TO_LTOD` (the date or time of day of the instant, Table 26) and `LDATE_TO_LDT` (its midnight). A user TYPE already named like one of these types stays the user's type. The CONCAT_ and SPLIT_ functions for them are those of Table 36 |
| STRING | Supported | Parameterized length: STRING(N), default 254. N may be a constant: a VAR_GLOBAL CONSTANT, a POU's VAR CONSTANT or an expression of them takes its value, a caller-supplied constant (`-D`) keeps its name. An element of an ARRAY OF STRING(N) or ARRAY OF REF_TO STRING(N), inline, named, a STRUCT field or an ARRAY[*] parameter, has that length: a longer value is truncated to N. Arrays whose elements differ only in that length assign and pass element by element (an in/out by copy-in / copy-out). A STRING holds Windows-1252 characters, one byte each, which matches the behaviour of common vendor toolchains: `LEN('ä')` is 1 and STRING(N) holds N such characters. A character Windows-1252 lacks in a STRING literal is an error at its position (`Character '☃' (U+2603) cannot be stored in a STRING, which holds Windows-1252 characters; use a WSTRING literal ("...") for it`). See RUNTIME.md for the debugger and REPL |
| WSTRING | Supported | Parameterized length: WSTRING(N). STRING_TO_WSTRING widens each STRING character to its Windows-1252 code point; WSTRING_TO_STRING writes a character Windows-1252 lacks as `?` |
| CHAR, WCHAR | Supported | |

### Derived Types

| Type | Status | Notes |
|------|--------|-------|
| TYPE ... END_TYPE | Supported | Type aliases. An alias of a STRUCT or UNION (`TYPE T_A : ST_A;`, also chained) names the same type: assignment both ways, VAR_INPUT and VAR_IN_OUT arguments and initialisers accept it in every dialect; a derived STRUCT (EXTENDS) stays a different type. A variable of an alias of an elementary or enumeration type with no initial value starts at the type's default (0, FALSE, the first value) |
| STRUCT ... END_STRUCT | Supported | With nested structs. A field may be a function block instance (a user FB or a library FB such as `TON`), directly, as an `ARRAY OF` one, or through another STRUCT, in any declaration order. Call it with or without arguments (`s.tmr(IN := x)`, `s.tmr();`). A STRUCT inheriting another's fields (`TYPE ST_B EXTENDS ST_A : STRUCT`) is an extension (IEC 61131-3 `Struct_Type_Decl` takes no EXTENDS): the feature `struct_extends` (refused with no dialect flag and under `--dialect iec-3`). The derived STRUCT holds the base fields, then its own; per 6.4.4.6 it is not assignment-compatible with its base in either direction, see [DIALECTS.md](DIALECTS.md) |
| Enumerations | Supported | With optional base type before the value list, `DINT (A, B)`. The base written after the list, `(A, B) DINT`, is a vendor ordering: the feature `postfix_enum_base` (refused with no dialect flag and under `--dialect iec-3`), same meaning and C++ as the base-first form. A type default (`(A, B) := B`, `:= E#B` or `:= E.B`) must be one of the type's own values. A value (`E#M`, `E.M` or a bare member) has its enumeration's type: the initial value of an enumeration variable, STRUCT field or array element, also inside an array literal or a structure initializer, must be a value of that enumeration (`Cannot assign E3 to E2`, `'Z' is not a value of enumeration E2`), and an enumeration is not used as a number without a conversion such as `TO_INT`. An alias of an enumeration (`TYPE E2A : E2;`, also chained) is that enumeration: its variables take the enumeration's values and variables, and are declared with the same C++ wrapper. An enumeration value is not an integer: as an array index, bound to an integer input or to an input of another enumeration, or as a CASE label of another type than the selector, it is an error (an alias of the enumeration is that enumeration). `E#M` names the type E even where a variable is named E. SEL and MUX of values of one enumeration (variables, literals and aliases mixed) yield that enumeration; an input of another type next to them is an error |
| Initialized type declarations | Supported | A type may carry its own default (`Setpoint : REAL := 25.0;`, `Origin : Point := (x := 0.0);`), inherited by every declaration of the type that has no initializer |
| ARRAY (1D) | Supported | Arbitrary bounds: ARRAY[1..10] OF INT. A bound is an integer constant expression, in a named array type and inline alike: literals, constants (a POU's `VAR CONSTANT`, a `VAR_GLOBAL CONSTANT` of any file, also list-qualified, a `-D` constant) and `+ - * / MOD` on them. An enumeration value is also accepted as a bound and counts as its number (`ARRAY[E#A..E#C]`), a vendor extension accepted in every dialect; the element is still indexed by an integer (`a[TO_INT(E#B)]`). A bound that is not a constant is an error (`The bounds of an ARRAY must be integer constants: 'N' is not a constant`) |
| ARRAY (2D) | Supported | ARRAY[1..3, 1..4] OF REAL. `LOWER_BOUND(arr, dim)` / `UPPER_BOUND(arr, dim)` answer each dimension of a fixed 2D or 3D array, as of an ARRAY[*]; a literal dimension the array does not have is an error |
| ARRAY (3D) | Supported | ARRAY[1..3, 1..4, 1..5] OF INT |
| ARRAY OF function block | Supported | Declaration, member access, and element invocation (`units[i](step := 1.0)`), also of a global array, through its global variable list (`GVL_A.units[i](...)`) and through a member path (`h.arr[i](...)`). A named TYPE of one (`BeltPair : ARRAY[0..1] OF FB_Belt`) may be a member, a STRUCT field, a global, or a method or interface method parameter. A method call on an element (`units[0].M()`) works like any method call through a member chain (see Method call) |
| ARRAY[*] (VLA) | Supported | Variable-length array parameters |
| Subranges | Supported | Runtime validation. A subrange variable with no initial value starts at the lower bound |
| REF_TO | Supported | IEC reference type (explicit dereference). `REF(x)` and `r REF= x` of an elementary, STRING, WSTRING, enumeration, STRUCT, ARRAY or function block variable or STRUCT field; `r^.field`, `r^.M()`. `REF()`, `ADR()` and `REF=` of a CONFIGURATION global refer to its storage, outside its lock: the compiler warns that under `STRUCPP_THREADED` accesses through the result are not serialized with other tasks. Not yet: `REF()` of an element of an ARRAY OF an enumeration, and `REF_TO STRING(n)` / `WSTRING(n)` of a length other than the default |
| REFERENCE_TO | Supported | Vendor reference type (implicit dereference); a vendor spelling: the feature `reference_to`, refused under `--dialect iec-3`. A `REFERENCE TO` VAR_INPUT of a function block, function or method is bound to its argument at the call (named or positional), so reads and writes through it reach the argument; an FB input keeps its binding until the next call that passes it. So is one of a library FUNCTION, whose archive records it (`referenceKind` on the parameter); an archive built before that reads the input as a plain value, and the call fails to build until the library is rebuilt. The argument must be a variable (a local, global, member, array element, STRUCT field, `p^` or another `REFERENCE TO`) of the referenced type or an alias of it: an expression, a constant, another type or a subrange variable is an error. A `REFERENCE TO` a STRUCT or function block reaches its members and methods (`rf.a`, `rr.M()`). Reading or writing an unbound `REFERENCE TO` raises the null-reference fault, as a NULL REF_TO dereference does. A `REFERENCE TO STRING` or `WSTRING` reads as the string it is bound to, in string functions, comparisons and assignments. `^` does not apply to a `REFERENCE TO` (it is dereferenced implicitly) and is an error. Not supported yet at compile: binding a `REFERENCE TO` (input or `REF=`) to a variable of an alias type |
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
| FUNCTION_BLOCK | Supported | Instantiation, invocation, member access. A bare call `f(...)` of an FB instance in scope (a local, a member, or a member inherited from a base FB) or of a PROGRAM invokes it, also when a FUNCTION or standard function has the same name. Every FB and PROGRAM has an implicit ENO output (TRUE after a call, FALSE when EN is FALSE). One that declares ENO itself gets no implicit one: a declared BOOL ENO is the ENO output, set TRUE before the body, which may clear it, and read by `ENO =>`; in a PROGRAM or an FB without a base, a declared ENO of another type is an error. A named argument of an invocation (`fb(a := 1)`, `inst.fb(a := 1)`, `a.b.fb(a := 1)`) that names no input, output or in/out of a function block declared in the compile is an error in every mode, including one naming a VAR, VAR_TEMP or CONSTANT local, a VAR_EXTERNAL, a method, a property or an action. From outside a function block only its interface is reachable (Ed. 3 Figure 13, 6.6.5.10), in every dialect, which matches the behaviour of common vendor toolchains: a VAR_INPUT is written (`f.i := 1`, `f(i := 1)`) but not read, a VAR_OUTPUT is read (`x := f.o`, `f(o => x)`) but not written, a VAR_IN_OUT is bound in the call and not reached through the instance, and VAR, VAR_TEMP and VAR_EXTERNAL members are internal: reading or writing them, an instance initializer naming them (`f : FB := (v := 3)`) and a call through an FB instance held in them (`o.inner(...)`, `o.inner.M()`, `o.inner.x`) are errors, for user and library blocks and in test files (where a test may reach an instance it MOCKs, and the path to it; from the mocked instance down the rule holds). Inside the block, its methods and the blocks derived from it everything stays reachable, also on another instance of the type. EN and ENO are always reachable. A VAR section's access specifier changes the internal rule: `VAR PUBLIC` is reachable from anywhere, `VAR PRIVATE` only inside the declaring block (not from derived blocks, also not through THIS or SUPER), `VAR PROTECTED` is the default; `VAR INTERNAL` is treated as PROTECTED, since namespaces are not supported. A specifier on another section or outside a FUNCTION_BLOCK, or two on one section, is an error. A library archive carries PUBLIC and PRIVATE for its blocks' variables; an older archive's are PROTECTED |
| INTERFACE | Supported | Method prototypes. PROPERTY prototypes (explicit `GET END_GET` / `SET END_SET`) are not in Ed. 3, where an interface holds method prototypes only: a vendor extension, the feature `property` (refused with no dialect flag and under `--dialect iec-3`; see [DIALECTS.md](DIALECTS.md)) |
| ACTION | Supported | ACTION blocks of PROGRAMs and FUNCTION_BLOCKs, written before or after the owner's body (before it, they may be mixed with VAR blocks and methods), called as Name() inside the owner and inst.Name() on an instance; no SFC action qualifiers. Extensions: calling an action directly from ST, and the top-level `ACTION Owner.Name` form; IEC declares actions inside the POU and controls them from SFC steps. Both forms parse (`ACTION Name[:]` after the body, `ACTION Owner.Name[:]` at top level; `ACTION` is contextual, `END_ACTION` reserved); each action is lowered to a parameterless PUBLIC method of its owner, needs no dialect feature, cannot override or be overridden, and never implements an INTERFACE method. A program's actions can be called only inside the program, or by its name from any POU with the feature `program_methods` |

## Variable Declarations

| Feature | Status | Notes |
|---------|--------|-------|
| VAR | Supported | Local variables |
| VAR_INPUT | Supported | Input parameters |
| VAR_OUTPUT | Supported | Output parameters |
| VAR_IN_OUT | Supported | Passed by reference (6.6.1.4, 6.6.3.4.2): the parameter refers to the caller's variable, so the callee reads and writes that variable itself and sees any other write to it during the call (through VAR_EXTERNAL, or a second in-out bound to the same variable). A FUNCTION or METHOD takes it as a C++ reference, of the declared length for a STRING(n) or WSTRING(n) (so does a VAR_OUTPUT): an argument of that length is bound, one of another length is passed through a STRING(n) temporary, so a longer value is truncated to n characters inside the call. A library FUNCTION or METHOD records that length in its archive; an archive built before keeps STRING. A FUNCTION_BLOCK holds it as `IEC_INOUT<T>`, bound by each call that assigns it (named or positional; inherited in-outs included) and kept until the next one; an ARRAY[*] in-out is a view of the caller's array, an interface in-out refers to the caller's instance. A binding whose target lives only for the call (a FUNCTION or METHOD parameter or local, a VAR_TEMP, or another in-out passed on) is released after the call. Reaching an in-out that no call has bound, or that was released, raises the null-reference fault. Reading `inst.x` from outside reads through the binding. A CONFIGURATION global bound to an in-out is referred to directly (`g->value`), outside its lock: the compiler warns that under `STRUCPP_THREADED` accesses through the in-out are not serialized with other tasks. The argument must be a variable: a literal, an expression, a bit (`w.3`), an enumeration value or a constant is an error. Without a dialect and under a vendor profile, these forms are warnings, and errors under `--dialect iec-3`: an argument of another type (an alias of an elementary type, another length of STRING, another elementary type; passed by copy-in/copy-out; an alias of a STRUCT or UNION is the same type and binds by reference), an omitted in-out (an FB call keeps the previous binding; a FUNCTION or METHOD gets a temporary), and a caller's VAR_INPUT as the argument. Reading or writing `inst.x` from outside the block is an error in every dialect (see the FUNCTION_BLOCK row). A UNION member is passed by copy-in/copy-out. A VAR_OUTPUT bound to a composite CONFIGURATION global is written back under its lock after the call. The debug table lists no leaf for an FB's in-out. A library FB from an archive built before in-outs were bound by reference is called with copy-in/copy-out and a warning to rebuild the library |
| VAR_EXTERNAL | Supported | References either a CONFIGURATION or a file-level VAR_GLOBAL |
| VAR_GLOBAL | Supported | Global variables (CONFIGURATION-scoped or file-level). A file-level VAR_GLOBAL may hold a function block instance (or a STRUCT or ARRAY holding one). The initial value of a file-level global may name another one, as a value or as the target of `ADR()`, wherever it is declared (later in the file or in another global variable list): the globals are created in dependency order, and initial values that depend on each other are an error naming the cycle. A CONFIGURATION VAR_GLOBAL may not: it is refused at its declaration (`VAR_GLOBAL <name> in a CONFIGURATION cannot hold a FUNCTION_BLOCK (<type>)`), since its storage is a shared, lock-guarded global. A CONFIGURATION POINTER TO or REF_TO global may be bound in its initial value (`q : POINTER TO INT := ADR(g)`, `p : REF_TO INT := REF(g)`), and a program dereferences it through VAR_EXTERNAL for reading and writing (`p^`, `p^ := v`, `ps^.a`); the pointer is read under its global's lock, the access through it is not serialized with other tasks under `STRUCPP_THREADED`. The globals of a CONFIGURATION and of its RESOURCEs are likewise created in dependency order, an initial value naming another global of the configuration as a value, inside a STRUCT or ARRAY initializer or as the target of `ADR()`; a cycle is an error naming it. Access qualified by a file's global variable list name (`GVL_A.x`) is a vendor extension: the feature `named_global_lists` (refused with no dialect flag and under `--dialect iec-3`), see [DIALECTS.md](DIALECTS.md) |
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
| STRUCT element defaults | Supported | Scalar, array-literal and structure-initializer defaults on a STRUCT element all carry their values. A default is a constant expression: a VAR_GLOBAL CONSTANT it names, declared before or after the type, plain or qualified by its global variable list (`GVL_C.cDefault`), is folded to its value; a global variable is an error, in every dialect. A REAL literal keeps its decimal point (`3.0 / 2.0` is 1.5). A POINTER TO, REF_TO or REFERENCE TO element takes no address or reference as its default (REF_TO and POINTER TO may default to NULL): assign it in the body |

### Initialization gaps

| Form | Notes |
|------|-------|
| Repetition with no value | `:= [10()]` (ten copies of the element default) — write `:= [10(0)]`, or omit the elements entirely. Matches matiec and CODESYS, which also require a value |

## Operators and Expressions

| Category | Operators | Status |
|----------|-----------|--------|
| Arithmetic | `+`, `-`, `*`, `/`, `MOD`, `**` | Supported |
| Comparison | `=`, `<>`, `<`, `>`, `<=`, `>=` | Supported. `=` and `<>` on two STRUCT values compare field by field (a nested STRUCT field by field, an ARRAY member element by element), also a STRUCT reached through `^` (`r1^ = r2^`, `p^ = s`) or a REFERENCE TO (`rr = s`); IEC 61131-3 Ed. 3 types the comparison functions on elementary values only, so this is not Ed. 3. It is accepted in every dialect, `--dialect iec-3` included, as it was before it compiled; whether iec-3 should refuse it is left to the iec-3 audit, see [DIALECTS.md](DIALECTS.md) |
| Logical | `AND`, `OR`, `XOR`, `NOT` | Supported |
| Bitwise | `AND`, `OR`, `XOR`, `NOT` (on bit types) | Supported |
| Bit shift | `SHL`, `SHR`, `ROL`, `ROR` | Supported |
| Assignment | `:=` | Supported |
| Reference assign | `REF=` | Supported; a vendor spelling: the feature `ref_assign`, refused under `--dialect iec-3`. The variable bound must be of the target's referenced type, and a STRING of its length, as for `r := REF(x)`: another type or length is an error. An alias of STRING(n) counts as STRING(n) here, for REF_TO assignment and for a REFERENCE TO input |
| Dereference | `^`, `DREF()` | Supported |
| Reference | `REF()` | Supported |
| Parentheses | `( )` | Supported |
| Operator precedence | Highest to lowest: `( )`, function call, unary `-` `+` `NOT`, `**`, `*` `/` `MOD`, `+` `-`, `<` `>` `<=` `>=`, `=` `<>`, `AND` `&`, `XOR`, `OR` | Supported. The comparison levels follow the Annex A grammar: `<`, `>`, `<=`, `>=` bind tighter than `=` and `<>`, and both levels repeat left-associatively, so chained comparisons parse in every dialect: `a < b < c` is `(a < b) < c`, `a = b = c` is `(a = b) = c`, `a = b < c` is `a = (b < c)`. Table 71 puts all six comparison operators on one level, which would read `a = b < c` as `(a = b) < c`; the two disagree and Annex A is followed. A comparison yields BOOL, and a chain compares that BOOL with the next operand under the usual comparison rules |
| Function call | `name(args)` | Supported (positional + named). An output of a user or library FUNCTION bound to a variable, named (`o => v`) or positional, `THIS.x` and TEST blocks included, follows the rules of the assignment `v := o`: refused where that assignment is (LTIME into TIME, INT into UDINT), with its narrowing warning, or its error under `--strict`. A CONSTANT is refused, as its assignment is. Where the two C++ types differ (USINT output, UINT variable; an alias type, a library's included; a STRING output of another length than the variable), and for a dereference `p^`, a REFERENCE TO or a bit `w.3`, the output is copied out through a temporary of its own type, and the variable expression is evaluated once (`o => arr[i]`). A bare call of a method of the FB, its bases or the PROGRAM binds that method's outputs. Outputs bound in a FUNCTION_BLOCK or method call are not checked this way. Named arguments bind by name, in any order, for user and library functions; an omitted input takes its declared default. A named argument of a user or library FUNCTION that names none of its VAR_INPUT, VAR_IN_OUT or VAR_OUTPUT (`F(zz := 1)`, a local of F included) is an error in every mode. Named arguments of a standard function bind by its IEC parameter names (`MID(IN, L, P)`, `LIMIT(MN, IN, MX)`, `SEL(G, IN0, IN1)`, `MUX(K, IN0, IN1, ...)`, an extensible input past the declared ones such as `IN3`); a name it does not declare, an input given twice or a missing one is an error in every mode. An argument of an alias type is checked as the alias's base type (`LEN(t)` with `TYPE TS : STRING(20)`). The arguments of a standard function are checked against its IEC constraints also when the bundled libraries are loaded (`LEN(i)` with `i : INT` is an error, not a C++ build failure); a library FUNCTION of a standard function's name (`ATAN2` of OSCAT) keeps its own signature. A left-out extensible input closes up (`ADD(IN1 := a, IN3 := c)` adds a and c), except on MUX, which selects its inputs by number. Inside a PROGRAM, `PRG.X()` by the program's own name must name a method or action of it: an unknown X is an error, and a member X without the feature `program_methods` is refused as `PRG.x` is |
| Method call | `obj.method(args)` | Supported. Named arguments (`obj.m(b := 2, a := 1)`, `out => v`) bind by name, in any order, to VAR_INPUT, VAR_IN_OUT and VAR_OUTPUT in declaration order; a missing input takes its default. Also for `THIS.m`, `SUPER.m`, a bare `m(...)` and a program method. A bare `m(...)` inside a PROGRAM or FUNCTION_BLOCK that has a method `m`, inherited ones included, calls the method even when a FUNCTION or standard function is named `m`, as the generated C++ member call does. A named argument that names no parameter of a method declared in the compile is an error on every form (`inst.m(zz := 3)`, `THIS.m`, `SUPER.m`, a bare `m`, `PRG.m`, through an interface or a REFERENCE TO); a method of a library block is not checked. Through a member chain in every dialect: `a.b.m()`, `a.b.c.m()`, an FB held in a STRUCT field (`s.fb.m()`) or an ARRAY element (`arr[i].m()`, `a.arr[i].fb.m()`), `THIS.f.m()` and `SUPER.f.m()`, as an expression or a statement. The method is resolved on the chain's final type, base FBs included; a chain ending at a non-FB value, an unknown method, an unknown named argument or too many arguments is an error, and a PRIVATE or PROTECTED method is callable through a chain only inside its declaring FB. The same holds for a call inside an expression or an IF, ELSIF, WHILE, REPEAT, FOR or CASE condition (`i := f.Pm() + 1`, `IF f.Pm() > 0`) and for an inherited method called through a derived instance (`d.Qm()`); a PROTECTED method is also callable from a derived FB. A FB held in a STRUCT field is not named by the standard's invocation production; it is accepted because an FB instance in a struct is still an FB instance. A global-list prefix (`GVL_A.fb.m()`) needs the feature `named_global_lists`. Through a dereference (`p^.m()`, `q^.m()`) and a REFERENCE TO (`rr.m()`), the method of the object referred to is called; so is the body (`pf^(v := 4)`, `rr(v := 2)`). An FB instance held in a member is invoked through the chain at any depth, with or without arguments (`inst.fb(k := 1)`, `a.b.fb()`, `a.s.arr[i].fb(k := 1)`, `THIS.b.fb()`). Each step of a chain through a function block's member follows the member access rule of the FUNCTION_BLOCK row: `a.b.m()` and `a.b.fb()` reach `b` only when it is a VAR_OUTPUT or in a `VAR PUBLIC` section |
| Array access | `arr[i]`, `arr[i, j]` | Supported — the index count is validated against the declared rank |
| Field access | `struct.field` | Supported |
| Typed literals | `INT#5`, `DINT#42`, `REAL#3.14`, `INT#-123`, `T#-14ms` | Supported. A sign after the prefix (Table 5 feature 9, Table 8) is taken by a decimal integer or real payload and by a duration, in every dialect; a signed integer outside its prefix type (`SINT#-129`, `USINT#-1`) is an error, and each type's minimum (`LINT#-9223372036854775808`) lowers without overflow. A typed literal is also a CASE label. A decimal payload outside its type (`SINT#200`, `USINT#300`, `BYTE#256`) is an error in every dialect. A 2#, 8# or 16# payload on a signed type is a bit pattern of the type's width (`INT#16#FFFF` is -1, as vendor toolchains read it); wider is an error (`INT#16#1_0000`). On an unsigned or bit-string type anything above the maximum is an error, in any base. `LT#` and `LTIME#` literals are LTIME (see the LTIME row) |
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
| Properties (GET/SET) | Supported | Virtual getter/setter methods in C++. Not in Ed. 3; a FUNCTION_BLOCK PROPERTY is accepted in every dialect. A GET or SET may open with a declaration part (`VAR ... END_VAR` or `VAR_TEMP`, possibly empty); its locals belong to that accessor and are fresh on every call, as a METHOD's are. A GET that calls a method of its FB, writes a member or another property, or invokes a member FB runs as a method too, so the C++ getter stays const. In a SET body the property's name is the value being set, also where an enumeration has a member of that name. `GET` and `SET` are keywords only as a PROPERTY's accessors, in every dialect; elsewhere they are names (a METHOD, variable, ACTION, POU, enumeration member or field called `Get` or `Set`). In an INTERFACE: the feature `property`, with the IMPLEMENTS contract checked and access through an interface variable dispatched to the instance. A property of a library function block is read and written by a consumer as a local one, also through a derived block, from archives built with this version. A PRIVATE property is read and written only inside its block (not from a derived block, also not through THIS or SUPER); a PROTECTED one inside its block and the blocks derived from it; reading or writing either from outside is an error, as for methods |
| Inheritance (EXTENDS) | Supported | Single inheritance |
| Interfaces (IMPLEMENTS) | Supported | Multiple interfaces, generates C++ abstract classes. An interface may EXTEND several interfaces; an interface reached through two inheritance paths (a shared base) is a virtual C++ base, so the instance holds it once. The method an FB provides (or inherits) for an interface method, the methods of base interfaces included, must match it: the same inputs, then outputs or in/outs, in order and of the same types (a STRING input of the same length), and the same return type; a mismatch is an error in every mode. A parameter named otherwise is a warning: a named call through the FB then differs from one through the interface. A different default value, or an output for an in/out, is accepted |
| Interface-typed variables | Supported | In every dialect. A variable of interface type (local, FB member, VAR_INPUT, VAR_OUTPUT, VAR_GLOBAL; FB, method and FUNCTION), an ARRAY element of one (inline or a named ARRAY type) and a STRUCT field of one refers to an instance of an implementing FB and starts as NULL; in C++ it is a non-owning nullable reference (`IEC_ITF<I>`). It takes an instance of an FB that implements the interface (directly, through an extending interface or through a base FB), bare `THIS`, another interface variable of the same or an extending interface, or NULL (also as an input argument: `fb(c := inst)`, `F(inst)`); anything else is an error at the value, e.g. `Cannot assign FB_X to I_A: FB_X does not implement I_A`. `=` and `<>` compare the referenced instance, also with NULL; comparing with `0` (`itf = 0`, `itf <> 0`) is accepted in every dialect and means NULL. Storing `0` (`itf := 0`, `itf : I_A := 0`, `F(0)`) is a vendor extension, the feature `interface_zero` (refused with no dialect flag and under `--dialect iec-3`; see [DIALECTS.md](DIALECTS.md)); any other integer is an error in every dialect. `itf.M()` (also through a member chain, `a.itf.M()`) dispatches to the instance's method; a call through NULL raises the null-reference fault, as a NULL REF_TO dereference does. The only initializer is NULL (or `0` with `interface_zero`). A VAR_IN_OUT of interface type binds the instance itself (no copy-back). Properties through an interface variable: see Properties. Not yet: ARRAY OF an interface, a STRUCT field of interface type |
| ABSTRACT | Supported | Abstract FB (no instantiation) and abstract methods (pure virtual) |
| FINAL | Supported | Sealed FB and methods |
| OVERRIDE | Supported | Method override with C++ override specifier |
| PUBLIC/PRIVATE/PROTECTED | Supported | Access modifiers of methods. On VAR sections of a FUNCTION_BLOCK (Ed. 3 Table 53, 11a-11d) also INTERNAL, in every dialect; see the FUNCTION_BLOCK row |
| THIS | Supported | Self-reference in methods: `THIS.member` and a longer path (`THIS.a.b`, `THIS.arr[i]`, `THIS.xs[i].q`) as a value or an assignment target, `THIS.m()`, and `THIS.r REF= x` (the feature `ref_assign`). `THIS^.member` and `THIS^.m()` are a vendor extension, the feature `self_caret` (refused with no dialect flag and under `--dialect iec-3`). Bare `THIS^` (the own instance) is a vendor form that is still accepted in every dialect. Bare `THIS` refers to the own instance, e.g. passed into an interface-typed input |
| FB_init | Supported | An extension (IEC 61131-3 Ed. 3 has no initialisation method): the feature `fb_init` (refused with no dialect flag and under `--dialect iec-3`). A METHOD FB_init runs once per instance at start-up, global instances first, members before their holder, every FB_init of an EXTENDS chain base first, with the flags `bInitRetains` and `bInCopyCode` FALSE; init arguments `fb : FB_A(p := 1)` set its inputs. With the feature off, a declared FB_init gets a warning that it is not run. Not yet: instances local to a FUNCTION or METHOD, in VAR_TEMP or held in a STRUCT, and init arguments on a library FB (refused by compile). See [DIALECTS.md](DIALECTS.md) |
| SUPER | Supported | `SUPER.m()` and `SUPER.member` reach the base FB's method or member, through any number of EXTENDS levels, in every dialect; a member takes a longer path (`SUPER.s.b`, `SUPER.arr[i]`) and is also an assignment target (`SUPER.x := v`, `SUPER.r REF= y`). `SUPER();` (Ed. 3) calls the base body. The caret forms `SUPER^.m()`, `SUPER^.member` and `SUPER^()` are vendor forms that are still accepted in every dialect |

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
| Date and time (Table 36) | CONCAT_DATE, CONCAT_TOD, CONCAT_LTOD, CONCAT_DT, CONCAT_LDT, CONCAT_DATE_LTOD, SPLIT_DATE, SPLIT_TOD, SPLIT_LTOD, SPLIT_DT, SPLIT_LDT, DAY_OF_WEEK, in every dialect, as FUNCTIONs of the bundled `iec-standard-fb` library. The parts are inputs of any integer type (taken as LINT); SPLIT_* outputs YEAR and MILLISECOND as UINT and the other parts as USINT and returns TRUE; an output is bound as any FUNCTION's VAR_OUTPUT is (Function call row): accepted where its assignment is, so a UINT YEAR goes into a UINT, UDINT, ULINT, DINT or LINT variable in every mode. DAY_OF_WEEK returns an INT, 0 for Sunday to 6 for Saturday. Dates are proleptic Gregorian, before 1970 included. A user declaration of one of these names, or another library's FUNCTION, FUNCTION_BLOCK, TYPE or global (OSCAT's DAY_OF_WEEK, which counts Monday 1 to Sunday 7), is the one used, whatever order the libraries load in; it hides that function only, as none of them calls another |

**Names of standard functions are not reserved.** A user FUNCTION named like a standard function or operator
(`MAX`, `LEN`, `ADR`, `SIZEOF`, `INT_TO_REAL`) is the function a call of that name reaches, with its own
parameters. A library FUNCTION named like a standard function (OSCAT's `ROUND(IN, N)`, `ATAN2`) is reached
by a call whose arguments, positional or named, fit only its own signature (`ROUND(x, 2)`,
`ROUND(N := 3, IN := x)`); a call the standard function takes keeps the standard function (`ROUND(x)`),
whatever order the libraries are loaded in. A FUNCTION, FUNCTION_BLOCK, INTERFACE or TYPE named like a function the C++ runtime declares
(`SUB`, `MID`, `LIMIT`, `TRUNC_INT`) is emitted as `NAME_` in the generated C++; diagnostics, the debug table
and the REPL keep the ST name. So is a variable, STRUCT field or local named like a user type, whatever its
case, that another declaration of the same PROGRAM, FUNCTION_BLOCK (with its methods), FUNCTION or STRUCT
uses (`s3 : STRING(3)` next to `a : S3`): the name would otherwise hide the type in the C++ class or body.
A FUNCTION or METHOD parameter keeps its name. A FUNCTION or standard function called where a variable of its name, in any case, is in scope (a local, a parameter or a member that is no FB instance) is reached through its namespace in the C++; an FB instance of that name is what the call invokes, and its call has no value.

**Implicit conversions** (Figures 11 and 12) are accepted in every dialect and under `--strict`: an integer
into a wider one of the same signedness, an unsigned integer into a wider signed one (USINT into INT, DINT or
LINT; UINT into DINT or LINT; UDINT into LINT), SINT, INT, USINT and UINT into REAL, an integer up to 32 bits into
LREAL, REAL into LREAL, a bit string into a wider one (BOOL into BYTE included), and TIME, DT, DATE and TOD into
their long forms. Without `--strict` some conversions the figures leave explicit are also accepted (a bit string
and an integer of a sufficient width, DINT into REAL), and a narrowing is a warning; `--strict` refuses a narrowing
between integers and REALs but keeps the warning for one involving a bit string.

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
| LTON, LTOF, LTP | The timers with an LTIME preset and elapsed time |
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
| CONFIGURATION | Supported | A name declared twice among the VAR_GLOBAL blocks of a CONFIGURATION (in one block or two, of any type or value, CONSTANT included) is an error at the second declaration (`Symbol '<name>' already defined in scope '<configuration>'`) |
| RESOURCE ... ON | Supported | A RESOURCE may declare VAR_GLOBAL blocks (no other block): its globals are reached by the program instances of that resource only (also through the VAR_EXTERNAL of a function block such an instance holds, nested, in an ARRAY or STRUCT, or through a base block), and by the initial values of its own globals; a name a RESOURCE shares with the CONFIGURATION or another RESOURCE is an error, and so is a name declared twice in one RESOURCE (`Symbol '<name>' already defined in scope '<configuration>.<resource>'`) |
| TASK ... WITH INTERVAL | Supported | |
| Program instances | Supported | `name : programType` with task assignment |
| VAR_GLOBAL in configuration | Supported | Not of a function block type, nor of a STRUCT or ARRAY holding one (refused at the declaration; declare it in a global variable list or a PROGRAM) |
| Library namespace | Supported | Set when compiling a library (`--lib-namespace`, `namespace` in the library API); no pragma sets it |

## Language Extensions

| Feature | Status | Notes |
|---------|--------|-------|
| Nested comments `(* (* *) *)` | Supported | Arbitrary nesting depth |
| Pragmas `{...}` (6.2, Table 4) | Supported | Lexed wherever whitespace may appear (not in string literals or comments) and skipped with a `Pragma ignored: {...}` warning, in every dialect; no pragma is interpreted except `{external}` and, under the dialect feature `conditional_pragmas`, the conditional ones. Conditional-compilation pragmas are errors without that feature. A pragma ends at the first `}` (no nesting); an unclosed `{` is an error |
| Conditional compilation `{IF}` / `{ELSIF}` / `{ELSE}` / `{END_IF}` | Vendor extension, under `conditional_pragmas` | Not IEC 61131-3 (a CODESYS / vendor-toolchain extension). With the dialect feature on, `defined()`, `project_defined()` (project defines only), `hasvalue()` (single-quoted value), `AND`/`OR`/`NOT`; case-sensitive define names from `-D`, `--pragma-define`, `--file-define` (one file only) and from `{define NAME ['value']}` / `{undefine NAME}` in the source (to the end of that file; `{undefine}` cannot remove a `-D` define); inactive branches are blanked line-preservingly. Without it, every directive is an error. The symbol operators are refused. See [DIALECTS.md](DIALECTS.md#conditional-pragmas) |
| Inline C++ | Supported | `{external ...}` as a statement in a POU body (braces inside it may nest); refused elsewhere, e.g. in a VAR block |
| Global constants (`-D`) | Supported | CLI `-D NAME=VALUE` with an integer VALUE, emits `constexpr`; every `-D` name is also a conditional-pragma define |
| Dynamic memory | Supported | `__NEW(type)`, `__DELETE(ptr)` |
| POINTER TO, `ADR()` | Supported | Full pointer type with dereference; the untyped literal `0` stored in a POINTER TO of any target type (assignment, initial value, input argument) is NULL, and `p = 0` / `p <> 0` compare the pointer itself, also for a STRUCT target; `p : POINTER TO T := ADR(x);` binds the pointer as an initial value, for a PROGRAM or FB member, a FUNCTION or METHOD local and a global (in a FUNCTION or METHOD `x` must be declared before `p`; a POINTER TO field of a STRUCT takes only NULL or `0` as its default; any other pointer or REF_TO initial value than NULL or `0` is assigned in the body); `p := ADR(x)` takes the address of a variable of any type, a STRUCT, UNION, ARRAY or FB instance included, into a POINTER TO it (`p^.field` reads and writes through it). Variables are laid out as on a PLC (each elementary value its own size, ARRAY and STRUCT packed with natural alignment, `STRING(n)` as `n + 1` NUL-terminated bytes), so a POINTER TO of another shape reads and writes the target's real bytes, `SIZEOF` returns those sizes, and characters plus a 0 written through a pointer into a STRING change its `LEN`; see [RUNTIME.md](RUNTIME.md). The feature `pointer_to` (`ADR` and `POINTER TO` are refused under `--dialect iec-3`; IEC `REF_TO`, `REF()` and `^` stay accepted, as do the vendor forms bare `THIS^` and `SUPER^`) |
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
