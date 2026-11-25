# Supporting References in Struct Fields

Status: **gap / planned**. POU‑level references work; references declared as
**struct fields** do not. This document describes the current behaviour, why
struct fields are a separate code path, the exact gap, and a concrete plan to
close it.

## Background: how references work today (POU level)

As of v0.5.6, `REF_TO` and `REFERENCE TO` are fully wired for variables
declared in a POU (program / function / function block locals, inputs,
outputs):

- **Declaration** — `mapTypeRefToCpp` (`src/backend/codegen.ts`) maps
  `referenceKind`:
  - `pointer_to`  → `IEC_Ptr<T>`
  - `ref_to`      → `IEC_REF_TO<T>`
  - `reference_to`→ `IEC_REFERENCE_TO<T>`

  where `T` is the **raw** element type (`INT_t`, a UDT name, or an
  `Array1D<…>`). The wrappers live in `src/runtime/include/iec_pointer.hpp`
  and are pulled in via `#include "iec_pointer.hpp"` in the generated header.
- **`REF=` rebind** — `generateRefAssignStatement` (`src/backend/codegen.ts`)
  branches on the target's reference kind, resolved from the
  `currentScopeVarRefKinds` scope map:
  - `reference_to` → `target.bind(source)`
  - `ref_to`       → `target = REF(source)` (`IEC_REF_TO` has no `bind()`)
- **Read / write** — `REFERENCE TO` reads/writes ride on the implicit
  `operator T()` / `operator=(const T&)` of `IEC_REFERENCE_TO`; `REF_TO` uses
  explicit `^` (lowered to `(*ref)` / `.deref()`).
- **Initialization** — references are skipped from the program constructor
  initializer list and default‑construct unbound (`IEC_REFERENCE_TO` gained a
  default constructor for exactly this reason).

## The gap: struct fields use a different code path

Struct fields are **not** emitted through `mapTypeRefToCpp`. They go through
`generateStructType` + `mapStructFieldTypeToCpp` in
`src/backend/type-codegen.ts`, which has its own type model:

- Elementary field → IECVar‑wrapped type (`INT` → `IEC_INT`,
  i.e. `IECVar<int>`).
- `STRING`/`WSTRING` → `IECStringVar<N>` / `IECWStringVar<N>`.
- Composite (struct/FB/enum/array) → bare name / `Array1D<…>`.

The **only** `referenceKind` this path handles is `pointer_to`, and it does so
by appending a raw `*`:

```ts
// src/backend/type-codegen.ts  (generateStructType)
if (field.type.referenceKind === "pointer_to") {
  cppType += "*";              // e.g. POINTER TO INT  ->  IEC_INT*
}
```

Consequences:

1. **`ref_to` / `reference_to` fields fall through unhandled.** A
   `REF_TO INT` / `REFERENCE TO INT` field is emitted as the plain wrapped
   field type (`IEC_INT`) — exactly the broken state POU references were in
   before v0.5.6. The reference semantics are lost.
2. **Even pointer fields use a different representation than POU pointers.**
   Struct `POINTER TO INT` → `IEC_INT*` (a raw pointer to `IECVar<int>`),
   whereas a POU `POINTER TO INT` → `IEC_Ptr<INT_t>`. These are not the same
   type. This is a pre‑existing inconsistency, relevant to the design choice
   below.

## Plan to close the gap

### 1. Map reference fields to the runtime wrappers

In `generateStructType` (`src/backend/type-codegen.ts`), extend the
`referenceKind` handling to cover references, mirroring `mapTypeRefToCpp`'s
raw‑element resolution. The wrappers take the **raw** element type, so this
must bypass `mapStructFieldTypeToCpp` (which returns the IECVar‑wrapped type
`IEC_INT`) and use the raw mapping (`INT_t`):

```ts
switch (field.type.referenceKind) {
  case "pointer_to":   cppType += "*"; break;                 // unchanged
  case "ref_to":       cppType = `IEC_REF_TO<${rawElem}>`; break;
  case "reference_to": cppType = `IEC_REFERENCE_TO<${rawElem}>`; break;
}
```

where `rawElem` is resolved the same way `mapTypeRefToCpp` does it (elementary
→ `mapTypeToCpp(name)`, UDT → struct/`Program_*` name, array → `Array1D<…>`).
Factoring that element‑type resolution into a shared helper used by both
`codegen.ts` and `type-codegen.ts` avoids drift.

`iec_pointer.hpp` is already included in the generated header, so no extra
include is needed for structs defined there.

### 2. Field default‑initialization

The existing `else` branch default‑constructs fields with `{}`. That is
correct for both reference wrappers:

- `IEC_REF_TO<T> f{};`       → default ctor → `nullptr`.
- `IEC_REFERENCE_TO<T> f{};` → default ctor (added in v0.5.6) → unbound.

Only `pointer_to` should keep the `= nullptr` initializer. Ensure
`ref_to` / `reference_to` fall into the `{}` branch (they will, since the
`= nullptr` branch is keyed on `pointer_to`). Do **not** emit `name(0)` /
`= 0` for reference fields — `IEC_REF_TO`'s pointer and `nullptr_t` ctors make
that ambiguous (the same trap fixed for the program constructor).

### 3. `REF=` on a struct‑field target (the hard part)

`generateRefAssignStatement` resolves the target kind from
`currentScopeVarRefKinds`, which is keyed by **simple top‑level variable
name**. A field target such as `myStruct.refField REF= x` is a
`VariableExpression` whose `.name` is `myStruct` (the field is in
`fieldAccess` / `accessChain`), so the lookup misses and the code falls back
to `.bind()`:

- For a `reference_to` field, `.bind()` is correct — so **`REFERENCE TO`
  fields happen to work** through the existing default.
- For a `ref_to` field, `.bind()` is **wrong** (`IEC_REF_TO` has no `bind()`);
  it must lower to `field = REF(x)`.

To close this, resolve the field's `referenceKind` by walking the access
chain against the owning struct's `StructDefinition` (the field declarations
already carry `referenceKind`). Suggested approach: a helper
`resolveTargetReferenceKind(expr)` that, for a `VariableExpression` with a
field access chain, looks up the base variable's struct type and follows the
chain to the final field's `referenceKind`; falls back to
`currentScopeVarRefKinds` for the simple‑variable case.

**Narrow workaround until then:** binding a `REF_TO` struct field via plain
assignment — `myStruct.refField := REF(x)` — already works (it is an ordinary
assignment, not a `REF=` statement). Only the `REF=` *operator form* on a
`ref_to` field is affected.

### 4. Tests

Add g++‑backed integration tests (alongside the POU reference tests in
`tests/integration/cpp-compile.test.ts`) covering:

- A struct with a `REF_TO INT` field: declare, bind via `:= REF(x)`, `^`
  read/write.
- A struct with a `REFERENCE TO INT` field: declare, `REF=` rebind, implicit
  read/write.
- Field access through a struct instance and through a pointer/reference to a
  struct.
- Codegen unit assertion that fields emit `IEC_REF_TO<…>` /
  `IEC_REFERENCE_TO<…>`.

## Design decision: wrapper vs. raw pointer for struct fields

Struct **pointer** fields are emitted as raw `IEC_INT*`, not `IEC_Ptr<T>`.
That raises the question of whether struct **reference** fields should follow
the raw model or the POU wrapper model.

Recommendation: **use the wrappers** (`IEC_REF_TO<T>` / `IEC_REFERENCE_TO<T>`)
for reference fields. The wrappers are what make `REF=`, `.bind()`, implicit
deref, and null checking work, and they keep struct references semantically
identical to POU references. The resulting inconsistency with raw `IEC_INT*`
pointer fields is acceptable; unifying the struct **pointer** representation
onto `IEC_Ptr<T>` is a separate, larger cleanup that should not block
reference‑field support.

Update: that cleanup is done. A struct (and UNION) **pointer** field is now the
`IEC_Ptr<T>` a variable gets, so `q.p := ADR(udi)`, `q.p := pd` and `__NEW`
into a field build as they do for a variable. `IEC_Ptr<T>` is pointer-sized,
standard-layout and trivially copyable (a `static_assert` in `iec_ptr.hpp`),
so the struct's size, alignment and field offsets are unchanged.

## Edge cases / open questions

- **Nested structs and arrays of reference fields** — the element‑type
  resolution must handle `ARRAY[…] OF REF_TO T` and references whose target is
  a UDT (`REF_TO MyStruct`). The raw‑element resolution from `mapTypeRefToCpp`
  already covers UDT and array element types and should be reused verbatim.
- **`REFERENCE TO` field with no initializer** — relies on the default
  constructor added in v0.5.6; unbound until first `REF=`. Reading it before
  binding is undefined behaviour (matches CODESYS and the POU case).
- **`REF=` field‑kind resolution** is the only non‑mechanical piece; it
  requires threading struct type information into the access‑chain walk. Until
  it lands, document the `:= REF(x)` workaround for `REF_TO` fields.

## Summary of touch points

| Concern | Location |
| --- | --- |
| Field type emission | `generateStructType`, `src/backend/type-codegen.ts` |
| Raw element resolution (reuse) | `mapTypeRefToCpp`, `src/backend/codegen.ts` |
| `REF=` lowering + field‑kind resolution | `generateRefAssignStatement`, `src/backend/codegen.ts` |
| Runtime wrappers | `src/runtime/include/iec_pointer.hpp` |
| Tests | `tests/integration/cpp-compile.test.ts` |
