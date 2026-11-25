// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * STruC++ Library Loader
 *
 * Loads library manifests and registers their symbols into the symbol tables
 * for cross-library function resolution.
 */

import type {
  LibraryManifest,
  LibraryTypeEntry,
  LibraryFunctionEntry,
  LibraryFBEntry,
  LibraryVarType,
  StlibArchive,
} from "./library-manifest.js";
import type {
  FunctionSymbol,
  SymbolTables,
  VariableSymbol,
} from "../semantic/symbol-table.js";
import { DuplicateSymbolError } from "../semantic/symbol-table.js";
import type {
  ArrayDefinition,
  EnumDefinition,
  EnumType,
  Expression,
  MethodDeclaration,
  ElementaryType,
  IECType,
  ReferenceKind,
  StructDefinition,
  StructType,
  TypeReference,
  VarDeclaration,
} from "../frontend/ast.js";
import { createDefaultSourceSpan } from "../frontend/ast.js";
import { isPragmaDefineName } from "../frontend/conditional-pragmas.js";
import { ELEMENTARY_TYPES } from "../semantic/type-utils.js";
import { lowerDefaultStringLength } from "../semantic/string-default-length.js";
import { libraryMethodDeclarations } from "./library-methods.js";

/**
 * Error thrown when a library manifest fails validation.
 */
export class LibraryManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LibraryManifestError";
  }
}

/** Build a TypeReference AST node from a manifest variable entry. The
 *  reference preserves the metadata downstream consumers (codegen,
 *  debug-table-gen) need to recurse into nested types. */
function makeTypeRef(
  v: LibraryVarType,
  stringDefaultLength?: number,
): TypeReference {
  // Archive JSON is external input: keep only kinds the compiler writes.
  const referenceKind: ReferenceKind = isReferenceKind(v.referenceKind)
    ? v.referenceKind
    : "none";
  const ref: TypeReference = {
    kind: "TypeReference",
    sourceSpan: createDefaultSourceSpan(),
    name: v.type,
    isReference: referenceKind !== "none",
    referenceKind,
  };
  if (v.arrayDimensions) ref.arrayDimensions = v.arrayDimensions;
  if (v.elementTypeName) ref.elementTypeName = v.elementTypeName;
  if (v.elementReferenceChain) {
    ref.elementReferenceChain = v.elementReferenceChain.filter(isReferenceKind);
  }
  if (v.referenceChain) {
    ref.referenceChain = v.referenceChain.filter(isReferenceKind);
  }
  applyStringLengths(ref, v);
  applyStringDefaultLength(ref, stringDefaultLength);
  return ref;
}

/** A STRING length as the library compiler writes it: a positive integer or a constant's name. */
function isStringLength(length: unknown): length is number | string {
  return typeof length === "number"
    ? Number.isInteger(length) && length > 0
    : typeof length === "string" && /^[A-Za-z_]\w*$/.test(length);
}

/** The STRING lengths a manifest entry records, onto `ref`. */
function applyStringLengths(
  ref: TypeReference,
  entry: { maxLength?: unknown; elementMaxLength?: unknown },
): void {
  if (isStringLength(entry.maxLength)) ref.maxLength = entry.maxLength;
  if (isStringLength(entry.elementMaxLength)) {
    ref.elementMaxLength = entry.elementMaxLength;
  }
}

/**
 * A STRING or WSTRING without a length of a library compiled with another
 * default length (manifest `stringDefaultLength`), an ARRAY element or an
 * ARRAY[*] parameter's included, has that length, marked as a default.
 */
function applyStringDefaultLength(
  ref: TypeReference,
  stringDefaultLength: number | undefined,
): void {
  if (stringDefaultLength === undefined) return;
  lowerDefaultStringLength(ref, stringDefaultLength);
}

/** The reference chain and inline-array shape a manifest function parameter records. */
function parameterShapeOf(
  p: LibraryFunctionEntry["parameters"][number],
): Partial<LibraryVarType> {
  return {
    ...(Array.isArray(p.referenceChain)
      ? { referenceChain: p.referenceChain }
      : {}),
    ...(Array.isArray(p.arrayDimensions)
      ? { arrayDimensions: p.arrayDimensions }
      : {}),
    ...(typeof p.elementTypeName === "string"
      ? { elementTypeName: p.elementTypeName }
      : {}),
    ...(Array.isArray(p.elementReferenceChain)
      ? { elementReferenceChain: p.elementReferenceChain }
      : {}),
  };
}

function isReferenceKind(
  kind: unknown,
): kind is "pointer_to" | "ref_to" | "reference_to" {
  return kind === "pointer_to" || kind === "ref_to" || kind === "reference_to";
}

/** Create a VariableSymbol from a library variable entry. The synthesized
 *  VarDeclaration carries the real TypeReference so AST-walking consumers
 *  (debug-table-gen) can recurse uniformly across user-defined and
 *  library-defined function blocks. */
/**
 * The AST definition a library type is registered under.
 *
 * A struct that exported its fields gets a real `StructDefinition`, so anything
 * walking the type — the debug table above all — can descend into its members.
 * Everything else keeps the historical self-referential `TypeReference`, which
 * the walk reads as "opaque library type": an alias points at its base, and a
 * struct without exported fields genuinely has nothing to descend into.
 */
function buildLibraryTypeDefinition(
  t: LibraryTypeEntry,
  stringDefaultLength?: number,
): StructDefinition | EnumDefinition | ArrayDefinition | TypeReference {
  if (
    (t.kind === "struct" || t.kind === "union") &&
    t.fields &&
    t.fields.length > 0
  ) {
    return {
      kind: "StructDefinition",
      ...(t.kind === "union" ? { isUnion: true as const } : {}),
      sourceSpan: createDefaultSourceSpan(),
      fields: t.fields.map((f) => {
        // ARRAY and reference shapes too (archives that record them)
        const type = makeTypeRef(f, stringDefaultLength);
        return {
          kind: "VarDeclaration" as const,
          sourceSpan: createDefaultSourceSpan(),
          names: [f.name],
          type,
        };
      }),
    };
  }
  if (t.kind === "enum" && Array.isArray(t.members)) {
    return libraryEnumDefinition(t, t.members);
  }
  if (
    t.kind === "alias" &&
    Array.isArray(t.arrayDimensions) &&
    typeof t.elementTypeName === "string"
  ) {
    const elementType: TypeReference = {
      kind: "TypeReference",
      sourceSpan: createDefaultSourceSpan(),
      name: t.elementTypeName,
      isReference: false,
      referenceKind: "none",
    };
    if (isStringLength(t.elementMaxLength)) {
      elementType.maxLength = t.elementMaxLength;
    }
    applyStringDefaultLength(elementType, stringDefaultLength);
    const array: ArrayDefinition = {
      kind: "ArrayDefinition",
      sourceSpan: createDefaultSourceSpan(),
      dimensions: t.arrayDimensions.map((d) => ({
        kind: "ArrayDimension" as const,
        sourceSpan: createDefaultSourceSpan(),
        isVariableLength: false,
        start: integerLiteral(d.start),
        end: integerLiteral(d.end),
      })),
      elementType,
    };
    return array;
  }
  if (t.kind === "alias" && typeof t.refTarget === "string") {
    const ref: TypeReference = {
      kind: "TypeReference",
      sourceSpan: createDefaultSourceSpan(),
      name: t.refTarget,
      isReference: true,
      referenceKind: "ref_to",
    };
    if (isStringLength(t.maxLength)) ref.maxLength = t.maxLength;
    return ref;
  }
  if (t.kind === "alias" && typeof t.pointerTarget === "string") {
    const pointer: TypeReference = {
      kind: "TypeReference",
      sourceSpan: createDefaultSourceSpan(),
      name: t.pointerTarget,
      isReference: false,
      referenceKind: "pointer_to",
    };
    if (t.maxLength !== undefined) pointer.maxLength = t.maxLength;
    return pointer;
  }
  const alias: TypeReference = {
    kind: "TypeReference",
    sourceSpan: createDefaultSourceSpan(),
    name: t.baseType ?? t.name,
    isReference: false,
    referenceKind: "none",
  };
  if (t.kind === "alias" && t.baseType !== undefined) {
    applyStringLengths(alias, t);
    applyStringDefaultLength(alias, stringDefaultLength);
  }
  return alias;
}

/** An integer literal expression of `value`, as the parser builds one. */
function integerLiteral(value: number): Expression {
  const literal: Expression = {
    kind: "LiteralExpression",
    sourceSpan: createDefaultSourceSpan(),
    literalType: "INT",
    value: Math.abs(value),
    rawValue: String(Math.abs(value)),
  };
  return value < 0
    ? {
        kind: "UnaryExpression",
        sourceSpan: createDefaultSourceSpan(),
        operator: "-",
        operand: literal,
      }
    : literal;
}

/** The enumeration a manifest records with its values (archives with `members`). */
function libraryEnumDefinition(
  t: LibraryTypeEntry,
  members: NonNullable<LibraryTypeEntry["members"]>,
): EnumDefinition {
  return {
    kind: "EnumDefinition",
    sourceSpan: createDefaultSourceSpan(),
    ...(typeof t.baseType === "string"
      ? {
          baseType: {
            kind: "TypeReference" as const,
            sourceSpan: createDefaultSourceSpan(),
            name: t.baseType,
            isReference: false,
            referenceKind: "none" as const,
          },
        }
      : {}),
    ...(typeof t.defaultMember === "string"
      ? { defaultValue: t.defaultMember }
      : {}),
    members: members.map((m) => ({
      kind: "EnumMember" as const,
      sourceSpan: createDefaultSourceSpan(),
      name: m.name,
      ...(typeof m.value === "number"
        ? { value: integerLiteral(m.value) }
        : {}),
    })),
  };
}

function makeVarSymbol(
  v: LibraryVarType,
  direction: "input" | "output" | "inout" | "local",
  stringDefaultLength?: number,
): VariableSymbol {
  const varType: ElementaryType = ELEMENTARY_TYPES[v.type.toUpperCase()] ?? {
    typeKind: "elementary",
    name: v.type,
    sizeBits: 0,
  };
  const declaration: VarDeclaration = {
    kind: "VarDeclaration",
    sourceSpan: createDefaultSourceSpan(),
    names: [v.name],
    type: makeTypeRef(v, stringDefaultLength),
  };
  return {
    name: v.name,
    kind: "variable",
    type: varType,
    declaration,
    isInput: direction === "input",
    isOutput: direction === "output",
    isInOut: direction === "inout",
    isExternal: false,
    isGlobal: false,
    // A `VAR RETAIN` inside the library is retained in every instance of the
    // block, whatever the instance's own qualifier — so the manifest's flag
    // travels onto the symbol rather than being re-derived at the use site.
    isRetain: v.retain === true,
    // Only present when the library's codegen mangled the member; the walk
    // prefers it over re-deriving the rule against the wrong unit.
    ...(v.cppName !== undefined ? { cppName: v.cppName } : {}),
    ...(v.access !== undefined ? { access: v.access } : {}),
  };
}

/**
 * Load a library manifest from a JSON object.
 * Validates required fields and structure.
 * (In production, this would read from a .stlib.json file on disk.)
 *
 * @throws {LibraryManifestError} if required fields are missing or invalid
 */
export function loadLibraryManifest(json: unknown): LibraryManifest {
  if (json === null || json === undefined || typeof json !== "object") {
    throw new LibraryManifestError(
      "Invalid library manifest: expected a JSON object",
    );
  }

  const obj = json as Record<string, unknown>;

  // Validate required top-level fields
  const name = obj.name;
  if (typeof name !== "string" || name.length === 0) {
    throw new LibraryManifestError(
      "Invalid library manifest: 'name' must be a non-empty string",
    );
  }
  const version = obj.version;
  if (typeof version !== "string" || version.length === 0) {
    throw new LibraryManifestError(
      "Invalid library manifest: 'version' must be a non-empty string",
    );
  }
  const namespace = obj.namespace;
  if (typeof namespace !== "string" || namespace.length === 0) {
    throw new LibraryManifestError(
      "Invalid library manifest: 'namespace' must be a non-empty string",
    );
  }

  // Validate functions array
  const functions: LibraryManifest["functions"] = [];
  if (Array.isArray(obj.functions)) {
    for (let i = 0; i < obj.functions.length; i++) {
      const fn = obj.functions[i] as Record<string, unknown>;
      if (typeof fn.name !== "string" || fn.name.length === 0) {
        throw new LibraryManifestError(
          `Invalid library manifest: functions[${i}].name must be a non-empty string`,
        );
      }
      if (typeof fn.returnType !== "string" || fn.returnType.length === 0) {
        throw new LibraryManifestError(
          `Invalid library manifest: functions[${i}].returnType must be a non-empty string`,
        );
      }
      if (!Array.isArray(fn.parameters)) {
        throw new LibraryManifestError(
          `Invalid library manifest: functions[${i}].parameters must be an array`,
        );
      }
      functions.push(fn as unknown as LibraryManifest["functions"][0]);
    }
  }

  // Validate function blocks array
  const functionBlocks: LibraryManifest["functionBlocks"] = [];
  if (Array.isArray(obj.functionBlocks)) {
    for (let i = 0; i < obj.functionBlocks.length; i++) {
      const fb = obj.functionBlocks[i] as Record<string, unknown>;
      if (typeof fb.name !== "string" || fb.name.length === 0) {
        throw new LibraryManifestError(
          `Invalid library manifest: functionBlocks[${i}].name must be a non-empty string`,
        );
      }
      if (!Array.isArray(fb.inputs)) {
        throw new LibraryManifestError(
          `Invalid library manifest: functionBlocks[${i}].inputs must be an array`,
        );
      }
      if (!Array.isArray(fb.outputs)) {
        throw new LibraryManifestError(
          `Invalid library manifest: functionBlocks[${i}].outputs must be an array`,
        );
      }
      if (!Array.isArray(fb.inouts)) {
        throw new LibraryManifestError(
          `Invalid library manifest: functionBlocks[${i}].inouts must be an array`,
        );
      }
      functionBlocks.push(
        fb as unknown as LibraryManifest["functionBlocks"][0],
      );
    }
  }

  // Validate types array
  const types: LibraryManifest["types"] = [];
  if (Array.isArray(obj.types)) {
    for (let i = 0; i < obj.types.length; i++) {
      const t = obj.types[i] as Record<string, unknown>;
      if (typeof t.name !== "string" || t.name.length === 0) {
        throw new LibraryManifestError(
          `Invalid library manifest: types[${i}].name must be a non-empty string`,
        );
      }
      if (
        typeof t.kind !== "string" ||
        !["struct", "union", "enum", "alias"].includes(t.kind)
      ) {
        throw new LibraryManifestError(
          `Invalid library manifest: types[${i}].kind must be "struct", "union", "enum", or "alias"`,
        );
      }
      if (t.fields !== undefined && !Array.isArray(t.fields)) {
        throw new LibraryManifestError(
          `Invalid library manifest: types[${i}].fields must be an array`,
        );
      }
      types.push(t as unknown as LibraryManifest["types"][0]);
    }
  }

  // Exported global variables (optional — archives compiled before globals
  // were exported simply omit the field).
  const globals: NonNullable<LibraryManifest["globals"]> = [];
  if (Array.isArray(obj.globals)) {
    for (let i = 0; i < obj.globals.length; i++) {
      const g = obj.globals[i] as Record<string, unknown>;
      if (typeof g.name !== "string" || g.name.length === 0) {
        throw new LibraryManifestError(
          `Invalid library manifest: globals[${i}].name must be a non-empty string`,
        );
      }
      if (typeof g.type !== "string" || g.type.length === 0) {
        throw new LibraryManifestError(
          `Invalid library manifest: globals[${i}].type must be a non-empty string`,
        );
      }
      globals.push(g as unknown as NonNullable<LibraryManifest["globals"]>[0]);
    }
  }

  const result: LibraryManifest = {
    name,
    version,
    namespace,
    functions,
    functionBlocks,
    types,
    headers: Array.isArray(obj.headers) ? (obj.headers as string[]) : [],
    isBuiltin: Boolean(obj.isBuiltin),
  };

  if (Array.isArray(obj.globals)) {
    result.globals = globals;
  }
  if (obj.description !== undefined) {
    result.description = String(obj.description);
  }
  if (Array.isArray(obj.sourceFiles)) {
    result.sourceFiles = obj.sourceFiles as string[];
  }
  if (obj.stringDefaultLength !== undefined) {
    const n = obj.stringDefaultLength;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
      throw new LibraryManifestError(
        "Invalid library manifest: stringDefaultLength must be a positive integer",
      );
    }
    result.stringDefaultLength = n;
  }
  if (obj.parameterShapes === true) result.parameterShapes = true;
  if (obj.stringLengthsRecorded === true) result.stringLengthsRecorded = true;
  // An ST identifier; anything else falls back to the name's namespace.
  if (
    typeof obj.stNamespace === "string" &&
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(obj.stNamespace)
  ) {
    result.stNamespace = obj.stNamespace;
  }

  return result;
}

/** `fb`'s methods as declarations, parsed once, on first use. */
function lazyLibraryMethods(
  fb: LibraryFBEntry,
  stringDefaultLength: number | undefined,
): () => MethodDeclaration[] | undefined {
  let parsed: { methods: MethodDeclaration[] | undefined } | undefined;
  return () => {
    parsed ??= { methods: libraryMethodDeclarations(fb, stringDefaultLength) };
    return parsed.methods;
  };
}

/**
 * The elementary type `name` is, an alias of one followed through the
 * library's own aliases (archives with `baseType`); undefined otherwise.
 */
function elementaryOf(
  name: string,
  manifest: LibraryManifest,
): ElementaryType | undefined {
  let upper = name.toUpperCase();
  for (let depth = 0; depth < 32; depth++) {
    const elementary = ELEMENTARY_TYPES[upper];
    if (elementary !== undefined) return elementary;
    const alias = manifest.types.find(
      (t) => t.kind === "alias" && t.name.toUpperCase() === upper,
    );
    if (typeof alias?.baseType !== "string") return undefined;
    upper = alias.baseType.toUpperCase();
  }
  return undefined;
}

/** The STRUCT a chain of this library's plain aliases of `t` ends at; undefined otherwise. */
function structAliasOf(
  t: LibraryTypeEntry,
  manifest: LibraryManifest,
  structTypes: ReadonlyMap<string, StructType>,
): StructType | undefined {
  let entry: LibraryTypeEntry | undefined = t;
  for (let depth = 0; entry !== undefined && depth < 32; depth++) {
    if (entry.kind !== "alias" || typeof entry.baseType !== "string") {
      return undefined;
    }
    const upper = entry.baseType.toUpperCase();
    const struct = structTypes.get(upper);
    if (struct !== undefined) return struct;
    entry = manifest.types.find((x) => x.name.toUpperCase() === upper);
  }
  return undefined;
}

/**
 * Register a library's symbols into the compiler's symbol tables.
 * This makes library functions, FBs, and types available for semantic analysis.
 */
export function registerLibrarySymbols(
  manifest: LibraryManifest,
  symbolTables: SymbolTables,
): void {
  // Register functions
  for (const fn of manifest.functions) {
    const returnType: ElementaryType = elementaryOf(
      fn.returnType,
      manifest,
    ) ?? {
      typeKind: "elementary",
      name: fn.returnType,
      sizeBits: 0,
    };

    const symbol: FunctionSymbol = {
      name: fn.name,
      kind: "function",
      libraryName: manifest.name,
      declaration: {
        kind: "FunctionDeclaration",
        sourceSpan: createDefaultSourceSpan(),
        name: fn.name,
        returnType: {
          kind: "TypeReference",
          sourceSpan: createDefaultSourceSpan(),
          name: fn.returnType,
          isReference: isReferenceKind(fn.returnReferenceKind),
          referenceKind: isReferenceKind(fn.returnReferenceKind)
            ? fn.returnReferenceKind
            : "none",
          ...(isStringLength(fn.returnMaxLength)
            ? { maxLength: fn.returnMaxLength }
            : manifest.stringDefaultLength !== undefined &&
                ["STRING", "WSTRING"].includes(fn.returnType.toUpperCase())
              ? {
                  maxLength: manifest.stringDefaultLength,
                  defaultLength: true as const,
                }
              : {}),
        },
        varBlocks: [],
        body: [],
      },
      returnType,
      parameters: fn.parameters.map((p) => {
        const sym = makeVarSymbol(
          {
            name: p.name,
            type: p.type,
            ...(p.referenceKind ? { referenceKind: p.referenceKind } : {}),
            // Older archives have none of these but a recovered `referenceChain`.
            ...parameterShapeOf(p),
            ...(p.maxLength !== undefined ? { maxLength: p.maxLength } : {}),
            ...(p.elementMaxLength !== undefined
              ? { elementMaxLength: p.elementMaxLength }
              : {}),
          },
          p.direction,
          manifest.stringDefaultLength,
        );
        // Carry the optional-input marker: a parameter with an initial value
        // is optional at the call site (see Option A in the analyzer).
        if (p.initialValue !== undefined) sym.initialValue = p.initialValue;
        return sym;
      }),
    };
    // An older archive's function whose prototype gave every shape and length.
    if (manifest.parameterShapes || fn.prototypeShapes) {
      symbol.parameterShapes = true;
    }
    if (manifest.stringLengthsRecorded || fn.prototypeShapes) {
      symbol.stringLengthsRecorded = true;
    }
    symbolTables.addLibraryFunction(symbol);
    try {
      symbolTables.globalScope.defineFromLibrary(symbol);
    } catch (e) {
      // Skip duplicate symbol errors (first definition wins), re-throw others
      if (!(e instanceof DuplicateSymbolError)) throw e;
    }
  }

  // For a struct with exported fields, register a real StructType carrying its
  // member types, so member access on a dependency struct (e.g. `MATH.PI`)
  // resolves to the field's type rather than staying untyped.
  const structTypes = new Map<string, StructType>();
  for (const t of manifest.types) {
    if ((t.kind !== "struct" && t.kind !== "union") || !t.fields) continue;
    structTypes.set(t.name.toUpperCase(), {
      typeKind: "struct",
      name: t.name,
      fields: new Map<string, IECType>(
        t.fields.map((f) => [
          f.name,
          ELEMENTARY_TYPES[f.type.toUpperCase()] ??
            ({
              typeKind: "elementary",
              name: f.type,
              sizeBits: 0,
            } as ElementaryType),
        ]),
      ),
    } as StructType);
  }

  // Register types
  for (const t of manifest.types) {
    const resolvedType: IECType =
      structTypes.get(t.name.toUpperCase()) ??
      // An alias of one of this library's STRUCTs is that STRUCT.
      structAliasOf(t, manifest, structTypes) ??
      // An enumeration that records its values (archives with `members`).
      (t.kind === "enum" && Array.isArray(t.members)
        ? ({
            typeKind: "enum",
            name: t.name,
            values: t.members.map((m) => m.name),
          } as EnumType)
        : undefined) ??
      ELEMENTARY_TYPES[t.name.toUpperCase()] ??
      // An alias of an elementary type is that type (archives with `baseType`).
      elementaryOf(t.name, manifest) ??
      ({
        typeKind: "elementary",
        name: t.name,
        sizeBits: 0,
      } as ElementaryType);

    try {
      symbolTables.globalScope.defineFromLibrary({
        name: t.name,
        kind: "type",
        declaration: {
          kind: "TypeDeclaration",
          sourceSpan: createDefaultSourceSpan(),
          name: t.name,
          // A struct with exported fields gets a REAL StructDefinition, not the
          // self-referential alias the other kinds fall back to.
          //
          // Everything that walks a type reads `declaration.definition`: the
          // debug table recurses into a struct's fields through it, and an
          // alias that points at itself is what it treats as "opaque library
          // type, do not descend". That was fine while library structs were
          // only ever type-checked, and wrong the moment a RETAINed library
          // block held one — the struct's fields simply never reached the
          // retain blob, so the instance restored around a hole.
          definition: buildLibraryTypeDefinition(
            t,
            manifest.stringDefaultLength,
          ),
        },
        resolvedType,
      });
    } catch (e) {
      if (!(e instanceof DuplicateSymbolError)) throw e;
    }
    // An enumeration's values are names of the global scope, as a local
    // TYPE's are; a name already taken keeps its symbol.
    if (t.kind === "enum" && Array.isArray(t.members)) {
      // A value without one written follows the one before it.
      let next = 0;
      t.members.forEach((m) => {
        const value = typeof m.value === "number" ? m.value : next;
        next = value + 1;
        try {
          symbolTables.globalScope.defineFromLibrary({
            name: m.name,
            kind: "enumValue",
            enumType: t.name,
            value,
          });
        } catch (e) {
          if (!(e instanceof DuplicateSymbolError)) throw e;
        }
      });
    }
  }

  // Register function blocks.
  //
  // The interface (inputs/outputs/inouts) is what a consuming compilation
  // type-checks against, and what the debugger shows: library FBs stay black
  // boxes, because their locals are implementation details.
  //
  // `locals` is the exception, and only retain uses it. It carries the block's
  // own VAR members so a RETAINed instance keeps the state it actually runs
  // on; it does not widen what the debugger displays, which stays the
  // interface.
  for (const fb of manifest.functionBlocks) {
    try {
      symbolTables.globalScope.defineFromLibrary({
        name: fb.name,
        kind: "functionBlock",
        declaration: {
          kind: "FunctionBlockDeclaration",
          sourceSpan: createDefaultSourceSpan(),
          name: fb.name,
          isAbstract: false,
          isFinal: false,
          ...(fb.extends !== undefined ? { extends: fb.extends } : {}),
          varBlocks: [],
          methods: [],
          properties: (fb.properties ?? []).map((p) => ({
            kind: "PropertyDeclaration" as const,
            sourceSpan: createDefaultSourceSpan(),
            name: p.name,
            type: makeTypeRef(p.type, manifest.stringDefaultLength),
            visibility: "PUBLIC" as const,
            ...(p.get === true ? { getter: [] } : {}),
            ...(p.set === true ? { setter: [] } : {}),
          })),
          actions: [],
          body: [],
        },
        inputs: fb.inputs.map((i) =>
          makeVarSymbol(i, "input", manifest.stringDefaultLength),
        ),
        outputs: fb.outputs.map((o) =>
          makeVarSymbol(o, "output", manifest.stringDefaultLength),
        ),
        inouts: fb.inouts.map((io) =>
          makeVarSymbol(io, "inout", manifest.stringDefaultLength),
        ),
        // Present from archives that export them; an older archive leaves
        // this empty and a RETAINed instance of its blocks covers the visible
        // surface only, with a warning naming the block.
        locals: (fb.locals ?? []).map((l) =>
          makeVarSymbol(l, "local", manifest.stringDefaultLength),
        ),
        ...(fb.temps !== undefined
          ? {
              temps: fb.temps.map((t) =>
                makeVarSymbol(t, "local", manifest.stringDefaultLength),
              ),
            }
          : {}),
        ...(fb.properties !== undefined && fb.methods !== undefined
          ? { libraryMethodNames: fb.methods.map((m) => m.name) }
          : {}),
        libraryMethods: lazyLibraryMethods(fb, manifest.stringDefaultLength),
        ...(manifest.stringLengthsRecorded
          ? { stringLengthsRecorded: true as const }
          : {}),
        ...(fb.prototypeInOuts === true
          ? { inOutLengthsRecovered: true as const }
          : {}),
        ...(fb.methods?.some((m) => m.prototypeShapes) === true
          ? {
              prototypeShapedMethods: fb.methods
                .filter((m) => m.prototypeShapes)
                .map((m) => m.name.toUpperCase()),
            }
          : {}),
        libraryName: manifest.name,
      });
    } catch (e) {
      if (!(e instanceof DuplicateSymbolError)) throw e;
    }
  }

  // Register exported global variables into the shared global scope. Because
  // every imported library registers into the SAME globalScope (and duplicates
  // are skipped, first-wins), a program importing several libraries can see all
  // of their globals together at the same place — globals are additive.
  for (const g of manifest.globals ?? []) {
    const globalType: TypeReference = {
      kind: "TypeReference",
      sourceSpan: createDefaultSourceSpan(),
      name: g.type,
      isReference: false,
      referenceKind: "none",
    };
    applyStringLengths(globalType, g);
    applyStringDefaultLength(globalType, manifest.stringDefaultLength);
    const varType: ElementaryType = ELEMENTARY_TYPES[g.type.toUpperCase()] ?? {
      typeKind: "elementary",
      name: g.type,
      sizeBits: 0,
    };
    try {
      symbolTables.globalScope.defineFromLibrary({
        name: g.name,
        kind: "variable",
        type: varType,
        declaration: {
          kind: "VarDeclaration",
          sourceSpan: createDefaultSourceSpan(),
          names: [g.name],
          type: globalType,
        },
        isInput: false,
        isOutput: false,
        isInOut: false,
        isExternal: false,
        isGlobal: true,
        isRetain: false,
      });
    } catch (e) {
      if (!(e instanceof DuplicateSymbolError)) throw e;
    }
  }
}

/** The C++ wrappers of a POINTER TO and a REF_TO level, as codegen spells a parameter's type. */
const REFERENCE_WRAPPERS: ReadonlyArray<[string, ReferenceKind]> = [
  ["IEC_Ptr<", "pointer_to"],
  ["IEC_REF_TO<", "ref_to"],
];

/** `text` split at the commas outside any `<>`, `()` or `[]`; undefined when they do not balance. */
function splitTopLevel(text: string): string[] | undefined {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "<" || ch === "(" || ch === "[") depth++;
    if (ch === ">" || ch === ")" || ch === "]") depth--;
    if (depth < 0) return undefined;
    if (depth === 0 && ch === ",") {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (depth !== 0) return undefined;
  if (current.trim() !== "") parts.push(current);
  return parts;
}

/** A parameter's type in a C++ prototype: its reference levels and the type inside them. */
interface PrototypeParameter {
  chain: ReferenceKind[];
  /** The innermost type, without the reference wrappers or a trailing `&`. */
  inner: string;
}

/**
 * Each parameter of function `name` in the C++ prototype `header`
 * (`IEC_DINT F(IEC_Ptr<INT_t> P, IEC_INT I);`), by parameter name. Undefined
 * unless the prototype is found exactly once and every parameter reads as
 * `<type> <name>`.
 */
function prototypeParameters(
  header: string,
  name: string,
): Map<string, PrototypeParameter> | undefined {
  const call = new RegExp(`(?<![\\w:])${name}\\s*\\(`, "g");
  const found = [...header.matchAll(call)];
  if (found.length !== 1) return undefined;
  const open = found[0]!.index + found[0]![0].length;
  let depth = 1;
  let close = open;
  for (; close < header.length && depth > 0; close++) {
    if (header[close] === "(") depth++;
    if (header[close] === ")") depth--;
  }
  if (depth !== 0) return undefined;
  const params = splitTopLevel(header.slice(open, close - 1));
  if (params === undefined) return undefined;
  const result = new Map<string, PrototypeParameter>();
  for (const raw of params) {
    // A default argument is not part of the declaration's name.
    const param = raw
      .replace(/=[^]*$/, "")
      .replace(/\s+/g, " ")
      .trim();
    const match = /^(.*?)[\s&*]*\b([A-Za-z_]\w*)$/.exec(param);
    if (match === null || match[1]!.trim() === "") return undefined;
    let type = match[1]!.trim();
    const chain: ReferenceKind[] = [];
    for (;;) {
      const wrapper = REFERENCE_WRAPPERS.find(([w]) => type.startsWith(w));
      if (wrapper === undefined || !type.endsWith(">")) break;
      chain.push(wrapper[1]);
      type = type.slice(wrapper[0].length, -1).trim();
    }
    const paramName = match[2]!.toUpperCase();
    if (result.has(paramName)) return undefined;
    result.set(paramName, { chain, inner: type });
  }
  return result;
}

/**
 * The reference levels of each parameter of function `name` in the C++
 * prototype `header` (`IEC_DINT F(IEC_Ptr<INT_t> P, IEC_INT I);`), by
 * parameter name. Undefined unless the prototype is found exactly once and
 * every parameter reads as `<type> <name>`.
 */
export function prototypeReferenceLevels(
  header: string,
  name: string,
): Map<string, ReferenceKind[]> | undefined {
  const params = prototypeParameters(header, name);
  if (params === undefined) return undefined;
  return new Map([...params].map(([n, p]) => [n, p.chain]));
}

/**
 * The length a prototype's STRING / WSTRING type spells (`IEC_STRING` is 254,
 * `IECStringVar<NAME>` a constant's name); undefined for any other type.
 */
function prototypeStringLength(inner: string): number | string | undefined {
  if (/^IEC_W?STRING$/.test(inner)) return 254;
  const match = /^IECW?String(?:Var)?<(\d+|[A-Za-z_]\w*)>$/.exec(inner);
  if (match === null) return undefined;
  return /^\d+$/.test(match[1]!) ? Number(match[1]) : match[1]!;
}

/**
 * The inline array an `Array1D<E, s, e>` / `IEC_ARRAY_1D<E, ArrayBounds<s, e>>`
 * prototype type spells: its bounds and element.
 */
function prototypeArray(
  inner: string,
):
  | { dims: Array<{ start: number; end: number }>; element: PrototypeParameter }
  | undefined {
  const match = /^(?:Array|IEC_ARRAY_)([123])D<(.*)>$/.exec(inner);
  if (match === null) return undefined;
  const args = splitTopLevel(match[2]!)?.map((a) => a.trim());
  if (args === undefined || args.length < 2) return undefined;
  let bounds = args.slice(1);
  const wrapped = /^ArrayBounds<(.*)>$/.exec(bounds.join(", "));
  if (wrapped !== null) bounds = wrapped[1]!.split(",").map((b) => b.trim());
  if (bounds.length !== Number(match[1]) * 2) return undefined;
  if (!bounds.every((b) => /^-?\d+$/.test(b))) return undefined;
  const dims: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < bounds.length; i += 2) {
    dims.push({ start: Number(bounds[i]), end: Number(bounds[i + 1]) });
  }
  const element = prototypeParameters(`E(${args[0]!} e)`, "E")?.get("E");
  return element === undefined ? undefined : { dims, element };
}

/** A manifest parameter, as recoverParameterShapes completes it. */
type RecoverableParameter = {
  name: string;
  type: string;
  referenceKind?: ReferenceKind;
  referenceChain?: ReferenceKind[];
  arrayDimensions?: Array<{ start: number; end: number }>;
  elementTypeName?: string;
  elementReferenceChain?: ReferenceKind[];
  maxLength?: number | string;
  elementMaxLength?: number | string;
};

/**
 * Complete the parameters of an older archive from the C++ prototype in
 * `header`: with `levels`, the POINTER TO / REF_TO levels and inline array
 * shapes (archives before `parameterShapes`), and each STRING / WSTRING
 * length (of the parameter, its pointer target or its elements) the archive
 * leaves out. All or nothing: true, and the parameters completed, only when
 * the prototype names exactly these parameters and gives every shape and
 * length; otherwise only the levels are read (as before), when it names them.
 */
function recoverParameterShapes(
  parameters: RecoverableParameter[],
  header: string,
  name: string,
  levels: boolean,
  defaultLength: number,
): boolean {
  const proto = prototypeParameters(header, name);
  if (proto === undefined || proto.size !== parameters.length) return false;
  const names = parameters.map((p) => String(p.name).toUpperCase());
  if (!names.every((n) => proto.has(n))) return false;
  const completed = parameters.map((p) => ({ ...p }));
  if (fillParameterShapes(completed, proto, levels, defaultLength)) {
    completed.forEach((p, i) => Object.assign(parameters[i]!, p));
    return true;
  }
  if (!levels) return false;
  for (const p of parameters) {
    const chain = proto.get(String(p.name).toUpperCase())!.chain;
    if (p.referenceKind !== undefined || chain.length === 0) continue;
    p.referenceKind = chain[0]!;
    if (chain.length > 1) p.referenceChain = chain;
  }
  return false;
}

/** recoverParameterShapes' work on copies of the parameters; true when complete. */
function fillParameterShapes(
  parameters: RecoverableParameter[],
  proto: Map<string, PrototypeParameter>,
  levels: boolean,
  defaultLength: number,
): boolean {
  const isString = (t: string | undefined): boolean =>
    /^W?STRING$/i.test(t ?? "");
  // The length `inner` spells, kept when it is not the archive's default.
  const lengthOf = (inner: string): number | string | null | undefined => {
    const length = prototypeStringLength(inner);
    if (length === undefined) return undefined;
    return length === defaultLength ? null : length;
  };
  let complete = true;
  for (const p of parameters) {
    const found = proto.get(String(p.name).toUpperCase())!;
    if (levels && p.referenceKind === undefined && found.chain.length > 0) {
      p.referenceKind = found.chain[0]!;
      if (found.chain.length > 1) p.referenceChain = found.chain;
    }
    if (isString(p.type)) {
      const length = lengthOf(found.inner);
      if (length === undefined) complete = false;
      else if (length !== null && p.maxLength === undefined) {
        p.maxLength = length;
      }
      continue;
    }
    const vla = /^__VLA_\d+D_(.+)$/i.exec(p.type);
    if (vla !== null) {
      if (!isString(vla[1])) continue;
      const view = /^ArrayView\dD<(.*)>$/.exec(found.inner);
      const length = view === null ? undefined : lengthOf(view[1]!.trim());
      if (length === undefined) complete = false;
      else if (length !== null && p.elementMaxLength === undefined) {
        p.elementMaxLength = length;
      }
      continue;
    }
    if (!p.type.toUpperCase().startsWith("__INLINE_ARRAY_")) continue;
    const array = prototypeArray(found.inner);
    if (array === undefined) {
      if (p.arrayDimensions === undefined || isString(p.elementTypeName)) {
        complete = false;
      }
      continue;
    }
    if (levels && p.arrayDimensions === undefined) {
      p.arrayDimensions = array.dims;
      p.elementTypeName = p.type.slice("__INLINE_ARRAY_".length);
      if (array.element.chain.length > 0) {
        p.elementReferenceChain = array.element.chain;
      }
    }
    if (isString(p.elementTypeName)) {
      const length = lengthOf(array.element.inner);
      if (length === undefined) complete = false;
      else if (length !== null && p.elementMaxLength === undefined) {
        p.elementMaxLength = length;
      }
    }
  }
  return complete;
}

/**
 * The STRING / WSTRING lengths of a block's in/outs an older archive leaves
 * out, read from their members in its C++ class (`IEC_INOUT<IECStringVar<n>>
 * NAME;`). All or nothing: true when the block has such an in/out and every
 * one is found exactly once with a length.
 */
function recoverInOutLengths(
  fb: LibraryFBEntry,
  header: string,
  defaultLength: number,
): boolean {
  const strings = (fb.inouts ?? []).filter(
    (p) => /^W?STRING$/i.test(p.type) && p.arrayDimensions === undefined,
  );
  if (strings.length === 0) return false;
  const lengths: Array<number | string | undefined> = [];
  for (const p of strings) {
    const member = p.cppName ?? p.name;
    if (!/^[A-Za-z_]\w*$/.test(member)) return false;
    const found = [
      ...header.matchAll(
        new RegExp(`\\bIEC_INOUT<\\s*(.*?)\\s*>\\s+${member}\\s*;`, "g"),
      ),
    ];
    if (found.length !== 1) return false;
    const length = prototypeStringLength(found[0]![1]!);
    if (length === undefined) return false;
    lengths.push(length === defaultLength ? undefined : length);
  }
  strings.forEach((p, i) => {
    if (p.maxLength === undefined && lengths[i] !== undefined) {
      p.maxLength = lengths[i];
    }
  });
  return true;
}

/**
 * An archive written before `parameterShapes` records a FUNCTION's POINTER TO
 * and REF_TO parameters by their target's name only, and an inline array by
 * its synthetic name; one before `stringLengthsRecorded` omits the length of a
 * pointer target or array element. These are read back from the C++
 * prototypes in its chunks (a function's, a block's methods'), so an address
 * passed to a pointer is accepted, one passed to a value parameter is still
 * checked, and a temporary or copy has the parameter's C++ type.
 */
function recoverParameters(manifest: LibraryManifest, chunks: unknown[]): void {
  const levels = manifest.parameterShapes !== true;
  const defaultLength = manifest.stringDefaultLength ?? 254;
  const headerOf = (kind: string, name: string): string | undefined => {
    const matching = chunks.filter(
      (c): c is { header: string } =>
        typeof c === "object" &&
        c !== null &&
        (c as { kind?: unknown }).kind === kind &&
        (c as { name?: unknown }).name === name &&
        typeof (c as { header?: unknown }).header === "string",
    );
    return matching.length === 1 ? matching[0]!.header : undefined;
  };
  for (const fn of manifest.functions) {
    if (!Array.isArray(fn.parameters)) continue;
    const upper = fn.name.toUpperCase();
    const header = headerOf("function", upper);
    if (
      header !== undefined &&
      recoverParameterShapes(
        fn.parameters,
        header,
        upper,
        levels,
        defaultLength,
      )
    ) {
      fn.prototypeShapes = true;
    }
  }
  for (const fb of manifest.functionBlocks) {
    const header = headerOf("functionBlock", fb.name.toUpperCase());
    if (header === undefined) continue;
    if (
      manifest.stringLengthsRecorded !== true &&
      recoverInOutLengths(fb, header, defaultLength)
    ) {
      fb.prototypeInOuts = true;
    }
    if (!Array.isArray(fb.methods)) continue;
    for (const method of fb.methods) {
      if (!Array.isArray(method.parameters)) continue;
      if (
        recoverParameterShapes(
          method.parameters,
          header,
          method.name,
          false,
          defaultLength,
        )
      ) {
        method.prototypeShapes = true;
      }
    }
  }
}

/**
 * Load a `.stlib` archive from a parsed JSON object.
 * Validates the archive structure including formatVersion, manifest, headerCode,
 * cppCode, and dependencies.
 *
 * @throws {LibraryManifestError} if required fields are missing or invalid
 */
export function loadStlibArchive(json: unknown): StlibArchive {
  if (json === null || json === undefined || typeof json !== "object") {
    throw new LibraryManifestError(
      "Invalid stlib archive: expected a JSON object",
    );
  }

  const obj = json as Record<string, unknown>;

  // Validate formatVersion
  if (obj.formatVersion !== 1) {
    throw new LibraryManifestError(
      "Invalid stlib archive: 'formatVersion' must be 1",
    );
  }

  // Validate manifest
  if (
    obj.manifest === null ||
    obj.manifest === undefined ||
    typeof obj.manifest !== "object"
  ) {
    throw new LibraryManifestError(
      "Invalid stlib archive: 'manifest' must be an object",
    );
  }
  const manifest = loadLibraryManifest(obj.manifest);
  if (
    (manifest.parameterShapes !== true ||
      manifest.stringLengthsRecorded !== true) &&
    Array.isArray(obj.chunks)
  ) {
    recoverParameters(manifest, obj.chunks);
  }

  // Validate chunks — every per-symbol slice of the library's emitted
  // C++ output, plus its dep edges. Empty array is valid (synthetic
  // libraries like iec-std-functions ship only symbol-table entries).
  if (!Array.isArray(obj.chunks)) {
    throw new LibraryManifestError(
      "Invalid stlib archive: 'chunks' must be an array",
    );
  }

  // Validate dependencies
  if (!Array.isArray(obj.dependencies)) {
    throw new LibraryManifestError(
      "Invalid stlib archive: 'dependencies' must be an array",
    );
  }

  const archive: StlibArchive = {
    formatVersion: 1,
    manifest,
    chunks: obj.chunks as StlibArchive["chunks"],
    dependencies: obj.dependencies as Array<{ name: string; version: string }>,
  };

  // Optional sources
  if (Array.isArray(obj.sources)) {
    archive.sources = obj.sources as Array<{
      fileName: string;
      source: string;
    }>;
  }

  // Optional globalConstants
  if (
    obj.globalConstants !== null &&
    obj.globalConstants !== undefined &&
    typeof obj.globalConstants === "object" &&
    !Array.isArray(obj.globalConstants)
  ) {
    const gc: Record<string, number> = {};
    for (const [key, val] of Object.entries(
      obj.globalConstants as Record<string, unknown>,
    )) {
      if (typeof val !== "number") {
        throw new LibraryManifestError(
          `Invalid stlib archive: globalConstants["${key}"] must be a number, got ${typeof val}`,
        );
      }
      gc[key] = val;
    }
    archive.globalConstants = gc;
  }

  // Optional pragmaDefines: name → string
  if (obj.pragmaDefines !== undefined) {
    const pd = obj.pragmaDefines;
    if (typeof pd !== "object" || pd === null || Array.isArray(pd)) {
      throw new LibraryManifestError(
        "Invalid stlib archive: pragmaDefines must be an object",
      );
    }
    const out: Record<string, string> = {};
    for (const [key, val] of Object.entries(pd as Record<string, unknown>)) {
      if (!isPragmaDefineName(key)) {
        throw new LibraryManifestError(
          `Invalid stlib archive: pragmaDefines key ${JSON.stringify(key)} is not an identifier`,
        );
      }
      if (typeof val !== "string") {
        throw new LibraryManifestError(
          `Invalid stlib archive: pragmaDefines["${key}"] must be a string, got ${typeof val}`,
        );
      }
      out[key] = val;
    }
    archive.pragmaDefines = out;
  }

  return archive;
}

/**
 * Parse and validate an stlib archive from its raw JSON text.
 *
 * Browser-safe sibling of `loadStlibFromFile` — takes a string the
 * caller already obtained (HTTP fetch, IPC, FileReader, etc.) instead
 * of touching the filesystem.  Use this in environments without `fs`.
 *
 * @param raw - JSON text of the `.stlib` archive
 * @param sourceLabel - Optional label used in error messages
 * @returns The validated archive
 * @throws {LibraryManifestError} if the JSON is malformed or invalid
 */
export function loadStlibFromString(
  raw: string,
  sourceLabel: string = "<string>",
): StlibArchive {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new LibraryManifestError(
      `Invalid JSON in stlib archive: ${sourceLabel}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return loadStlibArchive(json);
}

/**
 * Parse and validate an stlib archive from raw bytes.
 *
 * Browser-safe sibling of `loadStlibFromFile` — accepts the byte
 * payload of an `.stlib` (UTF-8 encoded JSON).  Suitable for
 * `fetch(...).then(r => r.arrayBuffer())` flows and for Electron
 * preload paths that hand the renderer a `Uint8Array` over IPC.
 *
 * @param bytes - Raw UTF-8 bytes of the `.stlib` archive
 * @param sourceLabel - Optional label used in error messages
 * @returns The validated archive
 * @throws {LibraryManifestError} if the JSON is malformed or invalid
 */
export function loadStlibFromBuffer(
  bytes: Uint8Array,
  sourceLabel: string = "<buffer>",
): StlibArchive {
  // TextDecoder is available in modern Node (≥11) and every browser /
  // worker context we care about.  Avoids pulling in `Buffer` so the
  // browser bundler doesn't have to polyfill it.
  const raw = new TextDecoder("utf-8").decode(bytes);
  return loadStlibFromString(raw, sourceLabel);
}

// File-shaped wrappers (`loadStlibFromFile`, `discoverStlibs`,
// `loadLibraryFromFile`, `discoverLibraries`) live in
// `src/node/library-loader.ts`.  Browser / worker consumers fetch
// bytes themselves and call the pure `loadStlibFromString` /
// `loadStlibFromBuffer` / `loadStlibArchive` / `loadLibraryManifest`
// helpers above.
