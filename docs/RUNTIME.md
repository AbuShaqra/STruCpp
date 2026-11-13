# C++ Runtime Library

The STruC++ runtime is a header-only C++14 library in `src/runtime/include/`. Every compiled ST program includes these headers. The runtime provides IEC 61131-3 type wrappers, a force table for variable forcing, and standard function implementations.

## Type Definitions (`iec_types.hpp`)

All types live in the `strucpp` namespace:

```cpp
// Bit strings
using BOOL_t  = bool;
using BYTE_t  = uint8_t;
using WORD_t  = uint16_t;
using DWORD_t = uint32_t;
using LWORD_t = uint64_t;

// Signed integers
using SINT_t = int8_t;
using INT_t  = int16_t;
using DINT_t = int32_t;
using LINT_t = int64_t;

// Unsigned integers
using USINT_t = uint8_t;
using UINT_t  = uint16_t;
using UDINT_t = uint32_t;
using ULINT_t = uint64_t;

// Floating point
using REAL_t  = float;
using LREAL_t = double;

// Time/date (nanosecond precision, stored as int64_t)
using TIME_t  = int64_t;
using DATE_t  = int64_t;
using TOD_t   = int64_t;  // TIME_OF_DAY
using DT_t    = int64_t;  // DATE_AND_TIME
using LTIME_t = int64_t;  // 64-bit time (nanosecond precision)
using LDATE_t = int64_t;
using LTOD_t  = int64_t;
using LDT_t   = int64_t;
```

## IECVar Wrapper (`iec_var.hpp`)

`IECVar<T>` wraps every program variable:

```cpp
template<typename T>
class STRUCPP_MAY_ALIAS IECVar {
    T value_;                    // the only member

public:
    operator T() const;          // read
    IECVar& operator=(T v);      // write

    // Raw pointer for I/O memory binding
    T* raw_ptr();

    // Cross-type converting constructor (enables implicit widening)
    template<typename U> IECVar(const IECVar<U>& other);
};
```

The implicit `operator T()` and `operator=(T)` make IECVar transparent in expressions -- ST code like `counter := counter + 1` generates natural C++.

Forcing is not part of the variable: it lives in the force table (below). Every
elementary leaf -- a struct field, an array element, a function-block member --
can be forced on its own, by address.

### Memory layout

A variable is laid out as on a PLC: `IECVar<T>`, `IEC_ENUM_Var<E>` and the
other elementary wrappers are exactly their value -- the size and alignment of
`T`, standard layout, trivially copyable (`static_assert`ed in `iec_var.hpp`).
So `ARRAY[0..3] OF BYTE` is 4 bytes, a `STRUCT` packs its fields with natural
alignment (`STRUCT a : BYTE; b : WORD; c : BOOL; END_STRUCT` is 6 bytes; on AVR
everything is 1-byte aligned), an enumeration without a declared base is an
`INT`, and `SIZEOF` returns those sizes. A `POINTER TO` of another shape reads
and writes the target's real bytes: a `DWORD` as `ARRAY[0..3] OF BYTE`, a
`REAL` as a `DWORD`, a `STRUCT` as bytes. A STRING is its characters and a NUL
(see String Types).

### Pointer punning and strict aliasing

Reading an object through a pointer of another type is undefined in C++, and
GCC and Clang's type-based alias analysis can reorder such accesses at `-O2`.
Two layers keep the IEC semantics:

- `STRUCPP_MAY_ALIAS` (`iec_types.hpp`) marks `IECVar`, `IEC_ENUM_Var` and every
  generated STRUCT, and a `POINTER TO` a scalar dereferences through an
  aliasing type. This travels with the headers, so it holds whatever flags a
  host build uses. It expands to `__attribute__((__may_alias__))` on GCC and
  Clang; it is empty elsewhere (MSVC does no type-based alias analysis).
- The builds this repo drives (`strucpp --build`, the CLI test runner, the VS
  Code extension) also pass `-fno-strict-aliasing`. Host builds are
  recommended to do the same; a compiler other than GCC, Clang or MSVC must.

### Located Variables

Located variables (`AT %IX0.0`) use `raw_ptr()` to bind to an I/O image table at runtime. The code generator produces a descriptor array (`__located_vars_[]`) with metadata for each located variable (area, size, byte/bit indices) and accessor methods (`getLocatedVars()`, `getLocatedVarCount()`).

## Force Table (`iec_force.hpp`)

`strucpp::force` keeps forced values in a fixed table beside the variables
instead of inside them. A forced value is written into its variable when the
force is set, and again at both cycle boundaries by a `force::Scope` held
around a program's cycle (also on an early `RETURN` or a fault). Between the two
boundaries a program that writes a forced variable sees its own write, as with
typical PLC forcing. What changes for a user, compared with forcing inside the
variable:

- A program that writes a forced variable reads its own write until the cycle
  ends; at the end, and at the start of the next cycle, the forced value is back.
- A forced function-block input that the call passes (`fb(i := x)`) takes the
  call's value inside the cycle; the forced value is restored at cycle end.
- Every external reader (the debugger's `handle_read` / `handle_ptr`, OPC-UA,
  retain save) sees the forced value throughout, and a soft write
  (`handle_write`, a REPL `set`) to a forced variable is dropped.
- At most `STRUCPP_FORCE_SLOTS` scalars and `STRUCPP_FORCE_STRING_SLOTS` strings
  can be forced at once; a force past the bound is refused
  (`STATUS_FORCE_TABLE_FULL`, 0x88, on the debugger protocol).

| Call | Purpose |
|------|---------|
| `set(ptr, bytes, size, flags, apply, lock)` | Force a variable; writes it now. `lock` (optional, used under `STRUCPP_THREADED`) is the `std::mutex` of the shared global the variable lives in. Returns `Ok`, `Full`, `TooLarge` or `BadArgument` |
| `set_bit(ptr, bit, value, flags, lock)` | Force bit `bit` (0..7, 0 the least significant) of the byte at `ptr`, a BIT member: only that bit is written, now and at every apply. The forced bits of one byte share one slot (`bytes[0]` values, `bytes[1]` mask) |
| `clear_bit(ptr, bit)`, `read_bit(ptr, bit, &value)` | Stop forcing one bit (the slot is freed with its last bit); query a forced bit |
| `clear(ptr)` / `clear_all()` | Stop forcing; the variable keeps its current value |
| `is_forced(ptr)`, `read(ptr, dest, cap)`, `value_ptr(ptr, &size)` | Query a force |
| `apply_all()`, `apply_owned(base, len)` | Write forced values in |
| `Scope(self, len)` | Applies on construction and destruction |

The table holds `STRUCPP_FORCE_SLOTS` scalar slots of 8 bytes (64; 16 on AVR)
and `STRUCPP_FORCE_STRING_SLOTS` slots of `STRUCPP_FORCE_STRING_BYTES` bytes for
larger values (8 of 256; 1 of 127 on AVR). All three are overridable with `-D`.
Under `STRUCPP_THREADED` a mutex guards the table, and a `Scope` applies only
the forces inside its own program instance plus those marked `FLAG_GLOBAL`.

Generated code opens every PROGRAM's `run()` with
`force::Scope __force_scope(this, sizeof(*this));`. The debug dispatch
(`handle_set`, `handle_read`, `handle_write`, `handle_ptr`) and the REPL force
through the table; `handle_set` marks a force on a configuration global
`FLAG_GLOBAL` from the generated `debug_array_kind[]` (`DEBUG_ARRAY_GLOBAL` /
`DEBUG_ARRAY_PROGRAM` per array). The pointer `handle_ptr` returns for a forced
leaf is its slot, valid until the force changes.

Under `STRUCPP_THREADED` a configuration global is also written under its own
lock (the `GlobalVar` mutex the program's accesses take): the generated table
provides `debug_leaf_lock(arr, elem)` for every leaf of a `DEBUG_ARRAY_GLOBAL`
array, `handle_set` hands it to the force slot, and `handle_read` /
`handle_write` hold it around the access. The force table writes such a slot
with both locks held, the global's taken first (a global's lock may be held
while the table lock is taken, never the reverse), and only while the slot
still holds that variable and lock, so a write never uses a value a slot that
was cleared, re-forced or reused no longer has. Without `STRUCPP_THREADED`
none of this is compiled. A hand-written debug table (as in the runtime's own
tests) must define `void* debug_leaf_lock(uint8_t arr, uint16_t elem) noexcept`
in `strucpp::debug` in a threaded build; returning `nullptr` is valid when no
leaf is a global.

The dispatch's `TypeOps::force` op takes a fourth argument in every build, the
leaf's lock (`void*`, null when there is none); `force_impl`, `force_string`
and `force_wstring` default it to null.

### BIT leaves (feature bit_type)

A BIT member of a STRUCT has no address of its own, so its debug-table entry
addresses the byte that holds it:

- `Entry.tag` is `TAG_BIT` (21) and `Entry.ptr` points at the byte;
- the bit number, 0 the least significant bit of that byte, is in the three high
  bits of `Entry.flags` (`leaf_bit(flags)`, `flags >> LEAF_BIT_SHIFT` with
  `LEAF_BIT_SHIFT` 5); the low bits keep their meaning (`LEAF_FLAG_READONLY`,
  `LEAF_FLAG_RETAIN`);
- on the wire the value is one byte, 0 or 1, as for BOOL (`handle_read` writes
  one byte; `handle_write` and `handle_set` take one byte, non-zero for TRUE).

`handle_read` reads the bit, or its forced value while it is forced;
`handle_write` sets or clears only that bit and is ignored while it is forced;
`handle_set` forces or unforces only that bit through `force::set_bit` /
`force::clear_bit`, so the other bits of the byte keep the program's values.
`handle_ptr` returns `nullptr` with length 0 for a BIT leaf. For a configuration
global the same `debug_leaf_lock` is held as for its other leaves. In the debug
map (`debugMap.leaves`) such a leaf has `"type": "BIT"`, `"size": 1` and
`"bit": n`, and `typeTags` lists `"BIT": 21`, only in a map that has a BIT leaf.
A host that does not know the tag treats the leaf as of an unknown type.

For a source-level debugger that has stopped the program (the VS Code
extension), the header exports `strucpp_force_capture(void* ptr, unsigned size)`
-- force the variable to the bytes it holds now -- and `strucpp_unforce(void*
ptr)`. They return 0 on success and never wait for the table lock (5 when it is
held).

## Type Traits (`iec_traits.hpp`)

Template traits for compile-time type categorization:

```cpp
template<typename T> struct is_any_int;     // SINT, INT, DINT, LINT, USINT, ...
template<typename T> struct is_any_real;    // REAL, LREAL
template<typename T> struct is_any_num;     // is_any_int || is_any_real
template<typename T> struct is_any_bit;     // BOOL, BYTE, WORD, DWORD, LWORD
template<typename T> struct is_any_string;  // IECString, IECWString
```

Used by standard function templates for type-safe dispatch.

## LTIME

LTIME is stored as TIME is, signed 64-bit nanoseconds (`IEC_LTIME` and
`IEC_TIME` are both `IECVar<int64_t>`). For debugger hosts an LTIME leaf is a
`TAG_TIME` leaf of 8 bytes, and `libs/iec-types.json` lists LTIME with the
`duration-ns-i64` wire format TIME uses; a host tells the two apart by the
declared type, not by the wire. `TO_LTIME` and `ADD_LTIME` / `SUB_LTIME` /
`MUL_LTIME` / `DIV_LTIME` are the TIME helpers under their LTIME names.

LDATE, LTOD and LDT are stored as DATE (days since 1970-01-01), TOD and DT
(nanoseconds) are; an LDATE, LTOD or LDT leaf is a `TAG_DATE`, `TAG_TOD` or
`TAG_DT` leaf of 8 bytes, and `libs/iec-types.json` lists them with the DATE,
TOD and DT wire formats. An LDATE leaf's value on the debug wire is therefore a
day count since 1970-01-01, as a DATE leaf's is, not the nanoseconds IEC
61131-3 Ed. 3 (Table 10) specifies for LDATE. The debug map (`debugMap.leaves`)
lists an LTIME, LDATE, LTOD or LDT leaf under its short type name (TIME, DATE,
TOD, DT), as the wire is the same; a host that shows the long name takes it from
the declaration. `TO_LDATE`, `TO_LTOD` and `TO_LDT` are the casts.

## CHAR and WCHAR

`IEC_CHAR` and `IEC_WCHAR` are `IECVar<char>` and `IECVar<char16_t>`. A CHAR
holds a Windows-1252 byte, so code that orders or converts one to a number
goes through its unsigned code (generated code casts it to `uint8_t`). For
debugger hosts a CHAR leaf is a `TAG_BYTE` leaf of 1 byte and a WCHAR leaf a
`TAG_WORD` leaf of 2 bytes; `libs/iec-types.json` lists them with the `uint8`
and `uint16` wire formats. `IECStringVar::at(i)` and `IECWStringVar::at(i)`
give the i-th character, 1-based, and raise the out-of-bounds error
(`std::out_of_range`, or `iec_runtime_fault(IecFault::ArrayBounds)` without
exceptions) outside the current length.

## String Types (`iec_string.hpp`, `iec_wstring.hpp`)

```cpp
template<size_t N = 254>
class IECString {
    char data_[N + 1];       // NUL-terminated; nothing else
    // ...
};

template<size_t N = 254>
class IECWString {
    char16_t data_[N + 1];   // NUL-terminated UTF-16 code units
    // ...
};
```

Fixed-capacity strings laid out as on a PLC: `STRING(N)` is `N + 1` bytes and
`WSTRING(N)` is `2 * (N + 1)`, so `SIZEOF(STRING(80))` is 81. There is no stored
length: the length is the position of the first NUL, at most `N` (`memchr` for
STRING). Characters and a 0 written through a `POINTER TO ARRAY OF BYTE` over a
string therefore change what `LEN` reports, and a string ends at an embedded
`$00`. A constructed string is zero past its terminator. Comparisons and
searches are bounded by the lengths, and every runtime operation that writes a
string re-terminates it. `N` defaults to 254 but can be parameterized via
`STRING(100)` declarations. String functions (LEFT, RIGHT, MID, CONCAT, FIND,
etc.) have explicit overloads for `IECString<N>` to work around C++ template
deduction limitations with implicit conversions.

`IECStringVar<N>` / `IECWStringVar<N>`, the type of a STRING / WSTRING variable,
hold exactly one `IECString<N>` / `IECWString<N>`.

A STRING holds Windows-1252 (CP1252) characters, one byte each, as common vendor
toolchains do: `STRING(N)` holds N characters, `LEN('ä')` is 1 and
`CODE('€', 1)` is 128. The compiler writes a STRING literal's characters as their
CP1252 bytes and refuses one CP1252 lacks. Bytes 0x80-0x9F are the CP1252
characters (0x80 is U+20AC); the five unassigned ones (0x81, 0x8D, 0x8F, 0x90,
0x9D) stand for the C1 control of that value. `iec_cp1252.hpp` holds the table:

- `STRING_TO_WSTRING` and `CHAR_TO_WCHAR` widen each byte to its CP1252 code
  point. `WSTRING_TO_STRING` and `WCHAR_TO_CHAR` write a character CP1252 lacks
  as `?` (a surrogate pair is one character), as Windows' `WideCharToMultiByte`
  does with its default character; IEC 61131-3 leaves the case open.
- The debug wire carries a STRING as UTF-8 (`len8-utf8`, unchanged): `handle_read`
  transcodes the stored bytes, the length byte counts UTF-8 bytes, and a value
  whose UTF-8 form passes the 126-byte window is cut before the first character
  that does not fit whole. `handle_write` and `handle_set` (force) decode a UTF-8
  payload to CP1252; a payload that is not UTF-8, holds a character CP1252
  lacks or holds a NUL (the STRING would end there), is refused with
  `STATUS_NOT_ENCODABLE` (0x89) and the leaf is left as
  it was.
- `handle_ptr` (the copy-free path OPC-UA uses) returns the stored CP1252 bytes
  and their count, not UTF-8: a host that needs Unicode transcodes them
  (`cp1252::to_utf8`).
- The 32-entry table for 0x80-0x9F is plain const data on every target: on AVR
  it costs 64 bytes of SRAM.
- The REPL shows a STRING as UTF-8 and decodes UTF-8 input; the test framework
  shows STRING values and assertion messages as UTF-8.

## Array Types (`iec_array.hpp`)

```cpp
template<typename T, int Lower, int Upper>
class Array1D;

template<typename T, int L1, int U1, int L2, int U2>
class Array2D;

template<typename T, int L1, int U1, int L2, int U2, int L3, int U3>
class Array3D;
```

IEC arrays use 1-based (or arbitrary-based) indexing. The template parameters encode bounds for compile-time size calculation. Bounds checking is performed at runtime in debug builds.

## Run-time faults with a site

A fault the compiler can place names where it happened. Integer division by zero (`iec_div`) raises
`strucpp::IecSiteFault` (a `std::runtime_error`) on a hosted target, with the message
`Division by zero in <POU>, line <n>, task <task>`, and calls `iec_runtime_fault(IecFault::DivideByZero, ...)`
on a target without exceptions. The POU and line come from the call site (`strucpp::iec_site{"MAIN", 12}`).
The task is the one the runtime named on this thread with `strucpp_set_current_task(name)` before running
it (thread-local under `STRUCPP_THREADED`); it is left out when none is set.

A store into a subrange variable goes through `iec_subrange_store`, which raises the same fault
(`IecFault::Subrange`) with `Value <v> outside <lo>..<hi> stored in <variable>` when the value is outside the range.

Where the fork dispatches the programs itself, it names the task:

- the REPL and the cyclic runner (`repl_run`, `cyclic_run`) set the task of each program before its
  cycle and clear it after; a program bound to a task in a CONFIGURATION carries that task's name, and a
  program run without a CONFIGURATION carries none;
- the `--test` runner names each test case as its task, as `TEST '<name>'`.

A runtime that runs the generated programs itself (an embedding scheduler, the threaded runtime of a host
such as OpenPLC) has no dispatcher in the fork. It must call `strucpp::strucpp_set_current_task(name)` on
the thread that runs a task, before that task's programs run in each cycle, and
`strucpp::strucpp_set_current_task(nullptr)` after them. The name is not copied: pass a string that
outlives the call, such as a literal.

## Pointer and Reference Types

### POINTER TO (`iec_pointer.hpp`)

```cpp
template<typename T>
class IEC_Ptr {
    T* ptr_;
public:
    T& operator*();        // Dereference
    T* operator->();
    IEC_Ptr& operator=(T* p);
    explicit operator bool() const;  // Null check
};
```

Supports CODESYS-style `POINTER TO` declarations with dereference via `^` operator.

### REF_TO and REFERENCE_TO (`iec_ptr.hpp`)

```cpp
template<typename T> class IEC_REF_TO;       // Explicit dereference with ^
template<typename T> class IEC_REFERENCE_TO;  // Implicit dereference (CODESYS style)
```

`REF_TO` follows the IEC standard (requires explicit dereference). `REFERENCE_TO` follows the CODESYS convention (implicit dereference -- the reference behaves like the referenced variable).

### ADR Function

`ADR(variable)` returns the memory address of a variable as `ULINT`. Implemented in `iec_std_lib.hpp`.

## Memory Management (`iec_memory.hpp`)

Dynamic allocation for CODESYS compatibility:

```cpp
template<typename T> T* iec_new();                  // __NEW(Type)
template<typename T> T* iec_new_array(size_t n);    // __NEW(Type, size)
template<typename T> void iec_delete(T*& ptr);       // __DELETE(ptr)
template<typename T> void iec_delete_array(T*& ptr); // __DELETE(array_ptr)
```

Uses `malloc`/`free` with placement new. Sets pointer to `nullptr` after deletion.

## Composite Types

- **Structs** (`iec_struct.hpp`): Plain C++ structs with IECVar-wrapped fields. Each byte of BIT members
  (feature bit_type) is one member `bits_<n>_` of a struct `<STRUCT>_bits<n>` holding up to 8 `bool`
  bitfields, least significant bit first; its constructor zeroes the byte, so unused bits read 0. In a
  UNION's storage such a byte is reached through `union_bit<Bit, Loc>` proxies (`iec_union.hpp`) that
  write one bit only
- **Enums** (`iec_enum.hpp`): C++ `enum class` with configurable underlying type; without a declared base it is `INT_t` (`DINT_t` when a value is outside the INT range or not a foldable constant)
- **Subranges** (`iec_subrange.hpp`): Runtime range validation on assignment

## Time Types (`iec_time.hpp`, `iec_date.hpp`, `iec_dt.hpp`, `iec_tod.hpp`)

All time/date types use nanosecond-precision `int64_t` storage. Arithmetic operations (`+`, `-`, comparison) are defined. Time literal parsing handles the IEC format: `T#1h2m3s4ms5us6ns`. LTIME types share the same int64_t representation with nanosecond precision.

## Standard Functions (`iec_std_lib.hpp`)

Template implementations of all IEC 61131-3 standard functions:

| Category | Functions |
|----------|-----------|
| Numeric | ABS, SQRT, EXPT, LN, LOG, EXP |
| Trigonometric | SIN, COS, TAN, ASIN, ACOS, ATAN, ATAN2 |
| Selection | SEL, MIN, MAX, LIMIT, MUX |
| Comparison | GT, GE, EQ, LE, LT, NE |
| Bitwise | AND, OR, XOR, NOT, MOVE |
| Bit Shift | SHL, SHR, ROR, ROL |
| Conversion | *_TO_* functions (INT_TO_REAL, REAL_TO_INT, etc.) |
| String | LEN, LEFT, RIGHT, MID, CONCAT, FIND, REPLACE, INSERT, DELETE, UPPER, LOWER, TRIM |
| System | ADR, SIZEOF |

Variadic functions (ADD, MUL, MIN, MAX) accept 2+ arguments via template parameter packs.

Integer `MOD` returns 0 for a divisor of 0 (Table 29, note e), and for a signed divisor of -1 without dividing (the minimum value MOD -1 would trap): the `MOD` function, the `%` operators of `IECVar` and subrange values, and `iec_mod(a, b)`, which the code generator emits for the `MOD` operator unless the divisor is a nonzero integer literal. `SHL` and `SHR` return 0 for a shift count at or above the bit width of IN (1 for BOOL; a count wider than `int` is not truncated), and a signed `SHR` returns the sign (0 or -1), so no shift reaches the undefined C++ case.

## REPL Runtime (`runtime/repl/`)

The interactive REPL binary uses [isocline](https://github.com/daanx/isocline) (MIT licensed) for line editing with syntax highlighting, tab completion, and command history. `iec_repl.hpp` provides the STruC++ REPL harness that wraps compiled programs with an interactive shell for variable inspection, function invocation, and time advancement for FB testing.

## Header Summary

| Header | Purpose |
|--------|---------|
| `iec_types.hpp` | Elementary type aliases (including LTIME/LDATE/LTOD/LDT) |
| `iec_var.hpp` | IECVar wrapper |
| `iec_force.hpp` | Force table: forced values held beside their variables, applied at cycle boundaries |
| `iec_traits.hpp` | Type category traits |
| `iec_string.hpp` | STRING type and functions |
| `iec_wstring.hpp` | WSTRING type and functions |
| `iec_char.hpp` | CHAR type |
| `iec_array.hpp` | Array templates (1D, 2D, 3D) |
| `iec_struct.hpp` | Struct support |
| `iec_enum.hpp` | Enum support |
| `iec_subrange.hpp` | Subrange type with validation |
| `iec_time.hpp` | TIME/LTIME types and arithmetic |
| `iec_date.hpp` | DATE/LDATE type |
| `iec_tod.hpp` | TIME_OF_DAY/LTOD type |
| `iec_dt.hpp` | DATE_AND_TIME/LDT type |
| `iec_located.hpp` | Located variable (AT %IX0.0) support |
| `iec_pointer.hpp` | POINTER TO type |
| `iec_ptr.hpp` | REF_TO, REFERENCE_TO, and ADR support |
| `iec_retain.hpp` | RETAIN variable tracking |
| `iec_memory.hpp` | Dynamic allocation (__NEW/__DELETE) |
| `iec_std_lib.hpp` | Standard function implementations |

## Runtime Unit Tests (`runtime/tests/`)

The headers have their own GoogleTest suite, built by `src/runtime/CMakeLists.txt`
(`runtime_tests`, compiled with `-Wall -Wextra -Wpedantic -Werror`). Every
`tests/*.cpp` must be listed in `add_executable(runtime_tests ...)`;
`tests/integration/runtime-cpp-tests.test.ts` fails if one is not.

```bash
cmake -S src/runtime -B build/runtime && cmake --build build/runtime -j && ctest --test-dir build/runtime --output-on-failure
```

googletest is taken, in this order, from a local checkout passed as
`-DFETCHCONTENT_SOURCE_DIR_GOOGLETEST=<dir>` (works offline), from an installed
package when CMake finds one (any version, not necessarily v1.14.0), or fetched
from GitHub (v1.14.0).

`npm test` runs the same steps in a temporary build directory
(`tests/integration/runtime-cpp-tests.test.ts`). That runner, not CMake, reads
these environment variables:

| Variable | Effect |
|----------|--------|
| `STRUCPP_GTEST_SOURCE_DIR` | Forwarded as `-DFETCHCONTENT_SOURCE_DIR_GOOGLETEST` |
| `STRUCPP_REQUIRE_RUNTIME_TESTS=1` | A skip becomes a failure (set in CI) |
| `STRUCPP_RUNTIME_TEST_JOBS` | Build and ctest parallelism (default: half the cores, at most 4) |

Without `STRUCPP_REQUIRE_RUNTIME_TESTS=1` the test is skipped, with the reason
printed, when cmake or a C++ compiler is missing or the googletest clone fails
for a network reason. Any other configure, build or test failure fails.
