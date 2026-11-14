// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * STruC++ Semantic Analyzer
 *
 * Coordinates semantic analysis passes over the AST.
 * Builds symbol tables, performs type checking, and validates IEC semantics.
 */

import type {
  Argument,
  ASTNode,
  RefAssignStatement,
  VarAccess,
  ArrayLiteralExpression,
  AssertCall,
  AssignmentStatement,
  CompilationUnit,
  ElementaryType,
  EnumType,
  Expression,
  FunctionBlockDeclaration,
  FunctionCallExpression,
  InterfaceDeclaration,
  LiteralExpression,
  MethodCallExpression,
  MethodDeclaration,
  MockFunctionStatement,
  PropertyDeclaration,
  TypeDeclaration,
  TypeDefinition,
  TypeReference,
  ProgramDeclaration,
  VarBlock,
  VarDeclaration,
  VariableExpression,
  Statement,
  TestFile,
  TestStatement,
  Visibility,
} from "../frontend/ast.js";
import type { CompileError, SourceSpan } from "../types.js";
import { describeInlineType } from "../frontend/lower-inline-types.js";
import { StdFunctionRegistry } from "./std-function-registry.js";
import { RUNTIME_CALLABLE_NAMES } from "./runtime-functions.js";
import { Scope, SymbolTables } from "./symbol-table.js";
import type { FunctionSymbol } from "./symbol-table.js";
import { TypeChecker } from "./type-checker.js";
import {
  findProgramReaches,
  findProgramSelfCalls,
  type ProgramReach,
} from "./program-access.js";
import {
  GlobalListResolver,
  type GlobalListScope,
  prepareGlobalLists,
  type GlobalListDiagnostic,
  type GlobalLists,
} from "./global-lists.js";
import {
  flattenStructExtends,
  LIBRARY_STRUCT,
  ownFields,
} from "./struct-extends.js";
import {
  isUnionDefinition,
  validateUnionInitializers,
  validateUnionTypes,
} from "./union.js";
import {
  fbChain,
  fbIndex,
  fbInitArgumentScope,
  fbInitAssignedNames,
  fbInitInputs,
  prepareFbInit,
  validateFbInitArguments,
} from "./fb-init.js";
import {
  DEFAULT_FEATURES,
  IEC_PROFILE,
  profilesWithFeature,
  type FeatureId,
  type ResolvedDialect,
} from "../dialect.js";
import {
  getBitAccessWidth,
  resolveFieldType,
  resolveArrayElementType,
  resolveFieldDeclaration,
  buildEnumMemberMap,
  describeType,
  resolveArrayShape,
  resolveArrayShapeByName,
  arrayDimSize,
  arrayTotalSize,
  type ArrayShape,
  type EnumMemberEntry,
  typeNamesHeldByValue,
  typesHoldingFunctionBlocks,
  ELEMENTARY_TYPES,
  enumBehindAlias,
} from "./type-utils.js";
import {
  isEnArgument,
  isEnoArgument,
  stripEnEno,
  walkAST,
} from "../ast-utils.js";
import {
  charLiteralUnits,
  exactIntegerLiteralValue,
  IEC_INTEGER_MAX,
  IEC_INTEGER_MIN,
  integerTypeRange,
} from "../literal-utils.js";
import { cp1252Byte } from "../byte-utils.js";
import { exactTimeLiteralNanoseconds } from "../project-model.js";
import { libraryOverloadFor } from "./library-overload.js";
import {
  vendorOperatorFeature,
  vendorOperatorNamed,
} from "./vendor-operators.js";
import {
  platformTypeTarget,
  restoreDeclaredPlatformTypes,
} from "./platform-types.js";
import { implicitParameterHint } from "./implicit-parameters.js";
import {
  POU_OPERATORS,
  lowerTestPouOperators,
  refusedOperatorCalls,
} from "./vendor-pou-operators.js";

// =============================================================================
// Located Variable Address Parsing
// =============================================================================

/**
 * Parsed components of a located variable address.
 */
interface ParsedAddress {
  area: "I" | "Q" | "M"; // Input, Output, Memory
  size: "X" | "B" | "W" | "D" | "L"; // Bit, Byte, Word, DWord, LWord
  byteIndex: number;
  bitIndex: number;
}

/**
 * Parse a located variable address string.
 * @param address Address string like "%IX0.0" or "%QW10"
 * @returns Parsed address components or null if invalid
 */
function parseAddress(address: string): ParsedAddress | null {
  // Pattern: %<area><size><byte_index>.<bit_index>
  // Examples: %IX0.0, %QX2.3, %IW10, %QW5, %MW100, %MD50
  const match = address.match(/^%([IQM])([XBWDL]?)(\d+)(?:\.(\d+))?$/i);
  if (!match) {
    return null;
  }

  const area = match[1]!.toUpperCase() as "I" | "Q" | "M";
  let size = match[2]?.toUpperCase() as "X" | "B" | "W" | "D" | "L" | undefined;
  const byteIndex = parseInt(match[3]!, 10);
  const bitIndex = match[4] ? parseInt(match[4], 10) : 0;

  // Default size to X (bit) if not specified and bit index is present
  if (!size) {
    size = "X";
  }

  return { area, size, byteIndex, bitIndex };
}

/**
 * Variable-block kinds that may carry a physical location ("AT %...").
 *
 * IEC 61131-3 allows located declarations in VAR and VAR_GLOBAL only — interface
 * sections describe a call contract, not hardware. The editor enforces the same
 * set at edit and load time (DISALLOWED_LOCATION_CLASSES, GitHub issue #904), so
 * enforcing it here keeps hand-written and editor-authored ST consistent.
 *
 * VAR_EXTERNAL is the sharpest case: it references storage a CONFIGURATION
 * VAR_GLOBAL owns, codegen emits it as `GlobalVar<T>*` and collects located
 * variables from local declarations only, so an address written there is silently
 * dropped while also duplicating the address the global legitimately claims.
 */
const LOCATABLE_BLOCK_TYPES: ReadonlySet<string> = new Set([
  "VAR",
  "VAR_GLOBAL",
]);

/**
 * The bank a located address lives in: its area and its size class.
 *
 * Two addresses can only collide within one bank. The image is not flat memory
 * -- each size class has its own array in the runtime (bool_memory[][],
 * int_memory[], dint_memory[], lint_memory[]) and the index selects an element
 * of THAT array -- so %MW0 and %MD0 name unrelated storage rather than
 * overlapping bytes.
 */
function bankKey(parsed: ParsedAddress): string {
  return `${parsed.area}${parsed.size}`;
}

/** What the property-access checks know of `TYPE.PROP`. */
interface PropertyAccessInfo {
  hasSetter: boolean;
  /** Set for interface properties only. */
  hasGetter?: boolean;
  /** The interface `TYPE` names, for interface properties. */
  interfaceName?: string;
}

/** Identity of a declared type for an exact match (property contracts). */
function typeKey(t: TypeReference): string {
  return JSON.stringify([
    t.name.toUpperCase(),
    t.referenceChain ?? [t.referenceKind],
    t.maxLength ?? null,
    t.arrayDimensions ?? null,
    t.elementTypeName?.toUpperCase() ?? null,
  ]);
}

/**
 * The first slot a located address names, as a linear index into its bank.
 *
 * Bit addresses linearise as `byte*8 + bit` so that consecutive bits are
 * consecutive slots across a byte boundary (%IX0.7 and %IX1.0 are slots 7 and
 * 8). Every other size class indexes its array directly.
 */
function firstSlot(parsed: ParsedAddress): number {
  return parsed.size === "X"
    ? parsed.byteIndex * 8 + parsed.bitIndex
    : parsed.byteIndex;
}

/**
 * Elementary types that may sit at an address of the given size.
 *
 * For an array, this is checked against the ELEMENT type: `ARRAY [0..66] OF
 * WORD AT %MW60` occupies 67 consecutive WORD slots, so what has to fit the
 * `W` size class is WORD, not the array as a whole.
 */
function getCompatibleTypes(size: "X" | "B" | "W" | "D" | "L"): string[] {
  switch (size) {
    case "X":
      return ["BOOL"];
    case "B":
      return ["BYTE", "USINT", "SINT"];
    case "W":
      return ["WORD", "INT", "UINT"];
    case "D":
      return ["DWORD", "DINT", "UDINT", "REAL"];
    case "L":
      return ["LWORD", "LINT", "ULINT", "LREAL"];
  }
}

/**
 * What a located declaration actually occupies in the process image.
 *
 * A plain variable takes one slot and must itself fit the size class. An array
 * takes one slot PER ELEMENT, laid out consecutively from the declared address,
 * and it is the element type that must fit -- `HR AT %MW60 : ARRAY [0..66] OF
 * WORD` means %MW60 through %MW126, each a WORD (openplc-editor#565).
 *
 * Arrays are supported here because nothing in the descriptor table stands in
 * the way: it is flat, one `{area, size, index, pointer}` row per slot, so an
 * array is N rows rather than a new mechanism. (The pre-strucpp toolchain
 * refused these because MatIEC could not express them at all; that constraint
 * left with MatIEC.)
 *
 * Returns a `reason` instead of a shape for the array forms that have no
 * meaningful linear layout. Each is rejected with its own sentence rather than
 * falling through to the type-compatibility error, which would otherwise
 * report the compiler's internal `__INLINE_ARRAY_<T>` spelling at the user.
 */
type LocatedShape =
  | { elementTypeName: string; slotCount: number; reason?: undefined }
  | { reason: string; elementTypeName?: undefined; slotCount?: undefined };

function resolveLocatedShape(
  type: TypeReference,
  ast: CompilationUnit,
): LocatedShape {
  // A variable-length array carries no bounds anywhere — the AST builder
  // records only its rank, in the synthetic `__VLA_<rank>_<T>` name — so
  // `resolveArrayShape` cannot see it and it would otherwise fall through to
  // the scalar branch and be reported as an incompatible type named
  // `__VLA_1D_WORD`. Catch it here so the message says what is actually wrong.
  if (type.name.toUpperCase().startsWith("__VLA_")) {
    return {
      reason: `its length is not known at compile time. A located array needs constant bounds, because each element is bound to a fixed address before the program runs`,
    };
  }

  const shape: ArrayShape | undefined = resolveArrayShape(type, ast);
  if (!shape) {
    // Not an array: the declaration is the slot, and its own type is what
    // has to fit the size class.
    return { elementTypeName: type.name, slotCount: 1 };
  }

  if (shape.dims.length !== 1) {
    return {
      reason: `a ${shape.dims.length}-dimensional array has no single linear run of addresses to occupy. Declare it unlocated, or use a one-dimensional array`,
    };
  }

  const dim = shape.dims[0];
  if (!dim) {
    // `ARRAY [*]` or a bound that isn't a compile-time constant. The runtime
    // binds each element to a fixed address, so the count has to be known
    // when the descriptor table is emitted -- not when the program runs.
    return {
      reason: `its length is not known at compile time. A located array needs constant bounds, because each element is bound to a fixed address before the program runs`,
    };
  }

  const slotCount = arrayDimSize(dim);
  if (slotCount === undefined || slotCount <= 0) {
    return { reason: `its declared bounds are empty` };
  }

  return { elementTypeName: shape.elementTypeName, slotCount };
}

// =============================================================================
// Analysis Result
// =============================================================================

/**
 * Result of semantic analysis.
 */
export interface SemanticAnalysisResult {
  /** Whether analysis was successful (no errors) */
  success: boolean;

  /** Symbol tables built during analysis */
  symbolTables: SymbolTables;

  /** Errors found during analysis */
  errors: CompileError[];

  /** Warnings found during analysis */
  warnings: CompileError[];
}

// =============================================================================
// Semantic Analyzer
// =============================================================================

/**
 * Semantic analyzer for IEC 61131-3 programs.
 *
 * Performs the following passes:
 * 1. Symbol table building - Index all declarations
 * 2. Type checking - Verify type correctness
 * 3. Semantic validation - Check IEC semantic rules
 */
/**
 * Why an `AT` operand cannot be compiled, in the words the user needs.
 *
 * Every place that reads an `AT` operand — POU-local `VAR`, top-level
 * `VAR_GLOBAL`, `CONFIGURATION VAR_GLOBAL` — reaches the same two dead ends, so
 * the wording lives here rather than three times over. An alias reported as an
 * "invalid address format" sends the user looking for a typo in something that
 * is spelled correctly, and that is exactly what happened in the CONFIGURATION
 * path while the POU path had already been taught better.
 */
export function unusableAddressMessage(decl: VarDeclaration): string {
  if (decl.addressKind === "alias") {
    // The parser accepts `AT Motor_Start` so the OpenPLC Editor can read its own
    // declarations with this parser. A compile is a different matter: an alias
    // names an I/O channel the editor knows about and the compiler does not, so
    // it has to have been resolved to a real address before we get here.
    return (
      `'${decl.address}' is an I/O alias, not an address, and it was not resolved before compiling. ` +
      `Check that '${decl.address}' still names a channel in the device configuration; ` +
      `a variable bound to an alias that no longer exists is left unlocated.`
    );
  }
  return `Invalid address format: ${decl.address}`;
}

/**
 * Information about a located variable for validation.
 */
interface LocatedVarInfo {
  name: string;
  address: string;
  parsed: ParsedAddress;
  typeName: string;
  /** "configuration" covers CONFIGURATION VAR_GLOBAL ... AT. Those live in
   *  ast.configurations[].varBlocks rather than ast.globalVarBlocks, so they are
   *  gathered during validation (collectConfigurationLocatedVars) instead of
   *  during symbol building. */
  scopeType: "program" | "function" | "functionBlock" | "configuration";
  scopeName: string;
  declaration: VarDeclaration;
}

/**
 * Context for undeclared variable checking within a POU scope.
 */
interface UndeclaredVarContext {
  functionName?: string;
  fbName?: string;
  /** The PROGRAM whose body or method is walked. */
  programName?: string;
  methodName?: string;
  propertyName?: string;
  /** Test bodies only (the type checker never sees them): report a CONTINUE outside a loop. */
  checkContinue?: boolean;
  /** Loops enclosing the statements being walked. */
  loopDepth?: number;
}

/** Bit width of each IEC bit-string type, for its typed literals. */
const BIT_STRING_BITS: Readonly<Record<string, number>> = {
  BYTE: 8,
  WORD: 16,
  DWORD: 32,
  LWORD: 64,
};

export class SemanticAnalyzer {
  private symbolTables: SymbolTables;
  private typeChecker: TypeChecker;
  private stdRegistry = new StdFunctionRegistry();
  private enumMemberMap: Map<string, EnumMemberEntry> = new Map();
  /** Uppercase names of the TYPEs hoisted from the test file being analyzed. */
  private testTypeNames = new Set<string>();
  /** The unit being checked holds an `{external}` block (inline C++). */
  private hasExternalCode = false;
  private errors: CompileError[] = [];
  private warnings: CompileError[] = [];

  /** Global variable lists of the unit being analyzed (see global-lists.ts). */
  private globalLists: GlobalLists | undefined;
  /** Internal name of a renamed or aliased list global → `LIST.NAME`. */
  private globalListDisplayNames = new Map<string, string>();
  /** Global-list diagnostics whose text is final (see displayGlobalListNames). */
  private verbatimDiagnostics = new WeakSet<CompileError>();

  /** Track all located variables for duplicate detection */
  private locatedVars: LocatedVarInfo[] = [];
  /** `PRG_A.x` uses that reach a program from another POU with program_methods on. */
  private reachedMemberNodes = new Set<VariableExpression>();

  /** Language features enabled for this analysis (the dialect's, or the default set). */
  readonly features: ReadonlySet<string>;

  constructor(
    private readonly options: {
      strict?: boolean;
      features?: ReadonlySet<string>;
      dialect?: ResolvedDialect;
    } = {},
  ) {
    this.features =
      options.features ?? options.dialect?.features ?? DEFAULT_FEATURES;
    this.symbolTables = new SymbolTables();
    this.typeChecker = new TypeChecker(
      this.symbolTables,
      this.stdRegistry,
      this.options.strict === true,
      this.features,
      (feature, construct) => this.featureMessage(feature, construct),
      this.options.dialect?.id === IEC_PROFILE.id,
    );
  }

  /**
   * Analyze a compilation unit.
   * @param ast The compilation unit to analyze
   * @param existingSymbolTables Optional pre-populated symbol tables (e.g., with library symbols)
   */
  analyze(
    ast: CompilationUnit,
    existingSymbolTables?: SymbolTables,
  ): SemanticAnalysisResult {
    this.errors = [];
    this.warnings = [];
    this.locatedVars = [];

    // Use provided symbol tables (with library symbols pre-registered) or create new ones
    if (existingSymbolTables) {
      this.symbolTables = existingSymbolTables;
      this.typeChecker = new TypeChecker(
        this.symbolTables,
        this.stdRegistry,
        this.options.strict === true,
        this.features,
        (feature, construct) => this.featureMessage(feature, construct),
        this.options.dialect?.id === IEC_PROFILE.id,
      );
    }

    // A refused EXTENDS is located and gates nothing; the STRUCT is still
    // flattened, so its members resolve. Flattening precedes the symbol tables.
    const errorsBeforeStructFeature = this.errors.length;
    this.validateStructExtendsFeature(ast);
    this.validateConfigurationGlobalNames(ast);
    this.validateTypeColonFeature(ast);
    this.flattenStructTypes(ast);
    // UNION refusals and rules are located and gate nothing either.
    this.validateUnions(ast);
    // So are the fb_init refusal, warning and FB_init signature rules.
    this.applyFbInitFeature(ast);
    const structFeatureErrors = this.errors.length - errorsBeforeStructFeature;

    // Pass 1: Build symbol tables (global lists first: they may rename globals)
    this.globalListDisplayNames.clear();
    // A method local renamed by lowerProgramSelfMembers shows as written.
    for (const prog of ast.programs) {
      for (const method of prog.methods) {
        for (const r of method.renamedLocals ?? []) {
          this.globalListDisplayNames.set(r.internal.toUpperCase(), r.name);
        }
      }
    }
    this.prepareGlobalLists(ast);
    this.buildSymbolTables(ast);

    // Reported before the gates below so a type error in any merged source cannot hide
    // an undefined type — and excluded from them, so the reverse cannot happen either.
    const errorsBeforeTypeReferences = this.errors.length;
    this.validateTypeReferences(ast);
    // Before type checking, so every later pass sees the unqualified form.
    const globalListErrors = this.resolveGlobalListAccess(ast);
    // A feature refusal is located and does not gate the passes below either,
    // so the rest of a refused method is still checked.
    this.validateProgramMethodFeature(ast);
    this.validateInterfaceProperties(ast);
    this.validatePostfixEnumBases(ast);
    this.validateConfigurationGlobalsHoldNoFB(ast);
    this.validateDeclaredEno(ast);
    if (this.features.has("fb_init")) {
      validateFbInitArguments(
        ast,
        (upper) => this.symbolTables.lookupFunctionBlock(upper) !== undefined,
        (message, span) =>
          this.addError(message, span.startLine, span.startCol, span.file),
      );
    }
    const typeReferenceErrors =
      this.errors.length -
      errorsBeforeTypeReferences -
      globalListErrors +
      structFeatureErrors;

    if (this.options.strict === true) this.validateReservedNames(ast);

    // Pass 2: Type checking
    if (this.errors.length - typeReferenceErrors === 0) {
      const typeResult = this.typeChecker.check(ast);
      this.errors.push(...typeResult.errors);
      this.warnings.push(...typeResult.warnings);
    }

    // Pass 3: Semantic validation. After an error it does not run, except
    // its literal checks, which need no resolved type.
    if (this.errors.length - typeReferenceErrors === 0) {
      this.validateSemantics(ast);
    } else {
      this.prepareLiteralFallback(ast);
      this.validateLiteralRanges(ast);
      this.literalsReported.clear();
    }

    this.displayGlobalListNames(this.errors);
    this.displayGlobalListNames(this.warnings);

    return {
      success: this.errors.length === 0,
      symbolTables: this.symbolTables,
      errors: this.errors,
      warnings: this.warnings,
    };
  }

  /**
   * A PROGRAM or a FUNCTION_BLOCK without a base that declares ENO declares
   * its ENO output, which must be a plain BOOL. (A derived block's ENO only
   * shadows its base's and keeps working as a variable.)
   */
  private validateDeclaredEno(ast: CompilationUnit): void {
    const blocks: Array<{
      label: string;
      name: string;
      varBlocks: readonly VarBlock[];
    }> = [
      ...ast.programs.map((p) => ({ ...p, label: "PROGRAM" })),
      ...ast.functionBlocks
        .filter((f) => f.extends === undefined)
        .map((f) => ({ ...f, label: "FUNCTION_BLOCK" })),
    ];
    for (const block of blocks) {
      for (const vb of block.varBlocks) {
        for (const decl of vb.declarations) {
          if (!decl.names.some((n) => n.toUpperCase() === "ENO")) continue;
          const t = decl.type;
          if (
            t.arrayDimensions === undefined &&
            t.referenceKind === "none" &&
            t.name.toUpperCase() === "BOOL"
          ) {
            continue;
          }
          this.addError(
            `'ENO' of ${block.label} ${block.name} must be BOOL: it is the block's ENO output`,
            decl.sourceSpan.startLine,
            decl.sourceSpan.startCol,
            decl.sourceSpan.file,
          );
        }
      }
    }
  }

  /** Report a global-list diagnostic; returns true when it must gate the later passes. */
  private reportGlobalList(d: GlobalListDiagnostic): boolean {
    if (d.featureRefusal) {
      this.requireFeature(
        "named_global_lists",
        `Global variable list access '${d.access}'`,
        d.span,
      );
      return false;
    }
    this.addError(d.message, d.span.startLine, d.span.startCol, d.span.file);
    // It may name an internal name the program declares: keep it verbatim.
    const added = this.errors[this.errors.length - 1];
    if (added) this.verbatimDiagnostics.add(added);
    return true;
  }

  /**
   * Collect the global variable lists and, with named_global_lists, rename the
   * globals two lists share (see global-lists.ts). Runs before the symbol tables.
   */
  private prepareGlobalLists(ast: CompilationUnit): void {
    const enabled = this.features.has("named_global_lists");
    this.globalLists = prepareGlobalLists(ast, enabled, (d) => {
      this.reportGlobalList(d);
    });
    for (const list of this.globalLists.lists.values()) {
      for (const [upper, declared] of list.variables) {
        if (
          declared.toUpperCase() !== upper &&
          !this.globalLists.clashing.has(declared)
        ) {
          this.globalListDisplayNames.set(declared, `${list.name}.${upper}`);
        }
      }
    }
  }

  /**
   * Rewrite `LIST.var` access in every POU body (see global-lists.ts) and
   * report plain uses of a name two lists declare. Returns how many errors it
   * added that gate the later passes; a feature refusal does not.
   */
  private resolveGlobalListAccess(ast: CompilationUnit): number {
    const lists = this.globalLists;
    if (!lists || lists.lists.size === 0) return 0;
    const enabled = this.features.has("named_global_lists");
    let gating = 0;
    const report = (d: GlobalListDiagnostic): void => {
      if (this.reportGlobalList(d)) gating++;
    };
    const globalScope = this.symbolTables.globalScope;
    // A renamed global's symbol shows, and completes, as `LIST.NAME`.
    for (const [internal, display] of this.globalListDisplayNames) {
      const sym = globalScope.lookupLocal(internal);
      if (sym?.kind === "variable" || sym?.kind === "constant") {
        sym.name = display;
        sym.globalList = display.slice(0, display.indexOf("."));
      }
    }
    const resolver = new GlobalListResolver(lists, enabled, report);
    const defineAlias = (name: string, alias: string): boolean => {
      const sym = globalScope.lookupLocal(name);
      if (sym?.kind !== "variable" && sym?.kind !== "constant") return false;
      const existing = globalScope.lookupLocal(alias);
      if (existing) {
        return (
          (existing.kind === "variable" || existing.kind === "constant") &&
          existing.globalList !== undefined &&
          existing.declaration === sym.declaration
        );
      }
      const list = alias.slice(0, alias.indexOf("__"));
      const display = `${lists.lists.get(list)?.name ?? list}.${name.toUpperCase()}`;
      globalScope.define({ ...sym, name: alias });
      const aliasSym = globalScope.lookupLocal(alias);
      if (aliasSym?.kind === "variable" || aliasSym?.kind === "constant") {
        aliasSym.name = display;
        aliasSym.globalList = display.slice(0, display.indexOf("."));
      }
      this.globalListDisplayNames.set(alias, display);
      const aliases = (sym.declaration.listAliases ??= []);
      aliases.push({ name, alias });
      return true;
    };
    const listScope = (
      scope: Scope,
      ctx: UndeclaredVarContext,
    ): GlobalListScope => ({
      resolvesOtherwise: (name): boolean => {
        const upper = name.toUpperCase();
        return (
          scope.lookup(upper) !== undefined ||
          this.isContextName(upper, ctx) ||
          this.stdRegistry.isStandardFunction(name) ||
          this.enumMemberMap.has(upper)
        );
      },
      hidesGlobal: (name): boolean => {
        const upper = name.toUpperCase();
        const hit = scope.lookup(upper);
        if (hit !== globalScope.lookup(upper)) {
          return !(hit?.kind === "variable" && hit.isExternal);
        }
        return this.isContextName(upper, ctx);
      },
      defineAlias,
    });
    this.forEachPouBody(ast, (body, scope, ctx) => {
      resolver.rewriteStatements(body, listScope(scope, ctx));
    });
    // Initial values and init argument lists, in the scope that declares them.
    this.forEachVarBlocks(ast, (blocks, scope, ctx) => {
      resolver.rewriteDeclarations(blocks, listScope(scope, ctx));
    });
    // VAR_EXTERNAL cannot name a global two lists declare.
    const pous = [...ast.programs, ...ast.functions, ...ast.functionBlocks];
    for (const pou of pous) {
      const blocks = [
        ...pou.varBlocks,
        ...("methods" in pou ? pou.methods.flatMap((m) => m.varBlocks) : []),
      ];
      for (const block of blocks) {
        if (block.blockType !== "VAR_EXTERNAL") continue;
        for (const decl of block.declarations) {
          for (const name of decl.names) {
            resolver.checkExternal(name, decl.sourceSpan);
          }
        }
      }
    }
    return gating;
  }

  /** Show `LIST.NAME` in place of the internal name of a list-qualified global. */
  private displayGlobalListNames(diags: CompileError[]): void {
    if (this.globalListDisplayNames.size === 0) return;
    const re = new RegExp(
      `\\b(${[...this.globalListDisplayNames.keys()].join("|")})\\b`,
      "gi",
    );
    for (const d of diags) {
      if (this.verbatimDiagnostics.has(d)) continue;
      d.message = d.message.replace(
        re,
        (m) => this.globalListDisplayNames.get(m.toUpperCase()) ?? m,
      );
    }
  }

  /**
   * A METHOD written in a PROGRAM needs the feature program_methods; a lowered
   * ACTION (`fromAction`) does not. Strict mode does not change this.
   */
  private validateProgramMethodFeature(ast: CompilationUnit): void {
    for (const prog of ast.programs) {
      for (const method of prog.methods) {
        if (method.fromAction === true) continue;
        this.requireFeature(
          "program_methods",
          "METHOD in a PROGRAM",
          method.sourceSpan,
        );
      }
    }
  }

  /** Init arguments and FB_init with the feature off or on (see fb-init.ts). */
  private applyFbInitFeature(ast: CompilationUnit): void {
    const at = (span: SourceSpan): [number, number, string | undefined] => [
      span.startLine,
      span.startCol,
      span.file,
    ];
    prepareFbInit(ast, this.features.has("fb_init"), {
      error: (message, span) => this.addError(message, ...at(span)),
      warning: (message, span) => this.addWarning(message, ...at(span)),
      needFeature: (construct, span) =>
        this.requireFeature("fb_init", construct, span),
    });
  }

  /** `TYPE X STRUCT` without the colon needs the feature type_colon_optional. Reported at STRUCT. */
  private validateTypeColonFeature(ast: CompilationUnit): void {
    for (const typeDecl of ast.types) {
      if (!typeDecl.colonOmittedSpan) continue;
      this.requireFeature(
        "type_colon_optional",
        `TYPE ${typeDecl.name.toUpperCase()} without ':' before STRUCT`,
        typeDecl.colonOmittedSpan,
      );
    }
  }

  /** `TYPE X EXTENDS Base : STRUCT` needs the feature struct_extends. Reported at EXTENDS. */
  private validateStructExtendsFeature(ast: CompilationUnit): void {
    for (const typeDecl of ast.types) {
      if (!typeDecl.extends) continue;
      // EXTENDS on a UNION is refused by validateUnions.
      if (isUnionDefinition(typeDecl.definition)) continue;
      this.requireFeature(
        "struct_extends",
        "EXTENDS on a STRUCT",
        typeDecl.extendsKeywordSpan ?? typeDecl.sourceSpan,
      );
    }
  }

  /**
   * `UNION ... END_UNION` needs the feature union (reported at UNION); its
   * rules and initial values are checked in every case (see union.ts).
   */
  private validateUnions(ast: CompilationUnit): void {
    const report = (message: string, span: SourceSpan): void => {
      this.addError(message, span.startLine, span.startCol, span.file);
    };
    for (const typeDecl of ast.types) {
      if (!isUnionDefinition(typeDecl.definition)) continue;
      // Ed. 3 STRUCT OVERLAP is a UNION in every dialect.
      if (typeDecl.definition.overlap === true) continue;
      this.requireFeature(
        "union",
        `UNION type '${typeDecl.name}'`,
        typeDecl.definition.sourceSpan,
      );
    }
    validateUnionTypes(
      ast,
      (upper) => {
        if (this.symbolTables.lookupFunctionBlock(upper)) {
          return { instance: "FUNCTION_BLOCK" };
        }
        const def =
          this.symbolTables.lookupType(upper)?.declaration?.definition;
        return def?.kind === "StructDefinition"
          ? { fields: def.fields }
          : undefined;
      },
      report,
    );
    validateUnionInitializers(ast, report);
  }

  /** Copy the base fields into each derived STRUCT (see struct-extends.ts). */
  private flattenStructTypes(ast: CompilationUnit): void {
    const named = (list: readonly { name: string }[], upper: string): boolean =>
      list.some((d) => d.name.toUpperCase() === upper);
    const describe = (upper: string): string | undefined => {
      if (named(ast.functionBlocks, upper)) return "a FUNCTION_BLOCK";
      if (named(ast.interfaces, upper)) return "an INTERFACE";
      if (named(ast.functions, upper)) return "a FUNCTION";
      if (named(ast.programs, upper)) return "a PROGRAM";
      if (ELEMENTARY_TYPES[upper] !== undefined) return "an elementary type";
      if (this.symbolTables.lookupFunctionBlock(upper)) {
        return "a FUNCTION_BLOCK";
      }
      const libraryType = this.symbolTables.lookupType(upper);
      if (!libraryType) return undefined;
      const isStruct =
        libraryType.resolvedType?.typeKind === "struct" ||
        libraryType.declaration?.definition.kind === "StructDefinition";
      return isStruct ? LIBRARY_STRUCT : "a type from a library";
    };
    flattenStructExtends(ast, describe, (message, span) => {
      this.addError(message, span.startLine, span.startCol, span.file);
    });
  }

  /**
   * An enumeration base type written after the value list, `(A, B) DINT`,
   * needs the feature postfix_enum_base. Reported at the base type.
   */
  private validatePostfixEnumBases(ast: CompilationUnit): void {
    for (const typeDecl of ast.types) {
      const def = typeDecl.definition;
      if (def.kind !== "EnumDefinition" || def.postfixBase !== true) continue;
      this.requireFeature(
        "postfix_enum_base",
        "an enum base type written after the value list",
        def.baseType?.sourceSpan ?? def.sourceSpan,
      );
    }
  }

  /**
   * A PROPERTY in an INTERFACE needs the feature property. With it on, each
   * prototype declares GET and/or SET, and an accessor has no body.
   */
  private validateInterfaceProperties(ast: CompilationUnit): void {
    for (const iface of ast.interfaces) {
      for (const prop of iface.properties) {
        this.requireFeature(
          "property",
          "PROPERTY in an INTERFACE",
          prop.sourceSpan,
        );
        if (!this.features.has("property")) continue;
        const span = prop.sourceSpan;
        if (prop.getter === undefined && prop.setter === undefined) {
          this.addError(
            `Property '${prop.name}' in INTERFACE '${iface.name}' declares no accessor: declare GET and/or SET`,
            span.startLine,
            span.startCol,
            span.file,
          );
        }
        const bodies: [string, Statement[] | undefined][] = [
          ["GET", prop.getter],
          ["SET", prop.setter],
        ];
        for (const [accessor, body] of bodies) {
          if (body === undefined || body.length === 0) continue;
          this.addError(
            `${accessor} of property '${prop.name}' in INTERFACE '${iface.name}' has a body; an interface accessor is written ${accessor} END_${accessor}`,
            span.startLine,
            span.startCol,
            span.file,
          );
        }
      }
    }
  }

  /**
   * The properties an interface declares, its own first, then those of each
   * EXTENDS base (nearest wins), keyed by upper-case name.
   */
  private collectInterfaceProperties(
    name: string,
    ifaceDecls: Map<string, InterfaceDeclaration>,
  ): Map<string, PropertyDeclaration> {
    const props = new Map<string, PropertyDeclaration>();
    const visited = new Set<string>();
    const visit = (ifaceName: string): void => {
      const upper = ifaceName.toUpperCase();
      if (visited.has(upper)) return;
      visited.add(upper);
      const iface = ifaceDecls.get(upper);
      if (!iface) return;
      for (const p of iface.properties) {
        const key = p.name.toUpperCase();
        if (!props.has(key)) props.set(key, p);
      }
      for (const base of iface.extends ?? []) visit(base);
    };
    visit(name);
    return props;
  }

  /**
   * An FB implementing an interface provides each property the interface
   * (with its bases) declares: same type, and every accessor it declares.
   */
  private validateImplementedProperties(
    fb: FunctionBlockDeclaration,
    fbMap: Map<string, FunctionBlockDeclaration>,
    ifaceDecls: Map<string, InterfaceDeclaration>,
  ): void {
    if (!this.features.has("property") || !fb.implements) return;
    // Own properties, then each base FB's (nearest wins)
    const provided = new Map<string, PropertyDeclaration>();
    const seen = new Set<string>();
    let current: FunctionBlockDeclaration | undefined = fb;
    while (current && !seen.has(current.name.toUpperCase())) {
      seen.add(current.name.toUpperCase());
      for (const p of current.properties) {
        const key = p.name.toUpperCase();
        if (!provided.has(key)) provided.set(key, p);
      }
      current = current.extends
        ? fbMap.get(current.extends.toUpperCase())
        : undefined;
    }
    for (const ifaceName of fb.implements) {
      const required = this.collectInterfaceProperties(ifaceName, ifaceDecls);
      for (const [key, req] of required) {
        const own = provided.get(key);
        if (!own) {
          this.addError(
            `FUNCTION_BLOCK '${fb.name}' implements '${ifaceName}' but does not provide property '${req.name}'.`,
            fb.sourceSpan.startLine,
            fb.sourceSpan.startCol,
            fb.sourceSpan.file,
          );
          continue;
        }
        const span = own.sourceSpan;
        if (typeKey(own.type) !== typeKey(req.type)) {
          this.addError(
            `Property '${own.name}' of FUNCTION_BLOCK '${fb.name}' has type ${own.type.name}, but '${ifaceName}' declares it ${req.type.name}.`,
            span.startLine,
            span.startCol,
            span.file,
          );
          continue;
        }
        const accessors: [string, boolean, boolean][] = [
          ["GET", req.getter !== undefined, own.getter !== undefined],
          ["SET", req.setter !== undefined, own.setter !== undefined],
        ];
        for (const [accessor, wanted, has] of accessors) {
          if (!wanted || has) continue;
          this.addError(
            `FUNCTION_BLOCK '${fb.name}' implements '${ifaceName}' but its property '${own.name}' has no ${accessor} accessor.`,
            span.startLine,
            span.startCol,
            span.file,
          );
        }
      }
    }
  }

  /**
   * A CONFIGURATION VAR_GLOBAL cannot hold a function block (user or library),
   * directly or through a STRUCT or ARRAY: its storage is a shared,
   * lock-guarded global and an FB instance there has no locking design (D3,
   * C11). A global variable list or a PROGRAM can hold one. Refused at the
   * declaration, called or not, like a feature refusal (not gated below).
   */
  private validateConfigurationGlobalsHoldNoFB(ast: CompilationUnit): void {
    const isFunctionBlock = (name: string): boolean =>
      this.symbolTables.globalScope.lookup(name)?.kind === "functionBlock";
    const lateTypes = typesHoldingFunctionBlocks(ast.types, isFunctionBlock);
    for (const config of ast.configurations) {
      for (const block of config.varBlocks) {
        if (block.blockType !== "VAR_GLOBAL") continue;
        for (const decl of block.declarations) {
          const held = typeNamesHeldByValue(decl.type).find(
            (n) =>
              isFunctionBlock(n.toUpperCase()) ||
              lateTypes.has(n.toUpperCase()),
          );
          if (held === undefined) continue;
          const shown =
            decl.type.elementTypeName !== undefined
              ? `ARRAY OF ${held}`
              : decl.type.name;
          for (const name of decl.names) {
            this.addError(
              `VAR_GLOBAL ${name} in a CONFIGURATION cannot hold a FUNCTION_BLOCK (${shown}); declare it in a global variable list or in a PROGRAM`,
              decl.sourceSpan.startLine,
              decl.sourceSpan.startCol,
              decl.sourceSpan.file,
            );
          }
        }
      }
    }
  }

  /**
   * A program's methods and actions may be called only inside the program:
   * its body, its methods and its actions. `MAIN.Name()` or `p.Name()` (with
   * `p : MAIN`) from any other POU is refused. With program_methods on,
   * `MAIN.Name()` names the program's one instance and is allowed (see
   * validateProgramAccess); `p.Name()` stays refused.
   */
  private validateProgramMethodCalls(ast: CompilationUnit): void {
    const programs = new Map<string, { name: string; methods: Set<string> }>();
    for (const prog of ast.programs) {
      if (prog.methods.length === 0) continue;
      programs.set(prog.name.toUpperCase(), {
        name: prog.name,
        methods: new Set(prog.methods.map((m) => m.name.toUpperCase())),
      });
    }
    if (programs.size === 0) return;
    const byName = this.features.has("program_methods");

    const check = (
      callerProgram: string | undefined,
      blocks: readonly VarBlock[],
      bodies: readonly Statement[][],
    ): void => {
      const varTypes = this.buildVarTypeMap([...blocks]);
      const refuse = (
        objectName: string,
        methodName: string,
        span: { startLine: number; startCol: number; file?: string },
      ): void => {
        const obj = objectName.toUpperCase();
        const target = programs.get(varTypes.get(obj) ?? obj);
        if (!target || !target.methods.has(methodName.toUpperCase())) return;
        if (target.name.toUpperCase() === callerProgram) return;
        // By name, the call reaches the one instance (validateProgramAccess).
        if (byName && !varTypes.has(obj)) return;
        this.addError(
          `the methods and actions of PROGRAM ${target.name} can be called only inside ${target.name}`,
          span.startLine,
          span.startCol,
          span.file,
        );
      };
      for (const body of bodies) {
        for (const stmt of body) {
          walkAST(stmt, (node) => {
            if (node.kind === "FunctionCallExpression") {
              const call = node as FunctionCallExpression;
              const parts = call.functionName.split(".");
              if (parts.length === 2 && !call.instance) {
                refuse(parts[0]!, parts[1]!, call.sourceSpan);
              }
            } else if (node.kind === "MethodCallExpression") {
              const call = node as MethodCallExpression;
              const obj = call.object;
              if (
                obj.kind === "VariableExpression" &&
                obj.fieldAccess.length === 0 &&
                obj.subscripts.length === 0
              ) {
                refuse(obj.name, call.methodName, call.sourceSpan);
              }
            }
          });
        }
      }
    };

    for (const prog of ast.programs) {
      const self = prog.name.toUpperCase();
      check(self, prog.varBlocks, [prog.body]);
      for (const method of prog.methods) {
        check(self, [...prog.varBlocks, ...method.varBlocks], [method.body]);
      }
    }
    for (const func of ast.functions) {
      check(undefined, func.varBlocks, [func.body]);
    }
    for (const fb of ast.functionBlocks) {
      check(undefined, fb.varBlocks, [fb.body]);
      for (const method of fb.methods) {
        check(undefined, [...fb.varBlocks, ...method.varBlocks], [method.body]);
      }
      for (const prop of fb.properties) {
        const bodies = [prop.getter, prop.setter].filter(
          (b): b is Statement[] => b !== undefined,
        );
        check(undefined, fb.varBlocks, bodies);
      }
    }
  }

  /**
   * A PROGRAM reached by name from another POU (see program-access.ts). With
   * program_methods off a body call is refused here (members and methods are
   * refused by checkInstanceAccess and validateProgramMethodCalls). With it
   * on, each reach is checked against the program:
   *
   *   - VAR_INPUT and VAR are read and written, VAR_OUTPUT and CONSTANT only
   *     read; VAR_TEMP, VAR_IN_OUT and VAR_EXTERNAL are not reachable
   *   - a method or action must exist and be PUBLIC
   *   - a body call is a statement; `:=` names a VAR_INPUT, `=>` a VAR_OUTPUT
   *
   * A reached program has one instance: a variable of its type, or a second
   * CONFIGURATION instance of it, is refused. A program calling its own body
   * is refused in every mode.
   */
  private validateProgramAccess(
    ast: CompilationUnit,
    reaches: readonly ProgramReach[],
  ): void {
    for (const call of findProgramSelfCalls(ast)) {
      this.addError(
        `PROGRAM ${call.program} cannot call itself`,
        call.span.startLine,
        call.span.startCol,
        call.span.file,
      );
    }
    const on = this.features.has("program_methods");
    const programs = new Map(
      ast.programs.map((p) => [p.name.toUpperCase(), p]),
    );
    const error = (message: string, span: SourceSpan): void =>
      this.addError(message, span.startLine, span.startCol, span.file);
    const member = (
      prog: ProgramDeclaration,
      name: string,
    ): { block: VarBlock; decl: VarDeclaration } | undefined => {
      const upper = name.toUpperCase();
      for (const block of prog.varBlocks) {
        for (const decl of block.declarations) {
          if (decl.names.some((n) => n.toUpperCase() === upper)) {
            return { block, decl };
          }
        }
      }
      return undefined;
    };

    for (const reach of reaches) {
      const prog = programs.get(reach.program);
      if (!prog) continue;
      const P = prog.name;
      if (!on) {
        if (reach.kind === "call") {
          this.requireFeature(
            "program_methods",
            `a call of PROGRAM ${P} from another POU`,
            reach.span,
          );
        }
        continue;
      }
      if (reach.kind === "member") {
        const found = member(prog, reach.member);
        if (!found) {
          error(`PROGRAM ${P} has no variable '${reach.member}'`, reach.span);
          continue;
        }
        const bt = found.block.blockType;
        if (bt !== "VAR" && bt !== "VAR_INPUT" && bt !== "VAR_OUTPUT") {
          error(
            `${bt} '${reach.member}' of PROGRAM ${P} cannot be reached from another POU`,
            reach.span,
          );
        } else if (reach.write && found.block.isConstant) {
          error(
            `Cannot assign to CONSTANT variable '${P}.${reach.member}'`,
            reach.span,
          );
        } else if (reach.write && bt === "VAR_OUTPUT") {
          error(
            `VAR_OUTPUT '${reach.member}' of PROGRAM ${P} is read-only outside ${P}`,
            reach.span,
          );
        }
      } else if (reach.kind === "method") {
        const upper = reach.method.toUpperCase();
        const method = prog.methods.find((m) => m.name.toUpperCase() === upper);
        if (!method) {
          error(
            `PROGRAM ${P} has no method or action '${reach.method}'`,
            reach.span,
          );
        } else if (
          method.visibility === "PRIVATE" ||
          method.visibility === "PROTECTED"
        ) {
          error(
            `Cannot call ${method.visibility} method '${reach.method}' of '${P}' from outside '${P}'.`,
            reach.span,
          );
        }
      } else {
        if (!reach.statement) {
          error(
            `PROGRAM ${P} has no result: call it as a statement`,
            reach.span,
          );
          continue;
        }
        const inputs = prog.varBlocks
          .filter((b) => b.blockType === "VAR_INPUT")
          .flatMap((b) => b.declarations.flatMap((d) => d.names));
        let positional = 0;
        for (const arg of reach.arguments) {
          const name = arg.name?.toUpperCase();
          if (name === "EN" || name === "ENO") continue;
          if (name === undefined) {
            positional++;
            continue;
          }
          const wanted = arg.isOutput ? "VAR_OUTPUT" : "VAR_INPUT";
          if (member(prog, name)?.block.blockType !== wanted) {
            error(`PROGRAM ${P} has no ${wanted} '${arg.name}'`, reach.span);
          }
        }
        if (positional > inputs.length) {
          error(`too many arguments in the call of PROGRAM ${P}`, reach.span);
        }
      }
    }

    if (!on) return;
    const reached = new Set(reaches.map((r) => r.program));
    if (reached.size === 0) return;
    const oneInstance = (P: string): string =>
      `PROGRAM ${P} has one instance, reached by name from other POUs`;

    // A variable of a reached program's type would be a second instance.
    const checkBlocks = (blocks: readonly VarBlock[]): void => {
      for (const block of blocks) {
        for (const decl of block.declarations) {
          const prog = programs.get(decl.type.name.toUpperCase());
          if (!prog || !reached.has(prog.name.toUpperCase())) continue;
          for (const name of decl.names) {
            error(
              `${oneInstance(prog.name)}; ${name} cannot declare another`,
              decl.sourceSpan,
            );
          }
        }
      }
    };
    checkBlocks(ast.globalVarBlocks);
    for (const prog of ast.programs) {
      checkBlocks(prog.varBlocks);
      for (const method of prog.methods) checkBlocks(method.varBlocks);
    }
    for (const func of ast.functions) checkBlocks(func.varBlocks);
    for (const fb of ast.functionBlocks) {
      checkBlocks(fb.varBlocks);
      for (const method of fb.methods) checkBlocks(method.varBlocks);
    }
    for (const config of ast.configurations) checkBlocks(config.varBlocks);

    // The configuration runs the one instance at most once.
    const first = new Map<string, string>();
    for (const config of ast.configurations) {
      for (const resource of config.resources) {
        for (const inst of resource.programInstances) {
          const prog = programs.get(inst.programType.toUpperCase());
          if (!prog || !reached.has(prog.name.toUpperCase())) continue;
          const seen = first.get(prog.name.toUpperCase());
          if (seen === undefined) {
            first.set(prog.name.toUpperCase(), inst.instanceName);
            continue;
          }
          error(
            `${oneInstance(prog.name)}; the CONFIGURATION cannot run it as both ${seen} and ${inst.instanceName}`,
            inst.sourceSpan,
          );
        }
      }
    }
  }

  /**
   * `--strict`: ON, STEP and MOVE are keywords of matiec's SFC grammar, so it
   * rejected them as the name of anything. The one exception it makes is a
   * FUNCTION named MOVE, which it accepts.
   */
  private validateReservedNames(ast: CompilationUnit): void {
    const reserved = new Set(["ON", "STEP", "MOVE"]);
    const check = (
      name: string,
      span: { startLine: number; startCol: number; file?: string },
    ): void => {
      if (!reserved.has(name.toUpperCase())) return;
      this.addError(
        `${name} is a reserved name`,
        span.startLine,
        span.startCol,
        span.file,
      );
    };
    const checkBlocks = (blocks: readonly VarBlock[]): void => {
      for (const block of blocks) {
        for (const decl of block.declarations) {
          for (const n of decl.names) check(n, decl.sourceSpan);
        }
      }
    };
    for (const prog of ast.programs) {
      check(prog.name, prog.sourceSpan);
      checkBlocks(prog.varBlocks);
      for (const method of prog.methods) {
        check(method.name, method.sourceSpan);
        checkBlocks(method.varBlocks);
      }
    }
    for (const fn of ast.functions) {
      if (fn.name.toUpperCase() !== "MOVE") check(fn.name, fn.sourceSpan);
      checkBlocks(fn.varBlocks);
    }
    for (const fb of ast.functionBlocks) {
      check(fb.name, fb.sourceSpan);
      checkBlocks(fb.varBlocks);
      for (const method of fb.methods) {
        check(method.name, method.sourceSpan);
        checkBlocks(method.varBlocks);
      }
    }
    for (const type of ast.types) {
      check(type.name, type.sourceSpan);
      const def = type.definition;
      if (def.kind === "EnumDefinition") {
        for (const m of def.members) check(m.name, m.sourceSpan);
      } else if (def.kind === "StructDefinition") {
        for (const field of ownFields(def)) {
          for (const n of field.names) check(n, field.sourceSpan);
        }
      }
    }
    checkBlocks(ast.globalVarBlocks);
    for (const cfg of ast.configurations) {
      check(cfg.name, cfg.sourceSpan);
      checkBlocks(cfg.varBlocks);
      for (const res of cfg.resources) {
        check(res.name, res.sourceSpan);
        for (const task of res.tasks) check(task.name, task.sourceSpan);
        for (const inst of res.programInstances) {
          check(inst.instanceName, inst.sourceSpan);
        }
      }
    }
  }

  /**
   * Resolve a type name to its registered type (preserves enum typeKind)
   * or fall back to a generic elementary type for unknown/user-defined types.
   */
  private resolveVarType(typeName: string): EnumType | ElementaryType {
    const typeSymbol = this.symbolTables.globalScope.lookup(typeName);
    return typeSymbol?.kind === "type" && typeSymbol.resolvedType
      ? (typeSymbol.resolvedType as EnumType | ElementaryType)
      : { typeKind: "elementary" as const, name: typeName, sizeBits: 0 };
  }

  /**
   * Build symbol tables from the AST.
   */
  private buildSymbolTables(ast: CompilationUnit): void {
    // Register type declarations
    for (const typeDecl of ast.types) {
      try {
        // Use enum typeKind for EnumDefinition so CASE and type checks work correctly
        // An alias of an enumeration is that enumeration.
        const aliased = enumBehindAlias(ast.types, typeDecl);
        const resolvedType: EnumType | ElementaryType =
          aliased !== undefined && aliased.definition.kind === "EnumDefinition"
            ? {
                typeKind: "enum" as const,
                name: aliased.name,
                values: aliased.definition.members.map((m) => m.name),
              }
            : {
                typeKind: "elementary" as const,
                name: typeDecl.name,
                sizeBits: 0,
              };
        this.symbolTables.globalScope.defineOrReplace({
          name: typeDecl.name,
          kind: "type",
          declaration: typeDecl,
          resolvedType,
        });

        // Surface each enum member as a separate `EnumValueSymbol`
        // in the global scope.  Type-checking uses the
        // `enumMemberMap` built below for resolution, but
        // autocomplete walks `scope.getAllSymbols()` — without
        // these entries, bare enum values (`Stopped`, `Running`, …)
        // never appear in the suggestion list even though the
        // language accepts them.  Skip names already claimed by a
        // real symbol (e.g. a global variable with the same
        // identifier) to avoid silently shadowing them.
        // An inline enumeration's members belong to its POU, not the global scope.
        if (
          typeDecl.definition.kind === "EnumDefinition" &&
          typeDecl.inline?.owner === undefined
        ) {
          typeDecl.definition.members.forEach((member, index) => {
            if (this.symbolTables.globalScope.hasLocal(member.name)) return;
            this.symbolTables.globalScope.defineOrReplace({
              name: member.name,
              kind: "enumValue",
              enumType: typeDecl.name,
              // Ordinal default; explicit values (`MEMBER := 5`) are
              // resolved by the analyzer's expression pass elsewhere
              // and not consumed by autocomplete.
              value: index,
            });
          });
        }
      } catch (err) {
        if (err instanceof Error) {
          this.addError(
            err.message,
            typeDecl.sourceSpan.startLine,
            typeDecl.sourceSpan.startCol,
            typeDecl.sourceSpan.file,
          );
        }
      }
    }

    // Build reverse lookup map: enum member name → owning enum type
    this.enumMemberMap = buildEnumMemberMap(
      ast.types
        .filter(
          (t) =>
            t.definition.kind === "EnumDefinition" &&
            t.inline?.owner === undefined,
        )
        .map((t) => ({
          name: t.name,
          members:
            t.definition.kind === "EnumDefinition"
              ? t.definition.members.map((m) => m.name)
              : [],
        })),
    );

    // Register function declarations
    for (const funcDecl of ast.functions) {
      try {
        const returnType = this.resolveVarType(
          funcDecl.returnType.name.toUpperCase(),
        );
        this.symbolTables.globalScope.defineOrReplace({
          name: funcDecl.name,
          kind: "function",
          declaration: funcDecl,
          returnType,
          parameters: [],
        });

        // Create local scope for function
        const scope = this.symbolTables.createFunctionScope(funcDecl.name);
        this.buildVarBlockSymbols(
          funcDecl.varBlocks,
          scope,
          "function",
          funcDecl.name,
          false,
        );
      } catch (err) {
        if (err instanceof Error) {
          this.addError(
            err.message,
            funcDecl.sourceSpan.startLine,
            funcDecl.sourceSpan.startCol,
            funcDecl.sourceSpan.file,
          );
        }
      }
    }

    // Register function block declarations
    for (const fbDecl of ast.functionBlocks) {
      try {
        this.symbolTables.globalScope.defineOrReplace({
          name: fbDecl.name,
          kind: "functionBlock",
          declaration: fbDecl,
          inputs: [],
          outputs: [],
          inouts: [],
          locals: [],
        });

        // Create local scope for function block
        const scope = this.symbolTables.createFBScope(fbDecl.name);
        this.buildVarBlockSymbols(
          fbDecl.varBlocks,
          scope,
          "functionBlock",
          fbDecl.name,
          true,
        );

        // Create method scopes (parent = FB scope for correct lookup chain)
        this.buildMethodScopes(fbDecl.name, fbDecl.methods);
      } catch (err) {
        if (err instanceof Error) {
          this.addError(
            err.message,
            fbDecl.sourceSpan.startLine,
            fbDecl.sourceSpan.startCol,
            fbDecl.sourceSpan.file,
          );
        }
      }
    }

    // Register interface declarations as types (so they can be used in IMPLEMENTS and var types)
    for (const ifaceDecl of ast.interfaces) {
      try {
        const resolvedType: ElementaryType = {
          typeKind: "elementary",
          name: ifaceDecl.name,
          sizeBits: 0,
        };
        this.symbolTables.globalScope.defineOrReplace({
          name: ifaceDecl.name,
          kind: "type",
          declaration:
            undefined as unknown as import("../frontend/ast.js").TypeDeclaration,
          resolvedType,
        });
      } catch (err) {
        if (err instanceof Error) {
          this.addError(
            err.message,
            ifaceDecl.sourceSpan.startLine,
            ifaceDecl.sourceSpan.startCol,
            ifaceDecl.sourceSpan.file,
          );
        }
      }
    }

    // Register program declarations
    for (const progDecl of ast.programs) {
      try {
        this.symbolTables.globalScope.defineOrReplace({
          name: progDecl.name,
          kind: "program",
          declaration: progDecl,
          variables: [],
        });

        // Create local scope for program
        const scope = this.symbolTables.createProgramScope(progDecl.name);
        this.buildVarBlockSymbols(
          progDecl.varBlocks,
          scope,
          "program",
          progDecl.name,
          true,
        );
        // Program methods: parent = program scope. A method refused for want
        // of program_methods is still registered, so calls to it add nothing.
        this.buildMethodScopes(progDecl.name, progDecl.methods);
      } catch (err) {
        if (err instanceof Error) {
          this.addError(
            err.message,
            progDecl.sourceSpan.startLine,
            progDecl.sourceSpan.startCol,
            progDecl.sourceSpan.file,
          );
        }
      }
    }

    // Register global variable declarations
    for (const block of ast.globalVarBlocks) {
      for (const decl of block.declarations) {
        // An `AT` operand on a TOP-LEVEL global is checked here, per
        // declaration, because nothing downstream looks at it: codegen emits
        // these as plain `inline` storage and only CONFIGURATION VAR_GLOBALs
        // reach `locatedVars[]` / `locatedGlobals[]`.
        //
        // The two cases part company on whether the source can be compiled at
        // all. An unresolved alias cannot: no address exists for it, so it is
        // an error, exactly as it is in a POU — left unchecked it compiled
        // clean and produced an unlocated variable, the silent failure the
        // alias diagnostic exists to prevent, newly reachable because this
        // grammar now accepts an identifier wherever it accepts an address. A
        // well-formed `%` address is a compilable program whose address this
        // compiler cannot bind, so it warns and carries on: the variable is
        // built, unlocated, and the user is told where to move it rather than
        // having a build refused over something that used to pass.
        if (decl.address) {
          if (parseAddress(decl.address)) {
            this.addWarning(
              `Located variable '${decl.names[0] ?? ""}' at ${decl.address} is declared in a top-level VAR_GLOBAL, ` +
                `where the compiler cannot bind it, so the address is ignored. ` +
                `Move it to CONFIGURATION VAR_GLOBAL to have it located.`,
              decl.sourceSpan.startLine,
              decl.sourceSpan.startCol,
              decl.sourceSpan.file,
            );
          } else {
            this.addError(
              unusableAddressMessage(decl),
              decl.sourceSpan.startLine,
              decl.sourceSpan.startCol,
              decl.sourceSpan.file,
            );
          }
        }
        for (const name of decl.names) {
          try {
            const varType = this.resolveVarType(decl.type.name);
            // A user global shadows a same-named library symbol.
            const scope = this.symbolTables.globalScope;
            const define = scope.definedByLibrary(name)
              ? scope.defineOrReplace.bind(scope)
              : scope.define.bind(scope);
            if (block.isConstant) {
              define({
                name,
                kind: "constant",
                declaration: decl,
                type: varType,
              });
            } else {
              define({
                name,
                kind: "variable",
                declaration: decl,
                type: varType,
                isInput: false,
                isOutput: false,
                isInOut: false,
                isExternal: false,
                isGlobal: true,
                isRetain: block.isRetain,
                address: decl.address,
              });
            }
          } catch (err) {
            if (err instanceof Error) {
              this.addError(
                err.message,
                decl.sourceSpan.startLine,
                decl.sourceSpan.startCol,
                decl.sourceSpan.file,
              );
            }
          }
        }
      }
    }
  }

  /**
   * Create a scope per method of an FB or a program, holding the method's
   * own VARs and its return variable (`MethodName := value`).
   */
  private buildMethodScopes(
    ownerName: string,
    methods: readonly MethodDeclaration[],
  ): void {
    for (const method of methods) {
      try {
        const methodScope = this.symbolTables.createMethodScope(
          ownerName,
          method.name,
        );
        this.buildVarBlockSymbols(
          method.varBlocks,
          methodScope,
          "functionBlock",
          ownerName,
          false,
        );
        if (method.returnType) {
          const retType = this.resolveVarType(method.returnType.name);
          methodScope.define({
            name: method.name,
            kind: "variable",
            type: retType,
            declaration: undefined as unknown as VarDeclaration,
            isInput: false,
            isOutput: false,
            isInOut: false,
            isExternal: false,
            isGlobal: false,
            isRetain: false,
          });
        }
      } catch (methodErr) {
        if (methodErr instanceof Error) {
          this.addError(
            methodErr.message,
            method.sourceSpan.startLine,
            method.sourceSpan.startCol,
            method.sourceSpan.file,
          );
        }
      }
    }
  }

  /**
   * Build symbols from variable blocks.
   */
  private buildVarBlockSymbols(
    varBlocks: CompilationUnit["programs"][0]["varBlocks"],
    scope: ReturnType<typeof this.symbolTables.createProgramScope>,
    scopeType: "program" | "function" | "functionBlock",
    scopeName: string,
    /**
     * Whether declarations here belong to something with instance storage.
     *
     * False for a FUNCTION and for a METHOD: neither has an instance, their
     * locals are stack temporaries, and RETAIN over a stack slot is
     * meaningless. `scopeType` cannot answer this — a method reports
     * "functionBlock" so its located variables are rejected the same way an
     * FB's are, and overloading it would change that unrelated rule.
     */
    hasInstanceState: boolean,
  ): void {
    for (const block of varBlocks) {
      this.validateVarModifiers(block, hasInstanceState);

      for (const decl of block.declarations) {
        for (const name of decl.names) {
          try {
            const varType = this.resolveVarType(decl.type.name);
            if (block.isConstant) {
              scope.define({
                name,
                kind: "constant",
                declaration: decl,
                type: varType,
              });
            } else {
              scope.define({
                name,
                kind: "variable",
                declaration: decl,
                type: varType,
                isInput: block.blockType === "VAR_INPUT",
                isOutput: block.blockType === "VAR_OUTPUT",
                isInOut: block.blockType === "VAR_IN_OUT",
                isExternal: block.blockType === "VAR_EXTERNAL",
                isGlobal: block.blockType === "VAR_GLOBAL",
                isRetain: block.isRetain,
                address: decl.address,
              });

              // Track located variables for validation.
              //
              // Only VAR and VAR_GLOBAL may own an address (see
              // LOCATABLE_BLOCK_TYPES). Report and do NOT record the declaration,
              // so a located VAR_EXTERNAL cannot also collide with the global that
              // legitimately claims the address.
              if (decl.address && !LOCATABLE_BLOCK_TYPES.has(block.blockType)) {
                this.addError(
                  `Variable '${name}' in ${block.blockType} cannot have a location ('AT ${decl.address}'). Only VAR and VAR_GLOBAL declarations may be located.` +
                    (block.blockType === "VAR_EXTERNAL"
                      ? ` A VAR_EXTERNAL references storage owned by a CONFIGURATION VAR_GLOBAL — declare the address on that VAR_GLOBAL and drop it here.`
                      : ` Move '${name}' to a VAR block, or to CONFIGURATION VAR_GLOBAL if other POUs need it.`),
                  decl.sourceSpan.startLine,
                  decl.sourceSpan.startCol,
                  decl.sourceSpan.file,
                );
              } else if (decl.address) {
                const parsed = parseAddress(decl.address);
                if (parsed) {
                  this.locatedVars.push({
                    name,
                    address: decl.address,
                    parsed,
                    typeName: decl.type.name,
                    scopeType,
                    scopeName,
                    declaration: decl,
                  });
                } else {
                  this.addError(
                    unusableAddressMessage(decl),
                    decl.sourceSpan.startLine,
                    decl.sourceSpan.startCol,
                    decl.sourceSpan.file,
                  );
                }
              }
            }
          } catch (err) {
            if (err instanceof Error) {
              this.addError(
                err.message,
                decl.sourceSpan.startLine,
                decl.sourceSpan.startCol,
                decl.sourceSpan.file,
              );
            }
          }
        }
      }
    }
  }

  /**
   * Validate IEC 61131-3 semantic rules.
   */
  private validateSemantics(ast: CompilationUnit): void {
    const reaches = findProgramReaches(ast);
    this.reachedMemberNodes = new Set(
      this.features.has("program_methods")
        ? reaches.flatMap((r) => (r.kind === "member" ? [r.node] : []))
        : [],
    );

    // Validate undeclared variable usage
    this.validateUndeclaredVariables(ast);

    // Validate located variables
    this.validateLocatedVariables(ast);

    // Validate CONSTANT assignment restrictions
    this.validateConstantAssignments(ast);

    // Validate OOP property/member name collisions
    this.validatePropertyNameCollisions(ast);

    // Validate OOP modifier contradictions
    this.validateOOPModifiers(ast);

    // Validate abstract FB instantiation
    this.validateAbstractInstantiation(ast);

    // Validate property write access (read-only check)
    this.validatePropertyAccess(ast);

    // Variable access specifiers only on a FUNCTION_BLOCK's VAR sections
    this.validateVarAccessSpecifiers(ast);

    // Validate access modifier enforcement
    this.validateAccessModifiers(ast);

    // Program methods are callable only inside their program (C12)
    this.validateProgramMethodCalls(ast);

    // A program reached by name from another POU (feature program_methods)
    this.validateProgramAccess(ast, reaches);

    // Validate bit access bounds and ADR l-value targets
    this.validateExpressions(ast);

    // Validate array initializer shape/size and subscript counts
    this.validateArrayShapes(ast);

    // Validate that structure initializers only appear where IEC allows them
    this.validateStructInitializerPlacement(ast);

    // Validate that an enumeration type's default is one of its values
    this.validateEnumTypeDefaults(ast);

    // Validate that integer literals fit an IEC integer type
    this.validateLiteralRanges(ast);

    // TODO: Implement additional semantic validation
    // - Check CASE statement coverage
    // - Validate reference operations
    // - Check for unreachable code
  }

  /**
   * Literals a type cannot hold (integer, typed, LTIME, REAL) and STRING
   * characters outside Windows-1252. Needs no resolved type, so it also runs
   * when an earlier error stops the type checks.
   */
  /** Literals an earlier error already reports, left out of the literal checks. */
  private literalsReported = new Set<LiteralExpression>();

  /**
   * Before the literal checks run without the type checks: leave out a literal
   * an earlier error starts at (`n := '☃'` refused as STRING into INT), and
   * take a one-character literal assigned to a CHAR or WCHAR as that
   * character, as the type checks would.
   */
  private prepareLiteralFallback(ast: CompilationUnit): void {
    const at = new Set(
      this.errors.map((e) => `${e.file ?? ""}:${e.line}:${e.column}`),
    );
    walkAST(ast, (node) => {
      if (node.kind !== "LiteralExpression") return;
      const literal = node as LiteralExpression;
      const span = literal.sourceSpan;
      if (at.has(`${span.file ?? ""}:${span.startLine}:${span.startCol}`)) {
        this.literalsReported.add(literal);
      }
    });
    const charKind = (typeName: string): "CHAR" | "WCHAR" | undefined => {
      let upper = typeName.toUpperCase();
      for (let i = 0; i < 32; i++) {
        if (upper === "CHAR" || upper === "WCHAR") return upper;
        const current = upper;
        const def = ast.types.find(
          (t) => t.name.toUpperCase() === current,
        )?.definition;
        if (def?.kind !== "TypeReference") return undefined;
        upper = def.name.toUpperCase();
      }
      return undefined;
    };
    const adapt = (value: Expression, typeName: string | undefined): void => {
      const kind = typeName === undefined ? undefined : charKind(typeName);
      if (kind === undefined || value.kind !== "LiteralExpression") return;
      const want = kind === "CHAR" ? "STRING" : "WSTRING";
      if (value.literalType !== want || (value.typePrefix ?? "") !== "") return;
      const raw = `${kind}#${value.rawValue}`;
      if (charLiteralUnits(raw).units.length !== 1) return;
      value.literalType = kind;
      value.rawValue = raw;
      value.value = raw;
    };
    const visitPou = (
      blocks: readonly VarBlock[],
      bodies: readonly Statement[][],
    ): void => {
      const types = new Map<string, string>();
      for (const b of [...ast.globalVarBlocks, ...blocks]) {
        for (const d of b.declarations) {
          for (const n of d.names) types.set(n.toUpperCase(), d.type.name);
          if (d.initialValue && d.type.arrayDimensions === undefined) {
            adapt(d.initialValue, d.type.name);
          }
        }
      }
      for (const body of bodies) {
        for (const stmt of body) {
          walkAST(stmt as ASTNode, (n) => {
            if (n.kind !== "AssignmentStatement") return;
            const a = n as AssignmentStatement;
            if (
              a.target.kind === "VariableExpression" &&
              a.target.fieldAccess.length === 0 &&
              a.target.subscripts.length === 0 &&
              !a.target.isDereference
            ) {
              adapt(a.value, types.get(a.target.name.toUpperCase()));
            }
          });
        }
      }
    };
    for (const p of ast.programs) visitPou(p.varBlocks, [p.body]);
    for (const f of ast.functions) visitPou(f.varBlocks, [f.body]);
    for (const fb of ast.functionBlocks) {
      visitPou(fb.varBlocks, [fb.body]);
      for (const m of fb.methods) {
        visitPou([...fb.varBlocks, ...m.varBlocks], [m.body]);
      }
    }
  }

  private validateLiteralRanges(ast: CompilationUnit): void {
    this.validateStringLiteralLengths(ast);
    this.validateIntegerLiteralRange(ast);
    this.validateStringLiteralCharset(ast);
    this.validateLtimeLiteralRange(ast);
    this.validateRealLiteralRange(ast);
  }

  /**
   * A STRING or WSTRING literal longer than the variable, input or field it is
   * stored in is cut to that length at run time: warn, in every mode.
   */
  private validateStringLiteralLengths(ast: CompilationUnit): void {
    const capacity = (type: TypeReference | undefined): number | undefined => {
      if (type === undefined || type.arrayDimensions !== undefined)
        return undefined;
      if ((type.referenceKind ?? "none") !== "none") return undefined;
      const name = type.name.toUpperCase();
      if (name !== "STRING" && name !== "WSTRING") return undefined;
      if (type.maxLength === undefined) return 254;
      return typeof type.maxLength === "number" ? type.maxLength : undefined;
    };
    const check = (
      value: Expression | undefined,
      type: TypeReference | undefined,
    ): void => {
      const max = capacity(type);
      if (max === undefined || value?.kind !== "LiteralExpression") return;
      const wide = value.literalType === "WSTRING";
      if (!wide && value.literalType !== "STRING") return;
      if ((type!.name.toUpperCase() === "WSTRING") !== wide) return;
      const length = charLiteralUnits(
        wide ? `WSTRING#${value.rawValue}` : value.rawValue,
      ).units.length;
      if (length <= max) return;
      const kind = wide ? "WSTRING" : "STRING";
      this.addWarning(
        `A ${kind} literal of ${length} characters is longer than ${kind}(${max}): it is cut to ${max}`,
        value.sourceSpan.startLine,
        value.sourceSpan.startCol,
        value.sourceSpan.file,
      );
    };
    const inputsOf = (
      blocks: readonly VarBlock[],
    ): TypeReference[] & { names?: string[] } => {
      const out: TypeReference[] & { names?: string[] } = [];
      out.names = [];
      for (const b of blocks) {
        if (b.blockType !== "VAR_INPUT" && b.blockType !== "VAR_IN_OUT")
          continue;
        for (const d of b.declarations) {
          for (const n of d.names) {
            out.push(
              b.blockType === "VAR_INPUT" ? d.type : { ...d.type, name: "" },
            );
            out.names.push(n.toUpperCase());
          }
        }
      }
      return out;
    };
    const globals = new Map<string, TypeReference>();
    const addDecls = (
      blocks: readonly VarBlock[],
      into: Map<string, TypeReference>,
    ): void => {
      for (const block of blocks) {
        for (const decl of block.declarations) {
          for (const name of decl.names)
            into.set(name.toUpperCase(), decl.type);
          check(decl.initialValue, decl.type);
        }
      }
    };
    addDecls(ast.globalVarBlocks, globals);
    for (const config of ast.configurations)
      addDecls(config.varBlocks, globals);
    for (const typeDecl of ast.types) {
      if (typeDecl.definition.kind !== "StructDefinition") continue;
      for (const field of ownFields(typeDecl.definition)) {
        check(field.initialValue, field.type);
      }
    }
    const callInputs = (
      call: FunctionCallExpression,
      scope: Map<string, TypeReference>,
    ): ReturnType<typeof inputsOf> | undefined => {
      const upper = call.functionName.toUpperCase();
      const local = scope.get(upper);
      if (local !== undefined) {
        const fb = ast.functionBlocks.find(
          (f) => f.name.toUpperCase() === local.name.toUpperCase(),
        );
        return fb === undefined ? undefined : inputsOf(fb.varBlocks);
      }
      const fn = ast.functions.find((f) => f.name.toUpperCase() === upper);
      return fn === undefined ? undefined : inputsOf(fn.varBlocks);
    };
    const checkPou = (
      blocks: readonly VarBlock[],
      bodies: Statement[][],
    ): void => {
      const scope = new Map(globals);
      for (const block of blocks) {
        for (const decl of block.declarations) {
          for (const name of decl.names)
            scope.set(name.toUpperCase(), decl.type);
          check(decl.initialValue, decl.type);
        }
      }
      for (const body of bodies) {
        for (const stmt of body) {
          walkAST(stmt as ASTNode, (node) => {
            if (node.kind === "AssignmentStatement") {
              const a = node as AssignmentStatement;
              if (
                a.target.kind === "VariableExpression" &&
                a.target.fieldAccess.length === 0 &&
                a.target.subscripts.length === 0 &&
                !a.target.isDereference
              ) {
                check(a.value, scope.get(a.target.name.toUpperCase()));
              }
              return;
            }
            if (node.kind !== "FunctionCallExpression") return;
            const call = node as FunctionCallExpression;
            if (call.instance !== undefined) return;
            const inputs = callInputs(call, scope);
            if (inputs === undefined) return;
            stripEnEno(call.arguments).forEach((arg, i) => {
              if (arg.isOutput) return;
              const type =
                arg.name === undefined
                  ? inputs[i]
                  : inputs[inputs.names!.indexOf(arg.name.toUpperCase())];
              check(arg.value, type);
            });
          });
        }
      }
    };
    for (const prog of ast.programs) {
      checkPou(prog.varBlocks, [prog.body]);
      for (const m of prog.methods)
        checkPou([...prog.varBlocks, ...m.varBlocks], [m.body]);
    }
    for (const func of ast.functions) checkPou(func.varBlocks, [func.body]);
    for (const fb of ast.functionBlocks) {
      checkPou(fb.varBlocks, [fb.body]);
      for (const m of fb.methods)
        checkPou([...fb.varBlocks, ...m.varBlocks], [m.body]);
    }
  }

  /**
   * Validate array declarations and array accesses against the declared shape:
   *
   *   - an initializer's nesting must match the array's rank
   *   - an initializer must not supply more values than the array (or a row) holds
   *   - a subscript must supply one index per dimension
   *
   * All three were previously invisible here: a nesting or rank mistake surfaced
   * as a C++ error against generated code, and an over-long initializer was
   * silently truncated by the runtime container's constructor.
   *
   * Every check is skipped rather than guessed at when the shape isn't statically
   * known (variable-length `ARRAY[*]`, non-constant bounds, a type that doesn't
   * resolve), so this can only ever add diagnostics for definite mistakes.
   */
  private validateArrayShapes(ast: CompilationUnit): void {
    // Globals are visible to every POU, and are the fallback when a name isn't
    // one of the POU's own variables.
    const globals = new Map<string, TypeReference>();
    const addDecls = (
      blocks: VarBlock[],
      into: Map<string, TypeReference>,
    ): void => {
      for (const block of blocks) {
        for (const decl of block.declarations) {
          for (const name of decl.names)
            into.set(name.toUpperCase(), decl.type);
        }
      }
    };
    addDecls(ast.globalVarBlocks, globals);
    for (const config of ast.configurations)
      addDecls(config.varBlocks, globals);

    // Declaration initializers, everywhere a declaration can appear.
    for (const block of ast.globalVarBlocks) {
      this.checkVarBlockInitializers(block, ast);
    }
    for (const config of ast.configurations) {
      for (const block of config.varBlocks) {
        this.checkVarBlockInitializers(block, ast);
      }
    }
    for (const typeDecl of ast.types) {
      if (typeDecl.definition.kind !== "StructDefinition") continue;
      for (const field of ownFields(typeDecl.definition)) {
        this.checkDeclarationInitializer(field, ast);
      }
    }

    // Per-POU: initializers plus the subscript counts in its body.
    const checkPou = (blocks: VarBlock[], bodies: Statement[][]): void => {
      const scope = new Map(globals);
      addDecls(blocks, scope);
      for (const block of blocks) this.checkVarBlockInitializers(block, ast);
      for (const body of bodies) this.checkSubscriptCounts(body, scope, ast);
    };

    for (const prog of ast.programs) {
      checkPou(prog.varBlocks, [prog.body]);
      for (const method of prog.methods) {
        checkPou([...prog.varBlocks, ...method.varBlocks], [method.body]);
      }
    }
    for (const func of ast.functions) checkPou(func.varBlocks, [func.body]);
    for (const fb of ast.functionBlocks) {
      checkPou(fb.varBlocks, [fb.body]);
      for (const method of fb.methods) {
        // A method sees its own locals plus the FB's members.
        checkPou([...fb.varBlocks, ...method.varBlocks], [method.body]);
      }
    }
  }

  /** Check every declaration in a VAR block. */
  private checkVarBlockInitializers(
    block: VarBlock,
    ast: CompilationUnit,
  ): void {
    for (const decl of block.declarations) {
      this.checkDeclarationInitializer(decl, ast);
    }
  }

  /**
   * Check one declaration's initializer against its declared array shape.
   *
   * Only array literals are examined. A scalar initializer on an array is left
   * alone: it is meaningful for a STRUCT element (`data : ARRAY[…] OF INT := 0`
   * value-initialises), so rejecting it here would flag working code.
   */
  private checkDeclarationInitializer(
    decl: VarDeclaration,
    ast: CompilationUnit,
  ): void {
    if (!decl.initialValue) return;
    if (decl.initialValue.kind !== "ArrayLiteralExpression") return;
    const shape = resolveArrayShape(decl.type, ast);
    if (!shape) return;
    this.checkArrayLiteralShape(
      decl.initialValue,
      shape,
      decl.names.join(", "),
      ast,
      0,
    );
  }

  /**
   * Recursively check an array literal against the dimensions it initialises.
   *
   * `depth` counts nesting levels already consumed. Returns true once something
   * has been reported, so one mistaken declaration yields one diagnostic rather
   * than one per row.
   */
  private checkArrayLiteralShape(
    literal: ArrayLiteralExpression,
    shape: ArrayShape,
    declName: string,
    ast: CompilationUnit,
    depth: number,
  ): boolean {
    const span = literal.sourceSpan;
    const where = depth === 0 ? "" : ` at nesting level ${depth + 1}`;
    const nestedCount = literal.elements.filter(
      (e) => e.kind === "ArrayLiteralExpression",
    ).length;

    if (nestedCount > 0 && nestedCount !== literal.elements.length) {
      this.addError(
        `Initializer for '${declName}' mixes nested and flat values${where}. ` +
          `Either give every element its own list, or write the whole array flat.`,
        span.startLine,
        span.startCol,
        span.file,
      );
      return true;
    }

    if (nestedCount === 0) {
      // A flat list at the outermost level fills the whole array row-major,
      // which IEC allows for any rank. Once nesting has started, though, each
      // level descends exactly one dimension — a flat list part-way down leaves
      // dimensions unaccounted for and no container constructor matches it.
      if (depth > 0 && shape.dims.length > 1) {
        this.addError(
          `Initializer for '${declName}' stops nesting at level ${depth + 1}, ` +
            `but ${shape.dims.length} dimensions remain. Nest one level per ` +
            `dimension, or write the whole array as a single flat list.`,
          span.startLine,
          span.startCol,
          span.file,
        );
        return true;
      }
      const total = arrayTotalSize(shape.dims);
      if (total !== undefined && literal.elements.length > total) {
        this.addError(
          `Initializer for '${declName}' has ${literal.elements.length} values ` +
            `but the array holds ${total}. The extra values would be discarded.`,
          span.startLine,
          span.startCol,
          span.file,
        );
        return true;
      }
      return false;
    }

    // Nested list — the outer level fills the first dimension. When only one
    // dimension remains, the nesting can only be meant for an element type that
    // is itself an array.
    const outerSize = arrayDimSize(shape.dims[0] ?? null);
    if (outerSize !== undefined && literal.elements.length > outerSize) {
      this.addError(
        `Initializer for '${declName}' has ${literal.elements.length} entries` +
          `${where} but that dimension holds ${outerSize}. ` +
          `The extra entries would be discarded.`,
        span.startLine,
        span.startCol,
        span.file,
      );
      return true;
    }

    let innerShape: ArrayShape;
    if (shape.dims.length > 1) {
      innerShape = {
        dims: shape.dims.slice(1),
        elementTypeName: shape.elementTypeName,
      };
    } else {
      const elementShape = resolveArrayShapeByName(shape.elementTypeName, ast);
      if (!elementShape) {
        this.addError(
          `Initializer for '${declName}' is nested ${depth + 2} levels deep, but ` +
            `the array has ${depth + 1} dimension${depth === 0 ? "" : "s"} and its ` +
            `elements are not arrays. Write the values at one level per dimension.`,
          span.startLine,
          span.startCol,
          span.file,
        );
        return true;
      }
      innerShape = elementShape;
    }

    for (const element of literal.elements) {
      if (
        this.checkArrayLiteralShape(
          element as ArrayLiteralExpression,
          innerShape,
          declName,
          ast,
          depth + 1,
        )
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Walk statements and check that every array subscript supplies one index per
   * dimension. `arr[i, j]` on a 1-dimensional array and `arr[i]` on a
   * 2-dimensional one are both static mistakes that used to reach g++ as
   * "no matching member function for call to 'at'".
   */
  private checkSubscriptCounts(
    statements: Statement[],
    scope: Map<string, TypeReference>,
    ast: CompilationUnit,
  ): void {
    const seen = new Set<Expression>();
    for (const stmt of statements) {
      walkAST(stmt, (node) => {
        if (node.kind !== "VariableExpression") return;
        const expr = node as VariableExpression;
        if (seen.has(expr)) return;
        seen.add(expr);
        this.checkVariableSubscripts(expr, scope, ast);
      });
    }
  }

  /**
   * Check one variable reference's subscripts, walking its access chain so that
   * `a[0][1]` (two single-index steps into an array of arrays) is not confused
   * with `a[0, 1]` (one two-index step into a 2D array).
   */
  private checkVariableSubscripts(
    expr: VariableExpression,
    scope: Map<string, TypeReference>,
    ast: CompilationUnit,
  ): void {
    const declared = scope.get(expr.name.toUpperCase());
    if (!declared) return;

    // Only the ordered chain distinguishes the two spellings above; without it
    // the flat `subscripts` list is ambiguous, so there is nothing safe to check.
    const chain = expr.accessChain;
    if (!chain || chain.length === 0) return;

    let currentTypeName: string | undefined = declared.name;
    let currentShape = resolveArrayShape(declared, ast);

    for (const step of chain) {
      if (step.kind === "subscript") {
        if (!currentShape) return; // not a known array — nothing to check
        if (step.indices.length !== currentShape.dims.length) {
          this.addError(
            `'${expr.name}' has ${currentShape.dims.length} dimension` +
              `${currentShape.dims.length === 1 ? "" : "s"} but is indexed with ` +
              `${step.indices.length} ` +
              `${step.indices.length === 1 ? "index" : "indices"}.`,
            expr.sourceSpan.startLine,
            expr.sourceSpan.startCol,
            expr.sourceSpan.file,
          );
          return;
        }
        currentTypeName = currentShape.elementTypeName;
        currentShape = currentTypeName
          ? resolveArrayShapeByName(currentTypeName, ast)
          : undefined;
      } else if (step.kind === "field") {
        if (!currentTypeName) return;
        const fieldType = resolveFieldType(currentTypeName, step.name, ast);
        if (!fieldType) return;
        currentTypeName = fieldType;
        currentShape = resolveArrayShapeByName(fieldType, ast);
      } else {
        // Dereference — pointer semantics are out of scope for this check.
        return;
      }
    }
  }

  /**
   * The default of an enumeration type (`(A, B) := B`, `(A, B) := E#B`) must be
   * one of that type's own values: a bare member name, or the member qualified
   * by the type itself. Anything else reached g++ as an invalid initializer.
   */
  private validateEnumTypeDefaults(ast: CompilationUnit): void {
    for (const td of ast.types) {
      const def = td.definition;
      const value = td.defaultValue;
      if (def.kind !== "EnumDefinition" || value === undefined) continue;
      const members = new Set(def.members.map((m) => m.name.toUpperCase()));
      let member: string | undefined;
      if (
        value.kind === "VariableExpression" &&
        value.subscripts.length === 0 &&
        !value.isDereference
      ) {
        const fields = value.fieldAccess;
        if (fields.length === 0) member = value.name;
        else if (
          fields.length === 1 &&
          value.name.toUpperCase() === td.name.toUpperCase()
        ) {
          member = fields[0];
        }
      }
      if (member !== undefined && members.has(member.toUpperCase())) continue;
      this.addError(
        `The default value of enumeration '${td.name}' must be one of its values`,
        value.sourceSpan.startLine,
        value.sourceSpan.startCol,
        value.sourceSpan.file,
      );
    }
  }

  /**
   * Reject a structure initializer written anywhere but a declaration's initial
   * value.
   *
   * `structure_initialization` (Annex B.1.4.3) belongs to `var_init_decl`; it is
   * not an expression, so IEC has no position for it inside a statement. The
   * lowering needs the target's C++ type, which only a declaration supplies —
   * reaching codegen without one used to value-initialise silently, so
   *
   *     arr := [(x := 1.0), (x := 2.0)];   ->  ARR = {{}, {}};
   *     f(P := (x := 3.0));                ->  F.P = {};
   *
   * compiled clean and ran with every written element discarded, the members
   * left at their declared defaults. Reported here instead, against the source.
   *
   * The walk prunes at every initial value a declaration can carry — a variable
   * or STRUCT element's (`VarDeclaration.initialValue`) and a type-level default's
   * (`TypeDeclaration.defaultValue`, Annex B.1.3.3) — so the legal forms, including
   * a structure initializer nested inside an array literal, are never visited.
   */
  private validateStructInitializerPlacement(ast: CompilationUnit): void {
    // Identity set rather than a node-kind test: only the initializer's own root
    // is legal, and pruning there covers everything beneath it.
    const declarationInitializers = new Set<Expression>();
    walkAST(ast, (node) => {
      if (node.kind === "VarDeclaration") {
        const decl = node as VarDeclaration;
        if (decl.initialValue) declarationInitializers.add(decl.initialValue);
      } else if (node.kind === "TypeDeclaration") {
        const type = node as TypeDeclaration;
        if (type.defaultValue) declarationInitializers.add(type.defaultValue);
      }
    });

    walkAST(ast, (node) => {
      if (declarationInitializers.has(node as Expression)) return false;
      if (node.kind !== "StructInitializerExpression") return;
      const span = node.sourceSpan;
      this.addError(
        "A structure initializer '(NAME := value, ...)' is only valid as a " +
          "variable's initial value in a declaration, not inside a statement. " +
          "Assign the elements individually instead.",
        span.startLine,
        span.startCol,
        span.file,
      );
      // One diagnostic per initializer, not one per nesting level.
      return false;
    });
  }

  /**
   * Reject an integer literal that no IEC 61131-3 integer type can hold.
   *
   * The widest are LINT (signed 64-bit) and ULINT (unsigned 64-bit), so a value
   * outside `[LINT_MIN, ULINT_MAX]` is a mistake against *every* declared type
   * and can be reported without knowing which one it initialises — the same
   * conservative rule the array-shape checks follow. In range but wrong for the
   * specific type (`INT := 70000`) is left to the type checker.
   *
   * Checked on the exact value rather than the parsed `number`, which rounds
   * above 2^53; codegen lowers from the same exact value (see
   * `formatIntegerLiteral`), so the two agree on what is representable.
   */
  private validateIntegerLiteralRange(ast: CompilationUnit): void {
    walkAST(ast, (node) => {
      if (node.kind !== "LiteralExpression") return;
      const literal = node as LiteralExpression;
      if (this.literalsReported.has(literal)) return;
      if (literal.literalType !== "INT") return;
      if ((literal.typePrefix ?? "") !== "") {
        this.validateTypedLiteralRange(literal);
        return;
      }
      const exact = exactIntegerLiteralValue(literal.rawValue);
      if (exact === undefined) return;
      // A negative literal parses as unary minus over a positive one, so the
      // magnitude LINT_MIN needs the unsigned bound to stay accepted here.
      if (exact <= IEC_INTEGER_MAX && exact >= IEC_INTEGER_MIN) return;
      const span = literal.sourceSpan;
      this.addError(
        `Integer literal '${literal.rawValue}' is outside the range of every ` +
          `IEC 61131-3 integer type (LINT holds ${IEC_INTEGER_MIN} to ` +
          `${-IEC_INTEGER_MIN - 1n}, ULINT holds 0 to ${IEC_INTEGER_MAX}).`,
        span.startLine,
        span.startCol,
        span.file,
      );
    });
  }

  /**
   * Reject a character Windows-1252 cannot hold in a STRING literal: a STRING
   * stores one CP1252 byte per character. A WSTRING literal holds any.
   */
  private validateStringLiteralCharset(
    roots: CompilationUnit | readonly ASTNode[],
  ): void {
    const visit = (node: ASTNode): void => {
      if (node.kind !== "LiteralExpression") return;
      const literal = node as LiteralExpression;
      if (this.literalsReported.has(literal)) return;
      if (literal.literalType === "CHAR" || literal.literalType === "WCHAR") {
        this.validateCharLiteral(literal);
        return;
      }
      if (literal.literalType !== "STRING") return;
      const raw = literal.rawValue;
      for (let i = raw.indexOf("'") + 1; i < raw.length; i++) {
        const codePoint = raw.codePointAt(i)!;
        if (codePoint <= 0x7f || cp1252Byte(codePoint) !== undefined) continue;
        const span = literal.sourceSpan;
        const before = raw.substring(0, i);
        const breaks = before.split("\n").length - 1;
        const line = span.startLine + breaks;
        const column =
          breaks === 0 ? span.startCol + i : i - before.lastIndexOf("\n");
        const hex = codePoint.toString(16).toUpperCase().padStart(4, "0");
        this.addError(
          codePoint === 0xfffd
            ? "A STRING literal holds U+FFFD, a byte the source could not decode: the file is probably not UTF-8 (saved as Windows-1252?); save it as UTF-8"
            : `Character '${String.fromCodePoint(codePoint)}' (U+${hex}) cannot be stored in a STRING, which holds Windows-1252 characters; use a WSTRING literal ("...") for it`,
          line,
          column,
          span.file,
        );
        return;
      }
    };
    for (const root of Array.isArray(roots) ? roots : [roots]) {
      walkAST(root as ASTNode, (n) => visit(n));
    }
  }

  /**
   * A CHAR or WCHAR literal holds exactly one character, and a CHAR one that
   * Windows-1252 has.
   */
  private validateCharLiteral(literal: LiteralExpression): void {
    const { wide, units } = charLiteralUnits(literal.rawValue);
    const type = wide ? "WCHAR" : "CHAR";
    const span = literal.sourceSpan;
    const fail = (message: string): void =>
      this.addError(message, span.startLine, span.startCol, span.file);
    if (units.length !== 1) {
      fail(
        `A ${type} literal holds exactly one character; ${literal.rawValue} holds ${units.length}`,
      );
      return;
    }
    if (units[0] === -1 && !/#['"]/.test(literal.rawValue)) {
      fail(`${literal.rawValue} is past the ${type} range`);
      return;
    }
    if (units[0] === -1) {
      fail(
        `${literal.rawValue} holds a character Windows-1252 lacks, which a CHAR cannot store; use a WCHAR literal (WCHAR#"...") for it`,
      );
    }
  }

  /**
   * Reject an untyped real literal no LREAL can hold (`1E400`): its value would
   * be infinite, which the C++ compiler refuses.
   */
  private validateRealLiteralRange(ast: CompilationUnit): void {
    walkAST(ast, (node) => {
      if (node.kind !== "LiteralExpression") return;
      const literal = node as LiteralExpression;
      if (this.literalsReported.has(literal)) return;
      if (literal.literalType !== "REAL" || (literal.typePrefix ?? "") !== "") {
        return;
      }
      if (Number.isFinite(Number(literal.value))) return;
      const span = literal.sourceSpan;
      this.addError(
        `Real literal '${literal.rawValue}' is outside the LREAL range`,
        span.startLine,
        span.startCol,
        span.file,
      );
    });
  }

  /**
   * Reject an LTIME literal outside the signed 64-bit nanosecond range LTIME
   * holds (about 106751 days either way).
   */
  private validateLtimeLiteralRange(ast: CompilationUnit): void {
    walkAST(ast, (node) => {
      if (node.kind !== "LiteralExpression") return;
      const literal = node as LiteralExpression;
      if (this.literalsReported.has(literal)) return;
      if (literal.literalType !== "LTIME") return;
      const ns = exactTimeLiteralNanoseconds(literal.rawValue);
      if (ns >= -(2n ** 63n) && ns < 2n ** 63n) return;
      const span = literal.sourceSpan;
      this.addError(
        `LTIME literal '${literal.rawValue}' is outside the LTIME range (${-(2n ** 63n)} to ${2n ** 63n - 1n} nanoseconds)`,
        span.startLine,
        span.startCol,
        span.file,
      );
    });
  }

  /**
   * Reject a typed integer literal whose value its prefix type cannot hold
   * (`SINT#200`, `USINT#-1`, `BYTE#256`). A based payload (`2#`, `8#`, `16#`)
   * on a signed type is a bit pattern: it is accepted when it fits the type's
   * width (`INT#16#FFFF`).
   */
  private validateTypedLiteralRange(literal: LiteralExpression): void {
    const raw = literal.rawValue;
    const payload = raw.substring(raw.indexOf("#") + 1);
    const prefix = (literal.typePrefix ?? "").toUpperCase();
    const range =
      integerTypeRange(prefix) ??
      (BIT_STRING_BITS[prefix] !== undefined
        ? { min: 0n, max: (1n << BigInt(BIT_STRING_BITS[prefix])) - 1n }
        : undefined);
    const exact = exactIntegerLiteralValue(payload);
    if (range === undefined || exact === undefined) return;
    if (exact >= range.min && exact <= range.max) return;
    const bitPattern =
      range.min < 0n && /^(2|8|16)#/.test(payload.replace(/_/g, ""));
    if (bitPattern && exact >= 0n && exact <= range.max - range.min) return;
    const span = literal.sourceSpan;
    this.addError(
      `Typed literal '${raw}' is outside the range of ` +
        `${literal.typePrefix} (${range.min} to ${range.max}` +
        (bitPattern
          ? `, or 0 to ${range.max - range.min} as a 2#, 8# or 16# bit pattern)`
          : ")") +
        ".",
      span.startLine,
      span.startCol,
      span.file,
    );
  }

  /**
   * Validate that no assignments target CONSTANT variables.
   */
  private validateConstantAssignments(ast: CompilationUnit): void {
    for (const prog of ast.programs) {
      const scope = this.symbolTables.getProgramScope(prog.name);
      if (scope) {
        this.validateStatementsForConstantAssignment(prog.body, scope);
      }
    }
    for (const func of ast.functions) {
      const scope = this.symbolTables.getFunctionScope(func.name);
      if (scope) {
        this.validateStatementsForConstantAssignment(func.body, scope);
      }
    }
    for (const fb of ast.functionBlocks) {
      const scope = this.symbolTables.getFBScope(fb.name);
      if (scope) {
        this.validateStatementsForConstantAssignment(fb.body, scope);
      }
    }
  }

  /**
   * Walk statements and check for assignments to CONSTANT variables.
   */
  private validateStatementsForConstantAssignment(
    stmts: Statement[],
    scope: ReturnType<typeof this.symbolTables.createProgramScope>,
  ): void {
    for (const stmt of stmts) {
      if (stmt.kind === "AssignmentStatement") {
        if (stmt.target.kind === "VariableExpression") {
          const varName = stmt.target.name;
          const symbol = scope.lookup(varName);
          if (symbol && symbol.kind === "constant") {
            this.addError(
              `Cannot assign to CONSTANT variable '${varName}'`,
              stmt.sourceSpan.startLine,
              stmt.sourceSpan.startCol,
              stmt.sourceSpan.file,
            );
          }
        }
      }
      // Recurse into control flow statements
      if (stmt.kind === "IfStatement") {
        const ifStmt = stmt as {
          thenStatements: Statement[];
          elsifClauses: Array<{ statements: Statement[] }>;
          elseStatements: Statement[];
        };
        this.validateStatementsForConstantAssignment(
          ifStmt.thenStatements,
          scope,
        );
        for (const clause of ifStmt.elsifClauses) {
          this.validateStatementsForConstantAssignment(
            clause.statements,
            scope,
          );
        }
        this.validateStatementsForConstantAssignment(
          ifStmt.elseStatements,
          scope,
        );
      }
      if (stmt.kind === "ForStatement") {
        const forStmt = stmt as { body: Statement[] };
        this.validateStatementsForConstantAssignment(forStmt.body, scope);
      }
      if (stmt.kind === "WhileStatement") {
        const whileStmt = stmt as { body: Statement[] };
        this.validateStatementsForConstantAssignment(whileStmt.body, scope);
      }
      if (stmt.kind === "RepeatStatement") {
        const repeatStmt = stmt as { body: Statement[] };
        this.validateStatementsForConstantAssignment(repeatStmt.body, scope);
      }
      if (stmt.kind === "CaseStatement") {
        const caseStmt = stmt as {
          cases: Array<{ statements: Statement[] }>;
          elseStatements: Statement[];
        };
        for (const c of caseStmt.cases) {
          this.validateStatementsForConstantAssignment(c.statements, scope);
        }
        this.validateStatementsForConstantAssignment(
          caseStmt.elseStatements,
          scope,
        );
      }
    }
  }

  /**
   * A CONFIGURATION global and a top-level VAR_GLOBAL of the same name would be
   * two C++ definitions of one name: refused at the CONFIGURATION's declaration.
   */
  private validateConfigurationGlobalNames(ast: CompilationUnit): void {
    // A name several global lists declare is emitted list-qualified
    // (named_global_lists), so only a name declared once can collide.
    const counts = new Map<string, number>();
    for (const b of ast.globalVarBlocks) {
      for (const d of b.declarations) {
        for (const n of d.names) {
          const upper = n.toUpperCase();
          counts.set(upper, (counts.get(upper) ?? 0) + 1);
        }
      }
    }
    const topLevel = new Set(
      [...counts].filter(([, count]) => count === 1).map(([name]) => name),
    );
    // A global another CONFIGURATION declares: by upper-case name, its configuration.
    const configOf = new Map<string, string>();
    for (const config of ast.configurations) {
      for (const block of config.varBlocks) {
        for (const decl of block.declarations) {
          for (const name of decl.names) {
            const upper = name.toUpperCase();
            const other = configOf.get(upper);
            if (other !== undefined && other !== config.name.toUpperCase()) {
              this.addError(
                `Global '${upper}' of CONFIGURATION ${config.name.toUpperCase()} is also declared in CONFIGURATION ${other}; rename one of them`,
                decl.sourceSpan.startLine,
                decl.sourceSpan.startCol,
                decl.sourceSpan.file,
              );
            }
            configOf.set(upper, other ?? config.name.toUpperCase());
            if (!topLevel.has(upper)) continue;
            this.addError(
              `Global '${name.toUpperCase()}' of CONFIGURATION ${config.name.toUpperCase()} is also declared in a top-level VAR_GLOBAL; rename one of them`,
              decl.sourceSpan.startLine,
              decl.sourceSpan.startCol,
              decl.sourceSpan.file,
            );
          }
        }
      }
    }
  }

  /**
   * Collect located CONFIGURATION VAR_GLOBALs.
   *
   * These are NOT gathered by buildVarBlockSymbols: that runs per POU scope
   * (program / function / functionBlock) over ast.programs et al, while
   * configuration globals live in ast.configurations[].varBlocks. Without this
   * they escaped every located-variable rule, so a POU-local `VAR ... AT %MX0.0`
   * and a `VAR_GLOBAL ... AT %MX0.0` could both claim the same image slot — and
   * they are serviced by different paths (the owning task vs. the dispatcher at
   * the quiescent frame boundary), which makes the outcome nondeterministic.
   *
   * Globals sharing a name across configurations are one canonical global (codegen
   * emits a single file-scope singleton, deduping by name), so dedupe here too —
   * otherwise a project declaring the same global in two configurations would
   * report a spurious duplicate-address error against itself.
   */
  private collectConfigurationLocatedVars(
    ast: CompilationUnit,
  ): LocatedVarInfo[] {
    const collected: LocatedVarInfo[] = [];
    const seen = new Set<string>();

    for (const config of ast.configurations) {
      for (const block of config.varBlocks) {
        if (block.blockType !== "VAR_GLOBAL") continue;
        for (const decl of block.declarations) {
          if (!decl.address) continue;
          for (const name of decl.names) {
            const key = name.toUpperCase();
            if (seen.has(key)) continue;
            seen.add(key);

            const parsed = parseAddress(decl.address);
            if (!parsed) {
              this.addError(
                unusableAddressMessage(decl),
                decl.sourceSpan.startLine,
                decl.sourceSpan.startCol,
                decl.sourceSpan.file,
              );
              continue;
            }
            collected.push({
              name,
              address: decl.address,
              parsed,
              typeName: decl.type.name,
              scopeType: "configuration",
              scopeName: config.name,
              declaration: decl,
            });
          }
        }
      }
    }
    return collected;
  }

  /**
   * How many times each PROGRAM type is instantiated across all configurations.
   * Keyed by upper-cased program type name.
   */
  private countProgramInstantiations(
    ast: CompilationUnit,
  ): Map<string, number> {
    const counts = new Map<string, number>();
    for (const config of ast.configurations) {
      for (const resource of config.resources) {
        for (const instance of resource.programInstances) {
          const key = instance.programType.toUpperCase();
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
    }
    return counts;
  }

  /**
   * Validate located variables for IEC 61131-3 compliance.
   * Checks:
   * - Located variables not allowed in function blocks
   * - Located variables not allowed in a PROGRAM instantiated more than once
   * - No duplicate addresses (POU-local and configuration globals together)
   * - Type must be compatible with address size
   * - Bit index must be 0-7 for bit addresses
   */
  private validateLocatedVariables(ast: CompilationUnit): void {
    /** Slot ranges already claimed, keyed by bank (`area + size`). */
    const claimedSlots = new Map<
      string,
      Array<{ start: number; end: number; owner: LocatedVarInfo }>
    >();
    const instanceCounts = this.countProgramInstantiations(ast);

    // Configuration globals participate in every rule below, above all in the
    // duplicate-address check they were previously invisible to.
    const allLocatedVars = [
      ...this.locatedVars,
      ...this.collectConfigurationLocatedVars(ast),
    ];

    for (const locVar of allLocatedVars) {
      const decl = locVar.declaration;

      // Rule 1: Located variables not allowed in function blocks
      if (locVar.scopeType === "functionBlock") {
        this.addError(
          `Located variable '${locVar.name}' at ${locVar.address} not allowed in FUNCTION_BLOCK '${locVar.scopeName}'. Located variables can only be declared in PROGRAM or VAR_GLOBAL scope.`,
          decl.sourceSpan.startLine,
          decl.sourceSpan.startCol,
          decl.sourceSpan.file,
        );
        continue;
      }

      // Rule 1b: a fully specified address cannot live in a PROGRAM that is
      // instantiated more than once. Same reasoning as Rule 1 for function
      // blocks: a physical address belongs to exactly one point of hardware, so
      // several instances of one POU type cannot each own it. IEC 61131-3 permits
      // multiple program instances, and its answer for per-instance addressing is
      // a partly specified location (`AT %I*`) resolved by VAR_CONFIG — which is
      // not supported here, so the fully specified form must be rejected.
      //
      // Left unchecked this fails silently rather than loudly: codegen allocates
      // one locatedVars[] slot per *declaration*, and each instance's constructor
      // overwrites its pointer, so the last instance constructed wins and the
      // other instances' copies of the variable are never serviced at all.
      if (locVar.scopeType === "program") {
        const instances =
          instanceCounts.get(locVar.scopeName.toUpperCase()) ?? 0;
        if (instances > 1) {
          this.addError(
            `Located variable '${locVar.name}' at ${locVar.address} not allowed in PROGRAM '${locVar.scopeName}': the program is instantiated ${instances} times, and a physical address cannot be shared by several instances. Declare the variable in CONFIGURATION VAR_GLOBAL and access it with VAR_EXTERNAL, or instantiate '${locVar.scopeName}' only once.`,
            decl.sourceSpan.startLine,
            decl.sourceSpan.startCol,
            decl.sourceSpan.file,
          );
          continue;
        }
      }

      // Rule 2: the type must fit the address size, and (for an array) the
      // array must have a linear run of addresses to occupy at all.
      const shape = resolveLocatedShape(decl.type, ast);
      if (shape.reason !== undefined) {
        this.addError(
          `Located variable '${locVar.name}' at ${locVar.address} cannot be placed: ${shape.reason}.`,
          decl.sourceSpan.startLine,
          decl.sourceSpan.startCol,
          decl.sourceSpan.file,
        );
        continue;
      }

      const compatibleTypes = getCompatibleTypes(locVar.parsed.size);
      if (!compatibleTypes.includes(shape.elementTypeName.toUpperCase())) {
        // For an array the mismatch is in the ELEMENT type, so say so —
        // "Type 'ARRAY [0..66] OF STRING'" would point at the wrong half of
        // the declaration.
        const subject =
          shape.slotCount > 1
            ? `Array element type '${shape.elementTypeName}'`
            : `Type '${shape.elementTypeName}'`;
        this.addError(
          `${subject} is not compatible with address size '${locVar.parsed.size}' in '${locVar.address}'. Expected one of: ${compatibleTypes.join(", ")}`,
          decl.sourceSpan.startLine,
          decl.sourceSpan.startCol,
          decl.sourceSpan.file,
        );
      }

      // Rule 3: Validate bit index is 0-7 for bit addresses
      if (
        locVar.parsed.size === "X" &&
        (locVar.parsed.bitIndex < 0 || locVar.parsed.bitIndex > 7)
      ) {
        this.addError(
          `Bit index ${locVar.parsed.bitIndex} out of range (0-7) in address '${locVar.address}'`,
          decl.sourceSpan.startLine,
          decl.sourceSpan.startCol,
          decl.sourceSpan.file,
        );
      }

      // Rule 4: no two declarations may claim the same slot.
      //
      // Overlap, not equality: an array occupies `slotCount` consecutive
      // slots, so `x AT %MW60 : ARRAY [0..66] OF WORD` collides with a plain
      // `y AT %MW61 : WORD` even though the two addresses differ. Comparing
      // addresses for equality (which is all that was needed while every
      // declaration took exactly one slot) would let the second variable
      // silently share storage with an element of the first.
      const bank = bankKey(locVar.parsed);
      const start = firstSlot(locVar.parsed);
      const end = start + shape.slotCount - 1;

      const claimsInBank = claimedSlots.get(bank) ?? [];
      const clash = claimsInBank.find((c) => start <= c.end && c.start <= end);
      if (clash) {
        this.addError(
          `Duplicate address ${locVar.address}: variable '${locVar.name}' conflicts with '${clash.owner.name}'${
            clash.end > clash.start || end > start
              ? ` (${clash.owner.name} occupies ${clash.owner.address} onwards)`
              : ""
          }`,
          decl.sourceSpan.startLine,
          decl.sourceSpan.startCol,
          decl.sourceSpan.file,
        );
      } else {
        claimsInBank.push({ start, end, owner: locVar });
        claimedSlots.set(bank, claimsInBank);
      }
    }
  }

  /**
   * Validate variable block modifiers (CONSTANT, RETAIN).
   * Checks:
   * - RETAIN + CONSTANT mutual exclusion
   * - CONSTANT requires initializer
   * - Block type restrictions for CONSTANT
   * - Block type restrictions for RETAIN
   */
  /**
   * Validate variable block modifiers (CONSTANT, RETAIN, NON_RETAIN,
   * PERSISTENT).
   *
   * PERSISTENT has already folded into `isRetain` by the time it gets here (see
   * `VarBlock.isRetain`), so there is nothing PERSISTENT-specific to check.
   * NON_RETAIN is the default spelled out, so it is accepted wherever a plain
   * `VAR` would be — including on `VAR_TEMP`, where it is redundant but true,
   * and rejecting a correct statement would fail a CODESYS import for no gain.
   */
  private validateVarModifiers(
    block: VarBlock,
    hasInstanceState: boolean,
  ): void {
    const blockType = block.blockType;

    // ---- Contradictions, checked first: once two qualifiers disagree there is
    // no single intent left to validate the rest against. ------------------
    if (block.isRetain && block.isConstant) {
      this.addError(
        "Variable cannot be both RETAIN and CONSTANT",
        block.sourceSpan.startLine,
        block.sourceSpan.startCol,
        block.sourceSpan.file,
      );
      return;
    }

    if (block.isNonRetain && block.isRetain) {
      this.addError(
        "Variable cannot be both RETAIN and NON_RETAIN",
        block.sourceSpan.startLine,
        block.sourceSpan.startCol,
        block.sourceSpan.file,
      );
      return;
    }

    if (block.isNonRetain && block.isConstant) {
      this.addError(
        "Variable cannot be both CONSTANT and NON_RETAIN",
        block.sourceSpan.startLine,
        block.sourceSpan.startCol,
        block.sourceSpan.file,
      );
      return;
    }

    // ---- CONSTANT ---------------------------------------------------------
    if (block.isConstant) {
      // CONSTANT requires initializer (except VAR_INPUT — caller provides value)
      if (blockType !== "VAR_INPUT") {
        for (const decl of block.declarations) {
          if (!decl.initialValue) {
            const names = decl.names.join(", ");
            this.addError(
              `CONSTANT variable '${names}' must have an initializer`,
              decl.sourceSpan.startLine,
              decl.sourceSpan.startCol,
              decl.sourceSpan.file,
            );
          }
        }
      }

      if (blockType === "VAR_OUTPUT") {
        this.addError(
          "VAR_OUTPUT cannot be CONSTANT",
          block.sourceSpan.startLine,
          block.sourceSpan.startCol,
          block.sourceSpan.file,
        );
      } else if (blockType === "VAR_IN_OUT") {
        this.addError(
          "VAR_IN_OUT cannot be CONSTANT",
          block.sourceSpan.startLine,
          block.sourceSpan.startCol,
          block.sourceSpan.file,
        );
      }
    }

    // ---- RETAIN -----------------------------------------------------------
    if (block.isRetain) {
      // No instance, no state to retain. A FUNCTION is re-entered from scratch
      // on every call and a METHOD's locals live on the stack, so RETAIN there
      // is not a restriction we are imposing — it has nothing to describe.
      // Previously accepted in silence, which is the worst outcome: the user
      // believes a value survives a power cycle and it never did.
      if (!hasInstanceState) {
        this.addError(
          // Deliberately unnamed: the only scope name in reach here is the
          // owning FB's, and a method-level RETAIN reported against the FB
          // name reads as a lie — RETAIN on the FB's own VAR is legal. The
          // source span points at the offending block.
          "RETAIN is not allowed in a FUNCTION or METHOD: there is no instance, so the variables have nothing to retain",
          block.sourceSpan.startLine,
          block.sourceSpan.startCol,
          block.sourceSpan.file,
        );
        return;
      }

      // VAR_INPUT and VAR_OUTPUT are deliberately absent: IEC 61131-3 permits
      // RETAIN on VAR, VAR_INPUT, VAR_OUTPUT and VAR_GLOBAL, and CODESYS
      // accepts all four. Refusing the first two rejected function blocks that
      // are valid everywhere else.
      //
      // The three below have no retainable storage of their own:
      //   VAR_IN_OUT   — a reference; the retention belongs to whatever it
      //                  points at.
      //   VAR_TEMP     — transient by definition, re-initialised every
      //                  invocation.
      //   VAR_EXTERNAL — a view onto a VAR_GLOBAL; that declaration is where
      //                  RETAIN belongs, and putting it here would suggest two
      //                  independent answers for one storage location.
      const invalidRetainTypes = ["VAR_IN_OUT", "VAR_TEMP", "VAR_EXTERNAL"];

      if (invalidRetainTypes.includes(blockType)) {
        this.addError(
          `${blockType} cannot be RETAIN`,
          block.sourceSpan.startLine,
          block.sourceSpan.startCol,
          block.sourceSpan.file,
        );
      }
    }
  }

  /**
   * Refuse a construct whose dialect feature is off. The message names the
   * construct and the feature and, when profiles were loaded, which of them
   * have it, so the caller can pick one.
   */
  private requireFeature(
    feature: FeatureId,
    construct: string,
    span: { startLine: number; startCol: number; file?: string | undefined },
  ): void {
    if (this.features.has(feature)) return;
    this.addError(
      this.featureMessage(feature, construct),
      span.startLine,
      span.startCol,
      span.file,
    );
  }

  /** `<construct> needs the feature <id>`, plus the loaded profiles that have it. */
  private featureMessage(feature: FeatureId, construct: string): string {
    const message = `${construct} needs the feature ${feature}`;
    const dialect = this.options.dialect ?? this.testFileDialect;
    const profiles = dialect ? profilesWithFeature(dialect, feature) : [];
    return profiles.length > 0
      ? `${message} (profiles: ${profiles.join(", ")})`
      : message;
  }

  /**
   * Add an error message.
   */
  private addError(
    message: string,
    line: number,
    column: number,
    file?: string,
  ): void {
    this.errors.push({
      message,
      line,
      column,
      severity: "error",
      ...(file ? { file } : {}),
    });
  }

  /**
   * Validate that property names don't collide with member variable names
   * within the same function block. A collision causes the setter parameter
   * to silently shadow the member variable.
   */
  private validatePropertyNameCollisions(ast: CompilationUnit): void {
    for (const fb of ast.functionBlocks) {
      if (fb.properties.length === 0) continue;

      // Collect all declared member variable names (case-insensitive)
      const memberNames = new Set<string>();
      for (const block of fb.varBlocks) {
        for (const decl of block.declarations) {
          for (const name of decl.names) {
            memberNames.add(name.toUpperCase());
          }
        }
      }

      // Check each property name against member names
      for (const prop of fb.properties) {
        if (memberNames.has(prop.name.toUpperCase())) {
          this.addWarning(
            `Property '${prop.name}' in FUNCTION_BLOCK '${fb.name}' has the same name as a member variable. ` +
              `The setter parameter will shadow the member variable.`,
            prop.sourceSpan.startLine,
            prop.sourceSpan.startCol,
            prop.sourceSpan.file,
          );
        }
      }
    }
  }

  /**
   * Validate OOP modifier contradictions on function blocks and methods.
   */
  private validateOOPModifiers(ast: CompilationUnit): void {
    // Build FB lookup map for OVERRIDE and IMPLEMENTS validation
    const fbMap = new Map<string, FunctionBlockDeclaration>();
    for (const fb of ast.functionBlocks) {
      fbMap.set(fb.name.toUpperCase(), fb);
    }

    // Build interface lookup map
    const ifaceMap = new Map<string, Set<string>>();
    const ifaceDecls = new Map<string, InterfaceDeclaration>();
    for (const iface of ast.interfaces) {
      ifaceDecls.set(iface.name.toUpperCase(), iface);
      const methodNames = new Set<string>();
      for (const m of iface.methods) {
        methodNames.add(m.name.toUpperCase());
      }
      ifaceMap.set(iface.name.toUpperCase(), methodNames);
    }

    // A PROGRAM has no base and no derived types: nothing to override.
    for (const prog of ast.programs) {
      for (const method of prog.methods) {
        const modifier = method.isAbstract
          ? "ABSTRACT"
          : method.isOverride
            ? "OVERRIDE"
            : undefined;
        if (modifier === undefined) continue;
        this.addError(
          `Method '${method.name}' in PROGRAM '${prog.name}' cannot be ${modifier}: a PROGRAM has no inheritance.`,
          method.sourceSpan.startLine,
          method.sourceSpan.startCol,
          method.sourceSpan.file,
        );
      }
    }

    for (const fb of ast.functionBlocks) {
      // ABSTRACT + FINAL on same FB is contradictory
      if (fb.isAbstract && fb.isFinal) {
        this.addError(
          `FUNCTION_BLOCK '${fb.name}' cannot be both ABSTRACT and FINAL.`,
          fb.sourceSpan.startLine,
          fb.sourceSpan.startCol,
          fb.sourceSpan.file,
        );
      }

      // Collect parent methods for OVERRIDE / FINAL validation
      const parentMethods = this.collectParentMethods(fb, fbMap);

      // Cannot extend a FINAL FB
      if (fb.extends) {
        const parentFB = fbMap.get(fb.extends.toUpperCase());
        if (parentFB && parentFB.isFinal) {
          this.addError(
            `Cannot extend FINAL FUNCTION_BLOCK '${fb.extends}'.`,
            fb.sourceSpan.startLine,
            fb.sourceSpan.startCol,
            fb.sourceSpan.file,
          );
        }
      }

      // ABSTRACT method in non-abstract FB is an error
      for (const method of fb.methods) {
        if (method.isAbstract && !fb.isAbstract) {
          this.addError(
            `Method '${method.name}' is ABSTRACT but FUNCTION_BLOCK '${fb.name}' is not ABSTRACT. ` +
              `ABSTRACT methods can only appear in ABSTRACT function blocks.`,
            method.sourceSpan.startLine,
            method.sourceSpan.startCol,
            method.sourceSpan.file,
          );
        }

        // ABSTRACT + FINAL on same method is contradictory
        if (method.isAbstract && method.isFinal) {
          this.addError(
            `Method '${method.name}' in '${fb.name}' cannot be both ABSTRACT and FINAL.`,
            method.sourceSpan.startLine,
            method.sourceSpan.startCol,
            method.sourceSpan.file,
          );
        }

        // OVERRIDE validation
        if (method.isOverride) {
          if (!fb.extends) {
            this.addError(
              `Method '${method.name}' in '${fb.name}' is marked OVERRIDE but '${fb.name}' does not extend any function block.`,
              method.sourceSpan.startLine,
              method.sourceSpan.startCol,
              method.sourceSpan.file,
            );
          } else {
            const parentMethod = parentMethods.get(method.name.toUpperCase());
            if (!parentMethod) {
              this.addError(
                `Method '${method.name}' in '${fb.name}' is marked OVERRIDE but no method '${method.name}' exists in parent '${fb.extends}'.`,
                method.sourceSpan.startLine,
                method.sourceSpan.startCol,
                method.sourceSpan.file,
              );
            } else {
              // Cannot override a FINAL method
              if (parentMethod.isFinal) {
                this.addError(
                  `Cannot override FINAL method '${method.name}' from '${fb.extends}'.`,
                  method.sourceSpan.startLine,
                  method.sourceSpan.startCol,
                  method.sourceSpan.file,
                );
              }
              // Signature must match parent
              this.validateOverrideSignature(
                method,
                parentMethod,
                fb.name,
                fb.extends,
              );
            }
          }
        }
      }

      // IMPLEMENTS contract validation: check all interface methods are provided
      if (fb.implements && !fb.isAbstract) {
        this.validateImplementedProperties(fb, fbMap, ifaceDecls);
        // A lowered ACTION (fromAction) never implements an interface method.
        const fbMethodNames = new Set<string>();
        for (const m of fb.methods) {
          if (m.fromAction !== true) fbMethodNames.add(m.name.toUpperCase());
        }
        // Include inherited methods
        for (const [name, m] of parentMethods) {
          if (m.fromAction !== true) fbMethodNames.add(name);
        }

        for (const ifaceName of fb.implements) {
          // The interface's own methods and those of its EXTENDS bases
          const requiredMethods = new Set<string>();
          const seenIfaces = new Set<string>();
          const collect = (name: string): void => {
            const upper = name.toUpperCase();
            if (seenIfaces.has(upper)) return;
            seenIfaces.add(upper);
            for (const m of ifaceMap.get(upper) ?? []) requiredMethods.add(m);
            for (const base of ifaceDecls.get(upper)?.extends ?? []) {
              collect(base);
            }
          };
          collect(ifaceName);
          this.validateInterfaceMethodSignatures(
            fb,
            parentMethods,
            [...seenIfaces].flatMap((n) => {
              const decl = ifaceDecls.get(n);
              return decl ? [decl] : [];
            }),
          );
          for (const reqMethod of requiredMethods) {
            if (!fbMethodNames.has(reqMethod)) {
              this.addError(
                `FUNCTION_BLOCK '${fb.name}' implements '${ifaceName}' but does not provide method '${reqMethod}'.`,
                fb.sourceSpan.startLine,
                fb.sourceSpan.startCol,
                fb.sourceSpan.file,
              );
            }
          }
        }
      }
    }
  }

  /**
   * Each method an FB provides for an interface method must have its C++
   * signature: the same inputs (by value) and outputs or in/outs (by
   * reference) in order, of the same types, and the same return type. A
   * parameter named otherwise only warns: the C++ still overrides.
   */
  private validateInterfaceMethodSignatures(
    fb: FunctionBlockDeclaration,
    parentMethods: ReadonlyMap<string, MethodDeclaration>,
    interfaces: readonly InterfaceDeclaration[],
  ): void {
    for (const iface of interfaces) {
      for (const required of iface.methods) {
        const upper = required.name.toUpperCase();
        const method =
          fb.methods.find(
            (m) => m.fromAction !== true && m.name.toUpperCase() === upper,
          ) ?? parentMethods.get(upper);
        if (!method || method.fromAction === true) continue;
        const where = `Method '${method.name}' of FUNCTION_BLOCK '${fb.name}' does not match interface '${iface.name}'`;
        const span = method.sourceSpan;
        const fail = (detail: string): void =>
          this.addError(
            `${where}: ${detail}`,
            span.startLine,
            span.startCol,
            span.file,
          );
        const own = signatureParams(method);
        const want = signatureParams(required);
        const ownRet = method.returnType ? cppTypeKey(method.returnType) : "";
        const wantRet = required.returnType
          ? cppTypeKey(required.returnType)
          : "";
        if (!sameCppType(ownRet, wantRet)) {
          fail(
            `it returns ${method.returnType ? typeText(method.returnType) : "nothing"}, the interface ${required.returnType ? typeText(required.returnType) : "nothing"}`,
          );
          continue;
        }
        if (own.length !== want.length) {
          fail(
            `it has ${own.length} parameter(s), the interface ${want.length}`,
          );
          continue;
        }
        for (let i = 0; i < own.length; i++) {
          const a = own[i]!;
          const b = want[i]!;
          const byRef = a.blockType !== "VAR_INPUT";
          if (byRef !== (b.blockType !== "VAR_INPUT")) {
            fail(
              `parameter ${i + 1} '${a.name}' is ${a.blockType}, the interface's '${b.name}' is ${b.blockType}`,
            );
            break;
          }
          if (!sameCppType(cppTypeKey(a.type), cppTypeKey(b.type))) {
            fail(
              `parameter ${i + 1} '${a.name}' is ${typeText(a.type)}, the interface's '${b.name}' is ${typeText(b.type)}`,
            );
            break;
          }
          if (a.name.toUpperCase() !== b.name.toUpperCase()) {
            this.addWarning(
              `Parameter ${i + 1} '${a.name}' of method '${method.name}' of FUNCTION_BLOCK '${fb.name}' is named '${b.name}' in interface '${iface.name}': a call with named arguments through the FB differs from one through the interface`,
              span.startLine,
              span.startCol,
              span.file,
            );
          }
        }
      }
    }
  }

  /**
   * Collect all methods from the parent chain of a function block.
   * Returns a map of uppercase method name → nearest parent MethodDeclaration.
   */
  private collectParentMethods(
    fb: FunctionBlockDeclaration,
    fbMap: Map<string, FunctionBlockDeclaration>,
  ): Map<string, MethodDeclaration> {
    const methods = new Map<string, MethodDeclaration>();
    let current = fb.extends;
    const visited = new Set<string>(); // prevent infinite loops on circular extends
    while (current) {
      const upper = current.toUpperCase();
      if (visited.has(upper)) break;
      visited.add(upper);
      const parent = fbMap.get(upper);
      if (!parent) break;
      for (const m of parent.methods) {
        const key = m.name.toUpperCase();
        // Only store the nearest parent's version (first encountered wins)
        if (!methods.has(key)) {
          methods.set(key, m);
        }
      }
      current = parent.extends;
    }
    return methods;
  }

  /**
   * Validate that an OVERRIDE method has the same signature as the parent method.
   */
  private validateOverrideSignature(
    method: MethodDeclaration,
    parentMethod: MethodDeclaration,
    fbName: string,
    parentFBName: string,
  ): void {
    // Extract VAR_INPUT parameters from both methods
    const childParams = this.extractMethodParams(method);
    const parentParams = this.extractMethodParams(parentMethod);

    // Compare parameter count and types
    const childSig = childParams.map((p) => p.type).join(", ") || "void";
    const parentSig = parentParams.map((p) => p.type).join(", ") || "void";

    let mismatch = false;
    if (childParams.length !== parentParams.length) {
      mismatch = true;
    } else {
      for (let i = 0; i < childParams.length; i++) {
        if (
          childParams[i]!.type.toUpperCase() !==
          parentParams[i]!.type.toUpperCase()
        ) {
          mismatch = true;
          break;
        }
      }
    }

    // Compare return types
    const childReturn = method.returnType?.name?.toUpperCase() ?? "";
    const parentReturn = parentMethod.returnType?.name?.toUpperCase() ?? "";
    if (childReturn !== parentReturn) {
      mismatch = true;
    }

    if (mismatch) {
      const childRetStr = method.returnType?.name ?? "void";
      const parentRetStr = parentMethod.returnType?.name ?? "void";
      this.addError(
        `Method '${method.name}' in '${fbName}' has different signature than parent method in '${parentFBName}'. ` +
          `Expected: (${parentSig}) : ${parentRetStr}, got: (${childSig}) : ${childRetStr}.`,
        method.sourceSpan.startLine,
        method.sourceSpan.startCol,
        method.sourceSpan.file,
      );
    }
  }

  /**
   * Extract VAR_INPUT parameter names and types from a method declaration.
   */
  private extractMethodParams(
    method: MethodDeclaration,
  ): Array<{ name: string; type: string }> {
    const params: Array<{ name: string; type: string }> = [];
    for (const block of method.varBlocks) {
      if (block.blockType === "VAR_INPUT") {
        for (const decl of block.declarations) {
          for (const name of decl.names) {
            params.push({ name, type: decl.type.name });
          }
        }
      }
    }
    return params;
  }

  /**
   * Validate that abstract function blocks are not instantiated directly.
   */
  private validateAbstractInstantiation(ast: CompilationUnit): void {
    // Build set of abstract FB names
    const abstractFBs = new Set<string>();
    for (const fb of ast.functionBlocks) {
      if (fb.isAbstract) {
        abstractFBs.add(fb.name.toUpperCase());
      }
    }
    if (abstractFBs.size === 0) return;

    // Check variable declarations in programs
    for (const prog of ast.programs) {
      this.checkVarBlocksForAbstractInstantiation(prog.varBlocks, abstractFBs);
    }

    // Check variable declarations in function blocks
    for (const fb of ast.functionBlocks) {
      this.checkVarBlocksForAbstractInstantiation(fb.varBlocks, abstractFBs);
    }

    // Check variable declarations in functions
    for (const func of ast.functions) {
      this.checkVarBlocksForAbstractInstantiation(func.varBlocks, abstractFBs);
    }
  }

  /**
   * Check var blocks for instantiation of abstract FBs.
   */
  private checkVarBlocksForAbstractInstantiation(
    varBlocks: VarBlock[],
    abstractFBs: Set<string>,
  ): void {
    for (const block of varBlocks) {
      for (const decl of block.declarations) {
        if (abstractFBs.has(decl.type.name.toUpperCase())) {
          this.addError(
            `Cannot instantiate ABSTRACT FUNCTION_BLOCK '${decl.type.name}'.`,
            decl.sourceSpan.startLine,
            decl.sourceSpan.startCol,
            decl.sourceSpan.file,
          );
        }
      }
    }
  }

  /**
   * A variable access specifier (PUBLIC, PRIVATE, PROTECTED, INTERNAL) is
   * allowed on a FUNCTION_BLOCK's own VAR section only, once (Ed. 3 6.6.5.10:
   * improper uses are errors).
   */
  private validateVarAccessSpecifiers(ast: CompilationUnit): void {
    const allowed = new Set<VarBlock>(
      ast.functionBlocks.flatMap((fb) =>
        fb.varBlocks.filter((b) => b.blockType === "VAR"),
      ),
    );
    walkAST(ast, (node) => {
      if (node.kind !== "VarBlock") return;
      const block = node as VarBlock;
      const access = block.access ?? [];
      if (access.length === 0) return;
      const at = block.sourceSpan;
      if (!allowed.has(block)) {
        this.addError(
          `${access[0]!} applies only to a VAR section of a FUNCTION_BLOCK, not to ${block.blockType} here`,
          at.startLine,
          at.startCol,
          at.file,
        );
      } else if (access.length > 1) {
        this.addError(
          `A VAR section takes one access specifier, not ${access.join(" and ")}`,
          at.startLine,
          at.startCol,
          at.file,
        );
      }
    });
  }

  /**
   * Validate that properties without setters are not written to.
   * Best-effort check for direct `x.Property := value;` assignments.
   */
  private validatePropertyAccess(ast: CompilationUnit): void {
    // Build property info map: "FBNAME.PROPNAME" → { hasSetter }
    const propertyInfo = new Map<string, PropertyAccessInfo>();
    for (const fb of ast.functionBlocks) {
      for (const prop of fb.properties) {
        const key = `${fb.name.toUpperCase()}.${prop.name.toUpperCase()}`;
        propertyInfo.set(key, { hasSetter: prop.setter !== undefined });
      }
    }
    // Library blocks' properties, from archives that list them
    const fbProps = new Map<string, FunctionBlockDeclaration>();
    for (const sym of this.symbolTables.globalScope.getAllSymbols()) {
      if (sym.kind === "functionBlock" && sym.libraryName !== undefined) {
        fbProps.set(sym.name.toUpperCase(), sym.declaration);
      }
    }
    for (const fb of ast.functionBlocks) fbProps.set(fb.name.toUpperCase(), fb);
    // A property a base declares, written through an instance of a derived block
    for (const [name, fb] of fbProps) {
      const seen = new Set<string>();
      let current: FunctionBlockDeclaration | undefined = fb;
      while (current !== undefined && !seen.has(current.name.toUpperCase())) {
        seen.add(current.name.toUpperCase());
        for (const prop of current.properties) {
          const key = `${name}.${prop.name.toUpperCase()}`;
          if (!propertyInfo.has(key)) {
            propertyInfo.set(key, { hasSetter: prop.setter !== undefined });
          }
        }
        current =
          current.extends !== undefined
            ? fbProps.get(current.extends.toUpperCase())
            : undefined;
      }
    }
    // Interface properties (own and inherited) as seen through a variable
    if (this.features.has("property")) {
      const ifaceDecls = new Map<string, InterfaceDeclaration>();
      for (const iface of ast.interfaces) {
        ifaceDecls.set(iface.name.toUpperCase(), iface);
      }
      for (const iface of ast.interfaces) {
        const props = this.collectInterfaceProperties(iface.name, ifaceDecls);
        for (const [key, prop] of props) {
          propertyInfo.set(`${iface.name.toUpperCase()}.${key}`, {
            hasSetter: prop.setter !== undefined,
            hasGetter: prop.getter !== undefined,
            interfaceName: iface.name,
          });
        }
      }
    }
    if (propertyInfo.size === 0) return;

    // Build a map of variable name (uppercase) → FB type name (uppercase) for each scope
    const checkStatementsInScope = (
      stmts: Statement[],
      varTypeMap: Map<string, string>,
    ) => {
      this.walkStatementsForPropertyWrites(stmts, varTypeMap, propertyInfo);
      this.checkInterfacePropertyReads(stmts, varTypeMap, propertyInfo);
    };

    // Check programs
    for (const prog of ast.programs) {
      const varTypeMap = this.buildVarTypeMap(prog.varBlocks);
      checkStatementsInScope(prog.body, varTypeMap);
      for (const method of prog.methods) {
        const methodVarMap = new Map(varTypeMap);
        for (const [k, v] of this.buildVarTypeMap(method.varBlocks)) {
          methodVarMap.set(k, v);
        }
        checkStatementsInScope(method.body, methodVarMap);
      }
    }

    // Check function blocks (body and method bodies)
    for (const fb of ast.functionBlocks) {
      const varTypeMap = this.buildVarTypeMap(fb.varBlocks);
      checkStatementsInScope(fb.body, varTypeMap);
      for (const method of fb.methods) {
        const methodVarMap = new Map(varTypeMap);
        // Add method-local vars
        for (const [k, v] of this.buildVarTypeMap(method.varBlocks)) {
          methodVarMap.set(k, v);
        }
        checkStatementsInScope(method.body, methodVarMap);
      }
    }

    // Check functions
    for (const func of ast.functions) {
      const varTypeMap = this.buildVarTypeMap(func.varBlocks);
      checkStatementsInScope(func.body, varTypeMap);
    }
  }

  /**
   * Build a map of variable name (uppercase) → type name (uppercase) from var blocks.
   */
  private buildVarTypeMap(varBlocks: VarBlock[]): Map<string, string> {
    const map = new Map<string, string>();
    for (const block of varBlocks) {
      for (const decl of block.declarations) {
        for (const name of decl.names) {
          map.set(name.toUpperCase(), decl.type.name.toUpperCase());
        }
      }
    }
    return map;
  }

  /**
   * `itf.P` read where the interface declares P without GET: no getter to
   * dispatch to. Assignment targets are writes and are skipped.
   */
  private checkInterfacePropertyReads(
    stmts: Statement[],
    varTypeMap: Map<string, string>,
    propertyInfo: Map<string, PropertyAccessInfo>,
  ): void {
    const targets = new Set<object>();
    for (const stmt of stmts) {
      walkAST(stmt, (node) => {
        if (node.kind === "AssignmentStatement") {
          targets.add((node as AssignmentStatement).target);
          return;
        }
        if (node.kind !== "VariableExpression" || targets.has(node)) return;
        const expr = node as VariableExpression;
        if (expr.fieldAccess.length !== 1 || expr.subscripts.length > 0) {
          return;
        }
        const varType = varTypeMap.get(expr.name.toUpperCase());
        if (!varType) return;
        const field = expr.fieldAccess[0]!;
        const info = propertyInfo.get(`${varType}.${field.toUpperCase()}`);
        if (info?.interfaceName === undefined || info.hasGetter === true) {
          return;
        }
        this.addError(
          `Property '${field}' of INTERFACE '${info.interfaceName}' has no GET accessor; it cannot be read through the interface.`,
          expr.sourceSpan.startLine,
          expr.sourceSpan.startCol,
          expr.sourceSpan.file,
        );
      });
    }
  }

  /**
   * Walk statements looking for assignments to read-only properties.
   */
  private walkStatementsForPropertyWrites(
    stmts: Statement[],
    varTypeMap: Map<string, string>,
    propertyInfo: Map<string, PropertyAccessInfo>,
  ): void {
    for (const stmt of stmts) {
      if (stmt.kind === "AssignmentStatement") {
        const target = stmt.target;
        // Check for x.Property := value pattern
        if (
          target.kind === "VariableExpression" &&
          target.fieldAccess.length === 1
        ) {
          const varType = varTypeMap.get(target.name.toUpperCase());
          if (varType) {
            const fieldName = target.fieldAccess[0]!;
            const propKey = `${varType}.${fieldName.toUpperCase()}`;
            const info = propertyInfo.get(propKey);
            if (info && !info.hasSetter) {
              this.addError(
                info.interfaceName !== undefined
                  ? `Property '${fieldName}' of INTERFACE '${info.interfaceName}' has no SET accessor; it cannot be written through the interface.`
                  : `Property '${fieldName}' of '${varType}' is read-only (no SET accessor).`,
                stmt.sourceSpan.startLine,
                stmt.sourceSpan.startCol,
                stmt.sourceSpan.file,
              );
            }
          }
        }
      }
      // Recurse into control flow
      this.recurseStatementsForPropertyWrites(stmt, varTypeMap, propertyInfo);
    }
  }

  /**
   * Recurse into control flow statements for property write checks.
   */
  private recurseStatementsForPropertyWrites(
    stmt: Statement,
    varTypeMap: Map<string, string>,
    propertyInfo: Map<string, PropertyAccessInfo>,
  ): void {
    if (stmt.kind === "IfStatement") {
      const s = stmt as unknown as {
        thenStatements: Statement[];
        elsifClauses: Array<{ statements: Statement[] }>;
        elseStatements: Statement[];
      };
      this.walkStatementsForPropertyWrites(
        s.thenStatements,
        varTypeMap,
        propertyInfo,
      );
      for (const clause of s.elsifClauses) {
        this.walkStatementsForPropertyWrites(
          clause.statements,
          varTypeMap,
          propertyInfo,
        );
      }
      this.walkStatementsForPropertyWrites(
        s.elseStatements,
        varTypeMap,
        propertyInfo,
      );
    } else if (stmt.kind === "ForStatement") {
      const s = stmt as unknown as { body: Statement[] };
      this.walkStatementsForPropertyWrites(s.body, varTypeMap, propertyInfo);
    } else if (stmt.kind === "WhileStatement") {
      const s = stmt as unknown as { body: Statement[] };
      this.walkStatementsForPropertyWrites(s.body, varTypeMap, propertyInfo);
    } else if (stmt.kind === "RepeatStatement") {
      const s = stmt as unknown as { body: Statement[] };
      this.walkStatementsForPropertyWrites(s.body, varTypeMap, propertyInfo);
    } else if (stmt.kind === "CaseStatement") {
      const s = stmt as unknown as {
        cases: Array<{ statements: Statement[] }>;
        elseStatements: Statement[];
      };
      for (const c of s.cases) {
        this.walkStatementsForPropertyWrites(
          c.statements,
          varTypeMap,
          propertyInfo,
        );
      }
      this.walkStatementsForPropertyWrites(
        s.elseStatements,
        varTypeMap,
        propertyInfo,
      );
    }
  }

  // =============================================================================
  // Bit Access & ADR Expression Validation
  // =============================================================================

  // IEC_TYPE_BITS removed — use getTypeBits() from type-utils.ts

  /**
   * Validate expressions across all programs, functions, and FBs.
   * Checks std function argument counts, bit access bounds, and ADR l-value targets.
   */
  private validateExpressions(ast: CompilationUnit): void {
    for (const prog of ast.programs) {
      this.callOwner = { programName: prog.name };
      const varTypeMap = this.buildVarTypeMap(prog.varBlocks);
      this.walkStatementsForExpressionValidation(prog.body, varTypeMap, ast);
      for (const method of prog.methods) {
        const methodVarTypeMap = new Map(varTypeMap);
        for (const [k, v] of this.buildVarTypeMap(method.varBlocks)) {
          methodVarTypeMap.set(k, v);
        }
        this.walkStatementsForExpressionValidation(
          method.body,
          methodVarTypeMap,
          ast,
        );
      }
    }
    this.callOwner = {};
    for (const func of ast.functions) {
      const varTypeMap = this.buildVarTypeMap(func.varBlocks);
      this.walkStatementsForExpressionValidation(func.body, varTypeMap, ast);
    }
    for (const fb of ast.functionBlocks) {
      this.callOwner = { fbName: fb.name };
      const varTypeMap = this.buildVarTypeMap(fb.varBlocks);
      this.walkStatementsForExpressionValidation(fb.body, varTypeMap, ast);
      for (const method of fb.methods) {
        const methodVarTypeMap = this.buildVarTypeMap(method.varBlocks);
        // Merge FB vars into method scope (method can access FB members)
        for (const [k, v] of varTypeMap) {
          if (!methodVarTypeMap.has(k)) methodVarTypeMap.set(k, v);
        }
        this.walkStatementsForExpressionValidation(
          method.body,
          methodVarTypeMap,
          ast,
        );
      }
      for (const prop of fb.properties) {
        for (const body of [prop.getter, prop.setter]) {
          if (body) {
            this.walkStatementsForExpressionValidation(body, varTypeMap, ast);
          }
        }
      }
    }
    this.callOwner = {};
  }

  /**
   * True when `upper` names an FB or PROGRAM instance of the body being
   * walked: a local, a member of its block or of one of the block's bases.
   */
  private isVisibleVariable(
    upper: string,
    varTypeMap: ReadonlyMap<string, string>,
  ): boolean {
    const isBlock = (typeName: string | undefined): boolean => {
      if (typeName === undefined) return false;
      const kind = this.symbolTables.globalScope.lookup(typeName)?.kind;
      return kind === "functionBlock" || kind === "program";
    };
    if (varTypeMap.has(upper)) return isBlock(varTypeMap.get(upper));
    const seen = new Set<string>();
    let fbName = this.callOwner.fbName;
    while (fbName !== undefined && !seen.has(fbName.toUpperCase())) {
      seen.add(fbName.toUpperCase());
      const fb = this.symbolTables.globalScope.lookup(fbName);
      if (fb?.kind !== "functionBlock") return false;
      for (const b of fb.declaration.varBlocks) {
        for (const d of b.declarations) {
          if (d.names.some((n) => n.toUpperCase() === upper)) {
            return d.type.arrayDimensions === undefined && isBlock(d.type.name);
          }
        }
      }
      fbName = fb.declaration.extends;
    }
    return false;
  }

  /** The PROGRAM or FUNCTION_BLOCK whose bodies validateExpressions walks. */
  private callOwner: UndeclaredVarContext = {};

  /**
   * True when the PROGRAM or FUNCTION_BLOCK of `ctx` declares, or inherits,
   * a method `upper`: a bare call of it calls the method.
   */
  private hasOwnMethod(upper: string, ctx: UndeclaredVarContext): boolean {
    const has = (methods: readonly { name: string }[] | undefined): boolean =>
      methods?.some((m) => m.name.toUpperCase() === upper) === true;
    if (ctx.programName !== undefined) {
      const prog = this.symbolTables.globalScope.lookup(ctx.programName);
      return prog?.kind === "program" && has(prog.declaration.methods);
    }
    const seen = new Set<string>();
    let fbName = ctx.fbName;
    while (fbName !== undefined && !seen.has(fbName.toUpperCase())) {
      seen.add(fbName.toUpperCase());
      const fb = this.symbolTables.globalScope.lookup(fbName);
      if (fb?.kind !== "functionBlock") return false;
      if (has(fb.declaration.methods)) return true;
      fbName = fb.declaration.extends;
    }
    return false;
  }

  /**
   * Walk statements checking expressions for bit access bounds and ADR l-value issues.
   */
  private walkStatementsForExpressionValidation(
    stmts: Statement[],
    varTypeMap: Map<string, string>,
    ast: CompilationUnit,
  ): void {
    for (const stmt of stmts) {
      // Check expressions in assignments
      if (stmt.kind === "AssignmentStatement") {
        this.validateExpression(stmt.target, varTypeMap, ast);
        this.validateExpression(stmt.value, varTypeMap, ast);
      } else if (stmt.kind === "IfStatement" && stmt.conditionalReturn) {
        this.requireFeature(
          "conditional_return",
          "RETURN (condition)",
          stmt.conditionalReturn,
        );
      } else if (stmt.kind === "RefAssignStatement") {
        this.requireFeature("ref_assign", "REF=", stmt.sourceSpan);
        this.validateExpression(stmt.target, varTypeMap, ast);
        this.validateExpression(stmt.source, varTypeMap, ast);
      } else if (stmt.kind === "FunctionCallStatement") {
        this.validateExpression(stmt.call, varTypeMap, ast);
      }
      // Recurse into control flow
      this.recurseStatementsForExpressionValidation(stmt, varTypeMap, ast);
    }
  }

  /**
   * Recurse into control flow statements for expression validation.
   */
  private recurseStatementsForExpressionValidation(
    stmt: Statement,
    varTypeMap: Map<string, string>,
    ast: CompilationUnit,
  ): void {
    if (stmt.kind === "IfStatement") {
      this.validateExpression(stmt.condition, varTypeMap, ast);
      this.walkStatementsForExpressionValidation(
        stmt.thenStatements,
        varTypeMap,
        ast,
      );
      for (const clause of stmt.elsifClauses) {
        this.validateExpression(clause.condition, varTypeMap, ast);
        this.walkStatementsForExpressionValidation(
          clause.statements,
          varTypeMap,
          ast,
        );
      }
      this.walkStatementsForExpressionValidation(
        stmt.elseStatements,
        varTypeMap,
        ast,
      );
    } else if (stmt.kind === "ForStatement") {
      this.validateExpression(stmt.start, varTypeMap, ast);
      this.validateExpression(stmt.end, varTypeMap, ast);
      if (stmt.step) this.validateExpression(stmt.step, varTypeMap, ast);
      this.walkStatementsForExpressionValidation(stmt.body, varTypeMap, ast);
    } else if (stmt.kind === "WhileStatement") {
      this.validateExpression(stmt.condition, varTypeMap, ast);
      this.walkStatementsForExpressionValidation(stmt.body, varTypeMap, ast);
    } else if (stmt.kind === "RepeatStatement") {
      this.walkStatementsForExpressionValidation(stmt.body, varTypeMap, ast);
      this.validateExpression(stmt.condition, varTypeMap, ast);
    } else if (stmt.kind === "CaseStatement") {
      this.validateExpression(stmt.selector, varTypeMap, ast);
      for (const c of stmt.cases) {
        this.walkStatementsForExpressionValidation(
          c.statements,
          varTypeMap,
          ast,
        );
      }
      this.walkStatementsForExpressionValidation(
        stmt.elseStatements,
        varTypeMap,
        ast,
      );
    }
  }

  /**
   * Validate a single expression recursively for std function args, bit access, and ADR issues.
   */
  private validateExpression(
    expr: Expression,
    varTypeMap: Map<string, string>,
    ast: CompilationUnit,
  ): void {
    // Check bit access bounds on variable expressions
    if (expr.kind === "VariableExpression") {
      this.checkBitAccess(expr, varTypeMap, ast, expr.subscripts.length > 0);
    }

    if (
      (expr.kind === "VariableExpression" ||
        expr.kind === "FunctionCallExpression") &&
      expr.selfCaret === true
    ) {
      this.requireFeature("self_caret", "THIS^.member", expr.sourceSpan);
    }

    // Validate standard function argument counts and ADR l-value requirement
    if (
      expr.kind === "FunctionCallExpression" &&
      !expr.functionName.includes(".")
    ) {
      this.checkStdFunctionArgs(expr, varTypeMap);
    }

    // Recurse into sub-expressions
    if (expr.kind === "BinaryExpression") {
      this.validateExpression(expr.left, varTypeMap, ast);
      this.validateExpression(expr.right, varTypeMap, ast);
    } else if (expr.kind === "UnaryExpression") {
      this.validateExpression(expr.operand, varTypeMap, ast);
    } else if (expr.kind === "FunctionCallExpression") {
      for (const arg of expr.arguments) {
        this.validateExpression(arg.value, varTypeMap, ast);
      }
    } else if (expr.kind === "MethodCallExpression") {
      this.validateExpression(expr.object, varTypeMap, ast);
      for (const arg of expr.arguments) {
        this.validateExpression(arg.value, varTypeMap, ast);
      }
    } else if (expr.kind === "ParenthesizedExpression") {
      this.validateExpression(expr.expression, varTypeMap, ast);
    }
  }

  /**
   * Check if an expression is a valid l-value (can have its address taken).
   */
  private isLValue(expr: Expression): boolean {
    return (
      expr.kind === "VariableExpression" ||
      (expr.kind === "ParenthesizedExpression" &&
        this.isLValue(expr.expression))
    );
  }

  /**
   * Validate standard function argument counts and special constraints (e.g., ADR l-value).
   * Covers all registered std functions and *_TO_* conversion functions.
   *
   * EN and ENO are implicit IEC 61131-3 pins — they gate execution and signal
   * success around the call site, but they are not part of any function's
   * declared signature. Strip them before counting against the registry.
   */
  private checkStdFunctionArgs(
    expr: FunctionCallExpression,
    varTypeMap: ReadonlyMap<string, string>,
  ): void {
    const nameUpper = expr.functionName.toUpperCase();
    // A method of the enclosing block is called, not a function of its name.
    if (this.hasOwnMethod(nameUpper, this.callOwner)) return;
    // So is an FB instance in scope, inherited members included.
    if (expr.instance || this.isVisibleVariable(nameUpper, varTypeMap)) {
      return;
    }
    const userArgs = stripEnEno(expr.arguments);
    const argCount = userArgs.length;

    // Look up in std function registry; a user or library function named
    // like a typed truncation (TRUNC_INT) keeps its own signature.
    const sym = this.symbolTables.globalScope.lookup(nameUpper);
    // A PROGRAM of the name is invoked, not a standard function.
    if (sym?.kind === "program") return;
    // A user FUNCTION named like a standard function or operator is called.
    const userFunction =
      sym?.kind === "function" &&
      !this.symbolTables.globalScope.definedByLibrary(nameUpper);
    const desc = userFunction
      ? undefined
      : (this.stdRegistry.lookup(nameUpper) ??
        (sym?.kind === "function"
          ? undefined
          : this.stdRegistry.resolveTypedTrunc(nameUpper)));
    // A library FUNCTION of the name that only these arguments fit is called.
    if (
      desc &&
      libraryOverloadFor(expr, this.symbolTables, this.stdRegistry) !==
        undefined
    ) {
      return;
    }
    if (desc) {
      if (desc.isVariadic) {
        const minArgs = desc.minArgs ?? desc.params.length;
        if (argCount < minArgs) {
          this.addError(
            `'${nameUpper}' requires at least ${minArgs} argument(s), got ${argCount}`,
            expr.sourceSpan.startLine,
            expr.sourceSpan.startCol,
            expr.sourceSpan.file,
          );
        }
      } else {
        const expected = desc.params.length;
        if (argCount !== expected) {
          this.addError(
            `'${nameUpper}' requires ${expected} argument(s), got ${argCount}`,
            expr.sourceSpan.startLine,
            expr.sourceSpan.startCol,
            expr.sourceSpan.file,
          );
        }
      }
    } else if (!userFunction && this.stdRegistry.resolveConversion(nameUpper)) {
      // *_TO_* conversion functions always take exactly 1 argument
      if (argCount !== 1) {
        this.addError(
          `'${nameUpper}' requires 1 argument, got ${argCount}`,
          expr.sourceSpan.startLine,
          expr.sourceSpan.startCol,
          expr.sourceSpan.file,
        );
      }
    } else {
      // Library or user-defined function (not a built-in registry function).
      // Every input WITHOUT an initial value is mandatory; inputs WITH one are
      // optional (the compiler supplies the default). A call that leaves a
      // mandatory input unsupplied — e.g. a graphical block with an
      // unconnected required pin, or hand-written ST missing an argument — is
      // a compile error here, instead of a confusing failure further down
      // (the C++ compiler for library functions, or silent zero-fill for
      // user functions). Function-block invocations resolve to a variable,
      // not a function, so their optional inputs never reach this path.
      if (sym?.kind === "function") {
        this.checkRequiredFunctionInputs(expr, sym, userArgs);
      }
    }

    if (nameUpper === "ADR" && !userFunction) {
      this.requireFeature("pointer_to", "ADR", expr.sourceSpan);
    }

    // Additional ADR / REF_LINK constraint: argument must be an l-value
    // (you can only take the address of / a reference to a variable).
    if (
      (nameUpper === "ADR" || nameUpper === "REF_LINK") &&
      !userFunction &&
      argCount > 0
    ) {
      const arg = userArgs[0]!.value;
      if (!this.isLValue(arg)) {
        this.addError(
          `${nameUpper}() requires a variable reference, not an expression`,
          expr.sourceSpan.startLine,
          expr.sourceSpan.startCol,
          expr.sourceSpan.file,
        );
      }
    }

    // EN/ENO type sanity. The codegen wrapper expects EN to evaluate to a
    // boolean and ENO to bind to a boolean l-value; bail early with a clear
    // message rather than letting the C++ compiler explode downstream.
    for (const arg of expr.arguments) {
      if (isEnArgument(arg)) {
        const t = arg.value.resolvedType;
        if (t) {
          const isBool =
            t.typeKind === "elementary" &&
            (t as ElementaryType).name.toUpperCase() === "BOOL";
          if (!isBool) {
            this.addError(
              `'EN' input must be a BOOL expression, got ${describeType(t)}`,
              arg.value.sourceSpan.startLine,
              arg.value.sourceSpan.startCol,
              arg.value.sourceSpan.file,
            );
          }
        }
      } else if (isEnoArgument(arg)) {
        if (!this.isLValue(arg.value)) {
          this.addError(
            "'ENO' output must be bound to a variable",
            arg.value.sourceSpan.startLine,
            arg.value.sourceSpan.startCol,
            arg.value.sourceSpan.file,
          );
        }
      }
    }
  }

  /**
   * Ordered input parameters of a function, each flagged optional when it
   * declares an initial value. Handles both symbol shapes:
   *   - Library functions carry resolved `parameters` (a VariableSymbol per
   *     param; its `initialValue` string marks an optional input).
   *   - User-defined functions carry their VAR_INPUT declarations on
   *     `declaration.varBlocks` (an AST `initialValue` marks an optional one).
   */
  private functionInputParams(
    sym: FunctionSymbol,
  ): Array<{ name: string; optional: boolean }> {
    if (sym.parameters.length > 0) {
      return sym.parameters
        .filter((p) => p.isInput)
        .map((p) => ({
          name: p.name.toUpperCase(),
          optional: p.initialValue !== undefined,
        }));
    }
    const params: Array<{ name: string; optional: boolean }> = [];
    for (const block of sym.declaration.varBlocks) {
      if (block.blockType !== "VAR_INPUT") continue;
      for (const decl of block.declarations) {
        const optional = decl.initialValue !== undefined;
        for (const n of decl.names)
          params.push({ name: n.toUpperCase(), optional });
      }
    }
    return params;
  }

  /** Upper-case names of a user FUNCTION's inputs that carry an implicit-parameter attribute. */
  private implicitParameterNames(sym: FunctionSymbol): Set<string> {
    const names = new Set<string>();
    for (const block of sym.declaration?.varBlocks ?? []) {
      for (const decl of block.declarations) {
        if (decl.implicitParameter === undefined) continue;
        for (const n of decl.names) names.add(n.toUpperCase());
      }
    }
    return names;
  }

  /**
   * Option A: every input without an initial value is mandatory. Resolve the
   * call's named/positional arguments to parameter slots (mirroring the
   * codegen's argument reordering) and error if any mandatory input is left
   * unsupplied.
   */
  private checkRequiredFunctionInputs(
    expr: FunctionCallExpression,
    sym: FunctionSymbol,
    userArgs: Argument[],
  ): void {
    const inputParams = this.functionInputParams(sym);
    const required = inputParams.filter((p) => !p.optional);
    if (required.length === 0) return;

    // Slots claimed by name; remaining positional args fill the rest in order.
    const satisfied = new Set<string>();
    const positional: Argument[] = [];
    for (const arg of userArgs) {
      if (arg.isOutput) continue; // `=> var` outputs don't fill inputs
      if (arg.name !== undefined) satisfied.add(arg.name.toUpperCase());
      else positional.push(arg);
    }
    let pi = 0;
    for (const p of inputParams) {
      if (pi >= positional.length) break;
      if (satisfied.has(p.name)) continue;
      satisfied.add(p.name);
      pi++;
    }

    const missing = required
      .filter((p) => !satisfied.has(p.name))
      .map((p) => p.name);
    if (missing.length > 0) {
      const implicit = this.implicitParameterNames(sym);
      this.addError(
        `'${expr.functionName.toUpperCase()}' is missing required input${
          missing.length > 1 ? "s" : ""
        }: ${missing.join(", ")}${implicitParameterHint(
          missing.filter((n) => implicit.has(n)),
        )}`,
        expr.sourceSpan.startLine,
        expr.sourceSpan.startCol,
        expr.sourceSpan.file,
      );
    }
  }

  /**
   * Check bit access bounds on a variable expression.
   * Detects patterns like `var.31` where 31 exceeds the bit width of var's type.
   */
  private checkBitAccess(
    expr: {
      name: string;
      fieldAccess: string[];
      sourceSpan: { startLine: number; startCol: number; file?: string };
    },
    varTypeMap: Map<string, string>,
    ast: CompilationUnit,
    hasSubscripts: boolean,
  ): void {
    if (expr.fieldAccess.length === 0) return;

    // Find the first numeric field access (bit index)
    for (let i = 0; i < expr.fieldAccess.length; i++) {
      const field = expr.fieldAccess[i]!;
      if (!/^\d+$/.test(field)) continue;

      const bitIndex = parseInt(field, 10);

      // Resolve the type of the field chain up to (but not including) the bit index
      let typeName = varTypeMap.get(expr.name.toUpperCase());
      if (!typeName) return;

      // If the variable has subscripts (array indexing), resolve to the element type
      if (i === 0 && hasSubscripts) {
        const elemType = resolveArrayElementType(typeName, ast);
        if (elemType) {
          typeName = elemType;
        } else {
          return; // Can't resolve element type — skip validation
        }
      }

      // Walk intermediate fields to resolve the type
      for (let j = 0; j < i; j++) {
        const intermediateField = expr.fieldAccess[j]!;
        if (/^\d+$/.test(intermediateField)) return; // Earlier bit access — skip
        typeName = resolveFieldType(typeName, intermediateField, ast);
        if (!typeName) return;
      }

      const typeUpper = typeName.toUpperCase();
      const bits = getBitAccessWidth(typeUpper);
      if (bits === undefined) {
        // Type doesn't support bit access (REAL, STRING, user-defined, etc.)
        this.addError(
          `Bit access is not valid on type ${typeName}`,
          expr.sourceSpan.startLine,
          expr.sourceSpan.startCol,
          expr.sourceSpan.file,
        );
        return;
      }
      if (bitIndex >= bits) {
        this.addError(
          `Bit index ${bitIndex} is out of range for type ${typeName} (0..${bits - 1})`,
          expr.sourceSpan.startLine,
          expr.sourceSpan.startCol,
          expr.sourceSpan.file,
        );
      }
      return; // Only check the first bit access
    }
  }

  // resolveStructFieldType and resolveArrayElementType removed
  // — use resolveFieldType() and resolveArrayElementType() from type-utils.ts

  /**
   * Validate access modifier enforcement for method calls.
   * PRIVATE methods only callable from within same FB.
   * PROTECTED only from same FB or derived FBs.
   */
  private validateAccessModifiers(ast: CompilationUnit): void {
    // Build method visibility map: "FBNAME.METHODNAME" → Visibility
    const methodVisibility = new Map<string, Visibility>();
    for (const fb of ast.functionBlocks) {
      for (const method of fb.methods) {
        const key = `${fb.name.toUpperCase()}.${method.name.toUpperCase()}`;
        methodVisibility.set(key, method.visibility);
      }
    }

    // Build inheritance chain: FB name → set of ancestor FB names (uppercase)
    const fbMap = new Map<string, FunctionBlockDeclaration>();
    for (const fb of ast.functionBlocks) {
      fbMap.set(fb.name.toUpperCase(), fb);
    }

    const getAncestors = (fbName: string): Set<string> => {
      const ancestors = new Set<string>();
      let current = fbMap.get(fbName.toUpperCase())?.extends;
      const visited = new Set<string>();
      while (current) {
        const upper = current.toUpperCase();
        if (visited.has(upper)) break;
        visited.add(upper);
        ancestors.add(upper);
        current = fbMap.get(upper)?.extends;
      }
      return ancestors;
    };

    // Check method calls in programs (caller context: not in any FB)
    for (const prog of ast.programs) {
      const varTypeMap = this.buildVarTypeMap(prog.varBlocks);
      this.walkStatementsForAccessViolations(
        prog.body,
        varTypeMap,
        methodVisibility,
        null,
        getAncestors,
      );
      for (const method of prog.methods) {
        const methodVarMap = new Map(varTypeMap);
        for (const [k, v] of this.buildVarTypeMap(method.varBlocks)) {
          methodVarMap.set(k, v);
        }
        this.walkStatementsForAccessViolations(
          method.body,
          methodVarMap,
          methodVisibility,
          null,
          getAncestors,
        );
      }
    }

    // Check method calls in functions
    for (const func of ast.functions) {
      const varTypeMap = this.buildVarTypeMap(func.varBlocks);
      this.walkStatementsForAccessViolations(
        func.body,
        varTypeMap,
        methodVisibility,
        null,
        getAncestors,
      );
    }

    // Check method calls in FBs and their methods
    for (const fb of ast.functionBlocks) {
      const varTypeMap = this.buildVarTypeMap(fb.varBlocks);
      this.walkStatementsForAccessViolations(
        fb.body,
        varTypeMap,
        methodVisibility,
        fb.name.toUpperCase(),
        getAncestors,
      );
      for (const method of fb.methods) {
        const methodVarMap = new Map(varTypeMap);
        for (const [k, v] of this.buildVarTypeMap(method.varBlocks)) {
          methodVarMap.set(k, v);
        }
        this.walkStatementsForAccessViolations(
          method.body,
          methodVarMap,
          methodVisibility,
          fb.name.toUpperCase(),
          getAncestors,
        );
      }
    }
  }

  /**
   * Walk statements looking for method calls that violate access modifiers.
   */
  private walkStatementsForAccessViolations(
    stmts: Statement[],
    varTypeMap: Map<string, string>,
    methodVisibility: Map<string, Visibility>,
    callerFB: string | null, // uppercase name of the FB we're inside, or null
    getAncestors: (fbName: string) => Set<string>,
  ): void {
    for (const stmt of stmts) {
      // Check method calls in FunctionCallStatement
      if (stmt.kind === "FunctionCallStatement") {
        const fcStmt = stmt as unknown as {
          call: {
            kind: string;
            functionName?: string;
            object?: Expression;
            methodName?: string;
            arguments: Array<{ value: Expression }>;
            sourceSpan: { startLine: number; startCol: number; file?: string };
          };
        };
        // Handle dotted FunctionCallExpression: m.Method() → functionName = "m.Method"
        if (
          fcStmt.call.kind === "FunctionCallExpression" &&
          fcStmt.call.functionName?.includes(".")
        ) {
          this.checkDottedFunctionCallAccess(
            fcStmt.call.functionName,
            fcStmt.call.sourceSpan,
            varTypeMap,
            methodVisibility,
            callerFB,
            getAncestors,
          );
        }
        // Handle MethodCallExpression: chained calls
        if (fcStmt.call.kind === "MethodCallExpression") {
          this.checkMethodCallAccess(
            fcStmt.call as {
              object: Expression;
              methodName: string;
              sourceSpan: {
                startLine: number;
                startCol: number;
                file?: string;
              };
            },
            varTypeMap,
            methodVisibility,
            callerFB,
            getAncestors,
          );
        }
      }

      // Check assignment RHS for method calls
      if (stmt.kind === "AssignmentStatement") {
        const value = (stmt as { value: Expression }).value;
        this.walkExpressionForAccessViolations(
          value,
          varTypeMap,
          methodVisibility,
          callerFB,
          getAncestors,
        );
      }

      // Recurse into control flow
      this.recurseStatementsForAccessViolations(
        stmt,
        varTypeMap,
        methodVisibility,
        callerFB,
        getAncestors,
      );
    }
  }

  /**
   * Walk an expression tree looking for method calls that violate access modifiers.
   */
  private walkExpressionForAccessViolations(
    expr: Expression,
    varTypeMap: Map<string, string>,
    methodVisibility: Map<string, Visibility>,
    callerFB: string | null,
    getAncestors: (fbName: string) => Set<string>,
  ): void {
    if (expr.kind === "MethodCallExpression") {
      this.checkMethodCallAccess(
        expr as {
          object: Expression;
          methodName: string;
          sourceSpan: { startLine: number; startCol: number; file?: string };
        },
        varTypeMap,
        methodVisibility,
        callerFB,
        getAncestors,
      );
      // Also check arguments
      const args = (expr as { arguments: Array<{ value: Expression }> })
        .arguments;
      for (const arg of args) {
        this.walkExpressionForAccessViolations(
          arg.value,
          varTypeMap,
          methodVisibility,
          callerFB,
          getAncestors,
        );
      }
    } else if (expr.kind === "FunctionCallExpression") {
      // `x := inst.M()`: the method's visibility, as for a statement call.
      const call = expr;
      if (call.instance === undefined && call.functionName.includes(".")) {
        this.checkDottedFunctionCallAccess(
          call.functionName,
          call.sourceSpan,
          varTypeMap,
          methodVisibility,
          callerFB,
          getAncestors,
        );
      }
      const args = (expr as { arguments: Array<{ value: Expression }> })
        .arguments;
      for (const arg of args) {
        this.walkExpressionForAccessViolations(
          arg.value,
          varTypeMap,
          methodVisibility,
          callerFB,
          getAncestors,
        );
      }
    } else if (expr.kind === "BinaryExpression") {
      const bin = expr as { left: Expression; right: Expression };
      this.walkExpressionForAccessViolations(
        bin.left,
        varTypeMap,
        methodVisibility,
        callerFB,
        getAncestors,
      );
      this.walkExpressionForAccessViolations(
        bin.right,
        varTypeMap,
        methodVisibility,
        callerFB,
        getAncestors,
      );
    } else if (expr.kind === "UnaryExpression") {
      const un = expr as { operand: Expression };
      this.walkExpressionForAccessViolations(
        un.operand,
        varTypeMap,
        methodVisibility,
        callerFB,
        getAncestors,
      );
    } else if (expr.kind === "ParenthesizedExpression") {
      const paren = expr as { expression: Expression };
      this.walkExpressionForAccessViolations(
        paren.expression,
        varTypeMap,
        methodVisibility,
        callerFB,
        getAncestors,
      );
    }
  }

  /**
   * Check a dotted FunctionCallExpression (e.g., functionName="m.InternalCalc")
   * for access modifier violations.
   */
  private checkDottedFunctionCallAccess(
    functionName: string,
    sourceSpan: { startLine: number; startCol: number; file?: string },
    varTypeMap: Map<string, string>,
    methodVisibility: Map<string, Visibility>,
    callerFB: string | null,
    getAncestors: (fbName: string) => Set<string>,
  ): void {
    const dotIndex = functionName.indexOf(".");
    if (dotIndex < 0) return;
    const objName = functionName.substring(0, dotIndex);
    const methodName = functionName.substring(dotIndex + 1);

    const calleeFBType = varTypeMap.get(objName.toUpperCase());
    if (!calleeFBType) return;
    this.checkMethodVisibility(
      calleeFBType,
      methodName,
      sourceSpan,
      methodVisibility,
      callerFB,
      getAncestors,
    );
  }

  /**
   * A call of `methodName` on an instance of `calleeFBType`, from `callerFB`
   * (null: a PROGRAM or FUNCTION): refused when the method, declared by the
   * type or inherited from a base, is PRIVATE to another FB or PROTECTED
   * outside its FB and the FBs derived from it.
   */
  private checkMethodVisibility(
    calleeFBType: string,
    methodName: string,
    sourceSpan: { startLine: number; startCol: number; file?: string },
    methodVisibility: Map<string, Visibility>,
    callerFB: string | null,
    getAncestors: (fbName: string) => Set<string>,
  ): void {
    const upper = methodName.toUpperCase();
    // The FB that declares the method: the type, else its nearest base.
    const owner = [calleeFBType, ...getAncestors(calleeFBType)].find((t) =>
      methodVisibility.has(`${t}.${upper}`),
    );
    if (owner === undefined) return;
    const visibility = methodVisibility.get(`${owner}.${upper}`);
    if (visibility === "PRIVATE") {
      if (callerFB !== owner) {
        this.addError(
          `Cannot call PRIVATE method '${methodName}' of '${owner}' from outside '${owner}'.`,
          sourceSpan.startLine,
          sourceSpan.startCol,
          sourceSpan.file,
        );
      }
    } else if (visibility === "PROTECTED") {
      if (callerFB !== owner) {
        const ancestors = callerFB ? getAncestors(callerFB) : new Set<string>();
        if (!ancestors.has(owner)) {
          this.addError(
            `Cannot call PROTECTED method '${methodName}' of '${owner}' from '${callerFB ?? "PROGRAM"}'.`,
            sourceSpan.startLine,
            sourceSpan.startCol,
            sourceSpan.file,
          );
        }
      }
    }
  }

  /**
   * Check a single method call for access modifier violations.
   */
  private checkMethodCallAccess(
    call: {
      object: Expression;
      methodName: string;
      sourceSpan: { startLine: number; startCol: number; file?: string };
    },
    varTypeMap: Map<string, string>,
    methodVisibility: Map<string, Visibility>,
    callerFB: string | null,
    getAncestors: (fbName: string) => Set<string>,
  ): void {
    // Only handle obj.Method() where obj is a simple VariableExpression
    if (call.object.kind !== "VariableExpression") return;
    const varExpr = call.object as { name: string; fieldAccess: string[] };
    if (varExpr.fieldAccess.length > 0) return; // skip chained access for now

    const calleeFBType = varTypeMap.get(varExpr.name.toUpperCase());
    if (!calleeFBType) return;
    this.checkMethodVisibility(
      calleeFBType,
      call.methodName,
      call.sourceSpan,
      methodVisibility,
      callerFB,
      getAncestors,
    );
  }

  /**
   * Recurse into control flow statements for access violation checks.
   */
  private recurseStatementsForAccessViolations(
    stmt: Statement,
    varTypeMap: Map<string, string>,
    methodVisibility: Map<string, Visibility>,
    callerFB: string | null,
    getAncestors: (fbName: string) => Set<string>,
  ): void {
    // The expressions of the statement itself (conditions, bounds, selector).
    const walk = (e: Expression | undefined): void => {
      if (e !== undefined) {
        this.walkExpressionForAccessViolations(
          e,
          varTypeMap,
          methodVisibility,
          callerFB,
          getAncestors,
        );
      }
    };
    if (stmt.kind === "IfStatement") {
      walk(stmt.condition);
      for (const clause of stmt.elsifClauses) walk(clause.condition);
    } else if (stmt.kind === "WhileStatement") {
      walk(stmt.condition);
    } else if (stmt.kind === "RepeatStatement") {
      walk(stmt.condition);
    } else if (stmt.kind === "ForStatement") {
      walk(stmt.start);
      walk(stmt.end);
      walk(stmt.step);
    } else if (stmt.kind === "CaseStatement") {
      walk(stmt.selector);
    }
    if (stmt.kind === "IfStatement") {
      const s = stmt as unknown as {
        thenStatements: Statement[];
        elsifClauses: Array<{ statements: Statement[] }>;
        elseStatements: Statement[];
      };
      this.walkStatementsForAccessViolations(
        s.thenStatements,
        varTypeMap,
        methodVisibility,
        callerFB,
        getAncestors,
      );
      for (const clause of s.elsifClauses) {
        this.walkStatementsForAccessViolations(
          clause.statements,
          varTypeMap,
          methodVisibility,
          callerFB,
          getAncestors,
        );
      }
      this.walkStatementsForAccessViolations(
        s.elseStatements,
        varTypeMap,
        methodVisibility,
        callerFB,
        getAncestors,
      );
    } else if (stmt.kind === "ForStatement") {
      const s = stmt as unknown as { body: Statement[] };
      this.walkStatementsForAccessViolations(
        s.body,
        varTypeMap,
        methodVisibility,
        callerFB,
        getAncestors,
      );
    } else if (stmt.kind === "WhileStatement") {
      const s = stmt as unknown as { body: Statement[] };
      this.walkStatementsForAccessViolations(
        s.body,
        varTypeMap,
        methodVisibility,
        callerFB,
        getAncestors,
      );
    } else if (stmt.kind === "RepeatStatement") {
      const s = stmt as unknown as { body: Statement[] };
      this.walkStatementsForAccessViolations(
        s.body,
        varTypeMap,
        methodVisibility,
        callerFB,
        getAncestors,
      );
    } else if (stmt.kind === "CaseStatement") {
      const s = stmt as unknown as {
        cases: Array<{ statements: Statement[] }>;
        elseStatements: Statement[];
      };
      for (const c of s.cases) {
        this.walkStatementsForAccessViolations(
          c.statements,
          varTypeMap,
          methodVisibility,
          callerFB,
          getAncestors,
        );
      }
      this.walkStatementsForAccessViolations(
        s.elseStatements,
        varTypeMap,
        methodVisibility,
        callerFB,
        getAncestors,
      );
    }
  }

  // =============================================================================
  // Undefined Type Validation
  // =============================================================================

  /**
   * Check if a type name is known (registered in symbol tables or a synthetic internal type).
   */
  private isKnownType(name: string): boolean {
    const upper = name.toUpperCase();
    // Whitelist synthetic internal types
    if (upper.startsWith("__VLA_") || upper.startsWith("__INLINE_ARRAY_")) {
      return true;
    }
    if (this.testTypeNames.has(upper)) return true;
    const sym = this.symbolTables.globalScope.lookup(upper);
    // An elementary type that is no global scope builtin (LTIME): a global
    // variable may still bear its name, as before it was a type.
    if (
      (sym === undefined || sym.kind === "variable") &&
      ELEMENTARY_TYPES[upper] !== undefined
    ) {
      return true;
    }
    if (!sym) return false;
    return (
      sym.kind === "type" ||
      sym.kind === "functionBlock" ||
      sym.kind === "program"
    );
  }

  /** REFERENCE TO is an alias with no storage of its own, so it cannot be stacked with other levels. */
  private validateReferenceLevels(
    typeRef: TypeReference,
    context: string,
  ): void {
    const stacked = [
      typeRef.referenceChain,
      typeRef.elementReferenceChain,
    ].some(
      (chain) =>
        chain !== undefined &&
        chain.length > 1 &&
        chain.includes("reference_to"),
    );
    if (!stacked) return;
    this.addError(
      `REFERENCE TO cannot be combined with other reference levels${context ? " in " + context : ""}`,
      typeRef.sourceSpan.startLine,
      typeRef.sourceSpan.startCol,
      typeRef.sourceSpan.file,
    );
  }

  /** POINTER TO and REFERENCE TO are dialect features: refuse them where the feature is off. */
  private requireReferenceFeatures(typeRef: TypeReference): void {
    const kinds = new Set<string>([
      ...(typeRef.referenceChain ?? [typeRef.referenceKind]),
      ...(typeRef.elementReferenceChain ?? []),
    ]);
    if (kinds.has("pointer_to")) {
      this.requireFeature("pointer_to", "POINTER TO", typeRef.sourceSpan);
    }
    if (kinds.has("reference_to")) {
      this.requireFeature("reference_to", "REFERENCE TO", typeRef.sourceSpan);
    }
  }

  /**
   * ADR is a dialect feature (pointer_to): refuse it in a declaration's
   * initial value too, where the statement walk does not reach.
   */
  private requireAdrFeatureIn(expr: Expression | undefined): void {
    if (!expr) return;
    switch (expr.kind) {
      case "FunctionCallExpression":
        if (expr.functionName.toUpperCase() === "ADR") {
          this.requireFeature("pointer_to", "ADR", expr.sourceSpan);
        }
        for (const arg of expr.arguments) this.requireAdrFeatureIn(arg.value);
        break;
      case "MethodCallExpression":
        this.requireAdrFeatureIn(expr.object);
        for (const arg of expr.arguments) this.requireAdrFeatureIn(arg.value);
        break;
      case "BinaryExpression":
        this.requireAdrFeatureIn(expr.left);
        this.requireAdrFeatureIn(expr.right);
        break;
      case "UnaryExpression":
      case "RefExpression":
      case "DrefExpression":
        this.requireAdrFeatureIn(expr.operand);
        break;
      case "ParenthesizedExpression":
        this.requireAdrFeatureIn(expr.expression);
        break;
      case "ArrayLiteralExpression":
        for (const el of expr.elements) this.requireAdrFeatureIn(el);
        break;
      case "StructInitializerExpression":
        for (const el of expr.elements) this.requireAdrFeatureIn(el.value);
        break;
      default:
        break;
    }
  }

  /**
   * Validate a single TypeReference node. Reports an error if the referenced type is unknown.
   */
  private validateSingleTypeReference(
    typeRef: TypeReference,
    context: string,
  ): void {
    this.validateReferenceLevels(typeRef, context);
    this.requireReferenceFeatures(typeRef);

    // Skip empty or VOID type names
    if (!typeRef.name || typeRef.name.toUpperCase() === "VOID") return;

    // For inline arrays, validate the element type instead
    const nameToCheck = typeRef.elementTypeName ?? typeRef.name;

    // A platform type is lowered where its feature is on.
    if (
      !this.isKnownType(nameToCheck) &&
      platformTypeTarget(nameToCheck) !== undefined
    ) {
      this.requireFeature(
        "platform_types",
        nameToCheck.toUpperCase(),
        typeRef.sourceSpan,
      );
      return;
    }
    if (!this.isKnownType(nameToCheck)) {
      this.addError(
        `Undefined type '${nameToCheck}'${context ? " in " + context : ""}`,
        typeRef.sourceSpan.startLine,
        typeRef.sourceSpan.startCol,
        typeRef.sourceSpan.file,
      );
    }
  }

  /**
   * Validate all type references in the AST.
   * Walks variable declarations, return types, EXTENDS/IMPLEMENTS clauses,
   * method parameters, properties, global var blocks, and type definitions.
   */
  private validateTypeReferences(ast: CompilationUnit): void {
    // Helper to validate var blocks
    const validateVarBlocks = (varBlocks: VarBlock[], context: string) => {
      for (const block of varBlocks) {
        for (const decl of block.declarations) {
          this.validateSingleTypeReference(decl.type, context);
          this.requireAdrFeatureIn(decl.initialValue);
        }
      }
    };

    // Programs
    for (const prog of ast.programs) {
      validateVarBlocks(prog.varBlocks, `PROGRAM '${prog.name}'`);
      for (const method of prog.methods) {
        if (method.returnType) {
          this.validateSingleTypeReference(
            method.returnType,
            `METHOD '${method.name}' of '${prog.name}' return type`,
          );
        }
        validateVarBlocks(
          method.varBlocks,
          `METHOD '${method.name}' of '${prog.name}'`,
        );
      }
    }

    // Functions — var blocks + return type
    for (const func of ast.functions) {
      validateVarBlocks(func.varBlocks, `FUNCTION '${func.name}'`);
      this.validateSingleTypeReference(
        func.returnType,
        `FUNCTION '${func.name}' return type`,
      );
    }

    // Function blocks — var blocks, methods, properties, EXTENDS, IMPLEMENTS
    for (const fb of ast.functionBlocks) {
      validateVarBlocks(fb.varBlocks, `FUNCTION_BLOCK '${fb.name}'`);

      // EXTENDS clause
      if (fb.extends) {
        if (!this.isKnownType(fb.extends)) {
          this.addError(
            `Undefined type '${fb.extends}' in EXTENDS clause of FUNCTION_BLOCK '${fb.name}'`,
            fb.sourceSpan.startLine,
            fb.sourceSpan.startCol,
            fb.sourceSpan.file,
          );
        }
      }

      // IMPLEMENTS clause
      if (fb.implements) {
        for (const ifaceName of fb.implements) {
          if (!this.isKnownType(ifaceName)) {
            this.addError(
              `Undefined type '${ifaceName}' in IMPLEMENTS clause of FUNCTION_BLOCK '${fb.name}'`,
              fb.sourceSpan.startLine,
              fb.sourceSpan.startCol,
              fb.sourceSpan.file,
            );
          }
        }
      }

      // Methods — return type + var blocks (parameters)
      for (const method of fb.methods) {
        if (method.returnType) {
          this.validateSingleTypeReference(
            method.returnType,
            `METHOD '${method.name}' of '${fb.name}' return type`,
          );
        }
        validateVarBlocks(
          method.varBlocks,
          `METHOD '${method.name}' of '${fb.name}'`,
        );
      }

      // Properties
      for (const prop of fb.properties) {
        this.validateSingleTypeReference(
          prop.type,
          `PROPERTY '${prop.name}' of '${fb.name}'`,
        );
      }
    }

    // Interfaces — methods (return type + parameters), EXTENDS
    for (const iface of ast.interfaces) {
      if (iface.extends) {
        for (const baseName of iface.extends) {
          if (!this.isKnownType(baseName)) {
            this.addError(
              `Undefined type '${baseName}' in EXTENDS clause of INTERFACE '${iface.name}'`,
              iface.sourceSpan.startLine,
              iface.sourceSpan.startCol,
              iface.sourceSpan.file,
            );
          }
        }
      }
      for (const method of iface.methods) {
        if (method.returnType) {
          this.validateSingleTypeReference(
            method.returnType,
            `METHOD '${method.name}' of INTERFACE '${iface.name}' return type`,
          );
        }
        validateVarBlocks(
          method.varBlocks,
          `METHOD '${method.name}' of INTERFACE '${iface.name}'`,
        );
      }
      for (const prop of iface.properties) {
        this.validateSingleTypeReference(
          prop.type,
          `PROPERTY '${prop.name}' of INTERFACE '${iface.name}'`,
        );
      }
    }

    // Global var blocks
    for (const block of ast.globalVarBlocks) {
      for (const decl of block.declarations) {
        this.validateSingleTypeReference(decl.type, "VAR_GLOBAL");
        this.requireAdrFeatureIn(decl.initialValue);
      }
    }

    // CONFIGURATION var blocks: only the dialect features are checked here
    // (RESOURCE has no var blocks in this grammar). Their type names are
    // resolved elsewhere, so the no-flag result is unchanged.
    for (const config of ast.configurations) {
      for (const block of config.varBlocks) {
        for (const decl of block.declarations) {
          this.requireReferenceFeatures(decl.type);
          this.requireAdrFeatureIn(decl.initialValue);
        }
      }
    }

    // Type definitions (struct fields, array element types, subrange base types, etc.)
    for (const typeDecl of ast.types) {
      this.validateTypeDefinitionReferences(typeDecl.name, typeDecl.definition);
    }
  }

  /**
   * Validate type references within a type definition (struct fields, array elements, etc.).
   */
  private validateTypeDefinitionReferences(
    typeName: string,
    def: TypeDefinition,
  ): void {
    switch (def.kind) {
      case "StructDefinition":
        for (const field of ownFields(def)) {
          this.validateSingleTypeReference(
            field.type,
            `${def.isUnion ? "UNION" : "STRUCT"} '${typeName}'`,
          );
          this.requireAdrFeatureIn(field.initialValue);
        }
        break;
      case "ArrayDefinition":
        this.validateSingleTypeReference(
          def.elementType,
          `ARRAY type '${typeName}'`,
        );
        break;
      case "SubrangeDefinition":
        this.validateSingleTypeReference(
          def.baseType,
          `subrange type '${typeName}'`,
        );
        break;
      case "EnumDefinition":
        if (def.baseType) {
          this.validateSingleTypeReference(def.baseType, `ENUM '${typeName}'`);
        }
        break;
      case "TypeReference":
        // Type alias — validate the target type
        this.validateSingleTypeReference(def, `type alias '${typeName}'`);
        break;
    }
  }

  // =============================================================================
  // Undeclared Variable Validation
  // =============================================================================

  /**
   * Validate that all variable references in POU bodies refer to declared variables.
   */
  private validateUndeclaredVariables(ast: CompilationUnit): void {
    this.hasExternalCode = false;
    walkAST(ast, (node) => {
      if (node.kind === "ExternalCodePragma") this.hasExternalCode = true;
    });
    this.forEachPouBody(ast, (body, scope, ctx) =>
      this.walkStatementsForUndeclaredVars(body, scope, ctx),
    );
    if (this.features.has("fb_init")) this.validateFbInitArgumentNames(ast);
    this.validateInitialValueNames(ast);
  }

  /**
   * Initial values (`x : INT := zz;`) name only what their declaring scope
   * declares, inside structure initializers and array literals too. A STRUCT
   * field default that names a sibling field is not checked.
   */
  private validateInitialValueNames(ast: CompilationUnit): void {
    const check = (
      blocks: VarBlock[],
      scope: Scope | undefined,
      ctx: UndeclaredVarContext,
    ): void => {
      if (!scope) return;
      for (const block of blocks) {
        for (const decl of block.declarations) {
          if (decl.initialValue) {
            this.checkInitialValueNames(
              decl.initialValue,
              scope,
              ctx,
              ast,
              this.declaredTypeName(decl.type),
            );
          }
        }
      }
    };
    const global = this.symbolTables.globalScope;
    check(ast.globalVarBlocks, global, {});
    for (const prog of ast.programs) {
      const scope = this.symbolTables.getProgramScope(prog.name);
      check(prog.varBlocks, scope, { programName: prog.name });
      for (const method of prog.methods) {
        check(
          method.varBlocks,
          this.symbolTables.getMethodScope(prog.name, method.name) ?? scope,
          { programName: prog.name, methodName: method.name },
        );
      }
    }
    for (const func of ast.functions) {
      check(func.varBlocks, this.symbolTables.getFunctionScope(func.name), {
        functionName: func.name,
      });
    }
    for (const fb of ast.functionBlocks) {
      const scope = this.symbolTables.getFBScope(fb.name);
      check(fb.varBlocks, scope, { fbName: fb.name });
      for (const method of fb.methods) {
        check(
          method.varBlocks,
          this.symbolTables.getMethodScope(fb.name, method.name) ?? scope,
          { fbName: fb.name, methodName: method.name },
        );
      }
    }
    for (const type of ast.types) {
      if (type.definition.kind !== "StructDefinition") continue;
      const fields = new Set(
        type.definition.fields.flatMap((f) =>
          f.names.map((n) => n.toUpperCase()),
        ),
      );
      for (const field of type.definition.fields) {
        if (!field.initialValue) continue;
        let namesSibling = false;
        walkAST(field.initialValue, (node) => {
          if (
            node.kind === "VariableExpression" &&
            fields.has((node as VariableExpression).name.toUpperCase())
          ) {
            namesSibling = true;
          }
        });
        if (!namesSibling) {
          this.checkInitialValueNames(
            field.initialValue,
            global,
            {},
            ast,
            this.declaredTypeName(field.type),
          );
        }
      }
    }
  }

  /**
   * Check one initial value's names; structure initializer element names are
   * not values. `typeName` is the type it initialises, which settles a bare
   * member of several enumerations.
   */
  private checkInitialValueNames(
    expr: Expression,
    scope: Scope,
    ctx: UndeclaredVarContext,
    ast: CompilationUnit,
    typeName: string | undefined,
  ): void {
    if (expr.kind === "StructInitializerExpression") {
      for (const el of expr.elements) {
        const field =
          typeName === undefined
            ? undefined
            : resolveFieldDeclaration(typeName, el.name, ast);
        this.checkInitialValueNames(
          el.value,
          scope,
          ctx,
          ast,
          field ? this.declaredTypeName(field.type) : undefined,
        );
      }
    } else if (expr.kind === "ArrayLiteralExpression") {
      const element =
        typeName === undefined
          ? undefined
          : resolveArrayElementType(typeName, ast);
      for (const el of expr.elements) {
        this.checkInitialValueNames(el, scope, ctx, ast, element);
      }
    } else {
      this.settleEnumMember(expr, typeName, scope);
      this.checkExpressionForUndeclaredVars(expr, scope, ctx);
    }
  }

  /** A declared type's name when it holds its value directly (no POINTER or reference). */
  private declaredTypeName(type: TypeReference): string | undefined {
    if (type.referenceKind !== "none" || type.referenceChain !== undefined) {
      return undefined;
    }
    return type.arrayDimensions !== undefined &&
      type.elementTypeName !== undefined
      ? type.elementReferenceChain === undefined
        ? `__INLINE_ARRAY_${type.elementTypeName}`
        : undefined
      : type.name;
  }

  /**
   * Mark a bare member of several enumerations (`B` in `e : E1 := B`) with the
   * one `typeName` is (through aliases), so it is not ambiguous there.
   */
  private settleEnumMember(
    expr: Expression,
    typeName: string | undefined,
    scope: Scope,
  ): void {
    if (typeName === undefined || expr.kind !== "VariableExpression") return;
    if (
      expr.fieldAccess.length > 0 ||
      expr.subscripts.length > 0 ||
      (expr.accessChain?.length ?? 0) > 0 ||
      expr.isDereference
    ) {
      return;
    }
    const upper = expr.name.toUpperCase();
    const entry = this.enumMemberMap.get(upper);
    if (entry?.typeName !== null || entry === undefined) return;
    const hit = scope.lookup(upper);
    if (hit && hit.kind !== "enumValue") return;
    let current = typeName.toUpperCase();
    for (let i = 0; i < 32; i++) {
      const sym = this.symbolTables.lookupType(current);
      if (!sym) return;
      const name = current;
      const owner = entry.conflictingTypes.find(
        (t) => t.toUpperCase() === name,
      );
      if (owner !== undefined) {
        expr.enumType = owner;
        return;
      }
      const def = sym.declaration?.definition;
      if (
        def?.kind !== "TypeReference" ||
        def.arrayDimensions !== undefined ||
        def.referenceKind !== "none"
      ) {
        return;
      }
      current = def.name.toUpperCase();
    }
  }

  /** The declared type of a plain variable assigned to (`e := ...`), if any. */
  private assignedTypeName(
    target: Expression,
    scope: Scope,
  ): string | undefined {
    if (
      target.kind !== "VariableExpression" ||
      target.fieldAccess.length > 0 ||
      target.subscripts.length > 0 ||
      (target.accessChain?.length ?? 0) > 0 ||
      target.isDereference
    ) {
      return undefined;
    }
    const sym = scope.lookup(target.name.toUpperCase());
    if (sym?.kind !== "variable") return undefined;
    const type = (sym.declaration as VarDeclaration | undefined)?.type;
    return type ? this.declaredTypeName(type) : undefined;
  }

  /** Init argument values (feature fb_init) name only what their declaring scope declares. */
  private validateFbInitArgumentNames(ast: CompilationUnit): void {
    const check = (
      blocks: VarBlock[],
      scope: Scope | undefined,
      ctx: UndeclaredVarContext,
    ): void => {
      if (!scope) return;
      for (const block of blocks) {
        for (const decl of block.declarations) {
          for (const arg of decl.fbInitArguments ?? []) {
            this.checkExpressionForUndeclaredVars(arg.value, scope, ctx);
          }
        }
      }
    };
    check(ast.globalVarBlocks, this.symbolTables.globalScope, {});
    for (const prog of ast.programs) {
      check(prog.varBlocks, this.symbolTables.getProgramScope(prog.name), {});
    }
    const fbs = fbIndex(ast);
    for (const fb of ast.functionBlocks) {
      const fbScope = this.symbolTables.getFBScope(fb.name);
      if (!fbScope) continue;
      check(
        fb.varBlocks,
        fbInitArgumentScope(this.symbolTables, fbs, fb, fbScope),
        { fbName: fb.name },
      );
      this.warnFbInitMemberReads(fbs, fb);
    }
  }

  /**
   * Warn when a member's init argument reads a variable of its holder that
   * the holder's FB_init assigns directly: the member's FB_init runs first.
   * An input of the holder's FB_init shadows the variable; calls are not followed.
   */
  private warnFbInitMemberReads(
    fbs: Map<string, FunctionBlockDeclaration>,
    fb: FunctionBlockDeclaration,
  ): void {
    const assigned = fbInitAssignedNames(fbs, fb.name);
    if (assigned.size === 0) return;
    const inputs = new Set(
      fbInitInputs(fbs, fb.name).map((d) => (d.names[0] ?? "").toUpperCase()),
    );
    const members = new Set<string>();
    for (const owner of fbChain(fbs, fb.name)) {
      for (const block of owner.varBlocks) {
        for (const decl of block.declarations) {
          for (const n of decl.names) members.add(n.toUpperCase());
        }
      }
    }
    for (const block of fb.varBlocks) {
      for (const decl of block.declarations) {
        for (const arg of decl.fbInitArguments ?? []) {
          walkAST(arg.value, (node) => {
            if (node.kind !== "VariableExpression") return;
            const read = node as VariableExpression;
            const name = read.name.toUpperCase();
            if (inputs.has(name) || !members.has(name)) return;
            if (!assigned.has(name)) return;
            this.addWarning(
              `${decl.names[0] ?? ""}'s FB_init runs before ${fb.name}.FB_init, so '${name}' still has its initial value here`,
              read.sourceSpan.startLine,
              read.sourceSpan.startCol,
              read.sourceSpan.file,
            );
          });
        }
      }
    }
  }

  /**
   * Call `visit` with each POU body (program, function, FB, method, property
   * accessor), the scope its names resolve in and its context.
   */
  /** Visit the VAR blocks of the global scope, every POU and every method, with their scope. */
  private forEachVarBlocks(
    ast: CompilationUnit,
    visit: (
      blocks: VarBlock[],
      scope: Scope,
      ctx: UndeclaredVarContext,
    ) => void,
  ): void {
    visit(ast.globalVarBlocks, this.symbolTables.globalScope, {});
    for (const prog of ast.programs) {
      const scope = this.symbolTables.getProgramScope(prog.name);
      if (!scope) continue;
      visit(prog.varBlocks, scope, { programName: prog.name });
      for (const method of prog.methods) {
        visit(
          method.varBlocks,
          this.symbolTables.getMethodScope(prog.name, method.name) ?? scope,
          { programName: prog.name, methodName: method.name },
        );
      }
    }
    for (const func of ast.functions) {
      const scope = this.symbolTables.getFunctionScope(func.name);
      if (scope) visit(func.varBlocks, scope, { functionName: func.name });
    }
    for (const fb of ast.functionBlocks) {
      const scope = this.symbolTables.getFBScope(fb.name);
      if (!scope) continue;
      visit(fb.varBlocks, scope, { fbName: fb.name });
      for (const method of fb.methods) {
        visit(
          method.varBlocks,
          this.symbolTables.getMethodScope(fb.name, method.name) ?? scope,
          { fbName: fb.name, methodName: method.name },
        );
      }
    }
  }

  private forEachPouBody(
    ast: CompilationUnit,
    visit: (body: Statement[], scope: Scope, ctx: UndeclaredVarContext) => void,
  ): void {
    // Programs
    for (const prog of ast.programs) {
      const scope = this.symbolTables.getProgramScope(prog.name);
      if (scope) {
        visit(prog.body, scope, { programName: prog.name });
        for (const method of prog.methods) {
          const methodScope = this.symbolTables.getMethodScope(
            prog.name,
            method.name,
          );
          visit(method.body, methodScope ?? scope, {
            programName: prog.name,
            methodName: method.name,
          });
        }
      }
    }

    // Functions
    for (const func of ast.functions) {
      const scope = this.symbolTables.getFunctionScope(func.name);
      if (scope) {
        visit(func.body, scope, {
          functionName: func.name,
        });
      }
    }

    // Function blocks
    for (const fb of ast.functionBlocks) {
      const scope = this.symbolTables.getFBScope(fb.name);
      if (scope) {
        visit(fb.body, scope, {
          fbName: fb.name,
        });
        for (const method of fb.methods) {
          const methodScope = this.symbolTables.getMethodScope(
            fb.name,
            method.name,
          );
          visit(method.body, methodScope ?? scope, {
            fbName: fb.name,
            methodName: method.name,
          });
        }
        for (const prop of fb.properties) {
          if (prop.getter) {
            visit(prop.getter, scope, {
              fbName: fb.name,
              propertyName: prop.name,
            });
          }
          if (prop.setter) {
            visit(prop.setter, scope, {
              fbName: fb.name,
              propertyName: prop.name,
            });
          }
        }
      }
    }
  }

  /**
   * Walk statements checking for undeclared variable usage.
   */
  private walkStatementsForUndeclaredVars(
    stmts: Statement[],
    scope: Scope,
    ctx: UndeclaredVarContext,
  ): void {
    const inLoop: UndeclaredVarContext = {
      ...ctx,
      loopDepth: (ctx.loopDepth ?? 0) + 1,
    };
    for (const stmt of stmts) {
      switch (stmt.kind) {
        case "ContinueStatement":
          if (ctx.checkContinue === true && (ctx.loopDepth ?? 0) === 0) {
            this.addError(
              "CONTINUE must be inside a FOR, WHILE or REPEAT loop",
              stmt.sourceSpan.startLine,
              stmt.sourceSpan.startCol,
              stmt.sourceSpan.file,
            );
          }
          break;
        case "AssignmentStatement":
          this.checkExpressionForUndeclaredVars(stmt.target, scope, ctx);
          this.settleEnumMember(
            stmt.value,
            this.assignedTypeName(stmt.target, scope),
            scope,
          );
          this.checkExpressionForUndeclaredVars(stmt.value, scope, ctx);
          break;
        case "RefAssignStatement":
          this.checkExpressionForUndeclaredVars(stmt.target, scope, ctx);
          this.checkExpressionForUndeclaredVars(stmt.source, scope, ctx);
          break;
        case "FunctionCallStatement":
          this.checkExpressionForUndeclaredVars(stmt.call, scope, ctx);
          break;
        case "DeleteStatement":
          this.checkExpressionForUndeclaredVars(stmt.pointer, scope, ctx);
          break;
        case "ForStatement":
          this.checkNameDeclared(
            stmt.controlVariable,
            scope,
            ctx,
            stmt.sourceSpan,
          );
          this.checkExpressionForUndeclaredVars(stmt.start, scope, ctx);
          this.checkExpressionForUndeclaredVars(stmt.end, scope, ctx);
          if (stmt.step) {
            this.checkExpressionForUndeclaredVars(stmt.step, scope, ctx);
          }
          this.walkStatementsForUndeclaredVars(stmt.body, scope, inLoop);
          break;
        case "IfStatement":
          this.checkExpressionForUndeclaredVars(stmt.condition, scope, ctx);
          this.walkStatementsForUndeclaredVars(stmt.thenStatements, scope, ctx);
          for (const clause of stmt.elsifClauses) {
            this.checkExpressionForUndeclaredVars(clause.condition, scope, ctx);
            this.walkStatementsForUndeclaredVars(clause.statements, scope, ctx);
          }
          this.walkStatementsForUndeclaredVars(stmt.elseStatements, scope, ctx);
          break;
        case "WhileStatement":
          this.checkExpressionForUndeclaredVars(stmt.condition, scope, ctx);
          this.walkStatementsForUndeclaredVars(stmt.body, scope, inLoop);
          break;
        case "RepeatStatement":
          this.walkStatementsForUndeclaredVars(stmt.body, scope, inLoop);
          this.checkExpressionForUndeclaredVars(stmt.condition, scope, ctx);
          break;
        case "CaseStatement":
          this.checkExpressionForUndeclaredVars(stmt.selector, scope, ctx);
          for (const c of stmt.cases) {
            for (const label of c.labels) {
              this.checkExpressionForUndeclaredVars(label.start, scope, ctx);
              if (label.end) {
                this.checkExpressionForUndeclaredVars(label.end, scope, ctx);
              }
            }
            this.walkStatementsForUndeclaredVars(c.statements, scope, ctx);
          }
          this.walkStatementsForUndeclaredVars(stmt.elseStatements, scope, ctx);
          break;
      }
    }
  }

  /**
   * Recursively check an expression for undeclared variable usage.
   */
  private checkExpressionForUndeclaredVars(
    expr: Expression,
    scope: Scope,
    ctx: UndeclaredVarContext,
  ): void {
    switch (expr.kind) {
      case "VariableExpression":
        if (expr.enumType !== undefined) break;
        this.checkNameDeclared(expr.name, scope, ctx, expr.sourceSpan);
        // Reject member access on a type-level symbol (FB / program / type).
        // Resolves the bug where `RED_YELLOW_GREEN.GREENTIME := …` is
        // silently accepted by the analyzer but blows up at C++
        // compile time as `expected unqualified-id before '.' token`,
        // because strucpp's codegen emits the FB name as a struct
        // type, not a struct instance.  Locally-shadowed names (a
        // `VAR foo : Foo;` declaration of the same identifier) are
        // honoured because `scope.lookup` walks the chain — the
        // shadowing variable wins.
        this.checkInstanceAccess(expr, scope, ctx);
        if (expr.accessChain) {
          // accessChain is the authoritative ordered chain — walk its subscripts
          for (const step of expr.accessChain) {
            if (step.kind === "subscript") {
              for (const idx of step.indices) {
                this.checkExpressionForUndeclaredVars(idx, scope, ctx);
              }
            }
          }
        } else {
          // Legacy path: no accessChain, use subscripts directly
          for (const sub of expr.subscripts) {
            this.checkExpressionForUndeclaredVars(sub, scope, ctx);
          }
        }
        break;
      case "FunctionCallExpression":
        // For dotted names (fb.method), check only the object part
        if (expr.functionName.includes(".")) {
          const objName = expr.functionName.substring(
            0,
            expr.functionName.indexOf("."),
          );
          this.checkNameDeclared(objName, scope, ctx, expr.sourceSpan);
          if (!expr.instance) this.checkSelfQualifiedCall(expr, scope, ctx);
        }
        // An FB instance reached through an expression (`units[0]()`) — check
        // the instance and its subscripts, which are ordinary variables.
        if (expr.instance) {
          this.checkExpressionForUndeclaredVars(expr.instance, scope, ctx);
        }
        if (!expr.functionName.includes(".") && !expr.instance) {
          this.checkCalleeDeclared(expr.functionName, scope, ctx, expr);
        }
        for (const arg of expr.arguments) {
          this.checkExpressionForUndeclaredVars(arg.value, scope, ctx);
        }
        break;
      case "MethodCallExpression":
        this.checkExpressionForUndeclaredVars(expr.object, scope, ctx);
        for (const arg of expr.arguments) {
          this.checkExpressionForUndeclaredVars(arg.value, scope, ctx);
        }
        break;
      case "BinaryExpression":
        this.checkExpressionForUndeclaredVars(expr.left, scope, ctx);
        this.checkExpressionForUndeclaredVars(expr.right, scope, ctx);
        break;
      case "UnaryExpression":
        this.checkExpressionForUndeclaredVars(expr.operand, scope, ctx);
        break;
      case "ParenthesizedExpression":
        this.checkExpressionForUndeclaredVars(expr.expression, scope, ctx);
        break;
      case "RefExpression":
        this.checkExpressionForUndeclaredVars(expr.operand, scope, ctx);
        break;
      case "DrefExpression":
        this.checkExpressionForUndeclaredVars(expr.operand, scope, ctx);
        break;
      case "ArrayLiteralExpression":
        for (const elem of expr.elements) {
          this.checkExpressionForUndeclaredVars(elem, scope, ctx);
        }
        break;
      case "NewExpression":
        if (expr.arraySize) {
          this.checkExpressionForUndeclaredVars(expr.arraySize, scope, ctx);
        }
        break;
    }
  }

  /**
   * Reject `Type.member` patterns where `Type` is a type-level
   * symbol (function block, program, or user-defined TYPE) rather
   * than an instance.  In IEC 61131-3 a function block can only be
   * accessed through an instance variable — `VAR x : MyFB;` then
   * `x.member` — never via the FB name directly.  Strucpp's codegen
   * emits the FB name as a C++ struct type, so `MyFB.member` lands
   * in g++ as `expected unqualified-id before '.' token`; catching
   * it here lets the diagnostic point at the actual ST line.
   *
   * Locally-shadowed names (a `VAR foo : Foo;` declaration of the
   * same identifier) are honoured because `scope.lookup` walks the
   * chain — the shadowing variable wins and no error fires.
   *
   * `enumValue` symbols also live in the global scope (for
   * autocomplete) but they're values, not types; member access on
   * them is rejected by the type system elsewhere, so we skip them
   * here.
   */
  private checkInstanceAccess(
    expr: VariableExpression,
    scope: Scope,
    ctx: UndeclaredVarContext,
  ): void {
    const hasFieldAccess =
      expr.fieldAccess.length > 0 ||
      (expr.accessChain?.some((step) => step.kind === "field") ?? false);
    if (!hasFieldAccess) return;

    const sym = scope.lookup(expr.name);
    if (!sym) return; // undeclared — separate diagnostic from checkNameDeclared

    if (expr.typedLiteral) {
      if (sym.kind === "type" && sym.resolvedType?.typeKind === "enum") return;
      // `E#M` names the type E, also where a variable is named E.
      const type = this.symbolTables.lookupType(expr.name);
      if (type?.kind === "type" && type.resolvedType?.typeKind === "enum") {
        return;
      }
      const member = expr.fieldAccess[0] ?? "";
      const hint = /^[0-9A-F_]+$/i.test(member)
        ? `; did you mean '16#${member}' or '${expr.name}#16#${member}'?`
        : ".";
      this.addError(
        `'${expr.name}#${member}' is not a valid literal: '${expr.name}' is not an enumeration${hint}`,
        expr.sourceSpan.startLine,
        expr.sourceSpan.startCol,
        expr.sourceSpan.file,
      );
      return;
    }

    // `PRG_A.x` from another POU is validated by validateProgramAccess.
    if (sym.kind === "program" && this.reachedMemberNodes.has(expr)) return;

    // `PRG_A.zz` inside PRG_A: its members were lowered, so this names none.
    if (
      sym.kind === "program" &&
      this.features.has("program_methods") &&
      ctx.programName?.toUpperCase() === expr.name.toUpperCase()
    ) {
      this.addError(
        `PROGRAM ${expr.name.toUpperCase()} has no variable '${expr.fieldAccess[0] ?? expr.accessChain?.find((s) => s.kind === "field")?.name ?? ""}'`,
        expr.sourceSpan.startLine,
        expr.sourceSpan.startCol,
        expr.sourceSpan.file,
      );
      return;
    }

    let noun: string | null = null;
    if (sym.kind === "functionBlock") noun = "function block";
    else if (sym.kind === "program") noun = "program";
    // Enum TYPEs intentionally allow `EnumType.Member` qualified
    // access — that's how the language disambiguates a member
    // shared between two enums.  Only flag non-enum type symbols
    // (STRUCT, ARRAY, SUBRANGE, …) where bare `.member` is
    // genuinely invalid.
    else if (sym.kind === "type" && sym.resolvedType?.typeKind !== "enum")
      noun = "type";
    if (noun === null) return;

    this.addError(
      `Cannot access members of ${noun} '${expr.name}' directly — declare a variable of type '${expr.name}' first.`,
      expr.sourceSpan.startLine,
      expr.sourceSpan.startCol,
      expr.sourceSpan.file,
    );
  }

  /**
   * A bare name in a derived block reaching a base's `VAR PRIVATE` variable
   * or PRIVATE property (Ed. 3 6.6.5.10: PRIVATE is not accessible to derived
   * blocks).
   */
  private refuseInheritedPrivate(
    upper: string,
    ctx: UndeclaredVarContext,
    span: { startLine: number; startCol: number; file?: string },
  ): void {
    if (ctx.fbName === undefined) return;
    const own = this.symbolTables.globalScope.lookup(ctx.fbName);
    if (own?.kind !== "functionBlock") return;
    if (this.symbolTables.getFBScope(ctx.fbName)?.lookupLocal(upper)) return;
    if (
      own.declaration.properties.some((p) => p.name.toUpperCase() === upper)
    ) {
      return;
    }
    const visited = new Set<string>();
    let base = own.declaration.extends;
    while (base !== undefined && !visited.has(base.toUpperCase())) {
      visited.add(base.toUpperCase());
      const sym = this.symbolTables.globalScope.lookup(base);
      if (sym?.kind !== "functionBlock") return;
      const block = sym.declaration.varBlocks.find((b) =>
        b.declarations.some((d) =>
          d.names.some((n) => n.toUpperCase() === upper),
        ),
      );
      const libMember = sym.locals.find((v) => v.name.toUpperCase() === upper);
      const declared = block !== undefined || libMember !== undefined;
      if (declared) {
        const priv =
          block?.blockType === "VAR" && block.access?.[0] === "PRIVATE"
            ? true
            : libMember?.access === "PRIVATE";
        if (priv) {
          this.addError(
            `'${upper}' is a PRIVATE variable of FUNCTION_BLOCK '${sym.name}'; only '${sym.name}' itself can access it`,
            span.startLine,
            span.startCol,
            span.file,
          );
        }
        return;
      }
      const prop = sym.declaration.properties.find(
        (p) => p.name.toUpperCase() === upper,
      );
      if (prop !== undefined) {
        if (prop.visibility === "PRIVATE") {
          this.addError(
            `Cannot access PRIVATE property '${upper}' of '${sym.name}' from outside '${sym.name}'.`,
            span.startLine,
            span.startCol,
            span.file,
          );
        }
        return;
      }
      base = sym.declaration.extends;
    }
  }

  /**
   * True when `upper` names, in the body `ctx` describes, an inherited FB
   * member (EXTENDS chain), the function/method/property return variable, or
   * THIS/SUPER inside an FB.
   */
  private isContextName(upper: string, ctx: UndeclaredVarContext): boolean {
    if (ctx.fbName) {
      const fbSym = this.symbolTables.globalScope.lookup(ctx.fbName);
      if (fbSym?.kind === "functionBlock") {
        let parentName = fbSym.declaration.extends;
        const visited = new Set<string>();
        // A PROPERTY of the block or of a base, read or written bare
        if (
          fbSym.declaration.properties.some(
            (p) => p.name.toUpperCase() === upper,
          )
        ) {
          return true;
        }
        while (parentName) {
          const parentUpper = parentName.toUpperCase();
          if (visited.has(parentUpper)) break;
          visited.add(parentUpper);
          const parentScope = this.symbolTables.getFBScope(parentName);
          if (parentScope?.lookupLocal(upper)) return true;
          const parentSym = this.symbolTables.globalScope.lookup(parentUpper);
          if (parentSym?.kind !== "functionBlock") break;
          if (
            parentSym.declaration.properties.some(
              (p) => p.name.toUpperCase() === upper,
            )
          ) {
            return true;
          }
          parentName = parentSym.declaration.extends;
        }
      }
    }
    if (ctx.functionName && upper === ctx.functionName.toUpperCase()) {
      return true;
    }
    if (ctx.methodName && upper === ctx.methodName.toUpperCase()) return true;
    if (ctx.propertyName && upper === ctx.propertyName.toUpperCase()) {
      return true;
    }
    return (upper === "THIS" || upper === "SUPER") && ctx.fbName !== undefined;
  }

  /**
   * A method (or action) of the enclosing PROGRAM, or of the enclosing
   * function block or one of its bases: callable bare. A library base
   * counts as having it.
   */
  private isOwnMethod(upper: string, ctx: UndeclaredVarContext): boolean {
    const has = (methods: readonly { name: string }[]): boolean =>
      methods.some((m) => m.name.toUpperCase() === upper);
    if (ctx.programName !== undefined) {
      const prog = this.symbolTables.globalScope.lookup(ctx.programName);
      if (prog?.kind === "program" && has(prog.declaration.methods)) {
        return true;
      }
    }
    const seen = new Set<string>();
    let fbName = ctx.fbName;
    while (fbName !== undefined && !seen.has(fbName.toUpperCase())) {
      seen.add(fbName.toUpperCase());
      const fb = this.symbolTables.globalScope.lookup(fbName);
      // A library or unresolved block: its methods are not known here
      if (fb?.kind !== "functionBlock" || fb.libraryName !== undefined) {
        return true;
      }
      if (has(fb.declaration.methods)) return true;
      fbName = fb.declaration.extends;
    }
    return false;
  }

  /**
   * `PRG_A.X()` inside PRG_A: X must be a method or action of PRG_A. A member
   * X is lowered to `X()` with program_methods and refused without it, as
   * `PRG_A.x` is; the C++ would name a member the program class lacks.
   */
  private checkSelfQualifiedCall(
    expr: FunctionCallExpression,
    scope: Scope,
    ctx: UndeclaredVarContext,
  ): void {
    const parts = expr.functionName.split(".");
    if (parts.length !== 2 || ctx.programName === undefined) return;
    const own = parts[0]!;
    if (own.toUpperCase() !== ctx.programName.toUpperCase()) return;
    const sym = scope.lookup(own);
    if (sym?.kind !== "program") return;
    const upper = parts[1]!.toUpperCase();
    const prog = sym.declaration;
    if (prog.methods.some((m) => m.name.toUpperCase() === upper)) return;
    const span = expr.sourceSpan;
    const isMember = prog.varBlocks.some((b) =>
      b.declarations.some((d) =>
        d.names.some((n) => n.toUpperCase() === upper),
      ),
    );
    this.addError(
      isMember
        ? `Cannot access members of program '${own}' directly — declare a variable of type '${own}' first.`
        : `PROGRAM ${prog.name} has no method or action '${parts[1]!}'`,
      span.startLine,
      span.startCol,
      span.file,
    );
  }

  /**
   * Error on a bare call whose name is no function, function block instance,
   * method, standard function or other declared callable in scope (C++
   * would see an undeclared name).
   */
  private checkCalleeDeclared(
    name: string,
    scope: Scope,
    ctx: UndeclaredVarContext,
    call: { sourceSpan: SourceSpan },
  ): void {
    // Refused by the operator lowering already.
    if (refusedOperatorCalls.has(call)) return;
    const upper = name.toUpperCase();
    const hit = scope.lookup(upper);
    if (hit && hit.kind !== "enumValue") return;
    if (this.isContextName(upper, ctx)) return;
    if (this.isOwnMethod(upper, ctx)) return;
    if (this.stdRegistry.isStandardFunction(upper)) return;
    if (this.symbolTables.lookupFunction(upper) !== undefined) return;
    if (RUNTIME_CALLABLE_NAMES.has(upper)) return;
    // Inline C++ may declare the name (a macro, a lambda)
    if (this.hasExternalCode) return;
    if (this.refusePouOperator(upper, call.sourceSpan)) return;
    const span = call.sourceSpan;
    // A built-in operator of a dialect feature: refused while it is off.
    const op = vendorOperatorNamed(upper);
    if (op !== undefined) {
      this.requireFeature(vendorOperatorFeature(op), op, span);
      return;
    }
    this.addError(
      `Undeclared function '${upper}'`,
      span.startLine,
      span.startCol,
      span.file,
    );
  }

  /**
   * INDEXOF, and `__POUNAME`, `__POSITION` or `BITADR` left as a call: off,
   * they need the feature vendor_operators; on, a call that was not lowered
   * stands where the operator has no value.
   */
  private refusePouOperator(upper: string, span: SourceSpan): boolean {
    if (upper === "INDEXOF") {
      this.addError(
        "INDEXOF is not supported: use ADR(x) for the address of a variable or instance",
        span.startLine,
        span.startCol,
        span.file,
      );
      return true;
    }
    if (!POU_OPERATORS.has(upper)) return false;
    if (this.features.has("vendor_operators")) {
      this.addError(
        `${upper} has no value here`,
        span.startLine,
        span.startCol,
        span.file,
      );
    } else {
      this.requireFeature("vendor_operators", upper, span);
    }
    return true;
  }

  /**
   * Check whether a name is declared in the current scope chain or context.
   */
  private checkNameDeclared(
    name: string,
    scope: Scope,
    ctx: UndeclaredVarContext,
    sourceSpan: { startLine: number; startCol: number; file?: string },
  ): void {
    const upper = name.toUpperCase();

    // 1. Scope chain lookup (local → parent → globalScope).
    //    `enumValue` hits are deliberately ignored here — the symbol
    //    table only carries them for autocomplete; the ambiguity-
    //    aware resolution path at step 6 (via `enumMemberMap`) is
    //    the source of truth for bare enum references.  Letting an
    //    enumValue match short-circuit here would swallow the
    //    "Ambiguous enum member" diagnostic.
    const scopeHit = scope.lookup(upper);
    if (scopeHit && scopeHit.kind !== "enumValue") return;

    // 1b-4. Inherited FB members, return variables, THIS / SUPER
    if (this.isContextName(upper, ctx)) {
      this.refuseInheritedPrivate(upper, ctx, sourceSpan);
      return;
    }

    // 5. Standard functions (safety net)
    if (this.stdRegistry.isStandardFunction(name)) return;

    // 6. Enum member names (bare enum values like Stopped, Running, Manual)
    const enumEntry = this.enumMemberMap.get(upper);
    if (enumEntry) {
      if (enumEntry.typeName === null) {
        // Ambiguous — member exists in multiple enum types
        const types = enumEntry.conflictingTypes.join("' or '");
        this.addError(
          `Ambiguous enum member '${name}' — qualify as '${types}'`,
          sourceSpan.startLine,
          sourceSpan.startCol,
          sourceSpan.file,
        );
      }
      return;
    }

    // 7. Not found
    this.addError(
      `Undeclared variable '${name}'`,
      sourceSpan.startLine,
      sourceSpan.startCol,
      sourceSpan.file,
    );
  }

  // =============================================================================
  // Test File Analysis
  // =============================================================================

  /**
   * Analyze a parsed test file against source symbol tables.
   * Validates type references in var blocks and undeclared variable usage
   * in SETUP, TEARDOWN, and TEST bodies.
   */
  /** The dialect a test file was parsed under, for the profiles a refusal names. */
  private testFileDialect: ResolvedDialect | undefined;

  analyzeTestFile(
    testFile: TestFile,
    sourceSymbolTables: SymbolTables,
    sourceAst?: CompilationUnit,
  ): { errors: CompileError[]; warnings: CompileError[] } {
    this.errors = [];
    this.warnings = [];
    this.testFileDialect = testFile.dialect;
    this.symbolTables = sourceSymbolTables;

    // Build enum member map from source symbol tables for bare enum resolution
    const enumDescriptors: Array<{ name: string; members: string[] }> = [];
    for (const sym of sourceSymbolTables.globalScope.getAllSymbols()) {
      if (
        sym.kind === "type" &&
        sym.resolvedType?.typeKind === "enum" &&
        (sym.declaration as TypeDeclaration | undefined)?.inline?.owner ===
          undefined
      ) {
        const enumType = sym.resolvedType as EnumType;
        enumDescriptors.push({ name: enumType.name, members: enumType.values });
      }
    }
    this.enumMemberMap = buildEnumMemberMap(enumDescriptors);

    // A platform type lowered by the test parser that the sources declare.
    restoreDeclaredPlatformTypes(testFile, (name) => {
      const kind = sourceSymbolTables.globalScope.lookup(name)?.kind;
      return kind === "type" || kind === "functionBlock" || kind === "program";
    });
    // Operators lower here, where the source declarations that shadow them are known.
    if (testFile.dialect?.features.has("vendor_operators") === true) {
      this.errors.push(
        ...lowerTestPouOperators(
          testFile,
          testFile.fileName,
          // An enum member is no declaration a call reaches.
          (name) => {
            const kind = sourceSymbolTables.globalScope.lookup(name)?.kind;
            return kind !== undefined && kind !== "enumValue";
          },
        ),
      );
    }
    const typeScope = this.buildTestTypeScope(testFile);

    // Validate type references in SETUP and TEST var blocks
    if (testFile.setup) {
      this.validateTestVarBlocks(testFile.setup.varBlocks, "SETUP");
    }
    for (const tc of testFile.testCases) {
      this.validateTestVarBlocks(tc.varBlocks, `TEST '${tc.name}'`);
    }

    // Build SETUP scope (parented to the test file's own types)
    const setupScope = this.buildTestScope(
      testFile.setup?.varBlocks ?? [],
      typeScope,
    );

    // Walk SETUP body
    if (testFile.setup) {
      this.walkTestStatementsForUndeclaredVars(testFile.setup.body, setupScope);
      this.checkTestMemberAccess(testFile.setup.body, setupScope);
    }

    // Walk TEARDOWN body (runs in setup context)
    if (testFile.teardown) {
      this.walkTestStatementsForUndeclaredVars(
        testFile.teardown.body,
        setupScope,
      );
      this.checkTestMemberAccess(testFile.teardown.body, setupScope);
    }

    // STRING literals (assertion messages included) hold Windows-1252 characters
    this.validateStringLiteralCharset([
      ...(testFile.setup?.varBlocks ?? []),
      ...(testFile.setup?.body ?? []),
      ...(testFile.teardown?.body ?? []),
      ...testFile.testCases.flatMap((tc) => [...tc.varBlocks, ...tc.body]),
    ] as ASTNode[]);

    // Walk each TEST body with scope = SETUP vars + TEST-local vars
    for (const tc of testFile.testCases) {
      const testScope = this.buildTestScope(tc.varBlocks, setupScope);
      this.walkTestStatementsForUndeclaredVars(tc.body, testScope);
      this.checkTestMemberAccess(
        tc.body,
        testScope,
        testFile.setup?.body ?? [],
      );
      this.checkTestOutputBindings(tc.body, testScope, sourceAst);
    }
    if (testFile.setup) {
      this.checkTestOutputBindings(
        [...testFile.setup.body, ...(testFile.teardown?.body ?? [])],
        setupScope,
        sourceAst,
      );
    }

    this.testTypeNames.clear();
    return { errors: [...this.errors], warnings: [...this.warnings] };
  }

  /** Output bindings in test bodies: checked as assignments, copied out where needed. */
  private checkTestOutputBindings(
    stmts: readonly TestStatement[],
    scope: Scope,
    sourceAst: CompilationUnit | undefined,
  ): void {
    const checker = new TypeChecker(this.symbolTables, this.stdRegistry);
    const found = checker.checkTestOutputBindings(
      stmts as readonly ASTNode[],
      scope,
      sourceAst,
    );
    this.errors.push(...found.errors);
    this.warnings.push(...found.warnings);
  }

  /**
   * A test body is outside every function block: `inst.x` follows the same
   * rule as in a PROGRAM (inputs written, outputs read, PUBLIC sections; no
   * internal variable, in-out or VAR_EXTERNAL), except on the path to an
   * instance the test or its SETUP MOCKs; from the mock down the rule holds.
   */
  private checkTestMemberAccess(
    stmts: TestStatement[],
    scope: Scope,
    inherited: readonly TestStatement[] = [],
  ): void {
    // The instances this test (or its SETUP) MOCKs, and the path to them, may be private.
    const mocked = [...inherited, ...stmts].flatMap((stmt) =>
      stmt.kind === "MockFBStatement"
        ? [stmt.instancePath.map((p) => p.toUpperCase())]
        : [],
    );
    const onMockPath = (path: string[]): boolean =>
      mocked.some(
        (m) =>
          path.length <= m.length && path.every((part, i) => part === m[i]),
      );
    const roots: ASTNode[] = stmts.flatMap((stmt): ASTNode[] => {
      switch (stmt.kind) {
        case "AssertCall":
          return stmt.args;
        case "AdvanceTimeStatement":
          return [stmt.duration];
        case "MockFunctionStatement":
          return [stmt.returnValue];
        case "MockVerifyCallCountStatement":
          return [stmt.expectedCount];
        case "MockFBStatement":
        case "MockVerifyCalledStatement":
          return [];
        default:
          return [stmt as ASTNode];
      }
    });
    const writes = new Set<Expression>();
    for (const stmt of roots) {
      walkAST(stmt, (node) => {
        if (node.kind === "AssignmentStatement") {
          writes.add((node as AssignmentStatement).target);
        } else if (node.kind === "RefAssignStatement") {
          writes.add((node as RefAssignStatement).target);
        } else if (node.kind === "Argument" && (node as Argument).isOutput) {
          writes.add((node as Argument).value);
        }
      });
    }
    for (const stmt of roots) {
      walkAST(stmt, (node) => {
        if (node.kind !== "VariableExpression") return;
        const expr = node as VariableExpression;
        const sym = scope.lookup(expr.name);
        if (sym?.kind !== "variable") return;
        let typeName: string | undefined = sym.declaration?.type?.name;
        const path = [expr.name.toUpperCase()];
        for (const step of expr.accessChain ??
          expr.fieldAccess.map((name) => ({ kind: "field" as const, name }))) {
          if (step.kind !== "field" || typeName === undefined) return;
          const fb = this.symbolTables.lookupFunctionBlock(typeName);
          if (fb === undefined) return;
          const found = testMemberOf(this.symbolTables, fb.name, step.name);
          if (found === undefined) return;
          path.push(step.name.toUpperCase());
          const write = writes.has(expr);
          const refused =
            !onMockPath(path) &&
            found.access !== "PUBLIC" &&
            !(found.kind === "input" && write) &&
            !(found.kind === "output" && !write);
          if (refused) {
            const fbText = `FUNCTION_BLOCK '${found.owner}'`;
            const message = {
              internal:
                found.access === "PRIVATE"
                  ? `'${step.name}' is a PRIVATE variable of ${fbText}; only '${found.owner}' itself can access it`
                  : `'${step.name}' is an internal variable of ${fbText} and cannot be accessed from outside`,
              external: `'${step.name}' is a VAR_EXTERNAL of ${fbText}, not a member it exposes, and cannot be accessed from outside`,
              input: `'${step.name}' is a VAR_INPUT of ${fbText}; from outside it can be written, not read`,
              output: `'${step.name}' is a VAR_OUTPUT of ${fbText}; from outside it can be read, not written`,
              inout: `'${step.name}' is a VAR_IN_OUT of ${fbText}; from outside it is bound in the call, not accessed through the instance`,
            }[found.kind];
            this.addError(
              message,
              expr.sourceSpan.startLine,
              expr.sourceSpan.startCol,
              expr.sourceSpan.file,
            );
            return;
          }
          typeName = found.type;
        }
      });
    }
  }

  /** Scope holding the TYPEs hoisted from a test file's inline enumerations and subranges. */
  private buildTestTypeScope(testFile: TestFile): Scope {
    const scope = new Scope("testTypes", this.symbolTables.globalScope);
    this.testTypeNames.clear();
    for (const typeDecl of testFile.inlineTypes ?? []) {
      if (this.symbolTables.globalScope.lookup(typeDecl.name)) {
        this.addError(
          `The ${describeInlineType(typeDecl)} uses the type name '${typeDecl.name}', ` +
            `which the program already declares; rename one of them.`,
          typeDecl.sourceSpan.startLine,
          typeDecl.sourceSpan.startCol,
          testFile.fileName,
        );
        continue;
      }
      const resolvedType: EnumType | ElementaryType =
        typeDecl.definition.kind === "EnumDefinition"
          ? {
              typeKind: "enum" as const,
              name: typeDecl.name,
              values: typeDecl.definition.members.map((m) => m.name),
            }
          : {
              typeKind: "elementary" as const,
              name: typeDecl.name,
              sizeBits: 0,
            };
      scope.define({
        name: typeDecl.name,
        kind: "type",
        declaration: typeDecl,
        resolvedType,
      });
      this.testTypeNames.add(typeDecl.name.toUpperCase());
    }
    return scope;
  }

  /**
   * Validate type references in test var blocks.
   */
  private validateTestVarBlocks(varBlocks: VarBlock[], context: string): void {
    for (const block of varBlocks) {
      for (const decl of block.declarations) {
        this.validateSingleTypeReference(decl.type, context);
      }
    }
  }

  /**
   * Build a Scope from test var blocks, parented to the given parent scope.
   */
  private buildTestScope(varBlocks: VarBlock[], parent: Scope): Scope {
    const scope = new Scope("test", parent);
    for (const block of varBlocks) {
      for (const decl of block.declarations) {
        for (const varName of decl.names) {
          try {
            scope.define({
              name: varName,
              kind: "variable",
              declaration: decl,
              isInput: false,
              isOutput: false,
              isInOut: false,
              isExternal: false,
              isGlobal: false,
              isRetain: false,
            });
          } catch {
            // Ignore duplicates within test blocks
          }
        }
      }
    }
    return scope;
  }

  /**
   * Walk test statements checking for undeclared variable usage.
   * Handles test-specific statement kinds (AssertCall, AdvanceTime, Mock*).
   */
  private walkTestStatementsForUndeclaredVars(
    stmts: TestStatement[],
    scope: Scope,
  ): void {
    const ctx: UndeclaredVarContext = { checkContinue: true };
    for (const stmt of stmts) {
      switch (stmt.kind) {
        case "AssertCall":
          this.validateAssertArgCount(stmt);
          for (const arg of stmt.args) {
            this.checkExpressionForUndeclaredVars(arg, scope, ctx);
          }
          break;
        case "AdvanceTimeStatement":
          this.checkExpressionForUndeclaredVars(stmt.duration, scope, ctx);
          break;
        case "MockFunctionStatement":
          this.validateMockFunction(stmt);
          this.checkExpressionForUndeclaredVars(stmt.returnValue, scope, ctx);
          break;
        case "MockVerifyCallCountStatement":
          this.validateMockInstancePath(
            stmt.instancePath,
            stmt.sourceSpan,
            scope,
          );
          this.checkExpressionForUndeclaredVars(stmt.expectedCount, scope, ctx);
          break;
        case "MockFBStatement":
          this.validateMockInstancePath(
            stmt.instancePath,
            stmt.sourceSpan,
            scope,
          );
          break;
        case "MockVerifyCalledStatement":
          this.validateMockInstancePath(
            stmt.instancePath,
            stmt.sourceSpan,
            scope,
          );
          break;
        default:
          // Regular Statement — delegate to existing walker
          this.walkStatementsForUndeclaredVars([stmt as Statement], scope, ctx);
          break;
      }
    }
  }

  /**
   * Validate assert call argument count matches the expected count for each assert type.
   */
  private validateAssertArgCount(assert: AssertCall): void {
    const expectedArgCounts: Record<string, number> = {
      ASSERT_TRUE: 1,
      ASSERT_FALSE: 1,
      ASSERT_EQ: 2,
      ASSERT_NEQ: 2,
      ASSERT_GT: 2,
      ASSERT_LT: 2,
      ASSERT_GE: 2,
      ASSERT_LE: 2,
      ASSERT_NEAR: 3,
    };
    const expected = expectedArgCounts[assert.assertType];
    if (expected !== undefined && assert.args.length !== expected) {
      this.addError(
        `${assert.assertType} expects ${expected} argument${expected !== 1 ? "s" : ""}, got ${assert.args.length}`,
        assert.sourceSpan.startLine,
        assert.sourceSpan.startCol,
      );
    }
  }

  /**
   * Validate MOCK_FUNCTION target exists in global scope or std function registry.
   */
  private validateMockFunction(stmt: MockFunctionStatement): void {
    const name = stmt.functionName.toUpperCase();
    const inGlobal = this.symbolTables.globalScope.lookup(name);
    const inStd = this.stdRegistry.isStandardFunction(name);
    if (!inGlobal && !inStd) {
      this.addWarning(
        `Unknown function '${stmt.functionName}' in MOCK_FUNCTION statement`,
        stmt.sourceSpan.startLine,
        stmt.sourceSpan.startCol,
      );
    }
  }

  /**
   * Validate that the first segment of a MOCK/MOCK_VERIFY instance path is a declared variable.
   */
  private validateMockInstancePath(
    instancePath: string[],
    span: SourceSpan,
    scope: Scope,
  ): void {
    if (instancePath.length === 0) return;
    const rootName = instancePath[0]!.toUpperCase();
    const found = scope.lookup(rootName);
    if (!found) {
      this.addWarning(
        `Unknown variable '${instancePath[0]}' in MOCK statement`,
        span.startLine,
        span.startCol,
      );
    }
  }

  /**
   * Add a warning message.
   * Used in Phase 3+ for semantic validation warnings.
   */
  protected addWarning(
    message: string,
    line: number,
    column: number,
    file?: string,
  ): void {
    this.warnings.push({
      message,
      line,
      column,
      severity: "warning",
      ...(file ? { file } : {}),
    });
  }
}

/**
 * Analyze a compilation unit.
 * Convenience function that creates an analyzer and runs analysis.
 */
export function analyze(
  ast: CompilationUnit,
  existingSymbolTables?: SymbolTables,
): SemanticAnalysisResult {
  const analyzer = new SemanticAnalyzer();
  return analyzer.analyze(ast, existingSymbolTables);
}

/**
 * Analyze a test file against source symbol tables.
 * Convenience function that creates an analyzer and runs test file analysis.
 */
export function analyzeTestFile(
  testFile: TestFile,
  sourceSymbolTables: SymbolTables,
  sourceAst?: CompilationUnit,
): { errors: CompileError[]; warnings: CompileError[] } {
  const analyzer = new SemanticAnalyzer();
  return analyzer.analyzeTestFile(testFile, sourceSymbolTables, sourceAst);
}

/** The parameters of a method the C++ signature carries, in order. */
function signatureParams(
  method: MethodDeclaration,
): Array<{ name: string; type: TypeReference; blockType: string }> {
  const out: Array<{ name: string; type: TypeReference; blockType: string }> =
    [];
  for (const block of method.varBlocks) {
    if (
      block.blockType !== "VAR_INPUT" &&
      block.blockType !== "VAR_OUTPUT" &&
      block.blockType !== "VAR_IN_OUT"
    ) {
      continue;
    }
    for (const decl of block.declarations) {
      for (const name of decl.names) {
        out.push({ name, type: decl.type, blockType: block.blockType });
      }
    }
  }
  return out;
}

/**
 * A key equal for two types the C++ signature spells alike (an alias is its
 * own C++ type, a STRING carries its length by value and by reference).
 */
function cppTypeKey(type: TypeReference): string {
  const name = type.name.toUpperCase();
  const maxLength = type.maxLength;
  const dims = type.arrayDimensions;
  const element = type.elementTypeName;
  const ref = type.referenceKind ?? "none";
  const isString = name === "STRING" || name === "WSTRING";
  // A length named by a constant is not resolved here: "*" matches any.
  const len = !isString
    ? ""
    : typeof maxLength === "string"
      ? "(*)"
      : `(${maxLength ?? 254})`;
  const arr =
    dims === undefined
      ? ""
      : `[${dims.map((d) => `${d.start}..${d.end}`).join(",")}] OF ${(element ?? "").toUpperCase()}`;
  return `${ref} ${name}${len}${arr}`;
}

/** Two cppTypeKey results name the same C++ type ("(*)" is any length). */
function sameCppType(a: string, b: string): boolean {
  if (a === b) return true;
  if (!a.includes("(*)") && !b.includes("(*)")) return false;
  const strip = (k: string): string => k.replace(/\([^)]*\)/, "");
  return strip(a) === strip(b);
}

/** A type as written, with its STRING length. */
function typeText(type: TypeReference): string {
  return type.maxLength === undefined
    ? type.name
    : `${type.name}(${String(type.maxLength)})`;
}

/** A member of function block `fbName` (or of a base): where and how it is declared. */
function testMemberOf(
  tables: SymbolTables,
  fbName: string,
  member: string,
):
  | {
      owner: string;
      kind: "input" | "output" | "inout" | "internal" | "external";
      access?: VarAccess;
      type: string;
    }
  | undefined {
  const upper = member.toUpperCase();
  const seen = new Set<string>();
  let current: string | undefined = fbName;
  while (current !== undefined && !seen.has(current.toUpperCase())) {
    seen.add(current.toUpperCase());
    const fb = tables.lookupFunctionBlock(current);
    if (fb === undefined) return undefined;
    const named = (v: { name: string }): boolean =>
      v.name.toUpperCase() === upper;
    const kinds = {
      VAR: "internal",
      VAR_TEMP: "internal",
      VAR_EXTERNAL: "external",
      VAR_INPUT: "input",
      VAR_OUTPUT: "output",
      VAR_IN_OUT: "inout",
    } as const;
    for (const block of fb.declaration.varBlocks) {
      const decl = block.declarations.find((d) =>
        d.names.some((n) => n.toUpperCase() === upper),
      );
      if (decl === undefined) continue;
      const kind = (
        kinds as Partial<Record<string, (typeof kinds)[keyof typeof kinds]>>
      )[block.blockType];
      if (kind === undefined) return undefined;
      const access = block.access?.[0];
      return {
        owner: fb.name,
        kind,
        type: decl.type.name,
        ...(access !== undefined ? { access } : {}),
      };
    }
    const lib = (
      [
        [fb.inputs, "input"],
        [fb.outputs, "output"],
        [fb.inouts, "inout"],
        [fb.locals, "internal"],
        [fb.temps ?? [], "internal"],
      ] as const
    )
      .map(([list, kind]) => ({ hit: list.find(named), kind }))
      .find((x) => x.hit !== undefined);
    if (lib?.hit !== undefined) {
      return {
        owner: fb.name,
        kind: lib.kind,
        type: lib.hit.declaration.type.name,
        ...(lib.hit.access !== undefined ? { access: lib.hit.access } : {}),
      };
    }
    current = fb.declaration.extends;
  }
  return undefined;
}
