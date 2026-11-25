// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * STruC++ Debug Table Generator
 *
 * Emits two artifacts alongside the normal compile() output:
 *
 *   1. `debugTableCpp` — contents for generated_debug.cpp, the per-project
 *      pointer tables consumed by strucpp::debug::handle_*() in the runtime
 *      header debug_dispatch.hpp.
 *
 *   2. `debugMap` — a JSON-serializable manifest the editor uses to translate
 *      variable paths (e.g. "INSTANCE0.speeds[5]") into the (arrayIdx,
 *      elemIdx) address pairs the target expects.
 *
 * Every leaf variable — including array elements, struct fields, and FB
 * input/output/inout members — gets its own entry. Leaves are packed into
 * arrays capped at 8,000 entries to stay below AVR GCC's 32,767-byte
 * single-object limit. A new array is also started at each program-instance
 * boundary so per-program edits don't cascade down the table.
 */

import type {
  CompilationUnit,
  ProgramDeclaration,
  TypeReference,
  StructDefinition,
  TypeDeclaration,
  VarDeclaration,
} from "../frontend/ast.js";
import type { ProjectModel } from "../project-model.js";
import { getProjectNamespace } from "../project-model.js";
import { programsReachedByName } from "../semantic/program-access.js";
import type {
  FunctionBlockSymbol,
  SymbolTables,
} from "../semantic/symbol-table.js";
import { isElementaryType } from "../semantic/type-registry.js";
import {
  evalIntConst,
  implicitEnumBaseName,
  MAX_TYPE_ALIAS_DEPTH,
} from "../semantic/type-utils.js";
import { formatArrayElementAccess } from "./codegen-utils.js";
import {
  mangledMemberName,
  typeShadowingMemberNames,
} from "./member-mangling.js";
import { globalCppName } from "./global-naming.js";
import { bitPlaceOf, bitRunMemberName } from "./bit-runs.js";

// ---------------------------------------------------------------------------
// Type tags — MUST match TypeTag enum in runtime/include/debug_dispatch.hpp.
// ---------------------------------------------------------------------------
export const TAG = {
  BOOL: 0,
  SINT: 1,
  USINT: 2,
  INT: 3,
  UINT: 4,
  DINT: 5,
  UDINT: 6,
  LINT: 7,
  ULINT: 8,
  REAL: 9,
  LREAL: 10,
  BYTE: 11,
  WORD: 12,
  DWORD: 13,
  LWORD: 14,
  LTIME: 15,
  LDATE: 16,
  LTOD: 17,
  LDT: 18,
  STRING: 19,
  WSTRING: 20,
  // 21 is the BIT tag (TAG_BIT)
  TIME: 22,
  DATE: 23,
  TOD: 24,
  DT: 25,
} as const;

export type TagName = keyof typeof TAG;

/**
 * Tag of a BIT member of a STRUCT (feature bit_type): its entry points at the
 * byte holding it and carries the bit number in the high bits of `flags`.
 * Listed in a map's `typeTags` only when the map has such a leaf.
 */
export const TAG_BIT = 21;

/** Shift of the bit number in an entry's `flags`; mirrors LEAF_BIT_SHIFT in debug_table.hpp. */
export const LEAF_BIT_SHIFT = 5;

// ---------------------------------------------------------------------------
// Per-leaf flag bits — MUST match LEAF_FLAG_* in
// runtime/include/debug_table.hpp. ABI: append only, never renumber.
//
// Carried down the leaf walk as an explicit parameter rather than a mutable
// `currentFlags`, because a bit can be *cleared* partway down a subtree —
// today nothing does, but the retain work adds exactly that (a NON_RETAIN
// member inside a RETAIN function-block instance), and a shared mutable
// would leak the cleared value into the following sibling.
// ---------------------------------------------------------------------------
export const LEAF_FLAG_READONLY = 1 << 0;

/** Mirrors LEAF_FLAG_RETAIN in runtime/include/debug_table.hpp. */
export const LEAF_FLAG_RETAIN = 1 << 1;

/** How a reference kind reads in a "not debuggable" warning. */
const REFERENCE_KIND_TEXT: Record<string, string> = {
  pointer_to: "a POINTER TO",
  ref_to: "a REF_TO",
  reference_to: "a REFERENCE TO",
  interface: "an interface reference",
};

/** Why an array whose elements are pointers or references is left out. */
function arrayOfReferencesReason(kind: string): string {
  if (kind === "interface") {
    return "an array of interface references holds addresses, which the debugger cannot show or write.";
  }
  const text = (REFERENCE_KIND_TEXT[kind] ?? "a reference").replace(/^a /, "");
  return `an array of ${text} holds addresses, which the debugger cannot show or write.`;
}

/**
 * Apply one var block's qualifiers to the flags inherited from its container.
 *
 * RETAIN is inherited: declaring `VAR RETAIN inst : FB;` retains every leaf
 * inside `inst`, which is the CODESYS rule. NON_RETAIN is how a member opts
 * back out, so it CLEARS the bit rather than merely failing to set it — and
 * that is exactly why the walk passes flags down as a parameter instead of
 * mutating shared state: a cleared bit must not leak into the next sibling.
 */
function applyBlockFlags(
  inherited: number,
  block: { isConstant: boolean; isRetain: boolean; isNonRetain: boolean },
): number {
  let flags = inherited;
  if (block.isConstant) flags |= LEAF_FLAG_READONLY;
  if (block.isRetain) flags |= LEAF_FLAG_RETAIN;
  if (block.isNonRetain) flags &= ~LEAF_FLAG_RETAIN;
  return flags;
}

/**
 * Mirrors `strucpp::retain::HEADER_SIZE` in runtime/include/iec_retain.hpp.
 * Changing one without the other makes the editor's capacity gate disagree
 * with the firmware's own arithmetic.
 */
const RETAIN_HEADER_SIZE = 14;

/**
 * FNV-1a (32-bit) over the retain layout — the ordered `path|typeTag` of every
 * retained leaf.
 *
 * Identity of the LAYOUT, deliberately not of the program: a body edit leaves
 * this unchanged and retained values survive, while adding, removing, retyping
 * or reordering a retained variable changes it and the stored blob is refused.
 * The project MD5 would have discarded retained state on every unrelated edit.
 *
 * FNV-1a rather than a cryptographic digest because this is a collision-check
 * against accident, not against an attacker, and it has to be computable in a
 * few lines on an AVR as well as here.
 */
function retainLayoutHashOf(
  vars: Array<{ path: string; tagName: TagName | "BIT" }>,
): string {
  let hash = 0x811c9dc5;
  for (const v of vars) {
    for (const ch of `${v.path}|${v.tagName}`) {
      hash ^= ch.codePointAt(0) ?? 0;
      // >>> 0 after the multiply: JS bitwise ops are on int32, and FNV needs the
      // product truncated to 32 unsigned bits at every step.
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Render an entry's flags byte as C++.
 *
 * Emits the named constant rather than a literal so `generated_debug.cpp`
 * reads as intent — a reviewer scanning the table sees which leaves are
 * gated without decoding a bitmask — and so a stale generated file fails to
 * compile against a header that renamed the flag instead of silently setting
 * the wrong bit.
 */
function flagsLiteral(flags: number): string {
  const names: string[] = [];
  if (flags & LEAF_FLAG_READONLY) names.push("LEAF_FLAG_READONLY");
  if (flags & LEAF_FLAG_RETAIN) names.push("LEAF_FLAG_RETAIN");
  const bit = flags >> LEAF_BIT_SHIFT;
  if (bit !== 0) names.push(`(${bit} << LEAF_BIT_SHIFT)`);
  return names.length > 0 ? names.join(" | ") : "0";
}

const TAG_NAME_BY_VALUE: Record<number, TagName> = Object.fromEntries(
  Object.entries(TAG).map(([k, v]) => [v, k as TagName]),
) as Record<number, TagName>;

/** Map IEC type name (upper case) → TagName (canonical). Handles aliases. */
const IEC_NAME_TO_TAG: Record<string, TagName> = {
  BOOL: "BOOL",
  SINT: "SINT",
  USINT: "USINT",
  INT: "INT",
  UINT: "UINT",
  DINT: "DINT",
  UDINT: "UDINT",
  LINT: "LINT",
  ULINT: "ULINT",
  REAL: "REAL",
  LREAL: "LREAL",
  BYTE: "BYTE",
  WORD: "WORD",
  DWORD: "DWORD",
  LWORD: "LWORD",
  // __XWORD is platform-width; the debug surface targets the native host
  // (where pointers are 64-bit), so it reads as an LWORD-tagged 8-byte value.
  __XWORD: "LWORD",
  TIME: "TIME",
  LTIME: "LTIME",
  DATE: "DATE",
  LDATE: "LDATE",
  TOD: "TOD",
  TIME_OF_DAY: "TOD",
  LTOD: "LTOD",
  LTIME_OF_DAY: "LTOD",
  DT: "DT",
  DATE_AND_TIME: "DT",
  LDT: "LDT",
  LDATE_AND_TIME: "LDT",
  // A CHAR is one Windows-1252 byte, a WCHAR one UTF-16 code unit.
  CHAR: "BYTE",
  WCHAR: "WORD",
  STRING: "STRING",
  WSTRING: "WSTRING",
};

/** Byte size for each IEC elementary type — authoritative for debug. */
/**
 * The string capacity the debug dispatch assumes.
 *
 * `debug_dispatch.hpp` casts every STRING/WSTRING leaf to
 * `IECStringVar<254>` / `IECWStringVar<254>`. A leaf declared with any other
 * length has its members at different offsets, so it cannot be registered —
 * see the check in `visit()`. Keep in step with those casts.
 */
const DISPATCH_STRING_CAPACITY = 254;

const IEC_NAME_TO_SIZE: Record<string, number> = {
  BOOL: 1,
  SINT: 1,
  USINT: 1,
  INT: 2,
  UINT: 2,
  DINT: 4,
  UDINT: 4,
  LINT: 8,
  ULINT: 8,
  REAL: 4,
  LREAL: 8,
  BYTE: 1,
  WORD: 2,
  DWORD: 4,
  LWORD: 8,
  __XWORD: 8,
  TIME: 4,
  LTIME: 8,
  DATE: 4,
  LDATE: 8,
  TOD: 4,
  TIME_OF_DAY: 4,
  LTOD: 8,
  LTIME_OF_DAY: 8,
  DT: 4,
  DATE_AND_TIME: 4,
  LDT: 8,
  LDATE_AND_TIME: 8,
  CHAR: 1,
  WCHAR: 2,
  // STRING / WSTRING wire widths match `DEBUG_STRING_WIDTH` /
  // `DEBUG_WSTRING_WIDTH` in `runtime/include/debug_dispatch.hpp`.
  // The runtime always writes a full fixed-width window
  // (1 byte length + 126 bytes UTF-8 / 252 bytes UTF-16LE); the
  // editor decoder reads `min(length, 126)` from the prefix and
  // skips the remainder.  Pinning the same constants here keeps the
  // editor's batch-byte arithmetic aligned with what the runtime
  // actually sends per entry.
  STRING: 127,
  WSTRING: 253,
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DebugLeaf {
  arrayIdx: number;
  elemIdx: number;
  /** Path from instance root, e.g. "INSTANCE0.SPEEDS[5]" or
   *  "INSTANCE0.FB_INST.COUNTER". */
  path: string;
  /** IEC type tag name (e.g. "INT", "BOOL", "REAL"). */
  type: string;
  /** Byte size of the leaf (matches type_ops[].size in the runtime). */
  size: number;
  /**
   * Present and `true` only for a leaf the debugger must not modify — an IEC
   * CONSTANT. Omitted otherwise, rather than written as `false`, because a
   * project's map holds thousands of leaves and the flag is rare.
   *
   * Advisory: it exists so the editor can hide the force control instead of
   * offering an action that will be refused. The refusal itself is enforced
   * in the runtime (`LEAF_FLAG_READONLY`), which is what makes an older
   * editor build — or an OPC-UA client that never reads this map — safe.
   *
   * Deliberately additive: `version` stays at 2 so an editor built against
   * the previous manifest keeps loading these maps unchanged. `debug-parser.ts`
   * rejects anything but 2 outright, so bumping it would break every editor
   * pinned to an older strucpp release.
   */
  readOnly?: true;
  /**
   * Present and `true` for a leaf declared `RETAIN` (or inherited from a
   * retained function-block instance). Omitted otherwise — a project's map
   * holds thousands of leaves and the flag is rare.
   */
  retain?: true;
  /** For a `"BIT"` leaf: the bit of the addressed byte, 0 the least significant. */
  bit?: number;
}

export interface DebugMapV2 {
  version: 2;
  md5: string;
  typeTags: Record<string, number>;
  arrays: Array<{ index: number; count: number }>;
  leaves: DebugLeaf[];
  /**
   * The retained leaves, in the order the retain blob packs them. Additive, so
   * `version` stays at 2 — the editor's `debug-parser.ts` rejects anything else
   * outright, and an older editor simply ignores this field.
   */
  retainVars?: Array<{
    arrayIdx: number;
    elemIdx: number;
    path: string;
    size: number;
  }>;
  /**
   * Total bytes the retain blob occupies: a 14-byte header plus one payload
   * slot per retained leaf. Matches `strucpp::retain::blob_size()`.
   *
   * Emitted so a build can be REFUSED when the target cannot hold it. Without
   * it the firmware links, runs, finds the blob too large for its buffer and
   * degrades to NON_RETAIN in silence.
   */
  retainBlobSize?: number;
  /**
   * Identity of the retain LAYOUT, not of the program.
   *
   * FNV-1a over `path|typeTag` for each retained leaf in table order, so a body
   * edit keeps retained values while adding, removing, retyping or reordering a
   * retained variable invalidates them. Keying on the program MD5 instead would
   * discard retained state on every unrelated edit.
   */
  retainLayoutHash?: string;
}

export interface DebugTableResult {
  /** Contents for generated_debug.cpp (ready to write to disk). */
  debugTableCpp: string;
  /** Structured manifest for the editor (ready to JSON.stringify). */
  debugMap: DebugMapV2;
  /** Any leaves that couldn't be classified (unsupported type construct,
   *  user-defined enum, reference, etc.). Useful for warnings. */
  skipped: Array<{ path: string; reason: string }>;
  /** Retained state the walk could not reach; surfaced as compile warnings. */
  incomplete: Array<{ path: string; reason: string }>;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface DebugTableGenOptions {
  /** Max entries per debug array. Default 8000 — safe under AVR's 32767-byte
   *  per-object limit assuming sizeof(Entry) == 4. */
  maxEntriesPerArray?: number;
  /** Name of the global configuration instance the generated table references.
   *  The sketch / runtime must declare this with external linkage. */
  configGlobalName?: string;
  /** MD5 to embed in the debug map. Caller computes over (program.st,
   *  strucpp version, projectModel) so the editor can detect staleness. */
  md5?: string;
  /** The length of a STRING or WSTRING declared without one (254, or 80 under
   *  string_default_80); it picks the advice for a skipped string leaf. */
  stringDefaultLength?: number;
  /** The compilation's global constants, which a `STRING(NAME)` length names. */
  globalConstants?: Readonly<Record<string, number>>;
}

const DEFAULTS: Required<
  Omit<DebugTableGenOptions, "md5" | "stringDefaultLength" | "globalConstants">
> = {
  maxEntriesPerArray: 8000,
  configGlobalName: "g_config",
};

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

interface Entry {
  cppExpr: string;
  tagName: TagName | "BIT";
  path: string;
  type: TagName | "BIT";
  size: number;
  /** Bitwise OR of LEAF_FLAG_*, emitted into the entry's `flags` byte. */
  flags: number;
}

export function generateDebugTable(
  ast: CompilationUnit,
  projectModel: ProjectModel,
  symbolTables: SymbolTables,
  opts: DebugTableGenOptions = {},
): DebugTableResult {
  const maxEntries = opts.maxEntriesPerArray ?? DEFAULTS.maxEntriesPerArray;
  const configGlobal = opts.configGlobalName ?? DEFAULTS.configGlobalName;
  const md5 = opts.md5 ?? "";
  const stringDefault = opts.stringDefaultLength ?? DISPATCH_STRING_CAPACITY;
  const constants = opts.globalConstants ?? {};
  /** The value of a STRING length, a constant's name resolved; undefined when unknown. */
  const lengthValue = (length: number | string): number | undefined => {
    if (typeof length === "number") return length;
    const key = Object.keys(constants).find(
      (k) => k.toUpperCase() === length.toUpperCase(),
    );
    return key === undefined ? undefined : constants[key];
  };
  /** True when a STRING length, a constant's name resolved, is not the dispatch's. */
  const otherThanDispatch = (length: number | string): boolean =>
    lengthValue(length) !== DISPATCH_STRING_CAPACITY;
  /** A length as written, with a constant's value: `10`, `SL = 10`. */
  const lengthText = (length: number | string): string => {
    const value = lengthValue(length);
    return typeof length === "string" && value !== undefined
      ? `${length} = ${value}`
      : String(length);
  };

  // Programs only live in the user AST (libraries don't ship PROGRAM blocks),
  // so we index them locally. Types and function blocks come from the symbol
  // table — that's the unified source covering both user-defined declarations
  // and library-loaded entries.
  const programByName = new Map<string, ProgramDeclaration>();
  for (const p of ast.programs) programByName.set(p.name.toUpperCase(), p);
  const reached = programsReachedByName(ast);

  // --- Inputs to the shared member-mangling rule (see member-mangling.ts) ----
  // The table addresses members by the name codegen declared them under, so
  // both predicates have to resolve the same way codegen's do.

  const interfaceNames = new Set(
    ast.interfaces.map((i) => i.name.toUpperCase()),
  );

  /**
   * Mirrors `CodeGenerator.isUserDefinedType`: a function block, interface,
   * STRUCT/UDT, or program. Elementary types are excluded explicitly — codegen
   * leaves `Time : TIME` unmangled, so mangling it here would name a member
   * that does not exist.
   */
  const shadowingNames = typeShadowingMemberNames(ast);
  const isUserDefinedType = (typeName: string): boolean => {
    const upper = typeName.toUpperCase();
    if (isElementaryType(upper)) return false;
    return (
      symbolTables.lookupType(upper) !== undefined ||
      symbolTables.lookupFunctionBlock(upper) !== undefined ||
      interfaceNames.has(upper) ||
      programByName.has(upper)
    );
  };

  /**
   * FB type name → upper-cased method names of every interface it implements,
   * mirroring `CodeGenerator.fbInterfaceMethodNames`. Directly implemented
   * interfaces only, which is what codegen consults.
   */
  const fbInterfaceMethods = new Map<string, Set<string>>();
  {
    const methodsByInterface = new Map<string, Set<string>>();
    for (const iface of ast.interfaces) {
      methodsByInterface.set(
        iface.name.toUpperCase(),
        new Set(iface.methods.map((m) => m.name.toUpperCase())),
      );
    }
    for (const fb of ast.functionBlocks) {
      if (!fb.implements || fb.implements.length === 0) continue;
      const methods = new Set<string>();
      for (const ifaceName of fb.implements) {
        for (const m of methodsByInterface.get(ifaceName.toUpperCase()) ?? []) {
          methods.add(m);
        }
      }
      if (methods.size > 0) {
        fbInterfaceMethods.set(fb.name.toUpperCase(), methods);
      }
    }
  }

  // Buckets of entries — grown in order, flushed at program boundary or size cap.
  const arrays: Entry[][] = [[]];
  const leaves: DebugLeaf[] = [];
  /** Retained leaves in walk order — the order the blob packs them. */
  const retainVars: Array<{
    arrayIdx: number;
    elemIdx: number;
    path: string;
    size: number;
    tagName: TagName | "BIT";
  }> = [];
  const skipped: Array<{ path: string; reason: string; decl?: string }> = [];
  /** The declaration (`TYPE.MEMBER`, a program's `PROG.VAR` or a global) being walked. */
  let currentDecl: string | undefined;
  /** Walk `fn` under declaration `decl`, for grouping its skips. */
  const inDecl = (decl: string, fn: () => void): void => {
    const outer = currentDecl;
    currentDecl = decl;
    try {
      fn();
    } finally {
      currentDecl = outer;
    }
  };
  /** Leaves left out without a warning (a non-RETAIN file-level global). */
  let silentSkips = false;
  const skip = (item: { path: string; reason: string }): void => {
    if (silentSkips) return;
    skipped.push(
      currentDecl !== undefined ? { ...item, decl: currentDecl } : item,
    );
  };
  /**
   * Retained state the walk could not reach — today only a RETAIN on a library
   * block whose manifest predates exported locals.
   *
   * Kept apart from `skipped`, which is a normal list nobody reads on a good
   * build. These are surfaced as compile WARNINGS: the program still builds
   * and its visible surface is still retained, because refusing would strand
   * anyone using a third-party .stlib they cannot rebuild. But a partial
   * retain that nobody is told about is exactly the failure this reports.
   */
  const incomplete: Array<{ path: string; reason: string; decl?: string }> = [];

  const tail = (): Entry[] => arrays[arrays.length - 1]!;

  const ensureRoom = () => {
    if (tail().length >= maxEntries) arrays.push([]);
  };

  const addLeaf = (
    path: string,
    cppExpr: string,
    iecName: string,
    flags: number,
  ) => {
    const tagName = IEC_NAME_TO_TAG[iecName.toUpperCase()];
    if (tagName === undefined) {
      skip({ path, reason: `unknown elementary type: ${iecName}` });
      return;
    }
    const size = IEC_NAME_TO_SIZE[iecName.toUpperCase()] ?? 0;
    ensureRoom();
    const bucket = tail();
    const arrIdx = arrays.length - 1;
    const elemIdx = bucket.length;
    bucket.push({ cppExpr, tagName, path, type: tagName, size, flags });
    leaves.push({
      arrayIdx: arrIdx,
      elemIdx,
      path,
      type: tagName,
      size,
      ...(flags & LEAF_FLAG_READONLY ? { readOnly: true as const } : {}),
      ...(flags & LEAF_FLAG_RETAIN ? { retain: true as const } : {}),
    });
    if (flags & LEAF_FLAG_RETAIN) {
      retainVars.push({ arrayIdx: arrIdx, elemIdx, path, size, tagName });
    }
  };

  /** A BIT member: the byte `cppExpr` addresses, bit `bit` of it (feature bit_type). */
  const addBitLeaf = (
    path: string,
    cppExpr: string,
    bit: number,
    flags: number,
  ): void => {
    ensureRoom();
    const bucket = tail();
    const arrIdx = arrays.length - 1;
    const elemIdx = bucket.length;
    const entryFlags = flags | (bit << LEAF_BIT_SHIFT);
    bucket.push({
      cppExpr,
      tagName: "BIT",
      path,
      type: "BIT",
      size: 1,
      flags: entryFlags,
    });
    leaves.push({
      arrayIdx: arrIdx,
      elemIdx,
      path,
      type: "BIT",
      size: 1,
      ...(flags & LEAF_FLAG_READONLY ? { readOnly: true as const } : {}),
      ...(flags & LEAF_FLAG_RETAIN ? { retain: true as const } : {}),
      bit,
    });
    if (flags & LEAF_FLAG_RETAIN) {
      retainVars.push({
        arrayIdx: arrIdx,
        elemIdx,
        path,
        size: 1,
        tagName: "BIT",
      });
    }
  };

  // The reference kind a TYPE alias resolves to (`TYPE PI : POINTER TO INT`), if any.
  const aliasReferenceKind = (typeName: string): string | undefined => {
    let name = typeName;
    for (let depth = 0; depth < MAX_TYPE_ALIAS_DEPTH; depth++) {
      // An interface-typed value is a reference to the implementing instance.
      if (interfaceNames.has(name.toUpperCase())) return "interface";
      const def = symbolTables.lookupType(name)?.declaration?.definition;
      if (def?.kind !== "TypeReference") return undefined;
      if (def.referenceKind !== undefined && def.referenceKind !== "none") {
        return def.referenceKind;
      }
      name = def.name;
    }
    return undefined;
  };

  /** The library type whose members the walk is in, if any: their declarations cannot change here. */
  let libraryOwner: string | undefined;
  /** Run `walk` with `owner` as the library type, unless the walk is already inside one. */
  const inLibraryType = (owner: string, walk: () => void): void => {
    const outer = libraryOwner;
    libraryOwner ??= owner;
    try {
      walk();
    } finally {
      libraryOwner = outer;
    }
  };

  /** What to declare a skipped string as so the debugger can show it. */
  const stringAdvice = (name: string): string =>
    stringDefault === DISPATCH_STRING_CAPACITY
      ? `a plain ${name}`
      : `${name}(${DISPATCH_STRING_CAPACITY})`;

  /** How the user can expose a skipped string, or why a library's cannot be. */
  const stringRemedy = (name: string, plural: boolean): string =>
    libraryOwner !== undefined
      ? `${plural ? "They are" : "It is"} declared in the library type ` +
        `${libraryOwner}, so ${plural ? "they" : "it"} cannot be exposed here.`
      : plural
        ? `Declare them as ${stringAdvice(name)} to expose them.`
        : `Declare it as ${stringAdvice(name)} to expose it.`;

  /** Where a default STRING length comes from: this compilation or a library's. */
  const defaultLengthPlace = (): string =>
    libraryOwner !== undefined ? "in its library" : "here";

  /**
   * Why an array whose elements are STRING / WSTRING of another length than
   * the dispatch's is left out whole (one warning, not one per element);
   * undefined for any other element, aliases followed.
   */
  const stringArrayReason = (
    elementTypeName: string,
    elementLength: { maxLength?: number | string; defaultLength?: true },
  ): string | undefined => {
    let name = elementTypeName.toUpperCase();
    let length = elementLength;
    const seen = new Set<string>();
    while (name !== "STRING" && name !== "WSTRING") {
      if (seen.has(name) || IEC_NAME_TO_TAG[name] !== undefined) {
        return undefined;
      }
      seen.add(name);
      const def = symbolTables.lookupType(name)?.declaration?.definition;
      if (def?.kind !== "TypeReference" || def.arrayDimensions !== undefined) {
        return undefined;
      }
      if (def.referenceKind !== undefined && def.referenceKind !== "none") {
        return undefined;
      }
      name = def.name.toUpperCase();
      length = {
        ...(def.maxLength !== undefined ? { maxLength: def.maxLength } : {}),
        ...(def.defaultLength === true ? { defaultLength: true as const } : {}),
      };
    }
    const max = length.maxLength;
    if (max === undefined || !otherThanDispatch(max)) return undefined;
    const declared =
      length.defaultLength === true
        ? `its elements are ${name} without a length, which holds ${max} characters ${defaultLengthPlace()}`
        : `its elements are declared ${name}(${lengthText(max)})`;
    return (
      `${declared}, but the debug dispatch addresses strings as ` +
      `${name}(${DISPATCH_STRING_CAPACITY}). ${stringRemedy(name, true)}`
    );
  };

  /** The names of the members an instance of `fbSym` holds itself (not its base's). */
  const ownMemberNames = (fbSym: FunctionBlockSymbol): string[] =>
    fbSym.libraryName !== undefined
      ? [
          ...fbSym.inputs,
          ...fbSym.outputs,
          ...fbSym.inouts,
          ...fbSym.locals,
        ].map((v) => v.name.toUpperCase())
      : fbSym.declaration.varBlocks
          .filter((b) => b.blockType !== "VAR_TEMP")
          .flatMap((b) => b.declarations.flatMap((d) => d.names))
          .map((n) => n.toUpperCase());

  /**
   * The members of an instance of function block `fbSym` (written `shownName`):
   * those of the block it EXTENDS first, as C++ inherits them, then its own.
   * A member a derived block declares again (`hiddenBy`) is listed under its
   * qualified name (`INST.FB_A::Y`, C++ `inst.FB_A::Y`), so each has one entry.
   * `seen` holds the blocks walked already, so a cyclic chain ends.
   */
  const visitFunctionBlock = (
    path: string,
    cppExpr: string,
    fbSym: FunctionBlockSymbol,
    shownName: string,
    flags: number,
    seen: Set<string>,
    hiddenBy: ReadonlySet<string> = new Set(),
  ): void => {
    const name = fbSym.name.toUpperCase();
    if (seen.has(name)) return;
    seen.add(name);
    /** A member's path step and C++ member, qualified when a derived block hides it. */
    const step = (member: string, cppMember: string): [string, string] =>
      hiddenBy.has(member)
        ? [`${name}::${member}`, `${name}::${cppMember}`]
        : [member, cppMember];
    const base = fbSym.declaration.extends;
    if (base !== undefined) {
      const baseSym = symbolTables.lookupFunctionBlock(base.toUpperCase());
      if (baseSym !== undefined) {
        visitFunctionBlock(
          path,
          cppExpr,
          baseSym,
          base,
          flags,
          seen,
          new Set([...hiddenBy, ...ownMemberNames(fbSym)]),
        );
      } else {
        skip({
          path,
          reason: `the members ${shownName} inherits from ${base} are unknown to the debugger`,
        });
      }
    }
    const interfaceVars = [...fbSym.inputs, ...fbSym.outputs, ...fbSym.inouts];
    // `name` is the FB type declaring these members, so it is the owner for
    // both mangling collisions.
    if (fbSym.libraryName !== undefined || interfaceVars.length > 0) {
      inLibraryType(name, () => {
        // A VAR_IN_OUT refers to the caller's variable (bound per call), so
        // it has no address of its own to list.
        for (const v of [...fbSym.inputs, ...fbSym.outputs]) {
          const [seg, cpp] = step(
            v.name.toUpperCase(),
            libraryMemberCppName(v, name),
          );
          inDecl(`${name}.${v.name.toUpperCase()}`, () =>
            visitTypeRef(
              `${path}.${seg}`,
              `${cppExpr}.${cpp}`,
              v.declaration.type,
              flags,
            ),
          );
        }

        // The block's own VAR members, from the manifest's `locals`.
        //
        // Only when the instance is RETAINed. The debugger keeps its
        // black-box view of a library block everywhere else — the
        // long-standing contract, and what stops a project instantiating a few
        // hundred OSCAT blocks from paying for internals nobody addresses.
        // Retain overrides it because a block restored from half its state
        // comes back in a configuration it could never have run into: a TON
        // with Q and ET but no STATE restarts its wait on the next scan.
        // Two reasons to descend into a library block's own VAR members:
        // the instance is RETAINed, or the library itself declared one of them
        // `VAR RETAIN` — which retains it in every instance, exactly as it
        // does for a user-defined block.
        const instanceRetained = (flags & LEAF_FLAG_RETAIN) !== 0;
        const localsToWalk = instanceRetained
          ? fbSym.locals
          : fbSym.locals.filter((v) => v.isRetain);
        if (localsToWalk.length > 0 || instanceRetained) {
          if (
            instanceRetained &&
            fbSym.locals.length === 0 &&
            fbSym.localsRecorded !== true
          ) {
            // An archive whose manifest does not export locals. Retain still
            // covers the visible surface — refusing the build would strand
            // anyone using a third-party .stlib they cannot rebuild — but it
            // is a partial retain, so it is said out loud rather than left to
            // be discovered after a power cycle.
            incomplete.push({
              ...(currentDecl !== undefined ? { decl: currentDecl } : {}),
              path,
              reason:
                `RETAIN on ${shownName}: the archive of library ` +
                `${fbSym.libraryName ?? "?"} lists no internal variables of the block ` +
                `(an archive built before they were recorded), so only its inputs ` +
                `and outputs are retained. Rebuild that library to retain the rest.`,
            });
          }
          for (const v of localsToWalk) {
            const [seg, cpp] = step(
              v.name.toUpperCase(),
              libraryMemberCppName(v, name),
            );
            inDecl(`${name}.${v.name.toUpperCase()}`, () =>
              visitTypeRef(
                `${path}.${seg}`,
                `${cppExpr}.${cpp}`,
                v.declaration.type,
                v.isRetain ? flags | LEAF_FLAG_RETAIN : flags,
              ),
            );
          }
        }
      });
    } else {
      for (const block of fbSym.declaration.varBlocks) {
        if (
          block.blockType === "VAR" ||
          block.blockType === "VAR_INPUT" ||
          block.blockType === "VAR_OUTPUT"
        ) {
          // A `VAR CONSTANT` inside a function block is read-only for every
          // instance of it, and a `VAR RETAIN` member is retained in every
          // instance, so the block's own qualifiers are folded in here rather
          // than only at the program level.
          const memberFlags = applyBlockFlags(flags, block);
          for (const fieldDecl of block.declarations) {
            for (const fieldName of fieldDecl.names) {
              const [seg, cpp] = step(
                fieldName.toUpperCase(),
                memberCppName(fieldName, fieldDecl.type, name),
              );
              inDecl(`${name}.${fieldName.toUpperCase()}`, () =>
                visitTypeRef(
                  `${path}.${seg}`,
                  `${cppExpr}.${cpp}`,
                  fieldDecl.type,
                  memberFlags,
                ),
              );
            }
          }
        }
      }
    }
  };

  // visitTypeRef walks a TypeReference: elementary type → leaf, inline array
  // → per-element recursion, named user type (struct / FB / elementary alias)
  // → recurse into definition.
  const visitTypeRef = (
    path: string,
    cppExpr: string,
    typeRef: TypeReference,
    flags: number,
  ): void => {
    // Pointers are left out: the table has no per-leaf width and pointer size varies per target.
    // Checked before the array branch, since a POINTER TO ARRAY has dimensions too.
    if (
      typeRef.referenceKind !== undefined &&
      typeRef.referenceKind !== "none"
    ) {
      skip({
        path,
        reason:
          `${REFERENCE_KIND_TEXT[typeRef.referenceKind] ?? "reference"} holds an ` +
          `address, which the debugger cannot show or write.`,
      });
      return;
    }

    // Inline array: `ARRAY[0..4] OF INT` → has arrayDimensions + elementTypeName
    if (typeRef.arrayDimensions && typeRef.elementTypeName) {
      const elementKind =
        typeRef.elementReferenceChain?.[0] ??
        aliasReferenceKind(typeRef.elementTypeName);
      if (elementKind !== undefined) {
        skip({ path, reason: arrayOfReferencesReason(elementKind) });
        return;
      }
      const elementLength = {
        ...(typeRef.elementMaxLength !== undefined
          ? { maxLength: typeRef.elementMaxLength }
          : {}),
        ...(typeRef.elementDefaultLength === true
          ? { defaultLength: true as const }
          : {}),
      };
      const stringReason = stringArrayReason(
        typeRef.elementTypeName,
        elementLength,
      );
      if (stringReason !== undefined) {
        skip({ path, reason: stringReason });
        return;
      }
      walkArrayDims(
        path,
        cppExpr,
        typeRef.arrayDimensions,
        0,
        typeRef.elementTypeName,
        flags,
        [],
        elementLength,
      );
      return;
    }

    const name = typeRef.name.toUpperCase();

    // Named elementary type (or alias thereof).
    if (IEC_NAME_TO_TAG[name] !== undefined) {
      // A parameterised STRING(n) / WSTRING(n) cannot be dispatched. Every
      // string op in `debug_dispatch.hpp` casts the leaf to
      // `IECStringVar<254>` / `IECWStringVar<254>`, but codegen emits the
      // DECLARED size (`IECStringVar<n>`), and `length_` sits at a different
      // offset for every `n` — so the cast reads out of bounds. Measured on
      // `s20 : STRING(20) := 'hello'`: `sizeof` 50 vs 518, and the length came
      // back from 468 bytes past the end of the object. It read 0 there, but
      // the value is undefined: with non-zero neighbouring memory it reads as
      // the cap, and the read path would then serve that many bytes of
      // adjacent memory.
      //
      // The dispatch has one function per TAG and `Entry` has nowhere to carry
      // a per-leaf size, so making this work needs a per-leaf width in the
      // table — a real change to a structure that is deliberately 6 bytes on
      // AVR. Until then the leaf is SKIPPED rather than registered wrong:
      // `skipped` is already surfaced to the caller, so this is a visible
      // build warning instead of an out-of-bounds read at runtime.
      //
      // Nothing authored in the editor reaches this: its type picker is a
      // closed list from the IEC registry, which carries `STRING` with no
      // length parameter. It is hand-written ST compiled through the CLI that
      // can declare `STRING(n)`.
      if (
        (name === "STRING" || name === "WSTRING") &&
        typeRef.maxLength !== undefined &&
        otherThanDispatch(typeRef.maxLength)
      ) {
        const declared =
          typeRef.defaultLength === true
            ? `${name} without a length holds ${typeRef.maxLength} characters ${defaultLengthPlace()}`
            : `declared ${name}(${lengthText(typeRef.maxLength)})`;
        skip({
          path,
          reason:
            `${declared}, but the debug dispatch ` +
            `addresses strings as ${name}(${DISPATCH_STRING_CAPACITY}). ` +
            stringRemedy(name, false),
        });
        return;
      }
      addLeaf(path, cppExpr, name, flags);
      return;
    }

    // An interface variable references the implementing instance, so it is
    // left out like a POINTER TO / REFERENCE TO. Checked before lookupType:
    // interfaces are registered as types without a declaration.
    if (interfaceNames.has(name)) {
      skip({
        path,
        reason:
          `${REFERENCE_KIND_TEXT.interface} (${typeRef.name}) holds an ` +
          `address, which the debugger cannot show or write.`,
      });
      return;
    }

    // Named type — covers user-defined TYPE..END_TYPE and library-registered
    // types (struct/enum/alias). The symbol table is the unified source.
    const ts = symbolTables.lookupType(name);
    // A type symbol registered without a declaration has no layout to walk.
    if (ts && (ts.declaration as TypeDeclaration | undefined) === undefined) {
      skip({
        path,
        reason: `type ${typeRef.name} has no definition the debugger can walk`,
      });
      return;
    }
    if (ts) {
      const def = ts.declaration.definition;
      if (def.kind === "StructDefinition") {
        // A UNION's members are proxies over one plain storage, not IECVar
        // leaves the dispatch could cast, so the UNION is left out whole.
        if (def.isUnion === true) {
          skip({
            path,
            reason:
              `UNION ${typeRef.name}: its members share one storage, which ` +
              `the debugger cannot address (not supported yet); they cannot be forced.`,
          });
          return;
        }
        if (symbolTables.globalScope.definedByLibrary(name)) {
          inLibraryType(name, () =>
            visitStructFields(path, cppExpr, def, flags, name),
          );
        } else {
          visitStructFields(path, cppExpr, def, flags, name);
        }
        return;
      }
      if (def.kind === "ArrayDefinition") {
        const ownKind = def.elementType.referenceKind;
        const elementKind =
          ownKind !== undefined && ownKind !== "none"
            ? ownKind
            : aliasReferenceKind(def.elementType.name);
        if (elementKind !== undefined) {
          skip({ path, reason: arrayOfReferencesReason(elementKind) });
          return;
        }
        // TYPE MyArr: ARRAY[0..9] OF INT; END_TYPE
        const dims = def.dimensions
          .filter((d) => !d.isVariableLength)
          .map((d) => ({
            start: evalIntConst(d.start),
            end: evalIntConst(d.end),
          }));
        if (dims.some((d) => d.start === undefined || d.end === undefined)) {
          skip({ path, reason: `array bounds not constant` });
          return;
        }
        const elementLength = {
          ...(def.elementType.maxLength !== undefined
            ? { maxLength: def.elementType.maxLength }
            : {}),
          ...(def.elementType.defaultLength === true
            ? { defaultLength: true as const }
            : {}),
        };
        const stringReason = stringArrayReason(
          def.elementType.name,
          elementLength,
        );
        if (stringReason !== undefined) {
          skip({ path, reason: stringReason });
          return;
        }
        walkArrayDims(
          path,
          cppExpr,
          dims as Array<{ start: number; end: number }>,
          0,
          def.elementType.name,
          flags,
          [],
          elementLength,
        );
        return;
      }
      if (def.kind === "EnumDefinition") {
        // Enums are stored as their base type; treat as a scalar whose tag
        // matches the base. Without one, the base codegen picks (INT or DINT).
        const baseName =
          def.baseType?.name?.toUpperCase() ??
          implicitEnumBaseName(def.members);
        if (IEC_NAME_TO_TAG[baseName] !== undefined) {
          addLeaf(path, cppExpr, baseName, flags);
          return;
        }
        skip({ path, reason: `enum base type ${baseName} unknown` });
        return;
      }
      if (def.kind === "SubrangeDefinition") {
        const baseName = def.baseType.name.toUpperCase();
        if (IEC_NAME_TO_TAG[baseName] !== undefined) {
          addLeaf(path, cppExpr, baseName, flags);
          return;
        }
        skip({ path, reason: `subrange base ${baseName} unknown` });
        return;
      }
      // TypeReference alias. The library loader registers library types
      // with `definition: TypeReference{ name: baseType ?? typeName }` —
      // an alias points at its base, but a struct with no baseType points
      // at itself (the manifest doesn't expose struct fields, so the
      // symbol carries only the type name). Treat self-referential
      // aliases as opaque library types: the debugger doesn't recurse
      // into them, just like it doesn't recurse into library FB locals.
      if (def.kind === "TypeReference") {
        if (def.name.toUpperCase() === name) {
          skip({
            path,
            reason:
              `library type ${typeRef.name} is opaque to the debugger: its ` +
              `archive records no layout for it (an enumeration's values, an array's shape).`,
          });
          return;
        }
        visitTypeRef(path, cppExpr, def, flags);
        return;
      }
      skip({
        path,
        reason: `unsupported TYPE kind: ${(def as { kind: string }).kind}`,
      });
      return;
    }

    // Function block instance. The symbol table holds both user-defined
    // FBs (populated by the semantic analyzer from `ast.functionBlocks`)
    // and library FBs (populated by `registerLibrarySymbols` from the
    // .stlib manifest). The two paths intentionally surface different
    // amounts of state:
    //
    //   • Library FBs — only the public inputs and outputs (an in-out
    //     refers to the caller's variable and has no address of its own).
    //     Locals are implementation details that stay inside the
    //     compiled archive; the debugger treats library FBs as black
    //     boxes. The library loader leaves `locals` empty for this
    //     reason, so iterating the flat arrays gives just the
    //     interface.
    //
    //   • User-defined FBs — every persistent member, including VAR
    //     locals. The analyzer leaves the symbol's flat arrays empty
    //     and keeps the declarations in `declaration.varBlocks`, so we
    //     fall through to the AST walk and surface VAR alongside the
    //     interface blocks. VAR_TEMP / VAR_EXTERNAL / VAR_IN_OUT are excluded —
    //     those are not persistent state.
    const fbSym = symbolTables.lookupFunctionBlock(name);
    if (fbSym) {
      visitFunctionBlock(path, cppExpr, fbSym, typeRef.name, flags, new Set());
      return;
    }

    // A hoisted inline array of a library STRUCT field, whose archive records no shape
    if (libraryOwner !== undefined && name.startsWith("__INLINE_ARRAY_")) {
      skip({
        path,
        reason:
          `an array field of the library type ${libraryOwner}: its archive ` +
          `records no array shape, so its elements cannot be listed.`,
      });
      return;
    }
    skip({ path, reason: `unresolved type name: ${typeRef.name}` });
  };

  const visitStructFields = (
    path: string,
    cppExpr: string,
    def: StructDefinition,
    flags: number,
    structName: string,
  ): void => {
    // `flags` passes straight through: IEC puts CONSTANT on a var *block*, and
    // a STRUCT declares fields without blocks, so a struct field can never
    // introduce or clear the bit — it only inherits whatever the declaration
    // that named the struct carried.
    for (const fieldDecl of def.fields) {
      for (const fieldName of fieldDecl.names) {
        const place = fieldDecl.type.bit
          ? bitPlaceOf(def.fields, fieldName.toUpperCase())
          : undefined;
        if (place !== undefined) {
          addBitLeaf(
            `${path}.${fieldName.toUpperCase()}`,
            `${cppExpr}.${bitRunMemberName(place.run)}`,
            place.bit,
            flags,
          );
          continue;
        }
        inDecl(`${structName}.${fieldName.toUpperCase()}`, () =>
          visitTypeRef(
            `${path}.${fieldName.toUpperCase()}`,
            // No owner: a STRUCT implements no interfaces, so only the
            // field-name-matches-its-type collision can apply.
            `${cppExpr}.${memberCppName(fieldName, fieldDecl.type)}`,
            fieldDecl.type,
            flags,
          ),
        );
      }
    }
  };

  /**
   * Enumerate every element of an array, emitting one debug entry per element.
   *
   * Indices are collected across all dimensions and only turned into C++ at the
   * innermost level, because the accessor depends on the array's rank:
   * `Array2D`/`Array3D` take every index in one `operator()` call, so emitting a
   * subscript per dimension as we descend would produce `arr[i][j]` — which has
   * no matching operator on those containers and fails to compile.
   * {@link formatArrayElementAccess} owns that rank rule. The IEC display path
   * stays `[i][j]`, which is what the debug UI shows.
   */
  const walkArrayDims = (
    path: string,
    cppExpr: string,
    dims: Array<{ start: number; end: number }>,
    dimIdx: number,
    elementTypeName: string,
    flags: number,
    indices: number[] = [],
    elementLength?: { maxLength?: number | string; defaultLength?: true },
  ): void => {
    if (dimIdx >= dims.length) {
      // Innermost element — visit as a TypeReference with the element type
      // name (and a STRING element's length). Manufactured for recursion.
      visitTypeRef(
        path,
        formatArrayElementAccess(cppExpr, indices),
        {
          kind: "TypeReference",
          name: elementTypeName,
          isReference: false,
          referenceKind: "none",
          ...(elementLength?.maxLength !== undefined
            ? { maxLength: elementLength.maxLength }
            : {}),
          ...(elementLength?.defaultLength === true
            ? { defaultLength: true as const }
            : {}),
        } as TypeReference,
        flags,
      );
      return;
    }
    const { start, end } = dims[dimIdx]!;
    for (let i = start; i <= end; i++) {
      walkArrayDims(
        `${path}[${i}]`,
        cppExpr,
        dims,
        dimIdx + 1,
        elementTypeName,
        flags,
        [...indices, i],
        elementLength,
      );
    }
  };

  /**
   * C++ member name for a declaration, by the same rule codegen used to emit it
   * (see `member-mangling.ts`).
   *
   * The table addresses members by name, so it has to agree with the class
   * definition exactly, in *both* directions. Mangling too little named a member
   * that does not exist (`RunningLights : RunningLights` is declared
   * `RUNNINGLIGHTS_`); mangling too much would do the same in reverse, since
   * `Time : TIME` is declared plain `TIME`. Either way `generated_debug.cpp`
   * fails to compile and takes the whole firmware build with it — and nothing
   * catches it earlier, because `strucpp file.st` emits no debug table.
   *
   * `ownerTypeName` is the type declaring the member, needed for the
   * interface-method collision; undefined for a PROGRAM or a STRUCT, neither of
   * which can implement an interface.
   */
  /**
   * C++ member name for a member of a LIBRARY function block.
   *
   * Prefers the manifest's `cppName`, which the library recorded when its own
   * codegen mangled the member. Both mangling rules are decided against the
   * declaring unit — whether the member's type is user-defined THERE, and
   * which interface methods the block implements — and a consumer that
   * re-derives them can name a member the class does not declare, which fails
   * the build of generated_debug.cpp. Falling back to the shared rule covers
   * archives predating the field, where it is right in every case the bundled
   * libraries contain.
   */
  const libraryMemberCppName = (
    v: {
      name: string;
      declaration: VarDeclaration;
      cppName?: string | undefined;
    },
    ownerTypeName: string,
  ): string =>
    v.cppName ?? memberCppName(v.name, v.declaration.type, ownerTypeName);

  const memberCppName = (
    varName: string,
    typeRef: TypeReference | undefined,
    ownerTypeName?: string,
  ): string =>
    mangledMemberName(varName, typeRef?.name, {
      isUserDefinedType,
      shadowingNames,
      interfaceMethods:
        ownerTypeName !== undefined
          ? fbInterfaceMethods.get(ownerTypeName.toUpperCase())
          : undefined,
    });

  const visitVarDecl = (
    path: string,
    cppExpr: string,
    decl: VarDeclaration,
    flags: number,
    ownerTypeName?: string,
  ): void => {
    for (const varName of decl.names) {
      visitTypeRef(
        `${path}.${varName.toUpperCase()}`,
        `${cppExpr}.${memberCppName(varName, decl.type, ownerTypeName)}`,
        decl.type,
        flags,
      );
    }
  };

  // Configurations carry both VAR_GLOBAL declarations and the
  // resource → task → program-instance tree. Globals go first so they own
  // a dedicated bucket at the head of the table — that way edits to a
  // program don't shift global addresses around.
  //
  // Path convention is bare uppercase name (no instance prefix): the
  // editor's `buildGlobalDebugPath()` returns `name.toUpperCase()` and
  // OPC-UA `GVL:foo` references resolve against the same key.
  // C++ expression is `${name}.value`: each global is emitted as a file-scope
  // `inline GlobalVar<V>` singleton (value + per-global mutex), so `.value`
  // reaches the underlying IEC storage the debugger reads/writes directly —
  // no configuration-instance prefix (see codegen.ts emitFileScopeGlobals,
  // iec_global.hpp).
  const seenGlobals = new Set<string>();
  for (const config of ast.configurations) {
    for (const block of config.varBlocks) {
      if (block.blockType !== "VAR_GLOBAL") continue;
      for (const decl of block.declarations) {
        for (const varName of decl.names) {
          // File-scope singletons are deduped by name; mirror that here so the
          // debug table doesn't emit duplicate entries for a shared global.
          const key = varName.toUpperCase();
          if (seenGlobals.has(key)) continue;
          seenGlobals.add(key);
          visitTypeRef(
            key,
            `${globalCppName(varName)}.value`,
            decl.type,
            applyBlockFlags(0, block),
          );
        }
      }
    }
  }

  // File-level VAR_GLOBALs (GVL files): plain file-scope objects under their
  // C++ global name, with no GlobalVar wrapper (codegen.ts emitGvlGlobals).
  for (const block of ast.globalVarBlocks) {
    for (const decl of block.declarations) {
      for (const varName of decl.names) {
        const key = varName.toUpperCase();
        if (seenGlobals.has(key)) continue;
        seenGlobals.add(key);
        // Listed for the debugger; a leaf it cannot list is only warned about
        // when retained, where leaving it out loses data at a power cycle.
        silentSkips = !block.isRetain;
        try {
          inDecl(key, () =>
            visitTypeRef(
              key,
              globalCppName(varName),
              decl.type,
              applyBlockFlags(0, block),
            ),
          );
        } finally {
          silentSkips = false;
        }
      }
    }
  }

  // Arrays filled so far hold globals only: the first program instance starts
  // a new array unless the current one is still empty.
  const globalArrayCount =
    tail().length > 0 ? arrays.length : arrays.length - 1;

  // Walk configurations → resources → tasks → instances.
  for (const config of projectModel.configurations) {
    for (const resource of config.resources) {
      for (const task of resource.tasks) {
        for (const instance of task.programInstances) {
          // Program-instance boundary flush (unless current bucket is empty).
          if (tail().length > 0) arrays.push([]);

          const prog = programByName.get(instance.programType.toUpperCase());
          if (!prog) continue;

          const instName = instance.instanceName.toUpperCase();
          const basePath = instName;
          // A reached program's instance is the shared header object; its
          // address stays a compile-time constant (the configuration holds a reference).
          const baseCpp = reached.has(prog.name.toUpperCase())
            ? `::${getProjectNamespace(projectModel)}::__program_${prog.name}`
            : `${configGlobal}.${instance.instanceName}`;

          for (const block of prog.varBlocks) {
            // Exclude VAR_EXTERNAL (points to globals handled separately) and
            // VAR_TEMP / VAR_IN_OUT (not persistent state). Debugger address
            // persistent local/input/output state.
            if (
              block.blockType !== "VAR" &&
              block.blockType !== "VAR_INPUT" &&
              block.blockType !== "VAR_OUTPUT"
            ) {
              continue;
            }
            const declFlags = applyBlockFlags(0, block);
            for (const decl of block.declarations) {
              for (const varName of decl.names) {
                inDecl(
                  `${prog.name.toUpperCase()}.${varName.toUpperCase()}`,
                  () =>
                    visitVarDecl(
                      basePath,
                      baseCpp,
                      { ...decl, names: [varName] },
                      declFlags,
                    ),
                );
              }
            }
          }
        }
      }
    }
  }

  // Drop trailing empty bucket if present.
  if (arrays.length > 0 && tail().length === 0) {
    arrays.pop();
  }
  // If everything is empty, keep one empty array for a valid table.
  if (arrays.length === 0) arrays.push([]);

  const configName = projectModel.configurations[0]?.name ?? "CONFIG0";
  const retainLayoutHash = retainLayoutHashOf(retainVars);
  const debugTableCpp = renderCpp(
    arrays,
    arrays.map((_, i) => i < globalArrayCount),
    configGlobal,
    configName,
    retainVars,
    retainLayoutHash,
  );
  const debugMap: DebugMapV2 = {
    version: 2,
    md5,
    typeTags: {
      ...TAG,
      ...(leaves.some((l) => l.type === "BIT") ? { BIT: TAG_BIT } : {}),
    },
    arrays: arrays.map((a, i) => ({ index: i, count: a.length })),
    leaves,
    // Omitted entirely when nothing is retained, so a project that uses no
    // RETAIN carries no retain fields at all and the runtime's `count == 0`
    // fast path is the only thing it ever sees.
    ...(retainVars.length > 0
      ? {
          retainVars: retainVars.map(({ arrayIdx, elemIdx, path, size }) => ({
            arrayIdx,
            elemIdx,
            path,
            size,
          })),
          retainLayoutHash,
          // 14 == strucpp::retain::HEADER_SIZE (iec_retain.hpp). Emitted so a
          // build can be refused when the target cannot hold the blob.
          retainBlobSize:
            RETAIN_HEADER_SIZE +
            retainVars.reduce((total, v) => total + v.size, 0),
        }
      : {}),
  };

  return {
    debugTableCpp,
    debugMap,
    skipped: groupSkipsByDeclaration(collapseElementSkips(skipped)),
    incomplete: groupSkipsByDeclaration(collapseElementSkips(incomplete)),
  };
}

/**
 * One entry for the same member of every element of an array left out for
 * the same reason, its indices written `[*]` (`I.ARR[*].S`); any other entry
 * as it is, in the order first seen.
 */
export function collapseElementSkips<
  T extends { path: string; reason: string },
>(skipped: ReadonlyArray<T>): T[] {
  const groups = new Map<string, T[]>();
  for (const item of skipped) {
    const key = `${item.path.replace(/\[[^\]]*\]/g, "[*]")}\u0000${item.reason}`;
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.values()].map((group) =>
    group.length === 1
      ? group[0]!
      : {
          ...group[0]!,
          path: group[0]!.path.replace(/\[[^\]]*\]/g, "[*]"),
        },
  );
}

/**
 * One entry per declaration left out for the same reason in several places
 * (each instance of a FB, each program instance): the declaration as its path,
 * with the first instance paths named; any other entry as it is.
 */
export function groupSkipsByDeclaration(
  skipped: ReadonlyArray<{ path: string; reason: string; decl?: string }>,
): Array<{ path: string; reason: string }> {
  const groups = new Map<
    string,
    Array<{ path: string; reason: string; decl?: string }>
  >();
  const order: Array<{ path: string; reason: string; decl?: string }[]> = [];
  for (const item of skipped) {
    const key =
      item.decl !== undefined
        ? `${item.decl}\u0000${item.reason}`
        : `\u0001${order.length}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = [];
      groups.set(key, group);
      order.push(group);
    }
    group.push(item);
  }
  const shown = 2;
  return order.map((group) => {
    const first = group[0]!;
    if (group.length === 1) return { path: first.path, reason: first.reason };
    const named = group
      .slice(0, shown)
      .map((g) => g.path)
      .join(", ");
    const more = group.length - shown;
    return {
      path: `${first.decl!} (in ${group.length} places: ${named}${more > 0 ? ` and ${more} more` : ""})`,
      reason: first.reason,
    };
  });
}

// ---------------------------------------------------------------------------
// C++ rendering
// ---------------------------------------------------------------------------

function renderCpp(
  arrays: Entry[][],
  globalArrays: boolean[],
  configGlobal: string,
  configName: string,
  retainVars: Array<{ arrayIdx: number; elemIdx: number; path: string }>,
  retainLayoutHash: string,
): string {
  const lines: string[] = [];
  lines.push("// SPDX-License-Identifier: GPL-3.0-only");
  lines.push("// Generated by STruC++ debug-table-gen - Do not edit by hand.");
  lines.push("//");
  lines.push("// Per-project debugger pointer tables consumed by");
  lines.push("// strucpp::debug::handle_*() in debug_dispatch.hpp.");
  lines.push("");
  lines.push('#include "generated.hpp"');
  // `debug_table.hpp` carries the AVR-clean subset (Entry, TypeTag,
  // STRUCPP_DEBUG_FLASH).  Including `debug_dispatch.hpp` here would
  // pull `<avr/pgmspace.h>` → `<avr/io.h>` into the only TU that
  // names user variables — AVR register macros (`SP`, `SREG`, …)
  // would then mangle identifiers like PID's `SP` setpoint.  See
  // runtime/include/debug_table.hpp.
  lines.push('#include "debug_table.hpp"');
  lines.push("");
  lines.push(
    `// The sketch/runtime must define this global with external linkage:`,
  );
  lines.push(`//   strucpp::Configuration_${configName} ${configGlobal};`);
  lines.push(`// The debug table below reaches into it via compile-time`);
  lines.push(`// address-of expressions — so it must be a real object, not a`);
  lines.push(`// static-local or a pointer.`);
  lines.push(`extern ::strucpp::Configuration_${configName} ${configGlobal};`);
  lines.push("");
  lines.push("namespace strucpp { namespace debug {");
  lines.push("");

  for (let ai = 0; ai < arrays.length; ai++) {
    const bucket = arrays[ai]!;
    lines.push(
      `const Entry debug_arr_${ai}[${bucket.length || 1}] STRUCPP_DEBUG_FLASH = {`,
    );
    if (bucket.length === 0) {
      lines.push(`    { nullptr, 0, 0 },  // placeholder — array is empty`);
    } else {
      for (const e of bucket) {
        lines.push(
          // The `(void*)` cast is load-bearing AND lossy: a CONSTANT member is
          // declared `const`, and a C-style cast strips that silently where
          // `static_cast` would refuse. The flags byte is what carries the
          // qualifier through to the runtime so the write paths can honour it.
          `    { (void*)&${e.cppExpr}, TAG_${e.tagName}, ${flagsLiteral(e.flags)} },  // ${e.path}`,
        );
      }
    }
    lines.push("};");
    lines.push("");
  }

  const arrNames = arrays.map((_, i) => `debug_arr_${i}`);
  lines.push(
    `const Entry* const debug_arrays[${arrays.length}] STRUCPP_DEBUG_FLASH = {`,
  );
  for (const n of arrNames) lines.push(`    ${n},`);
  lines.push("};");
  lines.push("");

  lines.push(
    `const uint16_t debug_array_counts[${arrays.length}] STRUCPP_DEBUG_FLASH = {`,
  );
  for (const b of arrays) lines.push(`    ${b.length},`);
  lines.push("};");
  lines.push("");

  lines.push(`const uint8_t debug_array_count = ${arrays.length};`);
  lines.push("");

  // The lock of the shared global each global leaf lives in (threaded builds):
  // the debugger and the force table write a global under it.
  lines.push("#ifdef STRUCPP_THREADED");
  lines.push("void* debug_leaf_lock(uint8_t arr, uint16_t elem) noexcept {");
  lines.push("    switch (arr) {");
  arrays.forEach((bucket, ai) => {
    if (globalArrays[ai] !== true || bucket.length === 0) return;
    lines.push(`        case ${ai}: {`);
    lines.push(`            static void* const locks[${bucket.length}] = {`);
    for (const e of bucket) {
      const root = e.cppExpr.substring(0, e.cppExpr.indexOf(".value"));
      lines.push(`                &${root}.mutex(),  // ${e.path}`);
    }
    lines.push("            };");
    lines.push(
      `            return elem < ${bucket.length} ? locks[elem] : nullptr;`,
    );
    lines.push("        }");
  });
  lines.push("        default:");
  lines.push("            return nullptr;");
  lines.push("    }");
  lines.push("}");
  lines.push("#endif");
  lines.push("");

  // Which arrays hold configuration globals and which a program instance's
  // variables: the force table applies a global's force from every task.
  lines.push(
    `const uint8_t debug_array_kind[${arrays.length}] STRUCPP_DEBUG_FLASH = {`,
  );
  for (const isGlobal of globalArrays) {
    lines.push(
      `    ${isGlobal ? "DEBUG_ARRAY_GLOBAL" : "DEBUG_ARRAY_PROGRAM"},`,
    );
  }
  lines.push("};");
  lines.push("");

  // --- Retain table --------------------------------------------------------
  //
  // Retained leaves addressed the same way the debugger addresses everything
  // else: (arr, elem) into the tables above. No offsets, no sizeof — the host
  // reads and writes each leaf through `handle_read` / `handle_write`, so it
  // moves the VALUE and never the IECVar wrapper's forcing state, and a nested
  // function-block member or a configuration global needs no special case.
  //
  // Order is the walk order, and it IS the blob's packing order.
  lines.push("// Retained leaves, in the order the retain blob packs them.");
  lines.push(
    `const RetainVar retain_vars[${retainVars.length || 1}] STRUCPP_DEBUG_FLASH = {`,
  );
  if (retainVars.length === 0) {
    lines.push("    { 0, 0 },  // placeholder — nothing is retained");
  } else {
    for (const v of retainVars) {
      lines.push(`    { ${v.arrayIdx}, ${v.elemIdx} },  // ${v.path}`);
    }
  }
  lines.push("};");
  lines.push("");
  lines.push(`const uint16_t retain_var_count = ${retainVars.length};`);
  lines.push("");
  lines.push(
    "// Identity of the retain LAYOUT (ordered path|typeTag), not of the",
  );
  lines.push(
    "// program: a body edit keeps retained values, a declaration change",
  );
  lines.push("// invalidates them.");
  lines.push(`const uint32_t retain_layout_hash = 0x${retainLayoutHash};`);
  lines.push("");
  lines.push("} } // namespace strucpp::debug");
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Expression helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers exposed for tests
// ---------------------------------------------------------------------------

export function tagNameForTypeName(name: string): TagName | undefined {
  return IEC_NAME_TO_TAG[name.toUpperCase()];
}

export function sizeForTypeName(name: string): number {
  return IEC_NAME_TO_SIZE[name.toUpperCase()] ?? 0;
}

/** For debugging / testing: reverse lookup tag → name. */
export function tagNameByValue(tag: number): TagName | undefined {
  return TAG_NAME_BY_VALUE[tag];
}
