// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * STruC++ Code Generator
 *
 * Generates C++ code from the typed AST or IR.
 * Produces readable, debuggable C++ that maintains line correspondence with ST source.
 */

import type {
  ElementaryType,
  ReferenceType,
  CompilationUnit,
  FunctionDeclaration,
  VarDeclaration,
  Statement,
  Expression,
  AssignmentStatement,
  RefAssignStatement,
  IfStatement,
  CaseStatement,
  ForStatement,
  WhileStatement,
  RepeatStatement,
  FunctionCallExpression,
  Argument,
  MethodCallExpression,
  BinaryExpression,
  UnaryExpression,
  LiteralExpression,
  VariableExpression,
  ReferenceKind,
  TypeReference,
  TypeDeclaration,
  AccessStep,
  ExternalCodePragma,
  MethodDeclaration,
  VarBlock,
  InterfaceDeclaration,
  PropertyDeclaration,
  Visibility,
  ASTNode,
  AssertCall,
} from "../frontend/ast.js";
import { charLiteralUnits } from "../literal-utils.js";
import { isEnEnoArgument, walkAST } from "../ast-utils.js";
import type { SymbolTables } from "../semantic/symbol-table.js";
import type { LineMapEntry, SourceSpan } from "../types.js";
import {
  StdFunctionRegistry,
  type StdFunctionDescriptor,
} from "../semantic/std-function-registry.js";
import type {
  ProjectModel,
  ConfigurationDecl,
  ProgramDecl,
  ProjectVarDeclaration,
} from "../project-model.js";
import type {
  LibraryChunk,
  LibraryFunctionEntry,
  StlibArchive,
} from "../library/library-manifest.js";
import {
  collectFileScopeGlobals,
  getProjectNamespace,
  parseDateLiteralToDays,
  parseDtLiteralToNs,
  parseTimeLiteral,
  parseTodLiteralToNs,
} from "../project-model.js";
import { isElementaryType, TypeRegistry } from "../semantic/type-registry.js";
import { programsReachedByName } from "../semantic/program-access.js";
import {
  FB_INIT_FLAGS,
  FbInitPlan,
  INSTANCE_BLOCKS,
  fbChain,
  fbInitChain,
  fbInitInput,
  fbInitInputs,
  storedInstance,
} from "../semantic/fb-init.js";
import {
  orderConfigurationGlobals,
  orderGlobals,
} from "../semantic/global-order.js";
import { wrapReferenceChain } from "./reference-types.js";
import {
  libraryFunctionDeclaration,
  libraryMethodDeclarations,
} from "../library/library-methods.js";
import { TypeCodeGenerator, IEC_TO_CPP_VAR_TYPE } from "./type-codegen.js";
import {
  dateArithmeticCpp,
  formatArrayType,
  formatIntegerLiteral,
  iecBaseToCppLiteral,
  isComparison,
  isComparisonExpr,
  isNonZeroIntegerLiteral,
  literalTemporalType,
  translateIECString,
} from "./codegen-utils.js";
import {
  mangledMemberName,
  needsMemberMangling,
  typeShadowingMemberNames,
} from "./member-mangling.js";
import { globalCppName, RUNTIME_NAMESPACE_NAMES } from "./global-naming.js";
import {
  getTypeBits,
  getTypeCategory,
  isImplicitlyConvertible,
  resolveFieldType as resolveFieldTypeUtil,
  resolveAccessType,
  resolveArrayElementAccessType,
  resolveFieldDeclaration as resolveFieldDeclarationUtil,
  type AccessLookup,
  resolveArrayElementType as resolveArrayElementTypeUtil,
  resolveArrayShapeByName,
  typeName as typeNameUtil,
  buildEnumMemberMap,
  type EnumMemberEntry,
  typeNamesHeldByTypeDefinition,
  typeNamesHeldByValue,
  typesHoldingFunctionBlocks,
  ELEMENTARY_TYPES,
  canonicalElementaryName,
  enumBehindAlias,
} from "../semantic/type-utils.js";
import {
  generateInitializerValue,
  isStructInitializerValue,
  type StructInitEmitter,
} from "./struct-init-codegen.js";
import { vendorOperatorCpp } from "../semantic/vendor-operators.js";

// =============================================================================
// Located Variable Support
// =============================================================================

/** `__VLA_<rank>D_<ElementType>`, the AST builder's name for an `ARRAY [*]`. */
const VLA_TYPE_NAME = /^__VLA_(\d+)D_(.+)$/;

/** An argument passed to a call by copy-in / copy-out; `cppType` types its
 *  temporary when that differs from the argument's own type. */
interface InOutCopyArg {
  value: VariableExpression;
  cppType?: string;
  /** Reads and writes the variable through one reference (its index runs once). */
  once?: true;
}

/** The parts of a type reference that decide its C++ type. */
interface TypeShape {
  name: string;
  maxLength?: number | string;
  referenceKind?: string;
  referenceChain?: ReferenceKind[];
  arrayDimensions?: Array<{ start: number; end: number }>;
  elementTypeName?: string;
  elementReferenceChain?: ReferenceKind[];
  elementMaxLength?: number | string;
}

/** What codegen keeps about a library FB member's type. */
interface LibraryFieldShape {
  arrayDimensions?: Array<{ start: number; end: number }>;
  elementTypeName?: string;
  referenceKind?: ReferenceKind;
}

/** One class-like header entry, in dependency order: a user function block
 *  or a late struct (a user STRUCT holding a function block by value). */
type HeaderClassNode =
  | { kind: "functionBlock"; fb: CompilationUnit["functionBlocks"][0] }
  | { kind: "type"; type: TypeDeclaration };

/** A library FB member as read from its manifest. */
interface LibraryField extends LibraryFieldShape {
  name: string;
  type: string;
}

/**
 * Information about a located variable for code generation.
 */
interface LocatedVarDescriptor {
  varName: string;
  address: string;
  area: "Input" | "Output" | "Memory";
  size: "Bit" | "Byte" | "Word" | "DWord" | "LWord";
  byteIndex: number;
  bitIndex: number;
  typeName: string;
  programName: string;
  /**
   * IEC index of the array element this descriptor binds, for a located
   * ARRAY. Absent for a scalar.
   *
   * A located array is emitted as one descriptor PER ELEMENT, laid out over
   * consecutive addresses -- `AT %MW60 : ARRAY [0..66] OF WORD` becomes 67
   * descriptors at %MW60..%MW126. The descriptor table is flat and carries no
   * notion of an aggregate, so the element index is what tells the pointer
   * initialiser to bind `arr[i]` rather than `arr` (openplc-editor#565).
   */
  elementIndex?: number;
}

/**
 * Physical lines one emitted string occupies in the joined output: one, plus
 * one for each newline inside it (a library chunk or a type block may carry
 * several lines in one string).
 */
function physicalLineCount(line: string): number {
  let count = 1;
  for (let i = line.indexOf("\n"); i !== -1; i = line.indexOf("\n", i + 1)) {
    count++;
  }
  return count;
}

/** A VAR_INPUT declared REFERENCE TO: the call binds it to its argument. */
function isReferenceInput(block: VarBlock, decl: VarDeclaration): boolean {
  return (
    block.blockType === "VAR_INPUT" &&
    decl.type.referenceKind === "reference_to"
  );
}

/**
 * Placeholder for a `#line` reset back to the generated file. Its number and
 * file name depend on the file the line ends up in (each `cppFiles` entry, the
 * concatenated `cppCode`, the header), so `generate()` resolves it per output
 * with `resolveLineResets`. The NUL bytes keep it from matching emitted code.
 */
const LINE_RESET_PLACEHOLDER = "\u0000#line-reset\u0000";

/**
 * Replace each `LINE_RESET_PLACEHOLDER` in `lines` with
 * `#line <n> "<fileName>"`, where n is the placeholder's own physical line + 1
 * in the file written by joining `lines` (a `#line N` numbers the line after
 * it). Returns a new array; other entries are kept as they are.
 */
function resolveLineResets(
  lines: readonly string[],
  fileName: string,
): string[] {
  const out: string[] = [];
  let physicalLine = 1;
  for (const line of lines) {
    out.push(
      line === LINE_RESET_PLACEHOLDER
        ? `#line ${physicalLine + 1} "${fileName}"`
        : line,
    );
    physicalLine += physicalLineCount(line);
  }
  return out;
}

/**
 * Parse a located variable address and return descriptor info.
 */
function parseLocatedAddress(address: string): {
  area: "Input" | "Output" | "Memory";
  size: "Bit" | "Byte" | "Word" | "DWord" | "LWord";
  byteIndex: number;
  bitIndex: number;
} | null {
  const match = address.match(/^%([IQM])([XBWDL]?)(\d+)(?:\.(\d+))?$/i);
  if (!match) return null;

  const areaChar = match[1]!.toUpperCase();
  const sizeChar = match[2]?.toUpperCase() || "X";
  const byteIndex = parseInt(match[3]!, 10);
  const bitIndex = match[4] ? parseInt(match[4], 10) : 0;

  const areaMap: Record<string, "Input" | "Output" | "Memory"> = {
    I: "Input",
    Q: "Output",
    M: "Memory",
  };

  const sizeMap: Record<string, "Bit" | "Byte" | "Word" | "DWord" | "LWord"> = {
    X: "Bit",
    B: "Byte",
    W: "Word",
    D: "DWord",
    L: "LWord",
  };

  const area = areaMap[areaChar];
  const size = sizeMap[sizeChar];

  if (!area || !size) return null;

  return {
    area,
    size,
    byteIndex,
    bitIndex,
  };
}

// =============================================================================
// Code Generation Options
// =============================================================================

/**
 * Options for code generation.
 */
export interface CodeGenOptions {
  /** Include #line directives for debugging */
  lineDirectives: boolean;

  /** Include ST source as comments */
  sourceComments: boolean;

  /** Indentation string (default: 4 spaces) */
  indent: string;

  /** Line ending (default: \n) */
  lineEnding: string;

  /** Header filename to use in #include directive (default: "generated.hpp") */
  headerFileName: string;

  /** Implementation filename named by the `#line` reset after each body in
   *  the concatenated `cppCode` (the file the CLI writes) when
   *  `lineDirectives` is on (default: "generated.cpp"). Each `cppFiles` entry
   *  names itself instead; every reset's number is its own line + 1 in the
   *  file it is written to. */
  cppFileName?: string;

  /** Additional library headers to include in the generated header */
  libraryHeaders: string[];

  /** Extra `#include "..."` lines to emit at the top of every per-POU
   *  translation unit (after the shared header include). Used by the
   *  editor to plumb in `c_blocks.h` so POU bodies that reference
   *  user-defined C/C++ block structs and extern functions resolve. */
  pouIncludes: string[];

  /** Whether this is a test build (adds mock infrastructure to FB classes) */
  isTestBuild: boolean;

  /** Global constants injected as constexpr into the header preamble (before namespace) */
  globalConstants: Record<string, number>;

  /** ST source filename for #line directives (default: "main.st") */
  fileName: string;

  /** Override filename used in #line directives (absolute path for debugger).
   *  Falls back to fileName when not set. */
  lineDirectiveFileName?: string;

  /** Emit `//@chunk:begin/end:<kind>:<NAME>` comment markers around each
   *  top-level declaration in both header and cpp output. The library
   *  compiler uses these to slice emitted code into per-symbol chunks
   *  for function-level tree-shaking. Off by default — production
   *  compiles produce identical output regardless. */
  emitChunkMarkers?: boolean;

  /** The feature fb_init is on: run FB_init at start-up (see fb-init.ts). */
  fbInit?: boolean;

  /** The C++ is built with STRUCPP_THREADED (see CompileOptions.threaded). */
  threaded?: boolean;
}

/**
 * How each IEC temporal type is exchanged with an integer, per CODESYS.
 *
 * `toUnit` converts our internal representation to the unit a conversion must
 * yield; `fromUnit` converts back. `undefined` means the internal
 * representation already IS that unit, so no call is emitted.
 *
 * Internally every temporal type is nanoseconds since its own zero, except
 * DATE, which is whole days. CODESYS uses 32-bit seconds for DATE and DT,
 * 32-bit milliseconds for TOD and TIME, and 64-bit nanoseconds for all four
 * `L` variants — so the `L` rows are pass-through and the rest scale.
 *
 * One table rather than a chain of `if`s because the two directions have to
 * agree: OSCAT converts out and back inside a single expression, and a unit
 * that disagreed between them would round-trip to nonsense. See DOPE-618.
 */
interface TemporalUnitInfo {
  /** internal → CODESYS unit, for a temporal source. */
  toUnit: string | undefined;
  /** CODESYS unit → internal, for a temporal target. */
  fromUnit: string | undefined;
}

const TEMPORAL_CONVERSION_UNITS = new Map<string, TemporalUnitInfo>([
  // milliseconds
  ["TIME", { toUnit: "TIME_TO_MS", fromUnit: "TIME_FROM_MS" }],
  ["TOD", { toUnit: "TOD_TO_MS", fromUnit: "TOD_FROM_MS" }],
  ["TIME_OF_DAY", { toUnit: "TOD_TO_MS", fromUnit: "TOD_FROM_MS" }],
  // seconds
  ["DT", { toUnit: "DT_TO_SECONDS", fromUnit: "DT_FROM_SECONDS" }],
  ["DATE_AND_TIME", { toUnit: "DT_TO_SECONDS", fromUnit: "DT_FROM_SECONDS" }],
  ["DATE", { toUnit: "DATE_TO_SECONDS", fromUnit: "DATE_FROM_SECONDS" }],
  ["D", { toUnit: "DATE_TO_SECONDS", fromUnit: "DATE_FROM_SECONDS" }],
  // nanoseconds — the 64-bit variants. TIME, TOD and DT are already stored in
  // nanoseconds, so those need no call at all; DATE is stored in days and
  // still has to be scaled.
  ["LTIME", { toUnit: undefined, fromUnit: undefined }],
  ["LTOD", { toUnit: undefined, fromUnit: undefined }],
  ["LTIME_OF_DAY", { toUnit: undefined, fromUnit: undefined }],
  ["LDT", { toUnit: undefined, fromUnit: undefined }],
  ["LDATE_AND_TIME", { toUnit: undefined, fromUnit: undefined }],
  ["LDATE", { toUnit: "DATE_TO_NS", fromUnit: "DATE_FROM_NS" }],
]);

/** Standard functions that order their arguments. */
const CHAR_ORDERED_FUNCTIONS = new Set([
  "MAX",
  "MIN",
  "LIMIT",
  "GT",
  "GE",
  "LT",
  "LE",
]);

/** The stored kind of each temporal type: days for a date, nanoseconds otherwise. */
const TEMPORAL_KIND: Record<string, "date" | "tod" | "dt" | "duration"> = {
  DATE: "date",
  D: "date",
  LDATE: "date",
  TOD: "tod",
  TIME_OF_DAY: "tod",
  LTOD: "tod",
  LTIME_OF_DAY: "tod",
  DT: "dt",
  DATE_AND_TIME: "dt",
  LDT: "dt",
  LDATE_AND_TIME: "dt",
  TIME: "duration",
  LTIME: "duration",
};
const LONG_TEMPORAL_NAMES = new Set([
  "LDATE",
  "LTOD",
  "LTIME_OF_DAY",
  "LDT",
  "LDATE_AND_TIME",
  "LTIME",
]);

/**
 * A conversion between two temporal types: the date or time of day of a
 * date-and-time is split off (in every form, Table 26); with a long (Ed. 3)
 * form on either side, a date becomes the date-and-time of its midnight and the
 * same kind converts unchanged. Undefined for any other pair.
 */
function longTemporalConversion(
  argExpr: string,
  from: string,
  to: string,
): string | undefined {
  const f = TEMPORAL_KIND[from];
  const t = TEMPORAL_KIND[to];
  if (f === undefined || t === undefined) return undefined;
  // Table 26: the date or the time of day of a date-and-time, in every form.
  // Through the stored nanoseconds, so a REFERENCE TO DT converts too.
  if (f === "dt" && t === "date") {
    return `DATE_OF_DT(IEC_DT(static_cast<int64_t>(${argExpr})))`;
  }
  if (f === "dt" && t === "tod") {
    return `TOD_OF_DT(IEC_DT(static_cast<int64_t>(${argExpr})))`;
  }
  if (!LONG_TEMPORAL_NAMES.has(from) && !LONG_TEMPORAL_NAMES.has(to)) {
    return undefined;
  }
  if (f === t) return argExpr;
  if (f === "date" && t === "dt") return `DATE_TO_NS(${argExpr})`;
  if (f === "tod" && t === "dt") return argExpr;
  return undefined;
}

/**
 * Numeric and bit-string targets for the `TO_*` family — i.e. every elementary
 * type whose runtime representation is "just an integer or a float."
 *
 * Gates BOTH directions of the temporal scaling. A temporal source is scaled
 * only when the target is in here; a numeric source is scaled into a temporal
 * target only when the SOURCE is in here. STRING / WSTRING need a format
 * pipeline rather than a scale, and temporal types stay out so that
 * temporal→temporal conversions are left alone.
 *
 * This set and `TEMPORAL_CONVERSION_UNITS` are disjoint, which is what makes
 * the two directions mutually exclusive: no type is both a temporal type and a
 * numeric target.
 */
const NUMERIC_OR_BIT_CONVERSION_TARGETS = new Set([
  "BOOL",
  "SINT",
  "INT",
  "DINT",
  "LINT",
  "USINT",
  "UINT",
  "UDINT",
  "ULINT",
  "REAL",
  "LREAL",
  "BYTE",
  "WORD",
  "DWORD",
  "LWORD",
]);

/**
 * Default code generation options.
 */
export const defaultCodeGenOptions: CodeGenOptions = {
  lineDirectives: false,
  sourceComments: true,
  indent: "    ",
  lineEnding: "\n",
  headerFileName: "generated.hpp",
  libraryHeaders: [],
  pouIncludes: [],
  isTestBuild: false,
  globalConstants: {},
  fileName: "main.st",
};

// =============================================================================
// Code Generation Result
// =============================================================================

/**
 * Result of code generation.
 */
export interface CodeGenResult {
  /**
   * One emit bucket per output file. Always contains
   * `configuration.cpp` (library preambles, located-var defs,
   * configuration glue) plus one `pou_<NAME>.cpp` per program/FB/
   * function. The single-string `cppCode` is the legacy concatenated
   * view — derived from this map by the public `compile()` wrapper.
   */
  cppFiles: Array<{ name: string; content: string }>;

  /** Generated C++ implementation code (concatenation of cppFiles). */
  cppCode: string;

  /** Generated C++ header code */
  headerCode: string;

  /** Line mapping from ST to C++ implementation lines */
  lineMap: Map<number, LineMapEntry>;

  /** Line mapping from ST to C++ header lines */
  headerLineMap: Map<number, LineMapEntry>;

  /** Warnings emitted during code generation */
  warnings: Array<{
    message: string;
    line?: number;
    column?: number;
    file?: string;
  }>;
}

// =============================================================================
// Code Generator
// =============================================================================

/**
 * C++ code generator for IEC 61131-3 programs.
 */
export class CodeGenerator {
  private options: CodeGenOptions;

  /**
   * One emit bucket per output .cpp file. The codegen splits POU
   * implementations across files so the runtime build can run
   * `make -j$(nproc)` and ccache can keep .o files for unchanged
   * POUs across rebuilds. `output` always points at the bucket for
   * the currently-active file; `setOutputFile` swaps it. The
   * bucket map preserves insertion order, which determines emit
   * order for the legacy `cppCode` concatenation.
   */
  private outputFiles: Map<string, string[]> = new Map();
  protected output: string[] = []; // currently-active bucket
  private currentLine = 1; // line counter within currently-active file
  /** An ST `#line` is in force in the implementation output. */
  private cppStLineActive = false;

  private headerOutput: string[] = [];
  private lineMap: Map<number, LineMapEntry> = new Map();
  private headerLineMap: Map<number, LineMapEntry> = new Map();
  private currentHeaderLine = 1;
  /** Header counterpart of `cppStLineActive`. */
  private headerStLineActive = false;
  private projectModel?: ProjectModel;

  /** Track located variables for descriptor array generation */
  private locatedVars: LocatedVarDescriptor[] = [];

  /** UPPER(names) of the current PROGRAM's VAR_EXTERNAL globals. Non-empty only
   *  while emitting a program body; access to these is rewritten to go through
   *  the GlobalVar pointer (g->read() / g->write() / g->with_lock()). */
  private programExternals: Set<string> = new Set();

  /** UPPER(names) of the CONFIGURATION globals, set while their storage is emitted. */
  private configGlobalInitNames: Set<string> = new Set();

  /** UPPER(names) of the current PROGRAM's VAR_EXTERNAL globals whose type is
   *  NOT elementary (struct / array / function-block). Subset of
   *  programExternals. Scalar externals get full read()/write() codegen;
   *  composite externals can be declared + debugged but their in-body access is
   *  gated here (fail-loud) until locked field/element/call codegen lands. */
  private compositeExternals: Set<string> = new Set();

  /** Composite-global arguments of a method or function call bound to a
   *  VAR_IN_OUT / VAR_OUTPUT, mapped to the copy-in temporary the call binds
   *  instead (copy-in/copy-out, see hoistGlobalInOutCopies). */
  private globalInOutTemps: Map<VariableExpression, string> = new Map();

  /** Copy-out lines (no indent) of the statement being emitted, written after
   *  the call's value is computed (see hoistGlobalInOutCopies). */
  private pendingGlobalCopyOuts: string[] = [];

  /** Calls in a compound statement's header (IF / ELSIF / WHILE / REPEAT
   *  condition, CASE selector, FOR bounds) whose arguments passed by copy
   *  are copied in and out around the call itself (wrapGlobalInOutCall). */
  private globalInOutCallWraps: Map<Expression, InOutCopyArg[]> = new Map();

  /** Store AST for looking up program bodies when using project model */
  protected ast?: CompilationUnit;

  /** Current function name (for redirecting function name := to result variable) */
  private currentFunctionName: string | undefined;

  /** Standard function registry for name mapping and conversion resolution */
  private stdRegistry: StdFunctionRegistry;

  /** Warnings collected during code generation */
  private codegenWarnings: Array<{
    message: string;
    line?: number;
    column?: number;
    file?: string;
  }> = [];

  /** Counter for generating unique temporary variable names */
  private tempVarCounter = 0;

  /**
   * Stack of loop exit labels for EXIT codegen. C++ `break` only escapes the
   * innermost switch/loop, so `EXIT` inside a `CASE` nested in a loop must
   * goto past the loop instead. Each loop pushes a fresh label; an inner
   * `EXIT` records `used=true` so the closing emitter only writes the label
   * when something jumps to it.
   */
  private loopExitLabelStack: Array<{ name: string; used: boolean }> = [];
  private loopExitLabelCounter = 0;

  /** Current statement indent level (set by generateStatement before expression generation) */
  private currentStatementIndent = "    ";

  /** Set of known function block type names (upper case) for FB instance detection */
  protected knownFBTypes: Set<string> = new Set();

  /** Set of known interface type names (upper case) */
  protected knownInterfaceTypes: Set<string> = new Set();

  /**
   * Interfaces (upper case) some class reaches through two inheritance paths;
   * every edge to one is virtual, so the instance has a single, unambiguous base.
   */
  private sharedInterfaceBases: Set<string> = new Set();

  /** Set of known struct/UDT type names (upper case) */
  protected knownStructTypes: Set<string> = new Set();

  /** Map of enum type name (upper case) → set of member names (upper case) for :: emission */
  protected enumTypeMembers: Map<string, Set<string>> = new Map();

  /** Reverse map: enum member name (upper case) → owning enum type (for bare enum qualification) */
  protected enumMemberToType: Map<string, EnumMemberEntry> = new Map();

  /** Lazily built hooks for structure-initializer lowering (see getStructInitEmitter). */
  private structInitEmitter?: StructInitEmitter;

  /** UPPER name of the property whose setter is being generated (its value parameter). */
  private currentSetterProperty: string | undefined;

  /** Lazily built set of file-level VAR_GLOBAL names (see fileScopeGlobalNames). */
  private fileScopeGlobalNameCache?: Set<string>;

  /** UPPER library FB name → its methods, from archives that list them. */
  private libraryMethods: Map<string, MethodDeclaration[]> = new Map();
  /** Library FB name → the library FB it EXTENDS (both upper case). */
  private libraryFBExtends: Map<string, string> = new Map();

  /** Library functions by upper-cased name, and their parsed declarations. */
  private libraryFunctions: Map<string, LibraryFunctionEntry> = new Map();
  /** Every library FUNCTION, keyed `LIBRARY:NAME` (upper case), shadowed ones included. */
  private libraryFunctionsByLibrary: Map<string, LibraryFunctionEntry> =
    new Map();
  private libraryFunctionDecls: Map<string, FunctionDeclaration | undefined> =
    new Map();

  /** Library FB field type map: "FBNAME.FIELDNAME" → type name (for field mangling in test codegen) */
  private libraryFBFieldTypes: Map<string, string> = new Map();

  /** Extended type metadata for library FB fields (array dims, reference kind) */
  private libraryFBFieldTypeRefs: Map<string, LibraryFieldShape> = new Map();

  /** Set of known program type names (upper case) for program invocation detection */
  protected knownProgramTypes: Set<string> = new Set();

  /** Map of variable name (upper case) → type name (original case) for current scope */
  protected currentScopeVarTypes: Map<string, string> = new Map();

  /** UPPER(names) the current scope declares in VAR_EXTERNAL blocks. */
  private scopeExternalNames: Set<string> = new Set();

  /** Map of variable name (upper case) → referenceKind ("ref_to" | "reference_to"
   *  | "pointer_to") for current scope. Only reference/pointer vars are present;
   *  used e.g. to pick the correct lowering for a REF= rebind. */
  protected currentScopeVarRefKinds: Map<string, string> = new Map();

  /** Map of variable name (upper case) → declared type, for current scope. */
  protected currentScopeVarTypeRefs: Map<string, TypeReference> = new Map();

  /** Parent class name of current FB (for SUPER resolution) */
  private currentFBExtends: string | undefined;

  /** When generating a method that returns an interface type, assignments to the
   *  result variable should be converted to return statements */
  private interfaceReturnMethod = false;

  /** Map of UPPER(typeName).UPPER(methodName) → declared method name for case normalization */
  protected methodNameMap: Map<string, string> = new Map();

  /** Map of UPPER(interfaceName) → Set of UPPER(methodName) for variable/method collision detection */
  protected interfaceMethodsByInterface: Map<string, Set<string>> = new Map();

  /** Map of UPPER(typeName).UPPER(propName) → declared property name for property access codegen */
  protected propertyNameMap: Map<string, string> = new Map();

  /** Current FB name (set during generateFBImplementation for property resolution) */
  private currentFBName: string | undefined;

  /** Mapping of VAR_INST names (upper case) to mangled class member names */
  private varInstMangledNames: Map<string, string> = new Map();

  /** Mapping of member names (upper case) that collide with their type name
   *  or interface method names to mangled names (e.g., SENSOR → SENSOR_) */
  private memberMangledNames: Map<string, string> = new Map();

  /** Interface method names for the current FB (UPPER case), used for variable/method collision detection */
  private currentFBInterfaceMethods: Set<string> = new Set();

  /** Map of UPPER(fbName) → Set of UPPER(interfaceMethodName) for external field access mangling */
  protected fbInterfaceMethodNames: Map<string, Set<string>> = new Map();

  /** Current FB's var blocks, kept so method scopes can see FB member types */
  private currentFBVarBlocks: CompilationUnit["programs"][0]["varBlocks"] = [];

  /** The PROGRAM whose run() or methods are being generated: `MAIN.M()`
   *  inside MAIN is a call on `this` (feature program_methods). */
  private currentProgramName: string | undefined;

  /** FB_init start-up work of this unit (feature fb_init), or undefined when off. */
  private fbInitPlan: FbInitPlan | undefined;

  /** True once the header defines `__fb_init_globals()`. */
  private fbInitGlobalsEmitted = false;

  /** Upper-case PROGRAMs reached by name from another POU: one shared instance each. */
  protected reachedPrograms: ReadonlySet<string> = new Set();

  /** Topologically sorted function blocks (computed once in generate(), used by header + impl) */
  private sortedFBs: CompilationUnit["functionBlocks"] = [];

  /** The header's class sequence: the FB classes and the late types, in
   *  dependency order (computed once in generate(); the implementation pass
   *  uses `sortedFBs`, the FBs alone in the same order). */
  private sortedHeaderClasses: HeaderClassNode[] = [];

  /** Upper-case names of the late types: user TYPEs that hold a function
   *  block (user or library) by value. They are emitted among the FB classes,
   *  after the library header chunks, instead of with the other user types. */
  private lateTypeNames: Set<string> = new Set();

  /** Per-archive reachable-chunk emission state.
   *
   *  Built by `addLibraryChunks` — one entry per library the consumer
   *  pulled at least one chunk from. The emission loop iterates this
   *  in insertion order (= the order index.ts hands archives over,
   *  which is library load order). For each library, only chunks
   *  whose name appears in `reachable` are emitted; the array order
   *  matches the library's `chunks[]` declaration order so symbol
   *  layout in the user's `generated.hpp` is stable across builds. */
  private libraryEmissions: Array<{
    archive: StlibArchive;
    reachable: Set<string>;
  }> = [];

  /** Map of UPPER(fbTypeName) → ordered VAR_INPUT parameter names (UPPER case).
   *  Used to resolve positional arguments in FB invocations. */
  private fbInputParams: Map<string, string[]> = new Map();

  /** Map of UPPER(fbTypeName) → set of its own VAR_IN_OUT parameter names
   *  (UPPER case). A call binds each by reference (see inOutKind). */
  private fbInoutParams: Map<string, Set<string>> = new Map();

  /** Library FBs (UPPER) built before in-outs were bound by reference: their
   *  in-outs are by-value members, copied in and back at the call. */
  private legacyInOutFBs: Set<string> = new Set();

  /** Library FBs already warned about as legacy in-out archives. */
  private legacyInOutWarned: Set<string> = new Set();

  /** Names (UPPER) in the current scope that are by-reference VAR_IN_OUT
   *  members of the enclosing function block: read and written as `(*X)`. */
  private scopeInOutRefs: Set<string> = new Set();

  /** Arguments a method or function call binds to a VAR_IN_OUT by reference
   *  that render differently from a read (a shared global's storage). */
  private inOutBindExprs: Set<VariableExpression> = new Set();

  /** Names (UPPER) of the current method or function body that live on the
   *  C++ stack (its parameters, VAR and VAR_TEMP). */
  private stackLocals: Set<string> = new Set();

  // IEC_TYPE_BITS and IEC_TYPE_CAT removed — use getTypeBits()/getTypeCategory() from type-utils.ts

  constructor(
    private readonly _symbolTables?: SymbolTables,
    options: Partial<CodeGenOptions> = {},
  ) {
    this.options = { ...defaultCodeGenOptions, ...options };
    this.stdRegistry = new StdFunctionRegistry();
  }

  /** TypeCodeGenerator instance for type mapping */
  private typeCodeGen = new TypeCodeGenerator();

  /** Get symbol tables (for future use in Phase 3+) */
  get symbolTables(): SymbolTables {
    if (!this._symbolTables) {
      throw new Error("SymbolTables not available (test codegen mode)");
    }
    return this._symbolTables;
  }

  /**
   * Map a variable type name to its C++ type string.
   * Handles VLA synthetic names (__VLA_1D_INT → ArrayView1D<INT_t>)
   * and regular types (INT → IEC_INT).
   */
  protected mapVarTypeToCpp(
    typeName: string,
    maxLength?: number | string,
  ): string {
    // Handle VLA synthetic names: __VLA_{ndims}D_{elementType}
    // Use IECVar-wrapped types to match concrete Array1D<IEC_T, ...> elements
    const vlaMatch = VLA_TYPE_NAME.exec(typeName);
    if (vlaMatch) {
      const ndims = vlaMatch[1];
      const elemType = this.mapVarTypeToCpp(vlaMatch[2]!);
      return `ArrayView${ndims}D<${elemType}>`;
    }
    // Handle parameterized STRING(n) / WSTRING(n) / STRING(CONSTANT_NAME)
    if (maxLength !== undefined) {
      const upper = typeName.toUpperCase();
      if (upper === "STRING") {
        return `IECStringVar<${maxLength}>`;
      }
      if (upper === "WSTRING") {
        return `IECWStringVar<${maxLength}>`;
      }
    }
    // User-defined types fall into two camps:
    //   1. FBs / interfaces / structs / arrays — fields already wrap leaves
    //      in IECVar internally, so the bare class name is used directly.
    //   2. Enums (`enum class`) — declared as the `IEC_<name>` wrapper
    //      (= `IEC_ENUM<name>`), which has the IECVar shape (one value_
    //      member) the debugger's `read_impl` and the operators expect.
    if (this.isUserDefinedType(typeName)) {
      // Programs use Program_NAME class naming convention
      if (this.knownProgramTypes.has(typeName.toUpperCase())) {
        return `Program_${typeName}`;
      }
      if (this.enumTypeMembers.has(typeName.toUpperCase())) {
        return `IEC_${typeName}`;
      }
      return typeName;
    }
    // Elementary types: use the canonical IECVar alias map so names whose
    // wrapper isn't simply `IEC_<NAME>` (e.g. __XWORD → IEC_XWORD) resolve
    // correctly; all standard types map to `IEC_<NAME>` as before.
    return IEC_TO_CPP_VAR_TYPE[typeName.toUpperCase()] ?? `IEC_${typeName}`;
  }

  /**
   * Map a TypeReference to its C++ type string, including parameterized length
   * and pointer/reference qualifiers.
   */
  /**
   * Build a TypeReference shape suitable for emitting a parameter type.
   *
   * Preserves array/pointer metadata (so inline ARRAY parameters become
   * `Array1D<T, L, U>&` and pointer params become `IEC_Ptr<T>&`) but
   * strips STRING/WSTRING maxLength so any size string binds to the
   * &-reference — matching the previous behavior of the call sites that
   * went through `mapVarTypeToCpp(decl.type.name)` without maxLength.
   */
  /**
   * The shape of a parameter passed by reference (VAR_IN_OUT, VAR_OUTPUT of
   * a FUNCTION or METHOD): as toParamTypeRef, keeping a STRING length so the
   * C++ reference has the declared type.
   */
  protected byRefParamTypeRef<T extends TypeShape>(typeRef: T): TypeShape {
    const upper = typeRef.name.toUpperCase();
    const isString = upper === "STRING" || upper === "WSTRING";
    const shape = this.toParamTypeRef(typeRef);
    return isString && typeRef.maxLength !== undefined
      ? { ...shape, maxLength: typeRef.maxLength }
      : shape;
  }

  protected toParamTypeRef<T extends TypeShape>(typeRef: T): TypeShape {
    const upper = typeRef.name.toUpperCase();
    const isString = upper === "STRING" || upper === "WSTRING";
    return {
      name: typeRef.name,
      ...(!isString && typeRef.maxLength !== undefined
        ? { maxLength: typeRef.maxLength }
        : {}),
      ...(typeRef.arrayDimensions !== undefined
        ? { arrayDimensions: typeRef.arrayDimensions }
        : {}),
      ...(typeRef.elementTypeName !== undefined
        ? { elementTypeName: typeRef.elementTypeName }
        : {}),
      ...(typeRef.elementReferenceChain !== undefined
        ? { elementReferenceChain: typeRef.elementReferenceChain }
        : {}),
      ...(typeRef.elementMaxLength !== undefined
        ? { elementMaxLength: typeRef.elementMaxLength }
        : {}),
      ...(typeRef.referenceKind !== undefined
        ? { referenceKind: typeRef.referenceKind }
        : {}),
      ...(typeRef.referenceChain !== undefined
        ? { referenceChain: typeRef.referenceChain }
        : {}),
    };
  }

  /**
   * Convert a project-model record (ProjectVarDeclaration /
   * VarExternalDeclaration) into a TypeReference shape suitable for
   * `mapTypeRefToCpp` / `toParamTypeRef`. Project-model records keep the
   * type name in `.typeName` and reserve `.name` for the variable name;
   * this helper rewires the fields so the shape matches what the
   * type-resolution helpers expect.
   */
  private projectVarToTypeRef(
    spec: Omit<TypeShape, "name"> & { typeName: string },
  ): TypeShape {
    return {
      name: spec.typeName,
      ...(spec.maxLength !== undefined ? { maxLength: spec.maxLength } : {}),
      ...(spec.arrayDimensions !== undefined
        ? { arrayDimensions: spec.arrayDimensions }
        : {}),
      ...(spec.elementTypeName !== undefined
        ? { elementTypeName: spec.elementTypeName }
        : {}),
      ...(spec.elementReferenceChain !== undefined
        ? { elementReferenceChain: spec.elementReferenceChain }
        : {}),
      ...(spec.elementMaxLength !== undefined
        ? { elementMaxLength: spec.elementMaxLength }
        : {}),
      ...(spec.referenceKind !== undefined
        ? { referenceKind: spec.referenceKind }
        : {}),
      ...(spec.referenceChain !== undefined
        ? { referenceChain: spec.referenceChain }
        : {}),
    };
  }

  /**
   * The type a pointer or reference wraps: the raw struct / FB / program name
   * for a user type, the raw value type (`INT_t`) for an elementary one. The
   * wrappers hold an IECVar<T> themselves.
   */
  private rawReferencedType(name: string): string {
    if (this.isUserDefinedType(name)) {
      return this.knownProgramTypes.has(name.toUpperCase())
        ? `Program_${name}`
        : name;
    }
    return this.typeCodeGen.mapTypeToCpp(name);
  }

  protected mapTypeRefToCpp(typeRef: TypeShape): string {
    let baseType: string;

    // Handle inline array types with dimension info
    // Array1D stores T directly — use IECVar-wrapped types for elementary elements
    // and bare names for composites (whose fields already contain IECVar leaves)
    if (typeRef.arrayDimensions && typeRef.elementTypeName) {
      const elementLength = typeRef.elementMaxLength;
      const elemCpp = typeRef.elementReferenceChain
        ? // ARRAY OF POINTER TO / REF_TO: each element is the wrapper a variable gets.
          wrapReferenceChain(
            typeRef.elementReferenceChain,
            elementLength !== undefined
              ? this.typeCodeGen.mapTypeRefToCpp({
                  name: typeRef.elementTypeName,
                  maxLength: elementLength,
                })
              : this.rawReferencedType(typeRef.elementTypeName),
          )
        : elementLength !== undefined
          ? this.typeCodeGen.mapStructFieldTypeToCpp(
              typeRef.elementTypeName,
              elementLength,
            )
          : this.isInterfaceType(typeRef.elementTypeName)
            ? // An INTERFACE element holds a nullable reference, as a variable does.
              `IEC_ITF<${typeRef.elementTypeName}>`
            : // An enumeration element is the variable a scalar gets (IEC_E), as in a
              // STRUCT field or named ARRAY type, so REF/ADR of it see one type.
              this.mapVarTypeToCpp(typeRef.elementTypeName);
      baseType = formatArrayType(elemCpp, typeRef.arrayDimensions);
    } else if (
      typeRef.elementReferenceChain &&
      VLA_TYPE_NAME.test(typeRef.name)
    ) {
      // ARRAY[*] OF POINTER TO / REF_TO: a view over the same wrappers.
      const [, ndims, elem] = VLA_TYPE_NAME.exec(typeRef.name)!;
      const elemCpp = wrapReferenceChain(
        typeRef.elementReferenceChain,
        this.rawReferencedType(elem!),
      );
      baseType = `ArrayView${ndims}D<${elemCpp}>`;
    } else if (
      typeRef.elementMaxLength !== undefined &&
      VLA_TYPE_NAME.test(typeRef.name)
    ) {
      // ARRAY[*] OF STRING(n): a view over elements of that length.
      const [, ndims, elem] = VLA_TYPE_NAME.exec(typeRef.name)!;
      const elemCpp = this.typeCodeGen.mapStructFieldTypeToCpp(
        elem!,
        typeRef.elementMaxLength,
      );
      baseType = `ArrayView${ndims}D<${elemCpp}>`;
    } else {
      baseType = this.mapVarTypeToCpp(
        typeRef.name,
        typeof typeRef.maxLength === "number" ? typeRef.maxLength : undefined,
      );
    }

    if (
      typeRef.referenceKind === "pointer_to" ||
      typeRef.referenceKind === "ref_to" ||
      typeRef.referenceKind === "reference_to"
    ) {
      // Pointer (IEC_Ptr<T>) and reference (IEC_REF_TO<T> / IEC_REFERENCE_TO<T>)
      // wrappers all take the raw element type (not IECVar-wrapped); they wrap
      // an IECVar<T> internally.
      // Array pointer/reference: baseType is already raw (Array1D<...>)
      const elemType =
        typeRef.arrayDimensions && typeRef.elementTypeName
          ? baseType
          : typeRef.maxLength !== undefined
            ? this.typeCodeGen.mapTypeRefToCpp(typeRef)
            : this.rawReferencedType(typeRef.name);
      // Nested levels (`POINTER TO REF_TO INT`) wrap innermost first.
      return wrapReferenceChain(
        typeRef.referenceChain ?? [typeRef.referenceKind],
        elemType,
      );
    }
    // An interface-typed variable holds a nullable reference to the instance.
    if (!typeRef.arrayDimensions && this.isInterfaceType(typeRef.name)) {
      return `IEC_ITF<${baseType}>`;
    }
    // For STRING(CONSTANT_NAME), emit template with the constant name
    if (typeof typeRef.maxLength === "string") {
      const upper = typeRef.name.toUpperCase();
      if (upper === "STRING") {
        return `IECStringVar<${typeRef.maxLength}>`;
      }
      if (upper === "WSTRING") {
        return `IECWStringVar<${typeRef.maxLength}>`;
      }
    }
    return baseType;
  }

  /**
   * Set the project model for enhanced code generation.
   */
  setProjectModel(model: ProjectModel): void {
    this.projectModel = model;
  }

  /**
   * Register FB type names from libraries so codegen can distinguish
   * FB invocations from regular function calls. Private — use registerLibraryArchives().
   */
  private registerLibraryFBTypes(
    fbs: Array<{
      name: string;
      inputNames: string[];
      inoutNames: string[];
      inoutByReference: boolean;
      fields: Array<LibraryField>;
    }>,
  ): void {
    for (const fb of fbs) {
      const fbUpper = fb.name.toUpperCase();
      this.knownFBTypes.add(fbUpper);
      if (fb.inoutNames.length > 0 && !fb.inoutByReference) {
        this.legacyInOutFBs.add(fbUpper);
      }
      if (fb.inputNames.length > 0) {
        this.fbInputParams.set(
          fbUpper,
          fb.inputNames.map((n) => n.toUpperCase()),
        );
      }
      if (fb.inoutNames.length > 0) {
        this.fbInoutParams.set(
          fbUpper,
          new Set(fb.inoutNames.map((n) => n.toUpperCase())),
        );
      }
      for (const f of fb.fields) {
        this.libraryFBFieldTypes.set(
          `${fbUpper}.${f.name.toUpperCase()}`,
          f.type,
        );
        // Store array metadata for inline array type reconstruction
        if (f.arrayDimensions || f.elementTypeName || f.referenceKind) {
          const ref: LibraryFieldShape = {};
          if (f.arrayDimensions) ref.arrayDimensions = f.arrayDimensions;
          if (f.elementTypeName) ref.elementTypeName = f.elementTypeName;
          if (f.referenceKind) ref.referenceKind = f.referenceKind;
          this.libraryFBFieldTypeRefs.set(
            `${fbUpper}.${f.name.toUpperCase()}`,
            ref,
          );
        }
      }
    }
  }

  /**
   * Register type info from library manifests (enum types for :: emission,
   * struct types for known-type detection). Private — use registerLibraryArchives().
   */
  private registerLibraryTypes(
    types: Array<{ name: string; kind: string }>,
  ): void {
    for (const t of types) {
      const nameUpper = t.name.toUpperCase();
      if (t.kind === "enum") {
        // Members are not available in the manifest, but we only need to
        // know the type IS an enum for :: emission in generateVariableExpression
        if (!this.enumTypeMembers.has(nameUpper)) {
          this.enumTypeMembers.set(nameUpper, new Set());
        }
      }
      this.knownStructTypes.add(nameUpper);
    }
  }

  /**
   * Register all type and FB metadata from library archives.
   * Single entry point used by both compile() and generateTestMain().
   */
  registerLibraryArchives(archives: StlibArchive[]): void {
    for (const archive of archives) {
      for (const fn of archive.manifest.functions) {
        const upper = fn.name.toUpperCase();
        if (!this.libraryFunctions.has(upper)) {
          this.libraryFunctions.set(upper, fn);
        }
        this.libraryFunctionsByLibrary.set(
          `${archive.manifest.name.toUpperCase()}:${upper}`,
          fn,
        );
      }
      for (const fb of archive.manifest.functionBlocks) {
        const methods = libraryMethodDeclarations(fb);
        if (methods !== undefined && methods.length > 0) {
          this.libraryMethods.set(fb.name.toUpperCase(), methods);
        }
        // Properties read and written through `get_X()` / `set_X(v)`.
        for (const prop of fb.properties ?? []) {
          this.propertyNameMap.set(
            `${fb.name.toUpperCase()}.${prop.name.toUpperCase()}`,
            prop.name,
          );
        }
        if (fb.extends !== undefined) {
          this.libraryFBExtends.set(
            fb.name.toUpperCase(),
            fb.extends.toUpperCase(),
          );
        }
      }
      this.registerLibraryFBTypes(
        archive.manifest.functionBlocks.map((fb) => {
          const mapVar = (v: LibraryField): LibraryField => {
            const entry: LibraryField = { name: v.name, type: v.type };
            if (v.arrayDimensions) entry.arrayDimensions = v.arrayDimensions;
            if (v.elementTypeName) entry.elementTypeName = v.elementTypeName;
            if (v.referenceKind) entry.referenceKind = v.referenceKind;
            return entry;
          };
          return {
            name: fb.name,
            inputNames: fb.inputs.map((i) => i.name),
            inoutNames: fb.inouts.map((i) => i.name),
            inoutByReference: fb.inoutByReference === true,
            fields: [
              ...fb.inputs.map(mapVar),
              ...fb.outputs.map(mapVar),
              ...fb.inouts.map(mapVar),
            ],
          };
        }),
      );
      if (archive.manifest.types) {
        this.registerLibraryTypes(archive.manifest.types);
      }
    }
  }

  /**
   * Hand the codegen a library archive and the set of chunk names
   * the consumer determined to be reachable from the user's AST.
   * Only those chunks are emitted into the final header/cpp.
   *
   * Single per-call entry point: nothing else mutates
   * `libraryEmissions`. The caller (index.ts) computes the reachable
   * set via function-level tree-shake before invoking this method.
   */
  addLibraryChunks(archive: StlibArchive, reachable: Set<string>): void {
    this.libraryEmissions.push({ archive, reachable });
  }

  /**
   * Emit a chunk-boundary marker in the active header stream. No-op
   * when `emitChunkMarkers` is off. See `CodeGenOptions.emitChunkMarkers`
   * — the markers exist so the library compiler can slice emitted code
   * into per-symbol chunks for function-level tree-shaking.
   */
  protected emitHeaderChunkMarker(
    boundary: "begin" | "end",
    kind: "function" | "functionBlock" | "type" | "inlineGlobal",
    name: string,
  ): void {
    if (!this.options.emitChunkMarkers) return;
    this.emitHeader(`//@chunk:${boundary}:${kind}:${name}`);
  }

  /** Emit a chunk-boundary marker in the active cpp stream. */
  protected emitCppChunkMarker(
    boundary: "begin" | "end",
    kind: "function" | "functionBlock" | "type" | "inlineGlobal",
    name: string,
  ): void {
    if (!this.options.emitChunkMarkers) return;
    this.emit(`//@chunk:${boundary}:${kind}:${name}`);
  }

  /**
   * Switch the active emit bucket. Creates a new bucket if the file
   * name hasn't been seen before; otherwise resumes appending to the
   * existing one. Caller is responsible for emitting the per-TU
   * preamble (license, #include, namespace open) on the first switch
   * to a file via `startTranslationUnit`.
   *
   * `currentLine` keeps its global value across switches — lineMap
   * entries reference positions in the legacy concatenated `cppCode`,
   * which is what the REPL line-mapping display and gdb debug info
   * (via #line directives) consume. Splitting only affects which
   * physical .cpp file a line lands in; the logical numbering for
   * the source-map is end-to-end across all files.
   */
  private setOutputFile(name: string): void {
    let bucket = this.outputFiles.get(name);
    if (!bucket) {
      bucket = [];
      this.outputFiles.set(name, bucket);
    }
    this.output = bucket;
  }

  /**
   * Begin a new translation unit. Emits the standard preamble (banner,
   * #include for the shared header, opening namespace) into the file's
   * bucket. Pair with `endTranslationUnit` after emitting POU bodies.
   */
  private startTranslationUnit(name: string): void {
    this.setOutputFile(name);
    const ns = this.projectModel
      ? getProjectNamespace(this.projectModel)
      : "strucpp";
    this.emit(
      "// Generated by STruC++ - IEC 61131-3 Structured Text to C++ Compiler",
    );
    this.emit("// Do not edit this file manually.");
    this.emit("");
    this.emit(`#include "${this.options.headerFileName}"`);
    for (const extra of this.options.pouIncludes) {
      this.emit(`#include "${extra}"`);
    }
    this.emit("");
    this.emit(`namespace ${ns} {`);
    this.emit("");
  }

  /**
   * Close the namespace on the currently-active translation unit.
   * Mirrors `startTranslationUnit`.
   */
  private endTranslationUnit(): void {
    const ns = this.projectModel
      ? getProjectNamespace(this.projectModel)
      : "strucpp";
    this.emit(`}  // namespace ${ns}`);
  }

  /**
   * Build a deterministic .cpp file name for a POU. Names already
   * conform to C identifier rules (the parser enforces it), so we
   * just lowercase + prefix; per-POU uniqueness is the caller's
   * concern (multiple POUs with the same name would already be a
   * semantic error caught earlier).
   */
  private pouFileName(pouName: string): string {
    return `pou_${pouName}.cpp`;
  }

  /**
   * Generate C++ code from a compilation unit.
   */
  generate(ast: CompilationUnit): CodeGenResult {
    this.outputFiles = new Map();
    this.output = [];
    this.headerOutput = [];
    this.lineMap = new Map();
    this.headerLineMap = new Map();
    this.currentLine = 1;
    this.currentHeaderLine = 1;
    this.cppStLineActive = false;
    this.headerStLineActive = false;
    this.locatedVars = [];
    this.codegenWarnings = [];
    this.tempVarCounter = 0;
    this.ast = ast; // Store AST for looking up program bodies
    this.fbInitPlan =
      this.options.fbInit === true ? new FbInitPlan(ast) : undefined;
    this.fbInitGlobalsEmitted = false;
    this.reachedPrograms = programsReachedByName(ast);

    // Build set of known FB types from AST (library FB types already registered
    // via registerLibraryFBTypes() before generate() is called)
    for (const fb of ast.functionBlocks) {
      this.knownFBTypes.add(fb.name.toUpperCase());
      // Build ordered input parameter names for positional argument resolution
      const inputNames: string[] = [];
      const inoutNames: string[] = [];
      for (const block of fb.varBlocks) {
        if (block.blockType === "VAR_INPUT") {
          for (const decl of block.declarations) {
            for (const name of decl.names) {
              inputNames.push(name.toUpperCase());
            }
          }
        } else if (block.blockType === "VAR_IN_OUT") {
          for (const decl of block.declarations) {
            for (const name of decl.names) {
              inoutNames.push(name.toUpperCase());
            }
          }
        }
      }
      if (inputNames.length > 0) {
        this.fbInputParams.set(fb.name.toUpperCase(), inputNames);
      }
      if (inoutNames.length > 0) {
        this.fbInoutParams.set(fb.name.toUpperCase(), new Set(inoutNames));
      }
    }

    // Build set of known interface types, method name map, and per-interface method sets
    for (const iface of ast.interfaces) {
      this.knownInterfaceTypes.add(iface.name.toUpperCase());
      const ifaceMethods = new Set<string>();
      for (const method of iface.methods) {
        this.methodNameMap.set(
          `${iface.name.toUpperCase()}.${method.name.toUpperCase()}`,
          method.name,
        );
        ifaceMethods.add(method.name.toUpperCase());
      }
      this.interfaceMethodsByInterface.set(
        iface.name.toUpperCase(),
        ifaceMethods,
      );
    }
    // Interface properties, own and inherited, resolve on the interface type
    for (const iface of ast.interfaces) {
      for (const prop of this.interfacePropertiesOf(iface.name, ast)) {
        this.propertyNameMap.set(
          `${iface.name.toUpperCase()}.${prop.name.toUpperCase()}`,
          prop.name,
        );
      }
    }

    this.sharedInterfaceBases = this.findSharedInterfaceBases(ast);

    // Build method name map, property name map, and interface method names for FBs
    for (const fb of ast.functionBlocks) {
      for (const method of fb.methods) {
        this.methodNameMap.set(
          `${fb.name.toUpperCase()}.${method.name.toUpperCase()}`,
          method.name,
        );
      }
      for (const prop of fb.properties) {
        this.propertyNameMap.set(
          `${fb.name.toUpperCase()}.${prop.name.toUpperCase()}`,
          prop.name,
        );
      }
      // Precompute interface method names for each FB (for field access mangling)
      const ifaceMethods = this.getInterfaceMethodNames(fb);
      if (ifaceMethods.size > 0) {
        this.fbInterfaceMethodNames.set(fb.name.toUpperCase(), ifaceMethods);
      }
    }

    // Program methods (feature program_methods) resolve like an FB's
    for (const prog of ast.programs) {
      for (const method of prog.methods) {
        this.methodNameMap.set(
          `${prog.name.toUpperCase()}.${method.name.toUpperCase()}`,
          method.name,
        );
      }
    }

    // Build set of known struct/UDT types and enum member maps
    const enumDescriptors: Array<{ name: string; members: string[] }> = [];
    for (const td of ast.types) {
      this.knownStructTypes.add(td.name.toUpperCase());
      if (td.definition.kind === "EnumDefinition") {
        const memberNames = td.definition.members.map((m) => m.name);
        const members = new Set(memberNames.map((m) => m.toUpperCase()));
        this.enumTypeMembers.set(td.name.toUpperCase(), members);
        if (td.inline?.owner === undefined) {
          enumDescriptors.push({ name: td.name, members: memberNames });
        }
      } else {
        // An alias of an enumeration is an enumeration type of the same members.
        const base = enumBehindAlias(ast.types, td);
        if (base?.definition.kind === "EnumDefinition") {
          this.enumTypeMembers.set(
            td.name.toUpperCase(),
            new Set(base.definition.members.map((m) => m.name.toUpperCase())),
          );
        }
      }
    }
    this.enumMemberToType = buildEnumMemberMap(enumDescriptors);

    // Register program names as types (CODESYS allows instantiating PROGRAMs like FBs)
    for (const prog of ast.programs) {
      this.knownProgramTypes.add(prog.name.toUpperCase());
    }

    // A user TYPE holding a function block by value is a "late" type. Only a
    // late STRUCT needs the FB class complete at its definition, so only it is
    // sorted and emitted with the FB classes; a late ARRAY or alias is a
    // `using` that instantiates nothing and stays with the other types, where
    // method and interface signatures can name it.
    this.lateTypeNames = typesHoldingFunctionBlocks(ast.types, (name) =>
      this.knownFBTypes.has(name),
    );

    // Topologically sort FBs and late structs once (used in both header and
    // implementation)
    this.sortedHeaderClasses = this.topologicalSortFBs(
      ast.functionBlocks,
      ast.types.filter(
        (t) =>
          t.definition.kind === "StructDefinition" &&
          this.lateTypeNames.has(t.name.toUpperCase()),
      ),
      ast.types,
    );
    this.sortedFBs = this.sortedHeaderClasses.flatMap((node) =>
      node.kind === "functionBlock" ? [node.fb] : [],
    );

    // Generate header
    this.generateHeader(ast);

    // Generate implementation
    this.generateImplementation(ast);

    const eol = this.options.lineEnding;
    // `#line` resets are placeholders until here: each output numbers and
    // names them for itself (a per-TU file is not the concatenated cppCode).
    const cppFiles = Array.from(this.outputFiles.entries()).map(
      ([name, lines]) => ({
        name,
        content: resolveLineResets(lines, name).join(eol),
      }),
    );
    return {
      cppFiles,
      // Legacy concatenation — preserves the historical single-blob
      // shape for callers (CLI single-file output, library compiler,
      // REPL preview, tests) that don't care about per-TU split. The
      // public compile() wrapper exposes this verbatim.
      cppCode: resolveLineResets(
        Array.from(this.outputFiles.values()).flat(),
        this.options.cppFileName ?? "generated.cpp",
      ).join(eol),
      headerCode: resolveLineResets(
        this.headerOutput,
        this.options.headerFileName,
      ).join(eol),
      lineMap: this.lineMap,
      headerLineMap: this.headerLineMap,
      warnings: this.codegenWarnings,
    };
  }

  /**
   * Generate the C++ header file.
   */
  private generateHeader(ast: CompilationUnit): void {
    // Determine the namespace for this project
    const ns = this.projectModel
      ? getProjectNamespace(this.projectModel)
      : "strucpp";

    this.emitHeader("#pragma once");
    this.emitHeader("");
    this.emitHeader(
      "// Generated by STruC++ - IEC 61131-3 Structured Text to C++ Compiler",
    );
    this.emitHeader("// Do not edit this file manually.");
    this.emitHeader("");
    this.emitHeader('#include "iec_types.hpp"');
    this.emitHeader('#include "iec_var.hpp"');
    this.emitHeader('#include "iec_force.hpp"');
    this.emitHeader('#include "iec_global.hpp"');
    this.emitHeader('#include "iec_array.hpp"');
    this.emitHeader('#include "iec_located.hpp"');
    this.emitHeader('#include "iec_std_lib.hpp"');
    this.emitHeader('#include "iec_enum.hpp"');
    this.emitHeader('#include "iec_struct.hpp"');
    this.emitHeader('#include "iec_memory.hpp"');
    this.emitHeader('#include "iec_pointer.hpp"');
    this.emitHeader('#include "iec_string.hpp"');
    this.emitHeader('#include "iec_wstring.hpp"');
    this.emitHeader("#include <array>");
    this.emitHeader("#include <cstddef>");
    this.emitHeader("#include <string>");

    // Undefine C standard-library macros that collide with legal ST identifiers
    // (e.g. OSCAT's T_AVG24 has a local `TMP_MAX`, which <cstdio> #defines).
    // Done after the runtime includes so the runtime still sees the real macros;
    // user code below only ever uses these names as ordinary identifiers.
    this.emitHeader("");
    this.emitHeader(
      "// Avoid clashes between ST identifiers and C stdlib macros",
    );
    for (const m of [
      "TMP_MAX",
      "EOF",
      "BUFSIZ",
      "FOPEN_MAX",
      "FILENAME_MAX",
      "RAND_MAX",
      "EXIT_SUCCESS",
      "EXIT_FAILURE",
    ]) {
      this.emitHeader(`#ifdef ${m}`);
      this.emitHeader(`#undef ${m}`);
      this.emitHeader(`#endif`);
    }

    // Include library headers
    if (this.options.libraryHeaders.length > 0) {
      this.emitHeader("");
      this.emitHeader("// Library headers");
      for (const header of this.options.libraryHeaders) {
        this.emitHeader(`#include "${header}"`);
      }
    }

    // Undefine macros that collide with IEC identifiers.
    //
    // `<math.h>` (transitively included via `<cmath>` in iec_std_lib.hpp)
    // defines `OVERFLOW` as a legacy SVID numeric-error constant on both
    // glibc/macOS and avr-libc. That collides with several OSCAT FB
    // struct fields named OVERFLOW, and the preprocessor expansion would
    // turn those into integer literals before the C++ parser sees them.
    // The architecturally-correct fixes — wrapping in a namespace,
    // renaming the IEC identifier — either don't help (macros expand
    // before scope resolution) or break IEC FB ABI. The `#undef` has
    // zero cost on platforms where the macro isn't defined.
    //
    // (`<avr/io.h>`'s `SP` macro used to need the same treatment, but
    // post the Arduino-glue split no TU that parses `generated.hpp`
    // also pulls in `<avr/io.h>`, so the SP undef was retired.)
    this.emitHeader("");
    this.emitHeader("#undef OVERFLOW");

    // Emit global constants (before namespace, so they work as template parameters)
    const globalConsts = Object.entries(this.options.globalConstants);
    if (globalConsts.length > 0) {
      this.emitHeader("");
      this.emitHeader("// Global constants");
      for (const [name, value] of globalConsts) {
        this.emitHeader(`constexpr size_t ${name} = ${value};`);
      }
    }

    this.emitHeader("");

    // Open namespace
    this.emitHeader(`namespace ${ns} {`);
    this.emitHeader("");

    // If using a custom namespace, import strucpp types
    if (ns !== "strucpp") {
      this.emitHeader("using namespace strucpp;  // Runtime types");
      this.emitHeader("");
    }

    // Forward-declare the POU classes before the user-defined types.
    //
    // A TYPE may name a function block — `AccumGrid : ARRAY[0..1,0..1] OF Accum`
    // emits `using ACCUMGRID = Array2D<ACCUM, …>`, and an alias to a class
    // template needs the argument to at least be declared. An incomplete type is
    // enough here because the alias doesn't instantiate anything; instantiation
    // happens where the alias is used as a member, by which point the full
    // definition has been emitted. Repeated below with the rest of the forward
    // declarations, which is harmless — redundant class declarations are legal.
    this.emitPouForwardDeclarations(ast);

    // A late STRUCT (holding a function block) is defined among the FB classes
    // below; the types, interface and method signatures before it name it, so
    // declare it here.
    const lateStructs = this.sortedHeaderClasses.flatMap((node) =>
      node.kind === "type" ? [node.type.name] : [],
    );
    for (const name of lateStructs) this.emitHeader(`struct ${name};`);
    if (lateStructs.length > 0) this.emitHeader("");

    // Generate user-defined types (Phase 2.2). Late structs wait for the FB
    // classes below; the enum lookups cover all types.
    const typeCodeGen = new TypeCodeGenerator({
      indent: this.options.indent,
      lineEnding: this.options.lineEnding,
      emitChunkMarkers: this.options.emitChunkMarkers ?? false,
      // Struct fields must mangle by the same rule as everything else that
      // names them, and only codegen knows the FB / program type names.
      isUserDefinedType: (t) => this.isUserDefinedType(t),
      shadowingNames: this.shadowingNames(),
      isInterfaceType: (t): boolean => this.isInterfaceType(t),
    });
    if (ast.types.length > 0) {
      const lateStructNames = new Set(lateStructs.map((n) => n.toUpperCase()));
      const typeRegistry = new TypeRegistry();
      typeRegistry.registerTypes(ast.types);
      const ordered = typeRegistry.getTypesInDependencyOrder();
      typeCodeGen.useTypeScope(ordered);
      const typeCode = typeCodeGen.emitTypeDeclarations(
        ordered.filter((t) => !lateStructNames.has(t.name.toUpperCase())),
      );
      if (typeCode.length > 0) {
        for (const line of typeCode.split(this.options.lineEnding)) {
          this.emitHeader(line);
        }
      }
    }

    // Generate top-level global variables (GVL files). One that holds a
    // function block waits for the FB classes and late types below.
    this.emitGvlGlobals(ast, false);

    // Inject reachable library chunks (header side).
    //
    // Per archive: emit `// Library: <name>` header, then `class X;`
    // forward decls for every reachable functionBlock chunk
    // (libraries' FB classes are sometimes mutually-referential and
    // the bodies are emitted in declaration order — the forward
    // decls ahead of any body keep the layout linkable in every
    // ordering). Then emit each reachable chunk's `header` slice in
    // chunk-array order; types come first, FBs next, functions last
    // because that's the order the library compiler emitted them
    // before slicing.
    for (const { archive, reachable } of this.libraryEmissions) {
      const reachableChunks: LibraryChunk[] = [];
      for (const chunk of archive.chunks ?? []) {
        if (chunk.header.length === 0) continue;
        if (reachable.has(chunk.name)) reachableChunks.push(chunk);
      }
      if (reachableChunks.length === 0) continue;

      this.emitHeader(`// Library: ${archive.manifest.name}`);

      for (const chunk of reachableChunks) {
        if (chunk.kind === "functionBlock") {
          this.emitHeader(`class ${chunk.name};`);
        }
      }

      for (const chunk of reachableChunks) {
        for (const line of chunk.header.split("\n")) {
          this.emitHeader(line);
        }
      }

      this.emitHeader("");
    }

    // Generate forward declarations
    this.emitPouForwardDeclarations(ast);

    // Generate interface declarations (before FBs since FBs may implement interfaces)
    for (const iface of ast.interfaces) {
      this.emitHeaderChunkMarker("begin", "type", iface.name);
      this.generateInterfaceHeaderDeclaration(iface);
      this.emitHeaderChunkMarker("end", "type", iface.name);
    }

    // Configuration VAR_GLOBALs as file-scope singletons — emitted before the
    // FB/program classes so their bodies (and FB constructors that bind a
    // VAR_EXTERNAL pointer to a global) can name them.
    this.emitFileScopeGlobals();

    // Generate function block class declarations and late structs
    // (topologically sorted by dependency)
    for (const node of this.sortedHeaderClasses) {
      if (node.kind === "type") {
        const typeCode = typeCodeGen.emitTypeDeclarations([node.type], false);
        for (const line of typeCode.split(this.options.lineEnding)) {
          this.emitHeader(line);
        }
        continue;
      }
      const fb = node.fb;
      this.emitHeaderChunkMarker("begin", "functionBlock", fb.name);
      this.generateFBHeaderDeclaration(fb);
      this.emitHeaderChunkMarker("end", "functionBlock", fb.name);
    }

    // GVL globals that hold a function block, now that its class is complete
    this.emitGvlGlobals(ast, true);
    this.emitFbInitGlobals(ast);

    // Generate program class declarations
    if (this.projectModel) {
      // Use project model for enhanced generation with VAR_EXTERNAL support
      for (const prog of this.projectModel.programs.values()) {
        this.emitHeaderChunkMarker(
          "begin",
          "functionBlock",
          `Program_${prog.name}`,
        );
        this.generateProgramHeaderFromModel(prog);
        this.emitSharedProgramInstance(prog.name, prog.varExternal);
        this.emitHeaderChunkMarker(
          "end",
          "functionBlock",
          `Program_${prog.name}`,
        );
      }
    } else {
      // Fallback to AST-based generation
      for (const prog of ast.programs) {
        this.emitHeaderChunkMarker(
          "begin",
          "functionBlock",
          `Program_${prog.name}`,
        );
        this.generateProgramHeaderDeclaration(prog);
        this.emitSharedProgramInstance(prog.name, []);
        this.emitHeaderChunkMarker(
          "end",
          "functionBlock",
          `Program_${prog.name}`,
        );
      }
    }

    // Generate function declarations
    for (const func of ast.functions) {
      this.emitHeaderChunkMarker("begin", "function", func.name);
      this.generateFunctionHeaderDeclaration(func);
      this.emitHeaderChunkMarker("end", "function", func.name);
    }

    // Generate configuration class declarations
    if (this.projectModel) {
      for (const config of this.projectModel.configurations) {
        this.generateConfigurationHeaderFromModel(config);
      }
    } else {
      for (const config of ast.configurations) {
        this.generateConfigurationHeaderDeclaration(config);
      }
    }

    // Generate located variables descriptor array declaration
    this.generateLocatedVarsDeclaration();

    this.emitHeader(`}  // namespace ${ns}`);
  }

  /**
   * Generate the C++ implementation files.
   *
   * Splits across multiple translation units so the runtime build can
   * run `make -j$(nproc)` and ccache can keep .o files for unchanged
   * POUs across rebuilds:
   *
   *   configuration.cpp     library preambles, located-vars definition,
   *                         configuration glue (must be exactly one TU
   *                         to avoid duplicate symbol errors at link).
   *   pou_<NAME>.cpp        one TU per program / FB / function.
   *
   * All files share `generated.hpp`, so editing a POU's *body* leaves
   * other TUs' preprocessed source unchanged → ccache reuses them.
   * Editing a declaration invalidates the header and forces a full
   * rebuild — same as any C++ project.
   */
  private generateImplementation(ast: CompilationUnit): void {
    // 1. Shared TU: library preambles, located-vars def, configurations.
    //    Anything that must have exactly one definition in the .so
    //    lives here (multiple-TU defs would link-fail with "multiple
    //    definition of …").
    this.startTranslationUnit("configuration.cpp");

    // Inject reachable library chunks (cpp side). Same per-archive
    // iteration order as the header side; only chunks whose `cpp`
    // slice is non-empty get emitted (types and inline globals are
    // header-only).
    for (const { archive, reachable } of this.libraryEmissions) {
      const reachableChunks: LibraryChunk[] = [];
      for (const chunk of archive.chunks ?? []) {
        if (chunk.cpp.length === 0) continue;
        if (reachable.has(chunk.name)) reachableChunks.push(chunk);
      }
      if (reachableChunks.length === 0) continue;

      this.emit(`// Library: ${archive.manifest.name}`);
      for (const chunk of reachableChunks) {
        for (const line of chunk.cpp.split("\n")) {
          this.emit(line);
        }
      }
      this.emit("");
    }

    this.generateLocatedVarsDefinition();

    if (this.projectModel) {
      for (const config of this.projectModel.configurations) {
        this.generateConfigurationImplementationFromModel(config);
      }
    } else {
      for (const config of ast.configurations) {
        this.generateConfigurationImplementation(config);
      }
    }

    this.endTranslationUnit();

    // 2. One TU per program.
    if (this.projectModel) {
      for (const prog of this.projectModel.programs.values()) {
        this.startTranslationUnit(this.pouFileName(prog.name));
        this.emitCppChunkMarker(
          "begin",
          "functionBlock",
          `Program_${prog.name}`,
        );
        this.generateProgramImplementationFromModel(prog);
        this.emitCppChunkMarker("end", "functionBlock", `Program_${prog.name}`);
        this.endTranslationUnit();
      }
    } else {
      for (const prog of ast.programs) {
        this.startTranslationUnit(this.pouFileName(prog.name));
        this.emitCppChunkMarker(
          "begin",
          "functionBlock",
          `Program_${prog.name}`,
        );
        this.generateProgramImplementation(prog);
        this.emitCppChunkMarker("end", "functionBlock", `Program_${prog.name}`);
        this.endTranslationUnit();
      }
    }

    // 3. One TU per function block. Topological order doesn't matter
    //    here (each impl just sees the shared header's full set of
    //    class declarations); ordering only mattered for the header.
    for (const fb of this.sortedFBs) {
      this.startTranslationUnit(this.pouFileName(fb.name));
      this.emitCppChunkMarker("begin", "functionBlock", fb.name);
      this.generateFBImplementation(fb);
      this.emitCppChunkMarker("end", "functionBlock", fb.name);
      this.endTranslationUnit();
    }

    // 4. One TU per function.
    for (const func of ast.functions) {
      this.startTranslationUnit(this.pouFileName(func.name));
      this.emitCppChunkMarker("begin", "function", func.name);
      this.generateFunctionImplementation(func);
      this.emitCppChunkMarker("end", "function", func.name);
      this.endTranslationUnit();
    }
  }

  /**
   * Emit the file-level VAR_GLOBALs (GVL files) as `inline` header objects:
   * those holding a function block by value (`late`: an FB or a late type, or
   * an inline array of one) or the others. A late one needs the FB class
   * complete, so it is emitted after the FB classes and late types.
   */
  private emitGvlGlobals(ast: CompilationUnit, late: boolean): void {
    const holdsFB = (typeRef: TypeReference): boolean =>
      typeNamesHeldByValue(typeRef).some((n) => {
        const upper = n.toUpperCase();
        return this.knownFBTypes.has(upper) || this.lateTypeNames.has(upper);
      });
    // Each global after the globals its initial value names; one that names
    // a late global is late too.
    const { order, dependencies } = orderGlobals(ast);
    const lateNames = new Set<string>();
    for (const item of order) {
      const upper = item.name.toUpperCase();
      if (
        holdsFB(item.decl.type) ||
        (dependencies.get(upper) ?? []).some((d) => lateNames.has(d))
      ) {
        lateNames.add(upper);
      }
    }
    let emittedAny = false;
    for (const { block, decl, name } of order) {
      if (lateNames.has(name.toUpperCase()) !== late) continue;
      const constQualifier = block.isConstant ? "const " : "";
      if (!emittedAny) {
        this.emitHeader("// Global variables");
        emittedAny = true;
      }
      const cppType = this.mapTypeRefToCpp(decl.type);
      // `inline`, not a static-local behind a reference: the debug table takes
      // their address into PROGMEM, which needs a constant.
      this.emitHeaderChunkMarker("begin", "inlineGlobal", name);
      const cppName = globalCppName(name);
      if (decl.initialValue) {
        const initExpr = this.generateInitializer(
          decl.initialValue,
          cppType,
          decl.type.name,
        );
        this.emitHeader(
          `${constQualifier}inline ${cppType} ${cppName} = ${initExpr};`,
        );
      } else {
        this.emitHeader(`inline ${cppType} ${cppName}{};`);
      }
      // List-qualified names of this global (named_global_lists), as references.
      for (const a of decl.listAliases ?? []) {
        if (a.name !== name) continue;
        this.emitHeader(
          `${constQualifier}inline ${cppType}& ${a.alias} = ${cppName};`,
        );
      }
      this.emitHeaderChunkMarker("end", "inlineGlobal", name);
    }
    if (emittedAny) this.emitHeader("");
  }

  /**
   * Collect a function block's VAR_EXTERNAL references to CONFIGURATION
   * VAR_GLOBALs. IEC 61131-3 lets an FB access globals this way; each becomes a
   * `GlobalVar<V>*` bound to the file-scope canonical.
   *
   * References to a **file-level** VAR_GLOBAL are excluded: that storage is a
   * plain file-scope object the FB body already reaches by name, so it needs no
   * pointer member — and adding one would shadow the global it references. Same
   * rule the project model applies to PROGRAMs (see `addVarExternal`).
   */
  private collectFBExternals(
    fb: CompilationUnit["functionBlocks"][0],
  ): Array<{ name: string; typeName: string; cppType: string }> {
    const fileScopeGlobals = this.fileScopeGlobalNames();
    const externals: Array<{
      name: string;
      typeName: string;
      cppType: string;
    }> = [];
    for (const block of fb.varBlocks) {
      if (block.blockType !== "VAR_EXTERNAL") continue;
      for (const decl of block.declarations) {
        const cppType = this.mapTypeRefToCpp(decl.type);
        for (const name of decl.names) {
          if (fileScopeGlobals.has(name.toUpperCase())) continue;
          externals.push({ name, typeName: decl.type.name, cppType });
        }
      }
    }
    return externals;
  }

  /** Upper-case names of the compilation unit's file-level VAR_GLOBALs. */
  private fileScopeGlobalNames(): Set<string> {
    if (!this.fileScopeGlobalNameCache) {
      this.fileScopeGlobalNameCache = this.ast
        ? new Set(collectFileScopeGlobals(this.ast).keys())
        : new Set<string>();
    }
    return this.fileScopeGlobalNameCache;
  }

  /**
   * Generate header declaration for a function block.
   */
  private generateFBHeaderDeclaration(
    fb: CompilationUnit["functionBlocks"][0],
  ): void {
    // Populate interface method names for variable/method collision detection
    this.currentFBInterfaceMethods = this.getInterfaceMethodNames(fb);

    // Build inheritance clause
    const bases: string[] = [];
    if (fb.extends) {
      bases.push(`public ${fb.extends}`);
    }
    if (fb.implements) {
      for (const iface of fb.implements) {
        bases.push(this.interfaceBaseSpec(iface));
      }
    }
    const inheritance = bases.length > 0 ? ` : ${bases.join(", ")}` : "";
    const finalSpec = fb.isFinal ? " final" : "";

    this.emitHeaderLineDirective(fb.sourceSpan.startLine);
    const classLine = this.currentHeaderLine;
    this.emitHeader(`class ${fb.name}${finalSpec}${inheritance} {`);
    this.emitHeader("public:");
    this.recordHeaderLineMapping(fb.sourceSpan.startLine, classLine);

    // Member names in this FB — used to detect a member that shadows the type
    // of a sibling member (e.g. F_LAMP has both `ONTIME : UDINT` and
    // `RUNTIME : ONTIME`, where the FB type ONTIME also exists). C++ member
    // lookup would resolve the bare type name to the data member, so such a
    // member declaration needs an elaborated `class`/`struct` specifier.
    const fbMemberNames = new Set<string>();
    for (const block of fb.varBlocks) {
      for (const decl of block.declarations) {
        for (const n of decl.names) fbMemberNames.add(n.toUpperCase());
      }
    }

    // Generate member variables
    for (const block of fb.varBlocks) {
      // VAR_EXTERNAL is a reference to a configuration global, not a member of
      // the FB — emitted below as a GlobalVar<V>* pointing at the file-scope
      // canonical (mirrors the PROGRAM path). Handling it here as a plain member
      // would give the FB a private copy that never touches the shared global.
      if (block.blockType === "VAR_EXTERNAL") continue;

      const comment =
        block.blockType === "VAR_INPUT"
          ? "// Inputs"
          : block.blockType === "VAR_OUTPUT"
            ? "// Outputs"
            : block.blockType === "VAR_IN_OUT"
              ? "// In-Out"
              : "// Local variables";

      this.emitHeader(`    ${comment}`);
      for (const decl of block.declarations) {
        const tag = this.elaboratedTagIfShadowed(decl.type.name, fbMemberNames);
        // A by-reference VAR_IN_OUT holds the caller's variable (IEC_INOUT).
        const cppType =
          block.blockType === "VAR_IN_OUT" &&
          this.inOutTypeKind(decl.type) === "ref"
            ? `IEC_INOUT<${tag}${this.mapTypeRefToCpp(decl.type)}>`
            : `${tag}${this.mapTypeRefToCpp(decl.type)}`;
        for (const name of decl.names) {
          const memberName = this.mangleMemberIfNeeded(name, decl.type.name);
          this.emitHeaderLineDirective(decl.sourceSpan.startLine);
          const memberLine = this.currentHeaderLine;
          const init =
            block.blockType === "VAR_IN_OUT"
              ? ""
              : this.scalarTypeInit(decl.type);
          this.emitHeader(`    ${cppType} ${memberName}${init};`);
          this.recordHeaderLineMapping(decl.sourceSpan.startLine, memberLine);
        }
      }
    }

    // VAR_EXTERNAL members: a pointer to the file-scope canonical GlobalVar<V>
    // (same shape a PROGRAM uses). Bound in the constructor to &<ns>::<name>.
    const fbExternals = this.collectFBExternals(fb);
    if (fbExternals.length > 0) {
      this.emitHeader("    // External variables (pointers to shared globals)");
      for (const ext of fbExternals) {
        this.emitHeader(
          `    GlobalVar<${ext.cppType}>* ${ext.name} = nullptr;`,
        );
      }
    }

    // Generate VAR_INST mangled members from methods
    const varInstMembers = this.collectVarInstMembers(fb);
    if (varInstMembers.length > 0) {
      this.emitHeader("");
      this.emitHeader("    // Method instance variables (VAR_INST)");
      for (const m of varInstMembers) {
        this.emitHeader(`    ${m.cppType} ${m.mangledName};`);
      }
    }

    // IEC 61131-3 implicit ENO output. Mirrors EN at every call site, so
    // user code that does `IF inst.ENO THEN ...` after invoking the FB
    // resolves. Default is true so FBs invoked without an EN pin see ENO=1
    // (matches the standard: ENO defaults to TRUE when EN is omitted).
    // Only emitted on the leaf FB; if it extends another FB, the parent
    // already provides ENO.
    if (!fb.extends && this.declaredEnoType(fb.name) === undefined) {
      this.emitHeader("");
      this.emitHeader("    // Implicit IEC 61131-3 ENO pin (mirrors EN)");
      this.emitHeader("    IEC_BOOL ENO = true;");
    }

    this.emitHeader("");
    this.emitHeader("    // Constructor");
    this.emitHeader(`    ${fb.name}();`);
    this.emitHeader("");
    this.emitHeader("    // Execute function block");
    this.emitHeader("    void operator()();");

    // Generate method declarations (grouped by visibility)
    if (fb.methods.length > 0) {
      this.emitHeader("");
      this.generateMethodDeclarations(fb.methods);
    }

    // Generate property declarations
    if (fb.properties.length > 0) {
      this.emitHeader("");
      this.generatePropertyDeclarations(fb.properties);
    }

    this.emitInheritedInterfaceOverrides(fb);

    if (this.fbInitPlan?.needsMembers(fb) === true) {
      this.emitHeader("");
      this.emitHeader("    // Start-up FB_init of the member instances");
      this.emitHeader(
        `    void __fb_init_members(${this.fbInitMembersParams(fb)});`,
      );
    }

    // Virtual destructor (needed for classes with virtual methods)
    if (fb.methods.length > 0 || fb.properties.length > 0 || !fb.isFinal) {
      this.emitHeader("");
      this.emitHeader(`    virtual ~${fb.name}() = default;`);
    }

    // Test build: add mock infrastructure
    if (this.options.isTestBuild) {
      this.emitHeader("");
      this.emitHeader("    // Test mock infrastructure");
      this.emitHeader("    bool __mocked_ = false;");
      this.emitHeader("    struct { int call_count = 0; } __mock_state_;");
    }

    this.emitHeader("};");
    this.emitHeaderLineReset();
    this.emitHeader("");
  }

  /**
   * Interface methods and property accessors an FB provides only through a
   * base FB that does not implement that interface: C++ needs an override in
   * this class, which calls the base's.
   */
  private emitInheritedInterfaceOverrides(
    fb: CompilationUnit["functionBlocks"][number],
  ): void {
    const ast = this.ast;
    if (!ast || !fb.implements || fb.isAbstract) return;
    const fbNamed = (
      name: string | undefined,
    ): CompilationUnit["functionBlocks"][number] | undefined =>
      name === undefined
        ? undefined
        : ast.functionBlocks.find(
            (f) => f.name.toUpperCase() === name.toUpperCase(),
          );
    const ancestors: CompilationUnit["functionBlocks"] = [];
    for (
      let a = fbNamed(fb.extends);
      a !== undefined && !ancestors.includes(a) && a !== fb;
      a = fbNamed(a.extends)
    ) {
      ancestors.push(a);
    }
    if (ancestors.length === 0) return;
    // Interfaces reached from IMPLEMENTS lists, with their EXTENDS bases
    const reach = (roots: readonly string[]): Set<string> => {
      const out = new Set<string>();
      const visit = (name: string): void => {
        const upper = name.toUpperCase();
        if (out.has(upper)) return;
        out.add(upper);
        const iface = ast.interfaces.find(
          (i) => i.name.toUpperCase() === upper,
        );
        for (const base of iface?.extends ?? []) visit(base);
      };
      roots.forEach(visit);
      return out;
    };
    const inherited = reach(ancestors.flatMap((a) => a.implements ?? []));
    const lines: string[] = [];
    const done = new Set<string>();
    for (const ifaceName of reach(fb.implements)) {
      if (inherited.has(ifaceName)) continue;
      const iface = ast.interfaces.find(
        (i) => i.name.toUpperCase() === ifaceName,
      );
      if (!iface) continue;
      for (const m of iface.methods) {
        const key = m.name.toUpperCase();
        if (done.has(key)) continue;
        if (fb.methods.some((x) => x.name.toUpperCase() === key)) continue;
        for (const a of ancestors) {
          const base = a.methods.find(
            (x) => x.name.toUpperCase() === key && x.fromAction !== true,
          );
          if (!base) continue;
          if (!base.isAbstract && !base.isFinal) {
            done.add(key);
            lines.push(this.forwardingMethod(base, a.name));
          }
          break;
        }
      }
      for (const p of iface.properties) {
        const key = `.${p.name.toUpperCase()}`;
        if (done.has(key)) continue;
        if (fb.properties.some((x) => `.${x.name.toUpperCase()}` === key)) {
          continue;
        }
        const owner = ancestors.find((a) =>
          a.properties.some((x) => `.${x.name.toUpperCase()}` === key),
        );
        const base = owner?.properties.find(
          (x) => `.${x.name.toUpperCase()}` === key,
        );
        if (!owner || !base) continue;
        done.add(key);
        const type = this.mapTypeRefToCpp(base.type);
        if (p.getter && base.getter) {
          lines.push(
            `    ${type} get_${base.name}() const override { return ${owner.name}::get_${base.name}(); }`,
          );
        }
        if (p.setter && base.setter) {
          lines.push(
            `    void set_${base.name}(${type} ${base.name}) override { ${owner.name}::set_${base.name}(${base.name}); }`,
          );
        }
      }
    }
    if (lines.length === 0) return;
    this.emitHeader("");
    this.emitHeader("    // Interface members provided by a base FB");
    for (const line of lines) this.emitHeader(line);
  }

  /** An inline override of `method` that calls the one `owner` declares. */
  private forwardingMethod(method: MethodDeclaration, owner: string): string {
    const isIfaceReturn =
      method.returnType !== undefined &&
      this.isInterfaceType(method.returnType.name);
    const returnType = method.returnType
      ? isIfaceReturn
        ? `${this.inOutParamType(method.returnType)}&`
        : this.mapTypeRefToCpp(method.returnType)
      : "void";
    const args = method.varBlocks
      .filter(
        (b) =>
          b.blockType === "VAR_INPUT" ||
          b.blockType === "VAR_IN_OUT" ||
          b.blockType === "VAR_OUTPUT",
      )
      .flatMap((b) => b.declarations.flatMap((d) => d.names));
    return `    ${returnType} ${method.name}(${this.generateMethodParamList(method)}) override { return ${owner}::${method.name}(${args.join(", ")}); }`;
  }

  /**
   * Generate header declaration for a program.
   */
  private generateProgramHeaderDeclaration(
    prog: CompilationUnit["programs"][0],
  ): void {
    this.emitHeaderLineDirective(prog.sourceSpan.startLine);
    const classLine = this.currentHeaderLine;
    this.emitHeader(`class Program_${prog.name} : public ProgramBase {`);
    this.emitHeader("public:");
    this.recordHeaderLineMapping(prog.sourceSpan.startLine, classLine);

    // Generate member variables and collect located variables
    for (const block of prog.varBlocks) {
      for (const decl of block.declarations) {
        const cppType = this.mapTypeRefToCpp(decl.type);
        for (const name of decl.names) {
          const memberName = this.mangleMemberIfNeeded(name, decl.type.name);
          this.emitHeaderLineDirective(decl.sourceSpan.startLine);
          const memberLine = this.currentHeaderLine;
          const init =
            block.blockType === "VAR_IN_OUT"
              ? ""
              : this.scalarTypeInit(decl.type);
          if (decl.address) {
            // Generate variable with optional address comment
            this.emitHeader(
              `    ${cppType} ${memberName}${init};  // AT ${decl.address}`,
            );
            // Collect located variable info
            this.collectLocatedVar(name, decl, prog.name);
          } else {
            this.emitHeader(`    ${cppType} ${memberName}${init};`);
          }
          this.recordHeaderLineMapping(decl.sourceSpan.startLine, memberLine);
        }
      }
    }

    this.emitProgramVarInstMembers(prog.methods);

    this.emitHeader("");
    // Implicit IEC 61131-3 ENO pin. Mirrors EN at every call site, so
    // user code that does `IF prog.ENO THEN ...` after invoking the
    // program (or the test framework that wraps a program as a UUT and
    // invokes it like an FB) resolves. Default true matches the
    // standard's "ENO defaults to TRUE when EN is omitted".
    if (this.declaredEnoType(prog.name) === undefined) {
      this.emitHeader("    // Implicit IEC 61131-3 ENO pin (mirrors EN)");
      this.emitHeader("    IEC_BOOL ENO = true;");
      this.emitHeader("");
    }
    this.emitHeader("    // Constructor");
    this.emitHeader(`    Program_${prog.name}();`);
    this.emitHeader("");
    this.emitHeader("    // Run program");
    this.emitHeader("    void run() override;");
    this.emitProgramMethodDeclarations(prog.methods);
    this.emitHeader("};");
    this.emitHeaderLineReset();
    this.emitHeader("");
  }

  /**
   * VAR_INST storage of a PROGRAM's methods (feature program_methods), as
   * mangled data members, like an FB's.
   */
  private emitProgramVarInstMembers(methods: MethodDeclaration[]): void {
    const varInstMembers = this.collectVarInstMembers({ methods });
    if (varInstMembers.length === 0) return;
    this.emitHeader("    // Method instance variables (VAR_INST)");
    for (const m of varInstMembers) {
      this.emitHeader(`    ${m.cppType} ${m.mangledName};`);
    }
  }

  /**
   * A PROGRAM's methods (feature program_methods), declared last in the class,
   * after the ProgramBase overrides. They are non-virtual (D7): a program has
   * no inheritance, so nothing dispatches on them, and the class's vtable
   * stays exactly as for a program without methods.
   */
  private emitProgramMethodDeclarations(methods: MethodDeclaration[]): void {
    if (methods.length === 0) return;
    this.emitHeader("");
    this.emitHeader("    // Methods");
    this.generateMethodDeclarations(methods, true);
  }

  /**
   * Generate header declaration for a function.
   */
  private generateFunctionHeaderDeclaration(
    func: CompilationUnit["functions"][0],
  ): void {
    const params = this.generateFunctionParams(func);

    this.emitHeaderLineDirective(func.sourceSpan.startLine);
    const declLine = this.currentHeaderLine;
    this.emitHeader(
      `${this.mapTypeRefToCpp(func.returnType)} ${func.name}(${params.join(", ")});`,
    );
    this.recordHeaderLineMapping(func.sourceSpan.startLine, declLine);
    this.emitHeaderLineReset();
  }

  /**
   * Generate function parameter list including VAR_INPUT and VAR_IN_OUT.
   * VAR_IN_OUT parameters are passed by reference.
   * VLA types use ArrayView instead of IECVar reference.
   */
  protected generateFunctionParams(
    func: CompilationUnit["functions"][0],
  ): string[] {
    const params: string[] = [];
    for (const block of func.varBlocks) {
      if (block.blockType === "VAR_INPUT") {
        for (const decl of block.declarations) {
          for (const name of decl.names) {
            params.push(`${this.mapTypeRefToCpp(decl.type)} ${name}`);
          }
        }
      } else if (block.blockType === "VAR_IN_OUT") {
        for (const decl of block.declarations) {
          for (const name of decl.names) {
            // VLA types (ArrayView) are already reference-like; others need &
            if (decl.type.name.startsWith("__VLA_")) {
              params.push(`${this.mapTypeRefToCpp(decl.type)} ${name}`);
            } else {
              // A STRING(n) keeps its length: the argument binds when it has it.
              params.push(`${this.inOutParamType(decl.type)}& ${name}`);
            }
          }
        }
      } else if (block.blockType === "VAR_OUTPUT") {
        for (const decl of block.declarations) {
          for (const name of decl.names) {
            // Same metadata-aware lookup as VAR_IN_OUT — see the comment above.
            params.push(
              `${this.mapTypeRefToCpp(this.byRefParamTypeRef(decl.type))}& ${name}`,
            );
          }
        }
      }
    }
    return params;
  }

  // ===========================================================================
  // OOP Code Generation (Phase 5.2)
  // ===========================================================================

  /**
   * Generate header declaration for an interface.
   * Interfaces become abstract classes with pure virtual methods.
   */
  private generateInterfaceHeaderDeclaration(
    iface: InterfaceDeclaration,
  ): void {
    const extendsClause =
      iface.extends && iface.extends.length > 0
        ? ` : ${iface.extends.map((e) => this.interfaceBaseSpec(e)).join(", ")}`
        : "";

    this.emitHeaderLineDirective(iface.sourceSpan.startLine);
    const classLine = this.currentHeaderLine;
    this.emitHeader(`class ${iface.name}${extendsClause} {`);
    this.emitHeader("public:");
    this.emitHeader(`    virtual ~${iface.name}() = default;`);
    this.recordHeaderLineMapping(iface.sourceSpan.startLine, classLine);

    for (const method of iface.methods) {
      const isIfaceReturn =
        method.returnType && this.isInterfaceType(method.returnType.name);
      const returnType = method.returnType
        ? isIfaceReturn
          ? `${this.inOutParamType(method.returnType)}&`
          : this.mapTypeRefToCpp(method.returnType)
        : "void";
      const params = this.generateMethodParamList(method);
      if (method.sourceSpan) {
        this.emitHeaderLineDirective(method.sourceSpan.startLine);
        const methodLine = this.currentHeaderLine;
        this.emitHeader(
          `    virtual ${returnType} ${method.name}(${params}) = 0;`,
        );
        this.recordHeaderLineMapping(method.sourceSpan.startLine, methodLine);
      } else {
        this.emitHeader(
          `    virtual ${returnType} ${method.name}(${params}) = 0;`,
        );
      }
    }

    // Property prototypes: pure virtual accessors an implementing FB overrides
    for (const prop of iface.properties) {
      const type = this.mapTypeRefToCpp(prop.type);
      this.emitHeaderLineDirective(prop.sourceSpan.startLine);
      const propLine = this.currentHeaderLine;
      if (prop.getter) {
        this.emitHeader(`    virtual ${type} get_${prop.name}() const = 0;`);
      }
      if (prop.setter) {
        this.emitHeader(
          `    virtual void set_${prop.name}(${type} ${prop.name}) = 0;`,
        );
      }
      this.recordHeaderLineMapping(prop.sourceSpan.startLine, propLine);
    }

    this.emitHeader("};");
    this.emitHeaderLineReset();
    this.emitHeader("");
  }

  /**
   * Properties an interface declares, its own first, then each EXTENDS
   * base's (nearest wins).
   */
  private interfacePropertiesOf(
    name: string,
    ast: CompilationUnit,
  ): PropertyDeclaration[] {
    const found = new Map<string, PropertyDeclaration>();
    const visited = new Set<string>();
    const visit = (ifaceName: string): void => {
      const upper = ifaceName.toUpperCase();
      if (visited.has(upper)) return;
      visited.add(upper);
      const iface = ast.interfaces.find((i) => i.name.toUpperCase() === upper);
      if (!iface) return;
      for (const p of iface.properties) {
        const key = p.name.toUpperCase();
        if (!found.has(key)) found.set(key, p);
      }
      for (const base of iface.extends ?? []) visit(base);
    };
    visit(name);
    return [...found.values()];
  }

  /**
   * `obj.get_P()` on the instance `obj` designates: through an interface
   * variable, on the instance it refers to.
   */
  private propertyRead(
    objectCode: string,
    ownerType: string | undefined,
    propName: string,
  ): string {
    return ownerType !== undefined && this.isInterfaceType(ownerType)
      ? `itf_ref(${objectCode}).get_${propName}()`
      : `${objectCode}.get_${propName}()`;
  }

  /**
   * Collect VAR_INST members from all methods of a function block or program.
   * These become name-mangled class members: __MethodName__varName
   */
  private collectVarInstMembers(fb: {
    methods: MethodDeclaration[];
  }): Array<{ mangledName: string; cppType: string }> {
    const result: Array<{ mangledName: string; cppType: string }> = [];
    for (const method of fb.methods) {
      for (const block of method.varBlocks) {
        if (block.blockType === "VAR_INST") {
          for (const decl of block.declarations) {
            for (const name of decl.names) {
              result.push({
                mangledName: `__${method.name}__${name}`,
                cppType: this.mapTypeRefToCpp(decl.type),
              });
            }
          }
        }
      }
    }
    return result;
  }

  /**
   * Generate method declarations in the class header, grouped by visibility.
   * A PROGRAM's methods pass `nonVirtual`: plain members, so the program
   * class's vtable (the ProgramBase overrides) stays as it is (the analyzer
   * refuses ABSTRACT and OVERRIDE on them; FINAL needs no specifier).
   */
  private generateMethodDeclarations(
    methods: MethodDeclaration[],
    nonVirtual = false,
  ): void {
    // Group by visibility
    const groups: Record<Visibility, MethodDeclaration[]> = {
      PUBLIC: [],
      PRIVATE: [],
      PROTECTED: [],
    };
    for (const method of methods) {
      groups[method.visibility].push(method);
    }

    // Track current visibility section (class starts as public:)
    let currentVisibility = "public";

    for (const [visibility, visMethods] of Object.entries(groups) as [
      Visibility,
      MethodDeclaration[],
    ][]) {
      if (visMethods.length === 0) continue;

      const cppVisibility = visibility.toLowerCase();
      if (cppVisibility !== currentVisibility) {
        this.emitHeader(`${cppVisibility}:`);
        currentVisibility = cppVisibility;
      }

      for (const method of visMethods) {
        const isIfaceReturn =
          method.returnType && this.isInterfaceType(method.returnType.name);
        const returnType = method.returnType
          ? isIfaceReturn
            ? `${this.inOutParamType(method.returnType)}&`
            : this.mapTypeRefToCpp(method.returnType)
          : "void";
        const params = this.generateMethodParamList(method);

        // Build declaration with appropriate specifiers
        let prefix: string;
        let suffix: string;

        if (nonVirtual) {
          prefix = "";
          suffix = "";
        } else if (method.isAbstract) {
          prefix = "virtual ";
          suffix = " = 0";
        } else if (method.isOverride) {
          prefix = "";
          suffix = " override";
          if (method.isFinal) suffix += " final";
        } else {
          prefix = "virtual ";
          suffix = method.isFinal ? " final" : "";
        }

        this.emitHeaderLineDirective(method.sourceSpan.startLine);
        const methodLine = this.currentHeaderLine;
        this.emitHeader(
          `    ${prefix}${returnType} ${method.name}(${params})${suffix};`,
        );
        this.recordHeaderLineMapping(method.sourceSpan.startLine, methodLine);
      }
    }

    // Restore public section if we changed it (for destructor etc.)
    if (currentVisibility !== "public") {
      this.emitHeader("public:");
    }
  }

  /**
   * Generate parameter list string for a method declaration.
   * VAR_INPUT, VAR_OUTPUT (by ref), VAR_IN_OUT (by ref) become C++ params.
   */
  private generateMethodParamList(method: MethodDeclaration): string {
    const params: string[] = [];
    for (const block of method.varBlocks) {
      if (block.blockType === "VAR_INPUT") {
        for (const decl of block.declarations) {
          for (const name of decl.names) {
            params.push(`${this.mapTypeRefToCpp(decl.type)} ${name}`);
          }
        }
      } else if (block.blockType === "VAR_IN_OUT") {
        for (const decl of block.declarations) {
          for (const name of decl.names) {
            // A STRING(n) keeps its length: the argument binds when it has it.
            params.push(`${this.inOutParamType(decl.type)}& ${name}`);
          }
        }
      } else if (block.blockType === "VAR_OUTPUT") {
        for (const decl of block.declarations) {
          for (const name of decl.names) {
            params.push(
              `${this.mapTypeRefToCpp(this.byRefParamTypeRef(decl.type))}& ${name}`,
            );
          }
        }
      }
    }
    return params.join(", ");
  }

  /**
   * Generate property getter/setter declarations in the class header.
   */
  private generatePropertyDeclarations(
    properties: PropertyDeclaration[],
  ): void {
    this.emitHeader("    // Properties");
    for (const prop of properties) {
      const type = this.mapTypeRefToCpp(prop.type);
      this.emitHeaderLineDirective(prop.sourceSpan.startLine);
      const propLine = this.currentHeaderLine;
      if (prop.getter) {
        this.emitHeader(`    virtual ${type} get_${prop.name}() const;`);
      }
      if (prop.setter) {
        this.emitHeader(
          `    virtual void set_${prop.name}(${type} ${prop.name});`,
        );
      }
      this.recordHeaderLineMapping(prop.sourceSpan.startLine, propLine);
    }
  }

  /**
   * Generate implementation for a method (in the .cpp file).
   * Follows the same return-variable pattern as functions.
   */
  private generateMethodImplementation(
    method: MethodDeclaration,
    className: string,
  ): void {
    const isIfaceReturn =
      method.returnType && this.isInterfaceType(method.returnType.name);
    const returnType = method.returnType
      ? isIfaceReturn
        ? `${this.inOutParamType(method.returnType)}&`
        : this.mapTypeRefToCpp(method.returnType)
      : "void";
    const params = this.generateMethodParamList(method);

    this.emitLineDirective(method.sourceSpan.startLine);
    const implLine = this.currentLine;
    this.emit(`${returnType} ${className}::${method.name}(${params}) {`);

    // Declare return variable if method has return type
    if (method.returnType) {
      if (isIfaceReturn) {
        // Interface return: assignments to result become return statements
        this.interfaceReturnMethod = true;
      } else {
        this.emit(
          `    ${this.mapTypeRefToCpp(method.returnType)} ${method.name}_result;`,
        );
      }
      this.currentFunctionName = method.name;
    }

    // Set up VAR_INST name mangling
    this.varInstMangledNames.clear();
    for (const block of method.varBlocks) {
      if (block.blockType === "VAR_INST") {
        for (const decl of block.declarations) {
          for (const name of decl.names) {
            this.varInstMangledNames.set(
              name.toUpperCase(),
              `__${method.name}__${name}`,
            );
          }
        }
      }
    }

    // Merge FB scope + method scope so FB member types are visible (same pattern as properties)
    this.enterScope(
      [...this.currentFBVarBlocks, ...method.varBlocks],
      method.varBlocks,
    );

    // Declare local variables (VAR, VAR_TEMP)
    for (const block of method.varBlocks) {
      if (block.blockType === "VAR" || block.blockType === "VAR_TEMP") {
        for (const decl of block.declarations) {
          for (const name of decl.names) {
            const cppType = this.mapTypeRefToCpp(decl.type);
            const initValue = decl.initialValue
              ? ` = ${this.generateInitializer(decl.initialValue, cppType, decl.type.name)}`
              : this.scalarTypeInit(decl.type);
            this.emit(`    ${cppType} ${this.localCppName(name)}${initValue};`);
          }
        }
      }
    }

    // Generate body
    if (method.body.length > 0) {
      this.generateStatements(method.body);
    }

    // Return if method has return type
    if (method.returnType) {
      if (!isIfaceReturn) {
        this.emit(`    return ${method.name}_result;`);
      }
      this.currentFunctionName = undefined;
      this.interfaceReturnMethod = false;
    }

    // Clean up
    this.exitScope();
    this.varInstMangledNames.clear();

    this.emitLineDirective(method.sourceSpan.endLine);
    this.emit("}");
    this.emitLineReset();
    this.emit("");
    this.recordLineMapping(method.sourceSpan.startLine, implLine);
  }

  /**
   * Generate implementation for a property (getter and/or setter in the .cpp file).
   */
  private generatePropertyImplementation(
    prop: PropertyDeclaration,
    className: string,
  ): void {
    const type = this.mapTypeRefToCpp(prop.type);

    // Getter
    if (prop.getter) {
      this.emitLineDirective(prop.sourceSpan.startLine);
      const getterLine = this.currentLine;
      this.emit(`${type} ${className}::get_${prop.name}() const {`);
      this.emit(`    ${type} ${prop.name}_result;`);
      this.currentFunctionName = prop.name;
      if (prop.getterMethod !== undefined) {
        // The body declares locals, so it is a method: the getter is const
        // to be readable through a const instance, the method is not.
        this.emit(
          `    const_cast<${className}*>(this)->${prop.getterMethod}(${prop.name}_result);`,
        );
      }
      this.generateStatements(prop.getter);
      this.emit(`    return ${prop.name}_result;`);
      this.currentFunctionName = undefined;
      this.emit("}");
      this.emitLineReset();
      this.emit("");
      this.recordLineMapping(prop.sourceSpan.startLine, getterLine);
    }

    // Setter
    if (prop.setter) {
      this.emitLineDirective(prop.sourceSpan.startLine);
      const setterLine = this.currentLine;
      this.emit(`void ${className}::set_${prop.name}(${type} ${prop.name}) {`);
      // In setter, prop.name refers to the input parameter (no redirection)
      this.currentSetterProperty = prop.name.toUpperCase();
      if (prop.setterMethod !== undefined) {
        this.emit(`    ${prop.setterMethod}(${prop.name});`);
      }
      this.generateStatements(prop.setter);
      this.currentSetterProperty = undefined;
      this.emit("}");
      this.emitLineReset();
      this.emit("");
      this.recordLineMapping(prop.sourceSpan.startLine, setterLine);
    }
  }

  /**
   * Generate implementation for a program.
   */
  private generateProgramImplementation(
    prog: CompilationUnit["programs"][0],
  ): void {
    // Constructor
    this.emit(`Program_${prog.name}::Program_${prog.name}() {`);
    this.emit("    // Initialize variables");
    for (const block of prog.varBlocks) {
      for (const decl of block.declarations) {
        if (decl.initialValue !== undefined) {
          const initExpr = this.generateInitializer(
            decl.initialValue,
            this.mapTypeRefToCpp(decl.type),
            decl.type.name,
          );
          for (const name of decl.names) {
            this.emit(`    ${name} = ${initExpr};`);
          }
        }
      }
    }

    // Initialize located variable pointers
    this.generateLocatedVarPointerInit(prog.name);

    this.emit("}");
    this.emit("");
    // PROGRAM line now maps to header class declaration, not constructor

    // Run method
    this.emit(`void Program_${prog.name}::run() {`);
    this.emitForceScope();
    this.currentProgramName = prog.name;
    this.enterScope(prog.varBlocks);
    if (prog.body.length > 0) {
      // Generate statements (Phase 2.8: only ExternalCodePragma; Phase 3+: all statements)
      this.generateStatements(prog.body);
    } else if (this.options.sourceComments) {
      this.emit("    // Empty program body");
    }
    this.exitScope();
    this.currentProgramName = undefined;
    this.emitLineDirective(prog.sourceSpan.endLine);
    const closingBraceLine = this.currentLine;
    this.emit("}");
    this.emitLineReset();
    this.emit("");
    this.recordLineMapping(prog.sourceSpan.endLine, closingBraceLine);

    // This path rewrites no VAR_EXTERNAL in run(), so neither in the methods.
    this.generateProgramMethodImplementations(prog, []);
  }

  /**
   * Implementations of a PROGRAM's methods (feature program_methods), after
   * run(), as members of `Program_<NAME>`.
   *
   * generateMethodImplementation resolves names through the FB-scope fields
   * (currentFBVarBlocks, currentFBName, ...), which an FB sets for its own
   * methods and clears at its end. A program sets them to itself here: its
   * VARs, no base, no interfaces, and the same VAR_EXTERNAL rewriting as its
   * run() (`externals`), then clears them the same way an FB does.
   */
  private generateProgramMethodImplementations(
    prog: CompilationUnit["programs"][0],
    externals: ReadonlyArray<{ name: string; typeName: string }>,
  ): void {
    if (prog.methods.length === 0) return;
    this.currentFBName = prog.name;
    this.currentFBExtends = undefined;
    this.currentFBVarBlocks = prog.varBlocks;
    this.currentFBInterfaceMethods = new Set();
    this.currentProgramName = prog.name;
    this.programExternals = new Set(
      externals.map((ext) => ext.name.toUpperCase()),
    );
    this.compositeExternals = new Set(
      externals
        .filter((ext) => !isElementaryType(ext.typeName))
        .map((ext) => ext.name.toUpperCase()),
    );

    for (const method of prog.methods) {
      this.generateMethodImplementation(method, `Program_${prog.name}`);
    }

    this.currentFBName = undefined;
    this.currentFBExtends = undefined;
    this.currentFBVarBlocks = [];
    this.currentFBInterfaceMethods = new Set();
    this.currentProgramName = undefined;
    this.programExternals = new Set();
    this.compositeExternals = new Set();
  }

  /**
   * Generate implementation for a function block.
   */
  private generateFBImplementation(
    fb: CompilationUnit["functionBlocks"][0],
  ): void {
    this.currentFBName = fb.name;
    this.currentFBExtends = fb.extends;
    this.currentFBVarBlocks = fb.varBlocks;
    this.currentFBInterfaceMethods = this.getInterfaceMethodNames(fb);

    // VAR_EXTERNAL: body access (operator(), methods, properties) is rewritten
    // to go through the GlobalVar pointer (g->read()/write()/with_lock), exactly
    // like a PROGRAM. Set for the whole implementation, cleared at the end.
    const externalDecls = this.collectFBExternals(fb);
    this.programExternals = new Set(
      externalDecls.map((e) => e.name.toUpperCase()),
    );
    this.compositeExternals = new Set(
      externalDecls
        .filter((e) => !isElementaryType(e.typeName))
        .map((e) => e.name.toUpperCase()),
    );

    // Constructor with initializer list for variables with defaults
    const fbInits: string[] = [];
    // Bind each VAR_EXTERNAL pointer to the file-scope canonical global. The
    // namespace qualifier disambiguates the global from the same-named pointer
    // member being initialized. File-scope visibility means this works no
    // matter how deeply the FB is instantiated — no pointer threading.
    if (externalDecls.length > 0) {
      const ns = this.projectModel
        ? getProjectNamespace(this.projectModel)
        : "strucpp";
      for (const e of externalDecls) {
        fbInits.push(`${e.name}(&${ns}::${globalCppName(e.name)})`);
      }
    }
    for (const block of fb.varBlocks) {
      // An in-out refers to the caller's variable: nothing to initialise.
      if (
        block.blockType === "VAR_EXTERNAL" ||
        block.blockType === "VAR_IN_OUT"
      )
        continue;
      for (const decl of block.declarations) {
        if (decl.initialValue) {
          const cppType = this.mapTypeRefToCpp(decl.type);
          const initExpr = this.generateInitializer(
            decl.initialValue,
            cppType,
            decl.type.name,
          );
          for (const name of decl.names) {
            const memberName = this.mangleMemberIfNeeded(name, decl.type.name);
            fbInits.push(`${memberName}(${initExpr})`);
          }
        }
      }
    }
    if (fbInits.length > 0) {
      this.emit(`${fb.name}::${fb.name}()`);
      this.emit(`    : ${fbInits.join(", ")}`);
      this.emit("{");
    } else {
      this.emit(`${fb.name}::${fb.name}() {`);
    }
    this.emit("    // Initialize variables");
    this.emit("}");
    this.emit("");

    // Operator()
    this.emitLineDirective(fb.sourceSpan.startLine);
    const fbImplLine = this.currentLine;
    this.emit(`void ${fb.name}::operator()() {`);
    if (this.options.isTestBuild) {
      this.emit("    if (__mocked_) { __mock_state_.call_count++; return; }");
    }
    this.enterScope(fb.varBlocks);
    if (fb.body.length > 0) {
      this.generateStatements(fb.body);
    } else if (this.options.sourceComments) {
      this.emit("    // Empty function block body");
    }
    this.exitScope();
    this.emitLineDirective(fb.sourceSpan.endLine);
    this.emit("}");
    this.emitLineReset();
    this.emit("");
    this.recordLineMapping(fb.sourceSpan.startLine, fbImplLine);

    // Method implementations
    for (const method of fb.methods) {
      if (!method.isAbstract) {
        this.generateMethodImplementation(method, fb.name);
      }
    }

    // Property implementations (enter FB scope so FB member types are visible)
    for (const prop of fb.properties) {
      this.enterScope(fb.varBlocks);
      this.generatePropertyImplementation(prop, fb.name);
      this.exitScope();
    }

    if (this.fbInitPlan?.needsMembers(fb) === true) {
      this.emit(
        `void ${fb.name}::__fb_init_members(${this.fbInitMembersParams(fb)}) {`,
      );
      const base =
        fb.extends !== undefined
          ? this.fbInitMembersOwner(fb.extends)
          : undefined;
      if (base) {
        const names = this.fbInitInputBlock(base.name).declarations.map(
          (d) => d.names[0] ?? "",
        );
        this.emit(`    ${base.name}::__fb_init_members(${names.join(", ")});`);
      }
      // The FB_init inputs come last, so they shadow members of the same name.
      this.enterScope([...fb.varBlocks, this.fbInitInputBlock(fb.name)]);
      for (const decl of this.fbInitPlan.memberDeclarations(fb)) {
        for (const name of decl.names) {
          const member = this.mangleMemberIfNeeded(name, decl.type.name);
          for (const line of this.fbInitInstanceLines(decl, member)) {
            this.emit(`    ${line}`);
          }
        }
      }
      this.exitScope();
      this.emit("}");
      this.emit("");
    }

    this.currentFBName = undefined;
    this.currentFBExtends = undefined;
    this.currentFBVarBlocks = [];
    this.currentFBInterfaceMethods = new Set();
    this.programExternals = new Set();
    this.compositeExternals = new Set();
  }

  /**
   * Generate implementation for a function.
   */
  private generateFunctionImplementation(
    func: CompilationUnit["functions"][0],
  ): void {
    const params = this.generateFunctionParams(func);
    const retType = this.mapTypeRefToCpp(func.returnType);

    // Helper to emit local variable declarations (VAR/VAR_TEMP) and body
    const emitFunctionBody = (funcName: string) => {
      this.emit(`    ${retType} ${funcName}_result;`);
      this.currentFunctionName = func.name;
      this.enterScope(func.varBlocks, func.varBlocks);

      // Declare local variables (VAR, VAR_TEMP) — same pattern as method locals
      for (const block of func.varBlocks) {
        if (block.blockType === "VAR" || block.blockType === "VAR_TEMP") {
          for (const decl of block.declarations) {
            for (const name of decl.names) {
              const cppType = this.mapTypeRefToCpp(decl.type);
              const initValue = decl.initialValue
                ? ` = ${this.generateInitializer(decl.initialValue, cppType, decl.type.name)}`
                : this.scalarTypeInit(decl.type);
              this.emit(
                `    ${cppType} ${this.localCppName(name)}${initValue};`,
              );
            }
          }
        }
      }

      if (func.body.length > 0) {
        this.generateStatements(func.body);
      } else if (this.options.sourceComments) {
        this.emit("    // Empty function body");
      }
      this.exitScope();
      this.currentFunctionName = undefined;
      this.emit(`    return ${funcName}_result;`);
    };

    if (this.options.isTestBuild) {
      // Test build: generate _real, dispatch pointer, and wrapper
      // 1. _real implementation (original body with renamed function)
      this.emitLineDirective(func.sourceSpan.startLine);
      const realLine = this.currentLine;
      this.emit(`${retType} ${func.name}_real(${params.join(", ")}) {`);
      emitFunctionBody(func.name);
      this.emit("}");
      this.emitLineReset();
      this.emit("");
      this.recordLineMapping(func.sourceSpan.startLine, realLine);

      // 2. Dispatch pointer (defaults to real implementation)
      this.emit(
        `${retType} (*${func.name}_dispatch)(${params.join(", ")}) = ${func.name}_real;`,
      );
      this.emit("");

      // 3. Wrapper that calls through dispatch pointer
      const paramNames = this.generateFunctionParamNames(func);
      this.emit(`${retType} ${func.name}(${params.join(", ")}) {`);
      this.emit(`    return ${func.name}_dispatch(${paramNames.join(", ")});`);
      this.emit("}");
      this.emit("");
    } else {
      // Production build: normal function
      this.emitLineDirective(func.sourceSpan.startLine);
      const funcImplLine = this.currentLine;
      this.emit(`${retType} ${func.name}(${params.join(", ")}) {`);
      emitFunctionBody(func.name);
      this.emit("}");
      this.emitLineReset();
      this.emit("");
      this.recordLineMapping(func.sourceSpan.startLine, funcImplLine);
    }
  }

  /**
   * Generate function parameter name list (just names, no types).
   */
  private generateFunctionParamNames(
    func: CompilationUnit["functions"][0],
  ): string[] {
    const names: string[] = [];
    for (const block of func.varBlocks) {
      if (
        block.blockType === "VAR_INPUT" ||
        block.blockType === "VAR_IN_OUT" ||
        block.blockType === "VAR_OUTPUT"
      ) {
        for (const decl of block.declarations) {
          for (const name of decl.names) {
            names.push(name);
          }
        }
      }
    }
    return names;
  }

  // ===========================================================================
  // Project Model-based Generation (Phase 2.1)
  // ===========================================================================

  /**
   * Generate header declaration for a program from the project model.
   * Handles VAR_EXTERNAL as reference members.
   */
  private generateProgramHeaderFromModel(prog: ProgramDecl): void {
    const className = `Program_${prog.name}`;

    // Look up AST program for source spans
    const astProg = this.ast?.programs.find(
      (p) => p.name.toUpperCase() === prog.name.toUpperCase(),
    );

    if (astProg) {
      this.emitHeaderLineDirective(astProg.sourceSpan.startLine);
    }
    const classLine = this.currentHeaderLine;
    this.emitHeader(`class ${className} : public ProgramBase {`);
    this.emitHeader("public:");

    // Map PROGRAM line → class declaration
    if (astProg) {
      this.recordHeaderLineMapping(astProg.sourceSpan.startLine, classLine);
    }

    // Build name→sourceLine lookup from AST for variable mappings
    const varSourceLines = new Map<string, number>();
    if (astProg) {
      for (const block of astProg.varBlocks) {
        for (const decl of block.declarations) {
          for (const name of decl.names) {
            varSourceLines.set(name, decl.sourceSpan.startLine);
          }
        }
      }
    }

    // Generate local variable members and collect located variables
    if (prog.varDeclarations.length > 0) {
      this.emitHeader("    // Local variables");
      for (const decl of prog.varDeclarations) {
        const constQualifier = decl.isConstant ? "const " : "";

        // Use mapTypeRefToCpp so inline ARRAY types (where typeName looks
        // like __INLINE_ARRAY_<T> and the bounds live alongside on the
        // ProjectVarDeclaration) get expanded to Array1D<T, L, U>. Going
        // through mapVarTypeToCpp directly would emit IEC___INLINE_ARRAY_<T>.
        const cppType = this.mapTypeRefToCpp({
          name: decl.typeName,
          ...(decl.maxLength !== undefined
            ? { maxLength: decl.maxLength }
            : {}),
          ...(decl.arrayDimensions !== undefined
            ? { arrayDimensions: decl.arrayDimensions }
            : {}),
          ...(decl.elementTypeName !== undefined
            ? { elementTypeName: decl.elementTypeName }
            : {}),
          ...(decl.elementReferenceChain !== undefined
            ? { elementReferenceChain: decl.elementReferenceChain }
            : {}),
          ...(decl.elementMaxLength !== undefined
            ? { elementMaxLength: decl.elementMaxLength }
            : {}),
          ...(decl.referenceKind !== undefined
            ? { referenceKind: decl.referenceKind }
            : {}),
          ...(decl.referenceChain !== undefined
            ? { referenceChain: decl.referenceChain }
            : {}),
        });
        const memberName = this.mangleMemberIfNeeded(decl.name, decl.typeName);
        // Map variable ST line → header member line
        const stLine = varSourceLines.get(decl.name);
        if (stLine !== undefined) {
          this.emitHeaderLineDirective(stLine);
        }
        const memberLine = this.currentHeaderLine;
        const init =
          decl.initialValue === undefined
            ? this.scalarTypeInit({
                name: decl.typeName,
                ...(decl.referenceKind !== undefined
                  ? { referenceKind: decl.referenceKind }
                  : {}),
                ...(decl.arrayDimensions !== undefined
                  ? { arrayDimensions: decl.arrayDimensions }
                  : {}),
              })
            : "";
        if (decl.address) {
          this.emitHeader(
            `    ${constQualifier}${cppType} ${memberName}${init};  // AT ${decl.address}`,
          );
          // Collect located variable info
          this.collectLocatedVarFromModel(decl, prog.name);
        } else {
          this.emitHeader(
            `    ${constQualifier}${cppType} ${memberName}${init};`,
          );
        }

        if (stLine !== undefined) {
          this.recordHeaderLineMapping(stLine, memberLine);
        }
      }
    }

    // Generate external variable members.
    //
    // A VAR_EXTERNAL reference to a CONFIGURATION VAR_GLOBAL is a pointer to the
    // single canonical GlobalVar<V> (which bundles the value + that global's own
    // mutex). Access goes through the pointer: `g->read()` / `g->write(v)` /
    // `g->with_lock(f)`. The lock is a no-op in the non-threaded build. Same
    // member shape and body code in both builds.
    if (prog.varExternal.length > 0) {
      // VAR_EXTERNAL records carry separate `name`/`typeName`;
      // projectVarToTypeRef + toParamTypeRef + mapTypeRefToCpp resolve the
      // C++ type the same way the constructor params do (must agree).
      const extTypes = prog.varExternal.map((ext) =>
        this.mapTypeRefToCpp(
          this.toParamTypeRef(this.projectVarToTypeRef(ext)),
        ),
      );
      this.emitHeader("    // External variables (pointers to shared globals)");
      for (let i = 0; i < prog.varExternal.length; i++) {
        const ext = prog.varExternal[i]!;
        // Every external — scalar or composite — is a pointer to its canonical
        // GlobalVar<V>. Composite globals (struct / array / function-block) can
        // be declared and debugged (the located image + debug table reach them
        // through `.value`); only their in-body ACCESS is currently gated, at
        // the access sites (see compositeExternals), because correct locked
        // field / element / call codegen is a follow-up phase.
        this.emitHeader(
          `    GlobalVar<${extTypes[i]!}>* ${ext.name} = nullptr;`,
        );
      }
    }

    if (astProg) {
      this.emitProgramVarInstMembers(astProg.methods);
    }

    this.emitHeader("");
    // Implicit IEC 61131-3 ENO pin (see generateProgramHeaderDeclaration
    // for the rationale; this is the project-model code path, same shape).
    if (this.declaredEnoType(prog.name) === undefined) {
      this.emitHeader("    // Implicit IEC 61131-3 ENO pin (mirrors EN)");
      this.emitHeader("    IEC_BOOL ENO = true;");
      this.emitHeader("");
    }
    this.emitHeader("    // Constructor");
    if (prog.varExternal.length > 0) {
      // Constructor takes a pointer to each canonical GlobalVar<V> (the
      // configuration owns the storage + mutex; the program just points at it).
      const params = prog.varExternal
        .map((ext) => {
          const cppType = this.mapTypeRefToCpp(
            this.toParamTypeRef(this.projectVarToTypeRef(ext)),
          );
          return `GlobalVar<${cppType}>* ${ext.name}_ref`;
        })
        .join(", ");
      this.emitHeader(`    explicit ${className}(${params});`);
    } else {
      this.emitHeader(`    ${className}();`);
    }
    this.emitHeader("");
    this.emitHeader("    // Run program");
    this.emitHeader("    void run() override;");

    // Threaded-runtime override (STRUCPP_THREADED only): this program's slice
    // of the located-vars table, for PROGRAM-LOCAL `VAR AT` only. Shared globals
    // no longer use sync_in/sync_out — VAR_EXTERNAL access goes through the
    // GlobalVar pointer (per-global-mutex locked). `sync_in`/`sync_out` remain
    // reserved no-op vtable slots in ProgramBase for ABI stability; we simply
    // don't override them. Config-scope located globals are copied at the
    // barrier (owned by the configuration), so this range covers only this
    // program's own `VAR AT` declarations.
    const threadedRange = this.locatedRangeForProgram(prog.name);
    if (threadedRange.count > 0) {
      this.emitHeader("");
      this.emitHeader("#ifdef STRUCPP_THREADED");
      this.emitHeader(
        `    void located_range(uint32_t* __off, uint32_t* __cnt) const override { *__off = ${threadedRange.offset}; *__cnt = ${threadedRange.count}; }`,
      );
      this.emitHeader("#endif");
    }

    // No per-program retain members are emitted. Retained leaves are listed
    // once, project-wide, in `generated_debug.cpp`'s `retain_vars[]` — see
    // backend/debug-table-gen.ts and runtime/include/iec_retain.hpp.
    //
    // `getRetainVars` / `getRetainCount` stay as no-op base methods on
    // ProgramBase and are deliberately NOT overridden: the v4 runtime's ABI
    // mirror pins their vtable positions, and renumbering would mis-dispatch
    // run() for any program built against a different version.

    if (astProg) {
      this.emitProgramMethodDeclarations(astProg.methods);
    }

    this.emitHeader("};");
    this.emitHeaderLineReset();
    this.emitHeader("");
  }

  /**
   * Generate implementation for a program from the project model.
   */
  private generateProgramImplementationFromModel(prog: ProgramDecl): void {
    // Look up AST program for source span
    const astProg = this.ast?.programs.find(
      (p) => p.name.toUpperCase() === prog.name.toUpperCase(),
    );

    // Constructor
    if (prog.varExternal.length > 0) {
      // Same metadata-aware type resolution as the matching declaration
      // in generateProgramHeaderFromModel — must agree byte-for-byte or
      // the linker rejects the definition.
      const params = prog.varExternal
        .map((ext) => {
          const cppType = this.mapTypeRefToCpp(
            this.toParamTypeRef(this.projectVarToTypeRef(ext)),
          );
          return `GlobalVar<${cppType}>* ${ext.name}_ref`;
        })
        .join(", ");
      this.emit(`Program_${prog.name}::Program_${prog.name}(${params})`);

      // Initializer list
      const inits: string[] = [];
      for (const decl of prog.varDeclarations) {
        const initVal = this.projectVarInitializer(decl);
        if (initVal) {
          // Name the member as `generateProgramHeaderFromModel` declared it —
          // `scale : Scale` is a collision (ST names are case-insensitive) and
          // is declared `SCALE_`, so an initializer list naming `SCALE` does not
          // compile. The FUNCTION_BLOCK constructor already does this.
          inits.push(
            `${this.mangleMemberIfNeeded(decl.name, decl.typeName)}(${initVal})`,
          );
        }
      }
      // External globals: bind the pointer member to the canonical GlobalVar<V>
      // passed by the configuration. Identical in both builds.
      const extInits = prog.varExternal.map(
        (ext) => `${ext.name}(${ext.name}_ref)`,
      );
      const combined = [...inits, ...extInits];
      if (combined.length > 0) {
        this.emit(`    : ${combined.join(", ")}`);
      }
      this.emit("{");

      // Initialize located variable pointers
      this.generateLocatedVarPointerInit(prog.name);
      this.emitProgramFbInit(prog, astProg);

      this.emit("}");
    } else {
      this.emit(`Program_${prog.name}::Program_${prog.name}()`);
      // Initializer list for local variables
      const inits: string[] = [];
      for (const decl of prog.varDeclarations) {
        const initVal = this.projectVarInitializer(decl);
        if (initVal) {
          // Name the member as `generateProgramHeaderFromModel` declared it —
          // `scale : Scale` is a collision (ST names are case-insensitive) and
          // is declared `SCALE_`, so an initializer list naming `SCALE` does not
          // compile. The FUNCTION_BLOCK constructor already does this.
          inits.push(
            `${this.mangleMemberIfNeeded(decl.name, decl.typeName)}(${initVal})`,
          );
        }
      }
      if (inits.length > 0) {
        this.emit(`    : ${inits.join(", ")}`);
      }
      this.emit("{");

      // Initialize located variable pointers
      this.generateLocatedVarPointerInit(prog.name);
      this.emitProgramFbInit(prog, astProg);

      this.emit("}");
    }
    this.emit("");
    // PROGRAM line now maps to header class declaration, not constructor

    // Run method
    this.emit(`void Program_${prog.name}::run() {`);
    this.emitForceScope();
    // VAR_EXTERNAL names for this program: body access to these is rewritten to
    // go through the GlobalVar pointer (g->read()/write()/with_lock).
    this.programExternals = new Set(
      prog.varExternal.map((ext) => ext.name.toUpperCase()),
    );
    this.compositeExternals = new Set(
      prog.varExternal
        .filter((ext) => !isElementaryType(ext.typeName))
        .map((ext) => ext.name.toUpperCase()),
    );
    this.currentProgramName = prog.name;
    if (astProg) {
      this.enterScope(astProg.varBlocks);
    }
    if (astProg && astProg.body.length > 0) {
      // Generate statements (Phase 2.8: only ExternalCodePragma; Phase 3+: all statements)
      this.generateStatements(astProg.body);
    } else if (this.options.sourceComments) {
      this.emit("    // Empty program body");
    }
    if (astProg) {
      this.exitScope();
      this.emitLineDirective(astProg.sourceSpan.endLine);
    }
    this.programExternals = new Set();
    this.compositeExternals = new Set();
    this.currentProgramName = undefined;
    const closingBraceLine = this.currentLine;
    this.emit("}");
    this.emitLineReset();
    this.emit("");
    if (astProg) {
      this.recordLineMapping(astProg.sourceSpan.endLine, closingBraceLine);
      this.generateProgramMethodImplementations(astProg, prog.varExternal);
    }
  }

  /** The nearest FB of `name`'s chain (itself first) that declares `__fb_init_members`. */
  private fbInitMembersOwner(
    name: string,
  ): CompilationUnit["functionBlocks"][0] | undefined {
    const plan = this.fbInitPlan;
    if (!plan) return undefined;
    return fbChain(plan.fbs, name)
      .reverse()
      .find((fb) => plan.needsMembers(fb));
  }

  /** One VAR_INPUT block with the FB_init inputs of `name`'s chain (see fbInitInputs). */
  private fbInitInputBlock(name: string): VarBlock {
    const declarations = this.fbInitPlan
      ? fbInitInputs(this.fbInitPlan.fbs, name)
      : [];
    return {
      kind: "VarBlock",
      sourceSpan:
        this.fbInitPlan?.fbs.get(name.toUpperCase())?.sourceSpan ??
        this.ast!.sourceSpan,
      blockType: "VAR_INPUT",
      isConstant: false,
      isRetain: false,
      isNonRetain: false,
      declarations,
    };
  }

  /** C++ parameter list of `fb`'s `__fb_init_members`: its chain's FB_init inputs. */
  private fbInitMembersParams(
    fb: CompilationUnit["functionBlocks"][0],
  ): string {
    return this.fbInitInputBlock(fb.name)
      .declarations.map(
        (d) => `${this.mapTypeRefToCpp(d.type)} ${d.names[0] ?? ""}`,
      )
      .join(", ");
  }

  /**
   * C++ statements that run the start-up work of instance `cppName` declared
   * by `decl`: its members' FB_init, then each FB_init of its chain, base
   * first, with the flags FALSE and the init arguments by name. An array
   * runs it per element, row-major.
   */
  private fbInitInstanceLines(decl: VarDeclaration, cppName: string): string[] {
    const plan = this.fbInitPlan;
    if (!plan || !this.ast) return [];
    const stored = storedInstance(this.ast, decl.type);
    const fb = stored ? plan.fbs.get(stored.name.toUpperCase()) : undefined;
    if (!stored || !fb || !plan.needs(fb.name)) return [];
    const target = stored.dims > 0 ? "__e" : cppName;
    const body: string[] = [];
    const span = decl.fbInitSpan ?? decl.sourceSpan;
    const named = (decl.fbInitArguments ?? []).filter(
      (a) => a.name !== undefined && !a.isOutput,
    );
    const membersOwner = this.fbInitMembersOwner(fb.name);
    if (membersOwner) {
      const inputs = this.fbInitInputBlock(membersOwner.name);
      const names = new Set(
        inputs.declarations.map((d) => (d.names[0] ?? "").toUpperCase()),
      );
      const values = this.bindArgumentsByName(
        [inputs],
        named.filter((a) => names.has((a.name ?? "").toUpperCase())),
        `the FB_init inputs of '${membersOwner.name}'`,
        span,
      );
      body.push(`${target}.__fb_init_members(${values.join(", ")});`);
    }
    for (const { fb: owner, method } of fbInitChain(plan.fbs, fb.name)) {
      const args: Argument[] = FB_INIT_FLAGS.map((flag) => ({
        kind: "Argument",
        sourceSpan: span,
        name: flag,
        isOutput: false,
        value: {
          kind: "LiteralExpression",
          sourceSpan: span,
          literalType: "BOOL",
          value: false,
          rawValue: "FALSE",
        },
      }));
      for (const arg of named) {
        if (fbInitInput(method, (arg.name ?? "").toUpperCase())) args.push(arg);
      }
      const values = this.bindArgumentsByName(
        method.varBlocks,
        args,
        `method '${method.name}'`,
        span,
      );
      body.push(
        `${target}.${owner.name}::${method.name}(${values.join(", ")});`,
      );
    }
    if (stored.dims === 0) return body;
    return [
      `::strucpp::for_each_element(${cppName}, [&](${fb.name}& __e) {`,
      ...body.map((line) => `    ${line}`),
      "});",
    ];
  }

  /**
   * Header: the once-only start-up work of the global instances, in
   * declaration order, which every PROGRAM constructor runs first.
   */
  private emitFbInitGlobals(ast: CompilationUnit): void {
    if (!this.fbInitPlan) return;
    const lines: string[] = [];
    for (const block of ast.globalVarBlocks) {
      for (const decl of block.declarations) {
        for (const name of decl.names) {
          lines.push(...this.fbInitInstanceLines(decl, name));
        }
      }
    }
    if (lines.length === 0) return;
    this.fbInitGlobalsEmitted = true;
    this.emitHeader("// Start-up FB_init of the global instances, run once");
    this.emitHeader("inline void __fb_init_globals() {");
    this.emitHeader("    static bool done = false;");
    this.emitHeader("    if (done) return;");
    this.emitHeader("    done = true;");
    for (const line of lines) this.emitHeader(`    ${line}`);
    this.emitHeader("}");
    this.emitHeader("");
  }

  /** Program constructor body: the global start-up work, then the program's instances. */
  private emitProgramFbInit(
    prog: ProgramDecl,
    astProg: CompilationUnit["programs"][0] | undefined,
  ): void {
    if (!this.fbInitPlan) return;
    if (this.fbInitGlobalsEmitted) this.emit("    __fb_init_globals();");
    if (!astProg) return;
    this.currentProgramName = prog.name;
    this.enterScope(astProg.varBlocks);
    for (const block of astProg.varBlocks) {
      if (!INSTANCE_BLOCKS.has(block.blockType)) continue;
      for (const decl of block.declarations) {
        for (const name of decl.names) {
          const member = this.mangleMemberIfNeeded(name, decl.type.name);
          for (const line of this.fbInitInstanceLines(decl, member)) {
            this.emit(`    ${line}`);
          }
        }
      }
    }
    this.exitScope();
    this.currentProgramName = undefined;
  }

  /**
   * Emit configuration VAR_GLOBALs as file-scope `inline GlobalVar<V>`
   * singletons — one per unique name — instead of configuration-class members.
   *
   * File scope makes the single canonical storage (value + its own mutex)
   * reachable from every POU regardless of nesting: a program keeps receiving a
   * `GlobalVar<V>*` via the configuration constructor (which now hands over the
   * file-scope address), and a function block binds its VAR_EXTERNAL pointer
   * straight to `&<ns>::<name>` in its own constructor — no pointer threading
   * through containers. Must run before the FB/program/config classes so their
   * bodies can name the globals. Also registers located VAR_GLOBALs so the
   * runtime binds them to the I/O image.
   */
  /** C++ name of the one shared instance of a reached PROGRAM. */
  protected sharedProgramInstance(name: string): string {
    return `__program_${name}`;
  }

  /** The shared instance a variable of type `typeName` binds to, when that is a reached PROGRAM. */
  sharedInstanceOfType(typeName: string): string | undefined {
    const upper = typeName.toUpperCase();
    return this.reachedPrograms.has(upper)
      ? this.sharedProgramInstance(upper)
      : undefined;
  }

  /** The reached PROGRAM `name` names when no local variable shadows it. */
  protected reachedProgramNamed(name: string): string | undefined {
    const upper = name.toUpperCase();
    if (!this.reachedPrograms.has(upper)) return undefined;
    if (this.currentScopeVarTypes.has(upper)) return undefined;
    return (
      this.ast?.programs.find((p) => p.name.toUpperCase() === upper)?.name ??
      upper
    );
  }

  /**
   * Header: the one instance of a PROGRAM reached by name from another POU.
   * An inline object in the header is initialised before any later static
   * of every TU that includes it (the runtime's configuration, a harness),
   * and its address is a constant the debug table can take.
   */
  private emitSharedProgramInstance(
    name: string,
    externals: readonly { name: string }[],
  ): void {
    if (!this.reachedPrograms.has(name.toUpperCase())) return;
    const args = externals
      .map((ext) => `&${globalCppName(ext.name)}`)
      .join(", ");
    this.emitHeader(
      `// The one instance of PROGRAM ${name}, reached by name from other POUs`,
    );
    this.emitHeader(
      `inline Program_${name} ${this.sharedProgramInstance(name)}${args ? `(${args})` : ""};`,
    );
    this.emitHeader("");
  }

  /**
   * Forward-declare every interface, function block, program and configuration
   * class. Emitted twice: once ahead of the user-defined types, which may name a
   * function block, and once in the usual forward-declaration block.
   */
  private emitPouForwardDeclarations(ast: CompilationUnit): void {
    for (const iface of ast.interfaces) {
      this.emitHeader(`class ${iface.name};`);
    }
    for (const fb of ast.functionBlocks) {
      this.emitHeader(`class ${fb.name};`);
    }
    for (const prog of ast.programs) {
      this.emitHeader(`class Program_${prog.name};`);
    }
    for (const config of ast.configurations) {
      this.emitHeader(`class Configuration_${config.name};`);
    }
    if (
      ast.interfaces.length > 0 ||
      ast.functionBlocks.length > 0 ||
      ast.programs.length > 0 ||
      ast.configurations.length > 0
    ) {
      this.emitHeader("");
    }
  }

  /** `config`'s globals, each after the globals its initial value names. */
  private orderedConfigurationGlobals(
    config: ConfigurationDecl,
  ): ProjectVarDeclaration[] {
    const decl = this.ast?.configurations.find(
      (c) => c.name.toUpperCase() === config.name.toUpperCase(),
    );
    if (decl === undefined) return config.globalVars;
    const rank = new Map(
      orderConfigurationGlobals(decl).order.map((item, i) => [
        item.name.toUpperCase(),
        i,
      ]),
    );
    return [...config.globalVars].sort(
      (a, b) =>
        (rank.get(a.name.toUpperCase()) ?? 0) -
        (rank.get(b.name.toUpperCase()) ?? 0),
    );
  }

  private emitFileScopeGlobals(): void {
    if (!this.projectModel) return;
    const seen = new Set<string>();
    let emittedAny = false;
    for (const config of this.projectModel.configurations) {
      this.configGlobalInitNames = new Set(
        config.globalVars.map((g) => g.name.toUpperCase()),
      );
      for (const gvar of this.orderedConfigurationGlobals(config)) {
        const key = gvar.name.toUpperCase();
        // Same name across configurations = one canonical global (strucpp
        // already treats them as such); emit its storage once.
        if (seen.has(key)) continue;
        seen.add(key);

        const cppType = this.mapTypeRefToCpp(this.projectVarToTypeRef(gvar));
        // GlobalVar's initialising constructor is a template
        // (`template<typename T> explicit GlobalVar(T)`), so a bare braced list
        // has nothing to deduce from — name the type for aggregate initialisers
        // (array literals) and pass everything else straight through.
        const rawInit = this.projectVarInitializer(gvar) ?? "";
        const initVal = rawInit.startsWith("{")
          ? `${cppType}${rawInit}`
          : rawInit;

        if (!emittedAny) {
          this.emitHeader(
            "// Configuration VAR_GLOBAL storage — file-scope so every POU " +
              "(program or nested function block) reaches the one canonical " +
              "GlobalVar<V> (value + mutex).",
          );
          emittedAny = true;
        }
        // Must stay a real object — generated_debug.cpp takes `&name` into PROGMEM.
        this.emitHeader(
          `inline GlobalVar<${cppType}> ${globalCppName(gvar.name)}{${initVal}};`,
        );

        // A located VAR_GLOBAL (`AT %IX/%QX/%MW ...`) enters the located-vars
        // descriptor so the runtime binds it to the I/O image. Owner "@config"
        // (not a real program) keeps it out of every program's located_range.
        if (gvar.address) {
          this.collectLocatedVarFromModel(
            {
              name: gvar.name,
              typeName: gvar.typeName,
              address: gvar.address,
              // Carried through so a located ARRAY global expands to one
              // descriptor per element rather than binding only its first.
              arrayDimensions: gvar.arrayDimensions,
            },
            "@config",
          );
        }
      }
    }
    this.configGlobalInitNames = new Set();
    if (emittedAny) this.emitHeader("");
  }

  /**
   * Generate header declaration for a configuration from the project model.
   */
  private generateConfigurationHeaderFromModel(
    config: ConfigurationDecl,
  ): void {
    this.emitHeader(
      `class Configuration_${config.name} : public ConfigurationInstance {`,
    );
    this.emitHeader("public:");

    // VAR_GLOBALs are emitted as file-scope singletons (see
    // emitFileScopeGlobals), not configuration-class members, so every POU can
    // reach them. Nothing to declare inside the class here.

    // Generate program instance members
    const allInstances = this.collectProgramInstances(config);
    if (allInstances.length > 0) {
      this.emitHeader("    // Program instances");
      for (const inst of allInstances) {
        // A reached program's instance is the shared one, held by reference.
        const ref = this.reachedPrograms.has(inst.programType.toUpperCase())
          ? "&"
          : "";
        this.emitHeader(
          `    Program_${inst.programType}${ref} ${inst.instanceName};`,
        );
      }
      this.emitHeader("");
    }

    // Generate task and resource storage
    const taskCount = this.countTasks(config);
    const resourceCount = config.resources.length;
    if (taskCount > 0) {
      this.emitHeader("    // Task storage");
      this.emitHeader(`    TaskInstance tasks_storage[${taskCount}];`);
      this.emitHeader(
        `    ProgramBase* task_programs_storage[${allInstances.length > 0 ? allInstances.length : 1}];`,
      );
    }
    if (resourceCount > 0) {
      this.emitHeader("    // Resource storage");
      this.emitHeader(
        `    ResourceInstance resources_storage[${resourceCount}];`,
      );
    }
    this.emitHeader("");

    // Constructor
    this.emitHeader("    // Constructor");
    this.emitHeader(`    Configuration_${config.name}();`);
    this.emitHeader("");

    // ConfigurationInstance interface
    this.emitHeader("    // ConfigurationInstance interface");
    this.emitHeader("    const char* get_name() const override;");
    this.emitHeader("    ResourceInstance* get_resources() override;");
    this.emitHeader("    size_t get_resource_count() const override;");

    this.emitHeader("};");
    this.emitHeader("");
  }

  /**
   * Generate implementation for a configuration from the project model.
   */
  private generateConfigurationImplementationFromModel(
    config: ConfigurationDecl,
  ): void {
    const allInstances = this.collectProgramInstances(config);

    // Constructor
    this.emit(`Configuration_${config.name}::Configuration_${config.name}()`);

    // Initializer list
    const inits: string[] = [];

    // VAR_GLOBALs self-initialize at file scope (see emitFileScopeGlobals), so
    // there's nothing to init here.

    // Initialize program instances (with external variable references).
    // `&${ext.name}` now resolves to the file-scope global (the class no longer
    // shadows it with a member), so programs receive the same canonical pointer.
    for (const inst of allInstances) {
      const prog = this.projectModel?.programs.get(
        inst.programType.toUpperCase(),
      );
      if (prog && this.reachedPrograms.has(prog.name.toUpperCase())) {
        inits.push(
          `${inst.instanceName}(${this.sharedProgramInstance(prog.name)})`,
        );
      } else if (prog && prog.varExternal.length > 0) {
        // Pass a pointer to each canonical GlobalVar<V> member.
        const args = prog.varExternal
          .map((ext) => `&${globalCppName(ext.name)}`)
          .join(", ");
        inits.push(`${inst.instanceName}(${args})`);
      } else {
        inits.push(`${inst.instanceName}()`);
      }
    }

    if (inits.length > 0) {
      this.emit(`    : ${inits.join(",")}`);
    }
    this.emit("{");

    // Wire up tasks and resources
    if (this.options.sourceComments) {
      this.emit("    // Wire up tasks and resources");
    }

    let taskIndex = 0;
    let programIndex = 0;
    let resourceIndex = 0;

    for (const resource of config.resources) {
      const resourceTaskStart = taskIndex;

      for (const task of resource.tasks) {
        const taskProgramStart = programIndex;

        // Store program pointers for this task
        for (const inst of task.programInstances) {
          this.emit(
            `    task_programs_storage[${programIndex}] = &${inst.instanceName};`,
          );
          programIndex++;
        }

        // Initialize task
        const intervalNs = task.interval?.nanoseconds ?? 0;
        const priority = task.priority ?? 0;
        const programCount = task.programInstances.length;
        this.emit(
          `    tasks_storage[${taskIndex}] = TaskInstance("${task.name}", ${intervalNs}LL, ${priority}, &task_programs_storage[${taskProgramStart}], ${programCount});`,
        );
        taskIndex++;
      }

      // Initialize resource
      const taskCount = resource.tasks.length;
      this.emit(
        `    resources_storage[${resourceIndex}] = ResourceInstance("${resource.name}", "${resource.processor}", &tasks_storage[${resourceTaskStart}], ${taskCount});`,
      );
      resourceIndex++;
    }

    // #172: bind located VAR_GLOBAL descriptor pointers to the canonical
    // storage (through the GlobalVar<V> wrapper's `.value`). The runtime copies
    // the I/O image to/from these pointers (locking each global's mutex on the
    // threaded path).
    this.generateLocatedVarPointerInit("@config", "    ", ".value");

    this.emit("}");
    this.emit("");

    // get_name()
    this.emit(`const char* Configuration_${config.name}::get_name() const {`);
    this.emit(`    return "${config.name}";`);
    this.emit("}");
    this.emit("");

    // get_resources()
    this.emit(
      `ResourceInstance* Configuration_${config.name}::get_resources() {`,
    );
    this.emit("    return resources_storage;");
    this.emit("}");
    this.emit("");

    // get_resource_count()
    this.emit(
      `size_t Configuration_${config.name}::get_resource_count() const {`,
    );
    this.emit(`    return ${config.resources.length};`);
    this.emit("}");
    this.emit("");
  }

  /**
   * Generate header declaration for a configuration from AST (fallback).
   */
  private generateConfigurationHeaderDeclaration(
    config: CompilationUnit["configurations"][0],
  ): void {
    this.emitHeader(
      `class Configuration_${config.name} : public ConfigurationInstance {`,
    );
    this.emitHeader("public:");

    // Generate VAR_GLOBAL members
    for (const block of config.varBlocks) {
      if (block.blockType === "VAR_GLOBAL") {
        this.emitHeader("    // VAR_GLOBAL variables");
        for (const decl of block.declarations) {
          for (const name of decl.names) {
            this.emitHeader(
              `    ${this.mapTypeRefToCpp(decl.type)} ${name}${this.scalarTypeInit(decl.type)};`,
            );
          }
        }
      }
    }

    this.emitHeader("");
    this.emitHeader("    // Constructor");
    this.emitHeader(`    Configuration_${config.name}();`);
    this.emitHeader("");
    this.emitHeader("    // ConfigurationInstance interface");
    this.emitHeader("    const char* get_name() const override;");
    this.emitHeader("    ResourceInstance* get_resources() override;");
    this.emitHeader("    size_t get_resource_count() const override;");
    this.emitHeader("};");
    this.emitHeader("");
  }

  /**
   * Generate implementation for a configuration from AST (fallback).
   */
  private generateConfigurationImplementation(
    config: CompilationUnit["configurations"][0],
  ): void {
    this.emit(`Configuration_${config.name}::Configuration_${config.name}() {`);
    this.emit("    // Initialize configuration");
    this.emit("}");
    this.emit("");

    this.emit(`const char* Configuration_${config.name}::get_name() const {`);
    this.emit(`    return "${config.name}";`);
    this.emit("}");
    this.emit("");

    this.emit(
      `ResourceInstance* Configuration_${config.name}::get_resources() {`,
    );
    this.emit("    return nullptr;");
    this.emit("}");
    this.emit("");

    this.emit(
      `size_t Configuration_${config.name}::get_resource_count() const {`,
    );
    this.emit("    return 0;");
    this.emit("}");
    this.emit("");
  }

  // ===========================================================================
  // Statement Generation (Phase 2.8+)
  // ===========================================================================

  /**
   * Generate code for a statement.
   */
  protected generateStatement(stmt: Statement, indent: string = "    "): void {
    this.currentStatementIndent = indent;
    this.emitLineDirective(stmt.sourceSpan.startLine);
    const cppStartLine = this.currentLine;
    // Arguments passed by copy (see globalInOutArgs): copy-in before the
    // statement (or around the call in a compound statement's header),
    // copy-out after it. In-out bindings of shared globals are per statement.
    const outerCopyOuts = this.pendingGlobalCopyOuts;
    this.pendingGlobalCopyOuts = [];
    const outerBinds = new Set(this.inOutBindExprs);
    let hoisted: VariableExpression[] = [];
    let wrapped: Expression[] = [];
    if (this.isCompoundStatement(stmt)) {
      wrapped = this.registerGlobalInOutCallWraps(stmt);
    } else {
      hoisted = this.hoistGlobalInOutCopies(stmt, indent);
    }
    // Hoisted copy-ins open a block (see hoistGlobalInOutCopies): the
    // statement and its copy-outs go one level in, and the block closes after.
    const outerIndent = indent;
    if (hoisted.length > 0) {
      indent = indent + this.options.indent;
      this.currentStatementIndent = indent;
    }
    // Compound statements handle their own line mappings internally
    let isCompound = false;
    switch (stmt.kind) {
      case "AssignmentStatement":
        this.generateAssignmentStatement(stmt, indent);
        break;
      case "RefAssignStatement":
        this.generateRefAssignStatement(stmt, indent);
        break;
      case "FunctionCallStatement": {
        const memberInstanceCall =
          stmt.call.kind === "MethodCallExpression"
            ? this.memberInstanceCall(stmt.call)
            : undefined;
        if (memberInstanceCall !== undefined) {
          this.generateFBInvocation(memberInstanceCall, indent);
        } else if (stmt.call.kind === "MethodCallExpression") {
          this.emit(
            `${indent}${this.generateMethodCallExpression(stmt.call)};`,
          );
        } else {
          const fbType = this.getFBInvocationType(
            stmt.call.functionName,
            stmt.call.instance,
          );
          const calledProgram =
            stmt.call.instance === undefined
              ? this.reachedProgramNamed(stmt.call.functionName)
              : undefined;
          if (calledProgram !== undefined) {
            this.generateFBInvocation(stmt.call, indent, calledProgram);
          } else if (fbType) {
            this.generateFBInvocation(stmt.call, indent);
          } else if (
            stmt.call.kind === "FunctionCallExpression" &&
            this.hasEnEno(stmt.call.arguments)
          ) {
            // Non-FB function call statement with EN/ENO
            const { enExpr, enoVar, filteredArgs } = this.extractEnEno(
              stmt.call.arguments,
            );
            const modifiedCall: FunctionCallExpression = {
              ...stmt.call,
              arguments: filteredArgs,
            };
            const callExpr = this.generateFunctionCallExpression(modifiedCall);
            this.emitEnEnoWrapper(indent, enExpr, enoVar, (bi) => {
              this.emit(`${bi}${callExpr};`);
            });
          } else {
            this.emit(`${indent}${this.generateExpression(stmt.call)};`);
          }
        }
        break;
      }
      case "IfStatement":
        this.generateIfStatement(stmt, indent);
        isCompound = true;
        break;
      case "CaseStatement":
        this.generateCaseStatement(stmt, indent);
        isCompound = true;
        break;
      case "ForStatement":
        this.generateForStatement(stmt, indent);
        isCompound = true;
        break;
      case "WhileStatement":
        this.generateWhileStatement(stmt, indent);
        isCompound = true;
        break;
      case "RepeatStatement":
        this.generateRepeatStatement(stmt, indent);
        isCompound = true;
        break;
      case "ExitStatement": {
        const top = this.loopExitLabelStack[this.loopExitLabelStack.length - 1];
        if (top) {
          top.used = true;
          this.emit(`${indent}goto ${top.name};`);
        } else {
          // EXIT outside a loop is invalid IEC ST; emit defensive break
          // rather than crash codegen.
          this.emit(`${indent}break;`);
        }
        break;
      }
      case "ContinueStatement":
        // FOR is a C++ `for` with the step in its header, REPEAT a do-while
        // (continue re-tests the condition) and CASE a switch (continue
        // reaches the enclosing loop), so a plain `continue;` is correct.
        this.emit(`${indent}continue;`);
        break;
      case "ReturnStatement":
        this.generateReturnStatement(indent);
        break;
      case "ExternalCodePragma":
        this.generateExternalCodePragma(stmt, indent);
        break;
      case "DeleteStatement":
        this.emit(
          `${indent}strucpp::iec_delete(${this.generateExpression(stmt.pointer)});`,
        );
        break;
      case "AssertCall":
        // Only in test files: emitted by the test generator, nested ones too
        for (const line of this.assertEmitter?.(stmt, indent) ?? []) {
          this.emit(line);
        }
        break;
      default: {
        const _exhaustive: never = stmt;
        throw new Error(
          `Unhandled statement kind: ${(_exhaustive as Statement).kind}`,
        );
      }
    }
    this.flushGlobalCopyOuts(indent);
    if (hoisted.length > 0) this.emit(`${outerIndent}}`);
    this.pendingGlobalCopyOuts = outerCopyOuts;
    this.inOutBindExprs = outerBinds;
    for (const arg of hoisted) this.globalInOutTemps.delete(arg);
    for (const call of wrapped) this.globalInOutCallWraps.delete(call);
    if (!isCompound) {
      this.recordLineMapping(stmt.sourceSpan.startLine, cppStartLine);
    }
  }

  /**
   * Generate code for an assignment statement.
   * ST: target := value;  →  C++: target = value;
   */
  private generateAssignmentStatement(
    stmt: AssignmentStatement,
    indent: string,
  ): void {
    // Check for property write: m.Speed := 75 → m.set_Speed(75)
    const propWrite = this.detectPropertyWrite(stmt.target);
    if (propWrite) {
      const value = this.generateExpression(stmt.value);
      this.emit(
        `${indent}${propWrite.objectCode}set_${propWrite.propertyName}(${value});`,
      );
      return;
    }

    // Composite / array shared-global WRITE (VAR_EXTERNAL to a composite
    // VAR_GLOBAL): take the global's own mutex and write the canonical directly
    // through with_lock. The RHS is computed into a temp first, so any
    // composite-global reads in it take + release their locks before we take the
    // target's lock — at most one global lock is ever held at a time.
    if (
      stmt.target.kind === "VariableExpression" &&
      !stmt.target.isDereference &&
      this.compositeExternals.has(stmt.target.name.toUpperCase())
    ) {
      this.emitCompositeGlobalWrite(stmt.target, stmt.value, indent);
      return;
    }

    // Bit access write: var.N := value → var = (var & ~(1ULL << N)) | ((value ? 1ULL : 0ULL) << N)
    // Uses 1ULL (64-bit) to avoid UB when bit index >= 32 (e.g., LWORD.33)
    const bitIdx =
      stmt.target.kind === "VariableExpression"
        ? this.lastFieldBitIndex(stmt.target)
        : undefined;
    if (stmt.target.kind === "VariableExpression" && bitIdx !== undefined) {
      // Build the base variable (without the bit index)
      const baseVar: VariableExpression = {
        ...stmt.target,
        fieldAccess: stmt.target.fieldAccess.slice(0, -1),
      };
      // Also trim the accessChain if present
      if (stmt.target.accessChain) {
        const trimmed = this.trimLastFieldFromAccessChain(
          stmt.target.accessChain,
        );
        if (trimmed) {
          baseVar.accessChain = trimmed;
        } else {
          delete baseVar.accessChain;
        }
      }
      const baseCode = this.generateLvalue(baseVar);
      const value = this.generateExpression(stmt.value);
      this.emit(
        `${indent}${baseCode} = (${baseCode} & ~(1ULL << ${bitIdx})) | ((${value} ? 1ULL : 0ULL) << ${bitIdx});`,
      );
      return;
    }

    // EN/ENO on function call assignment:
    // result := func(EN := cond, args..., ENO => eno_var);
    // → if (cond) { result = func(args); eno_var = true; } else { eno_var = false; }
    if (
      stmt.value.kind === "FunctionCallExpression" &&
      this.hasEnEno(stmt.value.arguments)
    ) {
      const { enExpr, enoVar, filteredArgs } = this.extractEnEno(
        stmt.value.arguments,
      );
      const target = this.generateLvalue(stmt.target);
      const modifiedCall: FunctionCallExpression = {
        ...stmt.value,
        arguments: filteredArgs,
      };
      const callExpr = this.generateFunctionCallExpression(modifiedCall);
      this.emitEnEnoWrapper(indent, enExpr, enoVar, (bi) => {
        this.emit(`${bi}${target} = ${callExpr};`);
      });
      return;
    }

    // VAR_EXTERNAL scalar write → lock the shared global and set its value via
    // the pointer. (Struct/array/FB-instance external writes go through
    // with_lock at their emission sites.)
    if (
      stmt.target.kind === "VariableExpression" &&
      stmt.target.fieldAccess.length === 0 &&
      !stmt.target.isDereference &&
      this.programExternals.has(stmt.target.name.toUpperCase())
    ) {
      const value = this.generateExpression(stmt.value);
      this.emit(`${indent}${stmt.target.name}->write(${value});`);
      return;
    }

    const target = this.generateLvalue(stmt.target);
    const value = this.generateExpression(stmt.value);

    // For interface-returning methods, convert assignment to result var into return statement
    if (
      this.interfaceReturnMethod &&
      this.currentFunctionName &&
      target === `${this.currentFunctionName}_result`
    ) {
      this.emit(`${indent}return ${value};`);
      return;
    }

    this.emit(`${indent}${target} = ${value};`);
  }

  /**
   * Emit a write to a composite / array shared global (VAR_EXTERNAL to a
   * composite VAR_GLOBAL) under the global's own mutex via with_lock. The RHS is
   * hoisted to a temp BEFORE the lock is taken so its own composite-global reads
   * (each a self-contained with_lock) release before this write's lock is
   * acquired — guaranteeing at most one global lock held at a time. Handles
   * whole-object, field/element, and bit writes (the bit read-modify-write runs
   * inside the single lock, so it is atomic). The lock compiles out on
   * non-STRUCPP_THREADED builds (the guard lives inside GlobalVar::with_lock).
   */
  private emitCompositeGlobalWrite(
    target: VariableExpression,
    valueExpr: Expression,
    indent: string,
  ): void {
    const tmp = `__gwv_${this.tempVarCounter++}`;
    const value = this.generateExpression(valueExpr);
    // In a block of its own: a declaration directly under a CASE label would
    // be jumped over by the next label (C++ "jump to case label").
    const inner = indent + this.options.indent;
    this.emit(`${indent}{`);
    this.emit(`${inner}auto ${tmp} = ${value};`);
    // A call in the value that took a composite global by copy-in writes it
    // back now, before this store, as the call ran before the assignment.
    this.flushGlobalCopyOuts(inner);
    this.emit(`${inner}${this.compositeGlobalStore(target, tmp)}`);
    this.emit(`${indent}}`);
  }

  /**
   * The locked store of `tmp` into a composite shared global (whole object,
   * field / element, or bit), one self-contained `with_lock`, without indent.
   */
  private compositeGlobalStore(
    target: VariableExpression,
    tmp: string,
  ): string {
    const nameUpper = target.name.toUpperCase();
    const ptr = this.resolveVariableBaseName(target.name);
    const lastField = this.lastFieldBitIndex(target);

    if (lastField !== undefined) {
      // Base without the trailing bit index, rendered on the lock lambda param.
      const baseVar: VariableExpression = {
        ...target,
        fieldAccess: target.fieldAccess.slice(0, -1),
      };
      if (target.accessChain) {
        const trimmed = this.trimLastFieldFromAccessChain(target.accessChain);
        if (trimmed) baseVar.accessChain = trimmed;
        else delete baseVar.accessChain;
      }
      const lv = this.renderAccessTail("(*__glk)", baseVar, nameUpper);
      return `${ptr}->with_lock([&](auto* __glk){ ${lv} = (${lv} & ~(1ULL << ${lastField})) | ((${tmp} ? 1ULL : 0ULL) << ${lastField}); });`;
    }

    const lv = this.renderAccessTail("(*__glk)", target, nameUpper);
    return `${ptr}->with_lock([&](auto* __glk){ ${lv} = ${tmp}; });`;
  }

  // ---------------------------------------------------------------------------
  // Arguments of a method or function call passed by copy-in / copy-out: a
  // composite global bound to a VAR_OUTPUT, a UNION member, an in-out
  // argument of another type. The call binds a temporary; no lock is held.
  // ---------------------------------------------------------------------------

  private isCompoundStatement(stmt: Statement): boolean {
    return (
      stmt.kind === "IfStatement" ||
      stmt.kind === "CaseStatement" ||
      stmt.kind === "ForStatement" ||
      stmt.kind === "WhileStatement" ||
      stmt.kind === "RepeatStatement"
    );
  }

  /**
   * Simple statement: emit the copy-in of every argument the calls in `stmt`
   * pass by copy (see globalInOutArgs) before it, the way `__gwv_`
   * reads are hoisted, and queue the copy-outs (written after the statement,
   * or before a composite-global store, see emitCompositeGlobalWrite).
   * Returns the arguments now bound to temporaries. When there are any, the
   * copy-ins open a block (`{`, closed by generateStatement after the
   * copy-outs): a declaration directly under a CASE label would be jumped
   * over by the next label (C++ "jump to case label").
   */
  private hoistGlobalInOutCopies(
    stmt: Statement,
    indent: string,
  ): VariableExpression[] {
    const calls = this.findGlobalInOutCalls(stmt);
    if (!calls.some(({ args }) => args.length > 0)) return [];
    this.emit(`${indent}{`);
    const inner = indent + this.options.indent;
    const hoisted: VariableExpression[] = [];
    for (const { args } of calls) {
      for (const arg of args) {
        const tmp = `__gio_${this.tempVarCounter++}`;
        const copy = this.inOutCopy(arg, tmp);
        this.emit(`${inner}${copy.declaration}`);
        this.globalInOutTemps.set(arg.value, tmp);
        this.pendingGlobalCopyOuts.push(copy.copyOut);
        hoisted.push(arg.value);
      }
    }
    return hoisted;
  }

  /**
   * Copy-in and copy-out of `arg` around a call that binds `tmp`: a composite
   * global under its lock, a UNION member through its proxy (its value as the
   * member's field type, so it binds the callee's `T&`).
   */
  private inOutCopy(
    { value: arg, cppType, once }: InOutCopyArg,
    tmp: string,
  ): { declaration: string; copyOut: string } {
    const read = this.generateVariableExpression(arg);
    const copyIn = arg.unionMember === true ? `union_value(${read})` : read;
    const upper = arg.name.toUpperCase();
    const bitStore = this.bitStore(arg, tmp);
    // A dereference, a REFERENCE TO or a bit is no lvalue a reference can hold.
    const plainLvalue =
      bitStore === undefined &&
      !arg.isDereference &&
      arg.accessChain?.some((s) => s.kind === "dereference") !== true &&
      this.currentScopeVarRefKinds.get(upper) !== "reference_to";
    const copyOut =
      bitStore !== undefined
        ? bitStore
        : this.compositeExternals.has(upper)
          ? this.compositeGlobalStore(arg, tmp)
          : this.programExternals.has(upper) &&
              arg.fieldAccess.length === 0 &&
              !arg.isDereference
            ? `${arg.name}->write(${tmp});`
            : `${read} = ${tmp};`;
    // A temporary of the parameter's type when the argument's type differs.
    const declaration =
      cppType !== undefined
        ? `${cppType} ${tmp}; ${tmp} = ${copyIn};`
        : `auto ${tmp} = ${copyIn};`;
    if (
      once === true &&
      plainLvalue &&
      cppType !== undefined &&
      copyOut === `${read} = ${tmp};`
    ) {
      return {
        declaration: `auto& ${tmp}_ref = ${read}; ${cppType} ${tmp}; ${tmp} = ${tmp}_ref;`,
        copyOut: `${tmp}_ref = ${tmp};`,
      };
    }
    return { declaration, copyOut };
  }

  /** `v.N := value` for a bit access `v.N` (see generateAssignmentStatement); undefined otherwise. */
  private bitStore(
    target: VariableExpression,
    value: string,
  ): string | undefined {
    const bitIdx = this.lastFieldBitIndex(target);
    if (bitIdx === undefined) return undefined;
    const baseVar: VariableExpression = {
      ...target,
      fieldAccess: target.fieldAccess.slice(0, -1),
    };
    if (target.accessChain) {
      const trimmed = this.trimLastFieldFromAccessChain(target.accessChain);
      if (trimmed) baseVar.accessChain = trimmed;
      else delete baseVar.accessChain;
    }
    const baseCode = this.generateLvalue(baseVar);
    return `${baseCode} = (${baseCode} & ~(1ULL << ${bitIdx})) | ((${value} ? 1ULL : 0ULL) << ${bitIdx});`;
  }

  /** Write the queued copy-outs of the current statement. */
  private flushGlobalCopyOuts(indent: string): void {
    for (const line of this.pendingGlobalCopyOuts) {
      this.emit(`${indent}${line}`);
    }
    this.pendingGlobalCopyOuts = [];
  }

  /**
   * Compound statement: a call in its header may run many times (a WHILE
   * condition) or not at all (an ELSIF condition), so the copies cannot sit
   * before and after the statement. Mark the calls; generateExpression wraps
   * each in a lambda that copies in, calls and copies out.
   */
  private registerGlobalInOutCallWraps(stmt: Statement): Expression[] {
    const calls = this.findGlobalInOutCalls(stmt);
    for (const { call, args } of calls) {
      this.globalInOutCallWraps.set(call, args);
    }
    return calls.map(({ call }) => call);
  }

  /** Copy-in, call and copy-out as one expression (see registerGlobalInOutCallWraps). */
  private wrapGlobalInOutCall(
    expr: Expression,
    generate: () => string,
  ): string {
    const args = this.globalInOutCallWraps.get(expr);
    if (!args) return generate();
    const copyIns: string[] = [];
    const copyOuts: string[] = [];
    for (const arg of args) {
      const tmp = `__gio_${this.tempVarCounter++}`;
      const copy = this.inOutCopy(arg, tmp);
      copyIns.push(copy.declaration);
      this.globalInOutTemps.set(arg.value, tmp);
      copyOuts.push(copy.copyOut);
    }
    const result = `__gio_${this.tempVarCounter++}`;
    const call = generate();
    for (const arg of args) this.globalInOutTemps.delete(arg.value);
    return `[&]{ ${copyIns.join(" ")} auto ${result} = ${call}; ${copyOuts.join(" ")} return ${result}; }()`;
  }

  /**
   * The method and function calls in `root` (not in its nested statements)
   * with an argument passed by copy (see globalInOutArgs), in evaluation
   * order (arguments before their call).
   */
  private findGlobalInOutCalls(
    root: Statement,
  ): Array<{ call: Expression; args: InOutCopyArg[] }> {
    const found: Array<{ call: Expression; args: InOutCopyArg[] }> = [];
    const visit = (node: ASTNode): boolean => {
      if (node !== root && node.kind.endsWith("Statement")) return false;
      if (
        node.kind !== "FunctionCallExpression" &&
        node.kind !== "MethodCallExpression"
      ) {
        return true;
      }
      const call = node as FunctionCallExpression | MethodCallExpression;
      if (call.kind === "MethodCallExpression") walkAST(call.object, visit);
      else if (call.instance) walkAST(call.instance, visit);
      for (const arg of call.arguments) walkAST(arg, visit);
      const args = this.globalInOutArgs(call);
      if (args.length > 0) found.push({ call, args });
      return false;
    };
    walkAST(root, visit);
    return found;
  }

  /**
   * The arguments of `call` (a callee declared in this unit) passed by
   * copy-in / copy-out: a composite global bound to a VAR_OUTPUT, a UNION
   * member, or an argument of another type bound to a VAR_IN_OUT, with the
   * C++ type of its temporary when that is the parameter's. Arguments bound
   * to a VAR_IN_OUT by reference that render differently from a read (a
   * shared global, a REFERENCE TO) are registered in inOutBindExprs.
   */
  private globalInOutArgs(
    call: FunctionCallExpression | MethodCallExpression,
  ): InOutCopyArg[] {
    const isCompositeGlobal = (e: Expression): e is VariableExpression =>
      e.kind === "VariableExpression" &&
      !e.isDereference &&
      this.compositeExternals.has(e.name.toUpperCase()) &&
      this.lastFieldBitIndex(e) === undefined;
    const isUnionMember = (e: Expression): e is VariableExpression =>
      e.kind === "VariableExpression" && e.unionMember === true;
    const rendersBound = (e: Expression): e is VariableExpression =>
      e.kind === "VariableExpression" &&
      !e.isDereference &&
      (this.programExternals.has(e.name.toUpperCase()) ||
        this.currentScopeVarRefKinds.get(e.name.toUpperCase()) ===
          "reference_to");
    const varBlocks =
      this.calleeVarBlocks(call) ??
      this.librarySizedStringBlocks(call) ??
      (call.arguments.some((a) => a.inOutCopy === true) &&
      call.kind === "FunctionCallExpression"
        ? this.libraryFunctionDeclaration(call.functionName)?.varBlocks
        : undefined);
    const hasSizedStringParam =
      varBlocks?.some(
        (b) =>
          (b.blockType === "VAR_OUTPUT" || b.blockType === "VAR_IN_OUT") &&
          b.declarations.some(
            (d) =>
              this.sizedStringLength(d.type) !== undefined ||
              this.arrayStringElementLength(d.type) !== undefined ||
              this.vlaStringElementCpp(d.type) !== undefined,
          ),
      ) === true;
    if (
      !hasSizedStringParam &&
      !call.arguments.some(
        (a) =>
          isCompositeGlobal(a.value) ||
          isUnionMember(a.value) ||
          rendersBound(a.value) ||
          a.inOutCopy === true,
      )
    ) {
      return [];
    }
    if (!varBlocks) return [];

    const params: Array<{
      name: string;
      blockType: string;
      type: TypeReference;
    }> = [];
    for (const block of varBlocks) {
      if (
        block.blockType === "VAR_INPUT" ||
        block.blockType === "VAR_IN_OUT" ||
        block.blockType === "VAR_OUTPUT"
      ) {
        for (const decl of block.declarations) {
          for (const name of decl.names) {
            params.push({
              name: name.toUpperCase(),
              blockType: block.blockType,
              type: decl.type,
            });
          }
        }
      }
    }
    // Bind as bindArgumentsByName does: named by name, positional to the
    // unclaimed parameters in declaration order.
    const claimed = new Set(
      call.arguments
        .filter((a) => a.name !== undefined)
        .map((a) => a.name!.toUpperCase()),
    );
    const free = params.filter((p) => !claimed.has(p.name));
    let positional = 0;
    const result: InOutCopyArg[] = [];
    for (const arg of call.arguments) {
      const param =
        arg.name !== undefined
          ? params.find((p) => p.name === arg.name!.toUpperCase())
          : free[positional++];
      if (!param) continue;
      const value = arg.value;
      if (value.kind !== "VariableExpression") continue;
      if (param.blockType === "VAR_IN_OUT" && !arg.isOutput) {
        const sized = this.sizedStringLength(param.type);
        if (
          arg.inOutCopy === true ||
          (sized !== undefined &&
            !isCompositeGlobal(value) &&
            !isUnionMember(value) &&
            !rendersBound(value) &&
            !this.hasStringLength(value, sized))
        ) {
          result.push({
            value,
            cppType: this.inOutParamType(param.type),
          });
        } else if (
          !isCompositeGlobal(value) &&
          !isUnionMember(value) &&
          !rendersBound(value) &&
          this.vlaStringElementDiffers(param.type, value)
        ) {
          // ARRAY[*] OF STRING(n) over elements of another length: a copy
          // with the argument's bounds and the parameter's element type.
          const elem = this.vlaStringElementCpp(param.type)!;
          const read = this.generateVariableExpression(value);
          result.push({
            value,
            cppType: `array_rebind_t<typename std::decay<decltype(${read})>::type, ${elem}>`,
          });
        } else if (value.unionMember === true) {
          result.push({ value });
        } else if (rendersBound(value)) {
          this.inOutBindExprs.add(value);
          if (this.programExternals.has(value.name.toUpperCase())) {
            this.warnSharedGlobalInOut(value.name, param.name, call);
          }
        }
      } else if (
        param.blockType === "VAR_OUTPUT" &&
        !isCompositeGlobal(value) &&
        !isUnionMember(value) &&
        (arg.inOutCopy === true ||
          (this.sizedStringLength(param.type) !== undefined &&
            !this.hasStringLength(
              value,
              this.sizedStringLength(param.type)!,
            )) ||
          this.stringElementLengthDiffers(param.type, value))
      ) {
        // A STRING(n) output binds only a variable of that length, an integer
        // output only one of its own C++ type: others go through a temporary.
        result.push({
          value,
          cppType: this.inOutParamType(param.type),
          once: true as const,
        });
      } else if (
        (arg.isOutput || param.blockType === "VAR_OUTPUT") &&
        (isCompositeGlobal(value) || isUnionMember(value))
      ) {
        result.push({ value });
      }
    }
    return result;
  }

  /**
   * The length of a STRING or WSTRING declared with one other than the
   * default (a constant resolved when known, else its name in upper case);
   * undefined for any other type.
   */
  private sizedStringLength(type: {
    name: string;
    maxLength?: number | string;
    arrayDimensions?: unknown;
    referenceKind?: string;
  }): string | undefined {
    const upper = type.name.toUpperCase();
    if (upper !== "STRING" && upper !== "WSTRING") return undefined;
    if (type.arrayDimensions !== undefined) return undefined;
    if (type.referenceKind !== undefined && type.referenceKind !== "none") {
      return undefined;
    }
    let length = type.maxLength;
    if (typeof length === "string") {
      const constants = this.options.globalConstants;
      const key = Object.keys(constants).find(
        (k) => k.toUpperCase() === (length as string).toUpperCase(),
      );
      if (key !== undefined) length = constants[key];
    }
    if (length === undefined || length === 254) return undefined;
    return String(length).toUpperCase();
  }

  /**
   * The declaration blocks of a library FUNCTION `call` invokes, when it has
   * a STRING(n) output or in/out (its archive records the length).
   */
  private librarySizedStringBlocks(
    call: FunctionCallExpression | MethodCallExpression,
  ): VarBlock[] | undefined {
    if (call.kind !== "FunctionCallExpression" || call.instance)
      return undefined;
    if (call.functionName.includes(".")) return undefined;
    if (this.getFBInvocationType(call.functionName, undefined) !== undefined) {
      return undefined;
    }
    const blocks = this.libraryFunctionDeclaration(
      call.functionName,
    )?.varBlocks;
    const sized = blocks?.some(
      (b) =>
        (b.blockType === "VAR_OUTPUT" || b.blockType === "VAR_IN_OUT") &&
        b.declarations.some(
          (d) => this.sizedStringLength(d.type) !== undefined,
        ),
    );
    return sized === true ? blocks : undefined;
  }

  /**
   * The element length (upper case text, "254" by default) of an ARRAY of
   * STRING or WSTRING, inline or declared here; undefined for anything else.
   */
  private arrayStringElementLength(type: TypeShape): string | undefined {
    if (type.referenceKind !== undefined && type.referenceKind !== "none") {
      return undefined;
    }
    let name: string | undefined;
    let length: number | string | undefined;
    if (type.arrayDimensions !== undefined) {
      if (type.elementReferenceChain !== undefined) return undefined;
      name = type.elementTypeName;
      length = type.elementMaxLength;
    } else {
      const upper = type.name.toUpperCase();
      const def = this.ast?.types.find(
        (t) => t.name.toUpperCase() === upper,
      )?.definition;
      if (def?.kind !== "ArrayDefinition") return undefined;
      const kind = def.elementType.referenceKind;
      if (kind !== undefined && kind !== "none") return undefined;
      name = def.elementType.name;
      length = def.elementType.maxLength;
    }
    const upperName = name?.toUpperCase();
    if (upperName !== "STRING" && upperName !== "WSTRING") return undefined;
    return `${upperName}(${String(length ?? 254).toUpperCase()})`;
  }

  /** The C++ element of an ARRAY[*] OF STRING / WSTRING parameter. */
  private vlaStringElementCpp(type: TypeShape): string | undefined {
    const vla = VLA_TYPE_NAME.exec(type.name);
    if (!vla || type.elementReferenceChain !== undefined) return undefined;
    const upper = vla[2]!.toUpperCase();
    if (upper !== "STRING" && upper !== "WSTRING") return undefined;
    return this.typeCodeGen.mapStructFieldTypeToCpp(
      upper,
      type.elementMaxLength,
    );
  }

  /**
   * True when `param` is an ARRAY[*] OF STRING and `value` a fixed ARRAY of
   * STRING whose element length differs (or is not known).
   */
  private vlaStringElementDiffers(
    param: TypeShape,
    value: VariableExpression,
  ): boolean {
    const vla = VLA_TYPE_NAME.exec(param.name);
    if (!vla || this.vlaStringElementCpp(param) === undefined) return false;
    const want = `${vla[2]!.toUpperCase()}(${String(param.elementMaxLength ?? 254).toUpperCase()})`;
    const hasAccess =
      value.subscripts.length > 0 ||
      value.fieldAccess.length > 0 ||
      value.isDereference ||
      (value.accessChain !== undefined && value.accessChain.length > 0);
    const root =
      this.currentScopeVarTypeRefs.get(value.name.toUpperCase()) ??
      this.namespaceGlobalTypeRef(value.name.toUpperCase());
    const type =
      root !== undefined && hasAccess
        ? resolveAccessType(root, value, this.accessLookup)
        : root;
    if (type === undefined) return false;
    // Another view passes through unchanged.
    if (VLA_TYPE_NAME.test(type.name)) return false;
    const have = this.arrayStringElementLength(type);
    return have !== undefined && have !== want;
  }

  /**
   * True when `param` is an ARRAY of STRING and `value` is not a plain
   * variable of an ARRAY with the same element length (another C++ type).
   */
  private stringElementLengthDiffers(
    param: TypeShape,
    value: VariableExpression,
  ): boolean {
    const want = this.arrayStringElementLength(param);
    if (want === undefined) return false;
    const hasAccess =
      value.subscripts.length > 0 ||
      value.fieldAccess.length > 0 ||
      value.isDereference ||
      (value.accessChain !== undefined && value.accessChain.length > 0);
    const root =
      this.currentScopeVarTypeRefs.get(value.name.toUpperCase()) ??
      this.namespaceGlobalTypeRef(value.name.toUpperCase());
    const type =
      root !== undefined && hasAccess
        ? resolveAccessType(root, value, this.accessLookup)
        : root;
    return type === undefined || this.arrayStringElementLength(type) !== want;
  }

  /**
   * True when `value` is a plain variable declared as a STRING or WSTRING of
   * `length` (the length text as written); false when unknown.
   */
  private hasStringLength(value: VariableExpression, length: string): boolean {
    const hasAccess =
      value.subscripts.length > 0 ||
      value.fieldAccess.length > 0 ||
      value.isDereference ||
      (value.accessChain !== undefined && value.accessChain.length > 0);
    const root =
      this.currentScopeVarTypeRefs.get(value.name.toUpperCase()) ??
      this.namespaceGlobalTypeRef(value.name.toUpperCase());
    const type =
      root !== undefined && hasAccess
        ? resolveAccessType(root, value, this.accessLookup)
        : root;
    return type !== undefined && this.sizedStringLength(type) === length;
  }

  /** The declaration blocks of the method or user FUNCTION `call` invokes;
   *  undefined for a function block invocation, a standard function or a
   *  callee not declared in this unit. */
  private calleeVarBlocks(
    call: FunctionCallExpression | MethodCallExpression,
  ): VarBlock[] | undefined {
    if (call.kind === "MethodCallExpression") {
      return this.findMethodDeclaration(
        this.methodCallOwnerType(call.object),
        call.methodName,
      )?.varBlocks;
    }
    const name = call.functionName;
    if (name.includes(".")) {
      const dotIdx = name.indexOf(".");
      return this.findMethodDeclaration(
        this.dottedCallOwnerType(name.substring(0, dotIdx)),
        name.substring(dotIdx + 1),
      )?.varBlocks;
    }
    const nameUpper = name.toUpperCase();
    const ownMethod = this.ownMethodCalled(call);
    if (ownMethod) return ownMethod.varBlocks;
    if (
      this.getFBInvocationType(name, call.instance) !== undefined ||
      this.stdRegistry.resolveConversion(nameUpper) ||
      this.stdRegistry.lookup(nameUpper)
    ) {
      return undefined;
    }
    const func = this.ast?.functions.find(
      (f) => f.name.toUpperCase() === nameUpper,
    );
    if (func) return func.varBlocks;
    return this.findMethodDeclaration(
      this.currentFBName ?? this.currentProgramName,
      nameUpper,
    )?.varBlocks;
  }

  /**
   * Generate code for a REF= rebind. The lowering depends on the target's
   * reference kind, because the two runtime wrappers expose different APIs:
   *
   *   REFERENCE TO (IEC_REFERENCE_TO)  →  target.bind(source);
   *   REF_TO       (IEC_REF_TO)        →  target = REF(source);
   *
   * IEC_REF_TO has no bind() — it rebinds via assignment from REF()/ADR() —
   * so emitting bind() unconditionally (the old behaviour) failed to compile
   * for REF_TO targets.
   */
  private generateRefAssignStatement(
    stmt: RefAssignStatement,
    indent: string,
  ): void {
    // The target is the reference itself, not the variable it is bound to.
    this.keepReferenceWrapper = true;
    let target: string;
    try {
      target = this.generateExpression(stmt.target);
    } finally {
      this.keepReferenceWrapper = false;
    }
    const source = this.addressedOperand(stmt.source, "REF=", stmt);
    const targetKind =
      stmt.target.kind === "VariableExpression"
        ? this.refAssignTargetKind(stmt.target)
        : undefined;
    if (targetKind === "ref_to") {
      this.emit(`${indent}${target} = REF(${source});`);
    } else {
      // REFERENCE_TO (and the default) rebind via bind().
      this.emit(`${indent}${target}.bind(${source});`);
    }
  }

  /**
   * The reference kind of a REF= target: a variable's own, or for a member or
   * element (`s.r`, `arr[1]`) the declared kind of what it lands on.
   */
  private refAssignTargetKind(target: VariableExpression): string | undefined {
    const nameUpper = target.name.toUpperCase();
    const hasAccess =
      target.subscripts.length > 0 ||
      target.fieldAccess.length > 0 ||
      target.isDereference ||
      (target.accessChain !== undefined && target.accessChain.length > 0);
    if (!hasAccess) return this.currentScopeVarRefKinds.get(nameUpper);
    const base =
      nameUpper === "THIS" && this.currentFBName
        ? { name: this.currentFBName, referenceKind: "none" as const }
        : this.currentScopeVarTypeRefs.get(nameUpper);
    if (base === undefined) return undefined;
    return resolveAccessType(base, target, this.accessLookup)?.referenceKind;
  }

  /** Member and element lookups over the AST and the library FBs. */
  private readonly accessLookup: AccessLookup = {
    field: (type, field) => {
      const local = this.ast
        ? resolveFieldDeclarationUtil(type, field, this.ast)
        : undefined;
      if (local) return local;
      // A library function block: its member types come from the manifest.
      const key = `${type.toUpperCase()}.${field.toUpperCase()}`;
      const name = this.libraryFBFieldTypes.get(key);
      if (name === undefined) return undefined;
      const kind = this.libraryFBFieldTypeRefs.get(key)?.referenceKind;
      return { type: { name, referenceKind: kind ?? "none" } };
    },
    arrayElement: (type) =>
      this.ast ? resolveArrayElementAccessType(type, this.ast) : undefined,
  };

  /**
   * Generate code for an external code pragma.
   * The code content is emitted AS-IS to the output.
   */
  private generateExternalCodePragma(
    pragma: ExternalCodePragma,
    indent: string,
  ): void {
    // Split the code into lines and emit each with proper indentation
    const lines = pragma.code.split(/\r?\n/);
    for (const line of lines) {
      // Emit the line with base indentation
      // The code is emitted AS-IS, but we add the base indent for consistency
      if (line.trim() === "") {
        this.emit("");
      } else {
        this.emit(`${indent}${line}`);
      }
    }
  }

  // ===========================================================================
  // Control Flow Statement Generation (Phase 3.2)
  // ===========================================================================

  /**
   * Generate code for an IF statement.
   * ST: IF/ELSIF/ELSE → C++: if/else if/else
   */
  private generateIfStatement(stmt: IfStatement, indent: string): void {
    const ifLine = this.currentLine;
    this.emit(`${indent}if (${this.generateExpression(stmt.condition)}) {`);
    this.recordLineMapping(stmt.sourceSpan.startLine, ifLine);
    this.generateStatements(stmt.thenStatements, indent + this.options.indent);

    for (const elsif of stmt.elsifClauses) {
      this.emitLineDirective(elsif.sourceSpan.startLine);
      const elsifLine = this.currentLine;
      this.emit(
        `${indent}} else if (${this.generateExpression(elsif.condition)}) {`,
      );
      this.recordLineMapping(elsif.sourceSpan.startLine, elsifLine);
      this.generateStatements(elsif.statements, indent + this.options.indent);
    }

    if (stmt.elseStatements.length > 0) {
      // Map ELSE to the `} else {` line. Use endLine-1 as an approximation
      // for the ELSE keyword line (one line before END_IF).
      // The ELSE doesn't have its own AST node, so we derive from context.
      let elseStLine: number | undefined;
      if (stmt.elsifClauses.length > 0) {
        elseStLine =
          stmt.elsifClauses[stmt.elsifClauses.length - 1]!.sourceSpan.endLine +
          1;
      } else if (stmt.thenStatements.length > 0) {
        elseStLine =
          stmt.thenStatements[stmt.thenStatements.length - 1]!.sourceSpan
            .endLine + 1;
      }
      if (elseStLine !== undefined) {
        this.emitLineDirective(elseStLine);
      }
      const elseLine = this.currentLine;
      this.emit(`${indent}} else {`);
      if (elseStLine !== undefined) {
        this.recordLineMapping(elseStLine, elseLine);
      }
      this.generateStatements(
        stmt.elseStatements,
        indent + this.options.indent,
      );
    }

    this.emitLineDirective(stmt.sourceSpan.endLine);
    const closingLine = this.currentLine;
    this.emit(`${indent}}`);
    this.recordLineMapping(stmt.sourceSpan.endLine, closingLine);
  }

  /**
   * Generate code for a CASE statement.
   * ST: CASE/OF → C++: switch/case with range expansion
   */
  private generateCaseStatement(stmt: CaseStatement, indent: string): void {
    const switchLine = this.currentLine;
    this.emit(`${indent}switch (${this.generateExpression(stmt.selector)}) {`);
    this.recordLineMapping(stmt.sourceSpan.startLine, switchLine);
    const innerIndent = indent + this.options.indent;
    const bodyIndent = innerIndent + this.options.indent;

    for (const caseElement of stmt.cases) {
      this.emitLineDirective(caseElement.sourceSpan.startLine);
      const caseLabelLine = this.currentLine;
      for (const label of caseElement.labels) {
        if (label.end) {
          // Range: expand to individual case labels
          const startVal = this.evaluateLiteralInt(label.start);
          const endVal = this.evaluateLiteralInt(label.end);
          const chars = this.charLabelRange(label.start, label.end);
          if (chars !== undefined) {
            for (let i = chars.from; i <= chars.to; i++) {
              this.emit(`${innerIndent}case static_cast<${chars.type}>(${i}):`);
            }
          } else if (startVal !== undefined && endVal !== undefined) {
            for (let i = startVal; i <= endVal; i++) {
              this.emit(`${innerIndent}case ${i}:`);
            }
          } else {
            // Fallback: emit as comment with expression
            this.emit(
              `${innerIndent}case ${this.generateExpression(label.start)}: // range to ${this.generateExpression(label.end)}`,
            );
          }
        } else {
          this.emit(`${innerIndent}case ${this.caseLabelCpp(label.start)}:`);
        }
      }
      this.recordLineMapping(caseElement.sourceSpan.startLine, caseLabelLine);
      this.generateStatements(caseElement.statements, bodyIndent);
      this.emit(`${bodyIndent}break;`);
    }

    if (stmt.elseStatements.length > 0) {
      this.emit(`${innerIndent}default:`);
      this.generateStatements(stmt.elseStatements, bodyIndent);
      this.emit(`${bodyIndent}break;`);
    }

    this.emitLineDirective(stmt.sourceSpan.endLine);
    const closingLine = this.currentLine;
    this.emit(`${indent}}`);
    this.recordLineMapping(stmt.sourceSpan.endLine, closingLine);
  }

  /** The codes of a CHAR or WCHAR literal range label, `'a'..'c'`. */
  private charLabelRange(
    start: Expression,
    end: Expression,
  ): { type: string; from: number; to: number } | undefined {
    const code = (
      e: Expression,
    ): { wide: boolean; unit: number } | undefined => {
      if (
        e.kind !== "LiteralExpression" ||
        (e.literalType !== "CHAR" && e.literalType !== "WCHAR")
      ) {
        return undefined;
      }
      const { wide, units } = charLiteralUnits(e.rawValue);
      const unit = units[0];
      return units.length === 1 && unit !== undefined && unit >= 0
        ? { wide, unit }
        : undefined;
    };
    const from = code(start);
    const to = code(end);
    if (from === undefined || to === undefined || from.wide !== to.wide) {
      return undefined;
    }
    return {
      type: from.wide ? "WCHAR_t" : "CHAR_t",
      from: from.unit,
      to: to.unit,
    };
  }

  /**
   * Generate code for a FOR statement.
   * ST: FOR i := start TO end BY step DO → C++: for (i = start; i <= end; i += step)
   */
  private generateForStatement(stmt: ForStatement, indent: string): void {
    // In function bodies, the control variable may be the function name (IEC ST return variable)
    let varName = stmt.controlVariable;
    if (
      this.currentFunctionName &&
      varName.toUpperCase() === this.currentFunctionName.toUpperCase()
    ) {
      varName = `${this.currentFunctionName}_result`;
    }
    const start = this.generateExpression(stmt.start);
    const end = this.generateExpression(stmt.end);

    const forLine = this.currentLine;
    if (stmt.step) {
      const stepExpr = this.generateExpression(stmt.step);
      // Determine direction from step when it's a literal
      const stepVal = this.evaluateLiteralInt(stmt.step);
      if (stepVal !== undefined && stepVal < 0) {
        this.emit(
          `${indent}for (${varName} = ${start}; ${varName} >= ${end}; ${varName} += ${stepExpr}) {`,
        );
      } else {
        this.emit(
          `${indent}for (${varName} = ${start}; ${varName} <= ${end}; ${varName} += ${stepExpr}) {`,
        );
      }
    } else {
      // Default step is 1, ascending
      this.emit(
        `${indent}for (${varName} = ${start}; ${varName} <= ${end}; ${varName}++) {`,
      );
    }
    this.recordLineMapping(stmt.sourceSpan.startLine, forLine);

    const exitLabel = {
      name: `__strucpp_loop_exit_${this.loopExitLabelCounter++}`,
      used: false,
    };
    this.loopExitLabelStack.push(exitLabel);
    this.generateStatements(stmt.body, indent + this.options.indent);
    this.loopExitLabelStack.pop();
    this.emitLineDirective(stmt.sourceSpan.endLine);
    const closingLine = this.currentLine;
    this.emit(`${indent}}`);
    if (exitLabel.used) this.emit(`${indent}${exitLabel.name}: ;`);
    this.recordLineMapping(stmt.sourceSpan.endLine, closingLine);
  }

  /**
   * Generate code for a WHILE statement.
   * ST: WHILE condition DO → C++: while (condition)
   */
  private generateWhileStatement(stmt: WhileStatement, indent: string): void {
    const whileLine = this.currentLine;
    this.emit(`${indent}while (${this.generateExpression(stmt.condition)}) {`);
    this.recordLineMapping(stmt.sourceSpan.startLine, whileLine);
    const exitLabel = {
      name: `__strucpp_loop_exit_${this.loopExitLabelCounter++}`,
      used: false,
    };
    this.loopExitLabelStack.push(exitLabel);
    this.generateStatements(stmt.body, indent + this.options.indent);
    this.loopExitLabelStack.pop();
    this.emitLineDirective(stmt.sourceSpan.endLine);
    const closingLine = this.currentLine;
    this.emit(`${indent}}`);
    if (exitLabel.used) this.emit(`${indent}${exitLabel.name}: ;`);
    this.recordLineMapping(stmt.sourceSpan.endLine, closingLine);
  }

  /**
   * Generate code for a REPEAT statement.
   * ST: REPEAT ... UNTIL condition → C++: do { ... } while (!(condition))
   */
  private generateRepeatStatement(stmt: RepeatStatement, indent: string): void {
    const doLine = this.currentLine;
    this.emit(`${indent}do {`);
    this.recordLineMapping(stmt.sourceSpan.startLine, doLine);
    const exitLabel = {
      name: `__strucpp_loop_exit_${this.loopExitLabelCounter++}`,
      used: false,
    };
    this.loopExitLabelStack.push(exitLabel);
    this.generateStatements(stmt.body, indent + this.options.indent);
    this.loopExitLabelStack.pop();
    this.emitLineDirective(stmt.sourceSpan.endLine);
    const untilLine = this.currentLine;
    this.emit(
      `${indent}} while (!(${this.generateExpression(stmt.condition)}));`,
    );
    if (exitLabel.used) this.emit(`${indent}${exitLabel.name}: ;`);
    this.recordLineMapping(stmt.sourceSpan.endLine, untilLine);
  }

  /**
   * Generate code for a RETURN statement.
   * In functions: return functionName_result;
   * In programs/FBs: return;
   */
  /** When set, a RETURN returns this C++ value: `true` in a TEST body, which passes. */
  protected returnValueOverride: string | undefined;
  /** Test files: the C++ lines of an ASSERT_* met inside IF, a loop or CASE. */
  protected assertEmitter:
    | ((stmt: AssertCall, indent: string) => string[])
    | undefined;

  private generateReturnStatement(indent: string): void {
    if (this.returnValueOverride !== undefined) {
      this.emit(`${indent}return ${this.returnValueOverride};`);
      return;
    }
    if (this.interfaceReturnMethod) {
      // Interface-returning methods: the assignment-based return path (methodName := expr)
      // directly emits `return expr;`. A bare `RETURN;` has no value to return, so we
      // default to `return *this;` which is correct for the common pattern where the
      // method returns its own FB as the interface implementor. Edge case: if the method
      // should return a different object, the user must use the assignment form instead.
      this.emit(`${indent}return *this;`);
    } else if (this.currentFunctionName) {
      this.emit(`${indent}return ${this.currentFunctionName}_result;`);
    } else {
      this.emit(`${indent}return;`);
    }
  }

  /**
   * C++ for a single CASE label. A typed integer literal (`INT#-7`) lowers to
   * its raw type: `IEC_INT` is not a literal type, so it cannot be a case label.
   */
  private caseLabelCpp(expr: Expression): string {
    const prefix =
      expr.kind === "LiteralExpression" && expr.literalType === "INT"
        ? (expr.typePrefix ?? "")
        : "";
    if (expr.kind === "LiteralExpression" && prefix !== "") {
      const payload = expr.rawValue.substring(expr.rawValue.indexOf("#") + 1);
      const value = formatIntegerLiteral(payload, expr.value as number);
      return `static_cast<${prefix.toUpperCase()}_t>(${value})`;
    }
    return this.generateExpression(expr);
  }

  /**
   * Evaluate an expression as a literal integer value (for CASE ranges and FOR step direction).
   * Returns undefined if the expression is not a compile-time integer constant.
   */
  private evaluateLiteralInt(expr: Expression): number | undefined {
    if (expr.kind === "LiteralExpression" && expr.literalType === "INT") {
      return typeof expr.value === "number"
        ? expr.value
        : parseInt(String(expr.value), 10);
    }
    if (
      expr.kind === "UnaryExpression" &&
      expr.operator === "-" &&
      expr.operand.kind === "LiteralExpression"
    ) {
      const val = this.evaluateLiteralInt(expr.operand);
      return val !== undefined ? -val : undefined;
    }
    return undefined;
  }

  /**
   * Generate code for a list of statements.
   */
  private generateStatements(
    stmts: Statement[],
    indent: string = "    ",
  ): void {
    for (const stmt of stmts) {
      this.generateStatement(stmt, indent);
    }
  }

  // ===========================================================================
  // Expression Generation (Phase 3.1)
  // ===========================================================================

  /**
   * Generate C++ code for an expression.
   * Returns the C++ expression as a string.
   */
  protected generateExpression(expr: Expression): string {
    switch (expr.kind) {
      case "LiteralExpression":
        return this.generateLiteralExpression(expr);
      case "VariableExpression": {
        const code = this.generateVariableExpression(expr);
        // A UNION member read yields its value; the proxy stays for writes.
        return expr.unionMember === true && !this.globalInOutTemps.has(expr)
          ? `union_read(${code})`
          : code;
      }
      case "BinaryExpression":
        return this.generateBinaryExpression(expr);
      case "UnaryExpression":
        return this.generateUnaryExpression(expr);
      case "ParenthesizedExpression":
        return `(${this.generateExpression(expr.expression)})`;
      case "FunctionCallExpression":
        return this.wrapGlobalInOutCall(expr, () =>
          this.generateFunctionCallExpression(expr),
        );
      case "MethodCallExpression":
        return this.wrapGlobalInOutCall(expr, () =>
          this.generateMethodCallExpression(expr),
        );
      case "RefExpression":
        return `REF(${this.addressedOperand(expr.operand, "REF", expr)})`;
      case "DrefExpression":
        return `${this.generateExpression(expr.operand)}.deref()`;
      case "NewExpression": {
        const cppType = this.typeCodeGen.mapTypeToCpp(expr.allocationType.name);
        if (expr.arraySize) {
          return `strucpp::iec_new_array<${cppType}>(${this.generateExpression(expr.arraySize)})`;
        }
        return `strucpp::iec_new<${cppType}>()`;
      }
      case "ArrayLiteralExpression": {
        const elements = expr.elements.map((e) => this.generateExpression(e));
        return `{${elements.join(", ")}}`;
      }
      case "StructInitializerExpression":
        // A structure initializer needs the target's C++ type, which only a
        // declaration supplies — declarations route through
        // `generateInitializer` instead. It is not an expression IEC allows in a
        // statement either, and the analyzer rejects it there
        // (`validateStructInitializerPlacement`), so this is unreachable for any
        // unit that got past semantic analysis. Loud rather than silent: the
        // previous `return "{}"` value-initialised, which discarded every
        // element the initializer named and produced no diagnostic anywhere.
        throw new Error(
          `Internal error: structure initializer at ${expr.sourceSpan.startLine}:` +
            `${expr.sourceSpan.startCol} reached expression codegen, where the ` +
            `target type is unknown. It is only valid as a declaration's initial value.`,
        );
    }
  }

  /**
   * Generate C++ for a literal expression.
   */
  private generateLiteralExpression(expr: LiteralExpression): string {
    if (expr.asNull === true) return "IEC_NULL";
    // Handle typed literals: BYTE#255 → static_cast<IEC_BYTE>(255)
    if (expr.typePrefix) {
      const cppType = `IEC_${expr.typePrefix}`;
      const hashIdx = expr.rawValue.indexOf("#");
      const valuePart = expr.rawValue.substring(hashIdx + 1);
      // An integer payload goes through the exact lowering too — `LINT#<64-bit>`
      // must not round, and `INT#0010` must not become a C++ octal constant.
      const cppValue =
        expr.literalType === "INT"
          ? formatIntegerLiteral(valuePart, expr.value as number)
          : iecBaseToCppLiteral(valuePart);
      return `static_cast<${cppType}>(${cppValue})`;
    }

    switch (expr.literalType) {
      case "BOOL":
        return expr.value === true ||
          expr.value === "TRUE" ||
          expr.rawValue?.toUpperCase() === "TRUE"
          ? "true"
          : "false";
      case "INT": {
        return formatIntegerLiteral(expr.rawValue, expr.value as number);
      }
      case "REAL": {
        const str = String(expr.value);
        // Ensure real literals have a decimal point (but not for scientific notation)
        return str.includes(".") || /[eE]/.test(str) ? str : str + ".0";
      }
      case "STRING": {
        // rawValue includes surrounding single quotes: 'hello' → strip them
        const inner = expr.rawValue.replace(/^'|'$/g, "");
        const escaped = translateIECString(inner);
        return `"${escaped}"`;
      }
      case "WSTRING": {
        // IEC WSTRING literals are double-quoted in source; strip either
        // form for safety. The C++ prefix is `u` (char16_t), not `L`
        // (wchar_t — wchar_t is 32-bit on Linux/AVR, so L"…" wouldn't
        // bind to IECWStringVar's char16_t* constructor).
        const wInner = expr.rawValue.replace(/^["']|["']$/g, "");
        const wEscaped = translateIECString(wInner, true);
        return `u"${wEscaped}"`;
      }
      case "TIME":
      case "LTIME": {
        const timeVal = parseTimeLiteral(String(expr.value));
        return `${timeVal.exact}LL`;
      }
      case "CHAR":
      case "WCHAR": {
        const { wide, units } = charLiteralUnits(expr.rawValue);
        return `static_cast<${wide ? "WCHAR_t" : "CHAR_t"}>(${Math.max(units[0] ?? 0, 0)})`;
      }
      case "DATE":
      case "LDATE":
        // DATE: int64 days since Unix epoch (UTC).  `iec_date.hpp`
        // stores DATE as days (see `DT_FROM_DATE_AND_TOD`'s
        // `iec_unwrap(date) * DT_NS_PER_DAY` math).  Lowering to ns
        // here would break every conversion / arithmetic helper.
        return `${parseDateLiteralToDays(String(expr.value))}LL`;
      case "TIME_OF_DAY":
      case "LTIME_OF_DAY":
        // TOD: int64 nanoseconds since midnight.
        return `${parseTodLiteralToNs(String(expr.value))}LL`;
      case "DATE_AND_TIME":
      case "LDATE_AND_TIME":
        // DT: int64 nanoseconds since Unix epoch (UTC).
        return `${parseDtLiteralToNs(String(expr.value))}LL`;
      case "NULL":
        return "IEC_NULL";
      default:
        return String(expr.value);
    }
  }

  /**
   * Generate C++ for an expression written to (or whose address is taken): a
   * UNION member stays its proxy instead of being read (see generateExpression).
   */
  private generateLvalue(expr: Expression): string {
    return expr.kind === "VariableExpression"
      ? this.generateVariableExpression(expr)
      : this.generateExpression(expr);
  }

  /**
   * Generate C++ for a variable expression.
   */
  private generateVariableExpression(expr: VariableExpression): string {
    // A composite global bound by copy-in/copy-out to a VAR_IN_OUT or
    // VAR_OUTPUT: the call binds the temporary (hoistGlobalInOutCopies).
    const copyInTemp = this.globalInOutTemps.get(expr);
    if (copyInTemp !== undefined) return copyInTemp;
    // Bound by reference to a VAR_IN_OUT of a method or function call.
    if (this.inOutBindExprs.has(expr)) return this.renderInOutBound(expr);
    const selfProperty = this.selfPropertyAccess(expr);
    if (selfProperty) return this.generateVariableExpression(selfProperty);

    const nameUpper = expr.name.toUpperCase();

    // A REFERENCE TO STRING / WSTRING read as a value: the bound variable, so
    // the string functions' templates see a string (no conversion deduced).
    if (!this.keepReferenceWrapper && this.isPlainStringReference(expr)) {
      return `${this.resolveVariableBaseName(expr.name)}.target()`;
    }

    // `PRG_A.x`: a member of a reached program's one shared instance.
    const reachedProgram = this.reachedProgramNamed(expr.name);
    if (reachedProgram !== undefined) {
      return this.renderAccessTail(
        this.sharedProgramInstance(reachedProgram),
        expr,
        nameUpper,
        reachedProgram,
      );
    }

    // A shared global is accessed under its own mutex: a scalar by
    // read()/write(), a composite through with_lock (below). Only a VAR_IN_OUT
    // binding reaches `g->value` directly, outside the lock (renderInOutBound).

    // VAR_EXTERNAL scalar read → lock the shared global and return its value.
    // read() yields the real IEC type, so it stays deduction-friendly in
    // std-lib templates (NOT/ADD/...). Composite externals use `->value`
    // directly (handled at the base below), not read().
    if (
      this.programExternals.has(nameUpper) &&
      !this.compositeExternals.has(nameUpper) &&
      expr.fieldAccess.length === 0 &&
      !expr.isDereference
    ) {
      return `${expr.name}->read()`;
    }

    // `p^` / `p^.x` on a VAR_EXTERNAL POINTER TO / REF_TO: dereference the
    // pointer the shared global holds, read under its lock.
    if (this.programExternals.has(nameUpper) && expr.isDereference) {
      return this.renderAccessTail(`${expr.name}->read()`, expr, nameUpper);
    }

    // Composite / array shared-global READ (VAR_EXTERNAL to a composite
    // VAR_GLOBAL). Take the global's own mutex and read the canonical value
    // directly through with_lock — a field/element read copies only that
    // sub-value, never the whole struct. The lock lives inside
    // GlobalVar::with_lock (compiled out when not STRUCPP_THREADED), and each
    // with_lock is self-contained (acquire → return → release), so several
    // composite-global reads in one expression are sequential, never nested.
    if (this.compositeExternals.has(nameUpper) && !expr.isDereference) {
      const ptr = this.resolveVariableBaseName(expr.name);
      const inner = this.renderAccessTail("(*__glk)", expr, nameUpper);
      return `${ptr}->with_lock([&](auto* __glk){ return ${inner}; })`;
    }

    // `THIS.a[i]`, `SUPER.p^.x`: a path with subscripts or dereferences
    // goes through the general access-chain renderer on the instance.
    if (
      (nameUpper === "THIS" ||
        (nameUpper === "SUPER" && this.currentFBExtends !== undefined)) &&
      expr.accessChain?.some((step) => step.kind !== "field") === true
    ) {
      return nameUpper === "THIS"
        ? this.renderAccessTail("(*this)", expr, nameUpper, this.currentFBName)
        : this.renderAccessTail(
            `static_cast<${this.currentFBExtends}&>(*this)`,
            expr,
            nameUpper,
            this.currentFBExtends,
          );
    }

    // Handle THIS reference
    if (nameUpper === "THIS") {
      // THIS^, or bare THIS (a reference to the own instance, bound to an
      // interface variable or input), with no field access → (*this)
      if (expr.fieldAccess.length === 0) {
        return "(*this)";
      }
      // THIS.member or THIS^.member → this->member
      // Check if last field is a property → this->get_Prop()
      let result = "this->";
      if (expr.fieldAccess.length > 0) {
        let currentType = this.currentFBName;
        for (let i = 0; i < expr.fieldAccess.length; i++) {
          const field = expr.fieldAccess[i]!;
          const isLast = i === expr.fieldAccess.length - 1;
          if (isLast) {
            const propName = this.resolvePropertyName(currentType, field);
            if (propName) {
              result += `get_${propName}()`;
              return result;
            }
          }
          const fieldType = this.resolveMemberType(currentType, field);
          const fieldCppName = this.needsFieldMangling(
            field,
            fieldType,
            currentType,
          )
            ? `${field}_`
            : field;
          if (i > 0) result += ".";
          result += fieldCppName;
          if (this.isRefInOutMember(currentType, field)) {
            result = `(*${result})`;
          }
          if (!isLast) {
            currentType = fieldType;
          }
        }
      }
      return result;
    }

    // Handle SUPER reference → BaseClass::member
    // Check if last field is a property → BaseClass::get_Prop()
    if (nameUpper === "SUPER" && this.currentFBExtends) {
      let result = `${this.currentFBExtends}::`;
      if (expr.fieldAccess.length > 0) {
        let currentType: string | undefined = this.currentFBExtends;
        for (let i = 0; i < expr.fieldAccess.length; i++) {
          const field = expr.fieldAccess[i]!;
          const isLast = i === expr.fieldAccess.length - 1;
          if (isLast) {
            const propName = this.resolvePropertyName(currentType, field);
            if (propName) {
              result += `get_${propName}()`;
              return result;
            }
          }
          const fieldType = this.resolveMemberType(currentType, field);
          const fieldCppName = this.needsFieldMangling(
            field,
            fieldType,
            currentType,
          )
            ? `${field}_`
            : field;
          if (i > 0) result += ".";
          result += fieldCppName;
          if (this.isRefInOutMember(currentType, field)) {
            result = `(*${result})`;
          }
          if (!isLast) {
            currentType = fieldType;
          }
        }
      }
      return result;
    }

    // In function/method bodies, references to the function/method name redirect to the result variable
    let result: string;
    if (
      this.currentFunctionName &&
      nameUpper === this.currentFunctionName.toUpperCase()
    ) {
      result = `${this.currentFunctionName}_result`;
    } else {
      // Check for VAR_INST name mangling
      const mangledName = this.varInstMangledNames.get(nameUpper);
      if (mangledName) {
        result = mangledName;
      } else {
        // Check for member name collision mangling (SENSOR SENSOR → SENSOR SENSOR_)
        const memberMangled = this.memberMangledNames.get(nameUpper);
        if (memberMangled) {
          result = memberMangled;
        } else {
          result = this.resolveVariableBaseName(expr.name);
        }
      }
    }

    // A CONFIGURATION global named by another one's initial value: its storage.
    if (this.configGlobalInitNames.has(nameUpper)) {
      result = `${globalCppName(expr.name)}.value`;
    }

    // A by-reference VAR_IN_OUT of the enclosing block: the caller's variable.
    if (
      this.scopeInOutRefs.has(nameUpper) &&
      !this.isCurrentFunctionResult(nameUpper)
    ) {
      result = `(*${result})`;
    }

    // A member of several enums, settled by its target's type.
    if (expr.enumType !== undefined) return `${expr.enumType}::${expr.name}`;

    // Bare enum member: Stopped → Irrigation_State::Stopped
    // Only qualify if the name is NOT a declared variable in the current scope
    // (a local variable named RED should not be rewritten as Color::RED).
    // Nor the return variable of the function or method being generated.
    const enumEntry = this.enumMemberToType.get(nameUpper);
    if (
      enumEntry?.typeName &&
      !this.currentScopeVarTypes.has(nameUpper) &&
      !this.isCurrentFunctionResult(nameUpper) &&
      // In a SET body the property's name is the value being set.
      this.currentSetterProperty !== nameUpper &&
      expr.fieldAccess.length === 0 &&
      (!expr.accessChain || expr.accessChain.length === 0)
    ) {
      return `${enumEntry.typeName}::${expr.name}`;
    }

    // Enum qualified access: TrafficState.RED → TrafficState::RED
    if (this.enumTypeMembers.has(nameUpper)) {
      if (
        expr.accessChain &&
        expr.accessChain.length === 1 &&
        expr.accessChain[0]!.kind === "field"
      ) {
        return `${expr.name}::${expr.accessChain[0]!.name}`;
      }
      if (expr.fieldAccess.length === 1) {
        return `${expr.name}::${expr.fieldAccess[0]}`;
      }
    }

    if (this.reachesThroughReference(expr)) result = `${result}.target()`;
    return this.renderAccessTail(result, expr, nameUpper);
  }

  /**
   * The object REF / ADR / REF= takes the address of: a shared global's
   * canonical storage (`g->value`, unlocked, with a warning), else the
   * operand as an lvalue.
   */
  private addressedOperand(
    operand: Expression,
    what: string,
    at: { sourceSpan: SourceSpan },
  ): string {
    if (
      operand.kind === "VariableExpression" &&
      !operand.isDereference &&
      this.programExternals.has(operand.name.toUpperCase())
    ) {
      if (this.tasksMayRace()) {
        this.codegenWarnings.push({
          message:
            `${what} of the shared global '${operand.name}': in a build with STRUCPP_THREADED, ` +
            `accesses through the result are not serialized by the global's lock, ` +
            `so another task using '${operand.name}' at the same time races with them`,
          line: at.sourceSpan.startLine,
          column: at.sourceSpan.startCol,
          file: at.sourceSpan.file,
        });
      }
      return this.renderInOutBound(operand);
    }
    return what === "ADR"
      ? this.generateLvalue(operand)
      : this.generateExpression(operand);
  }

  /** {@link typeShadowingMemberNames} of the unit, computed once per AST. */
  private shadowingNamesCache:
    | { ast: CompilationUnit; names: Set<string> }
    | undefined;

  private shadowingNames(): Set<string> | undefined {
    if (!this.ast) return undefined;
    if (this.shadowingNamesCache?.ast !== this.ast) {
      this.shadowingNamesCache = {
        ast: this.ast,
        names: typeShadowingMemberNames(this.ast),
      };
    }
    return this.shadowingNamesCache.names;
  }

  /** A local's C++ name: renamed as the body names it (see enterScope). */
  private localCppName(name: string): string {
    return this.memberMangledNames.get(name.toUpperCase()) ?? name;
  }

  /** Set while a REF= target is generated: it names the reference itself. */
  private keepReferenceWrapper = false;

  /** `rr`, a REFERENCE TO STRING / WSTRING variable of the scope, with no access. */
  private isPlainStringReference(expr: VariableExpression): boolean {
    const upper = expr.name.toUpperCase();
    if (
      this.currentScopeVarRefKinds.get(upper) !== "reference_to" ||
      this.isCurrentFunctionResult(upper) ||
      expr.isDereference ||
      expr.fieldAccess.length > 0 ||
      expr.subscripts.length > 0 ||
      (expr.accessChain?.length ?? 0) > 0
    ) {
      return false;
    }
    const type = this.currentScopeVarTypeRefs.get(upper);
    if (type === undefined || (type.referenceChain?.length ?? 1) !== 1) {
      return false;
    }
    const base = type.name.toUpperCase();
    return base === "STRING" || base === "WSTRING";
  }

  /**
   * `r.member` / `r[i]` on a REFERENCE TO variable of the scope: the access
   * applies to the bound object (`r.target()`), not to the reference.
   */
  private reachesThroughReference(expr: VariableExpression): boolean {
    const upper = expr.name.toUpperCase();
    if (
      this.currentScopeVarRefKinds.get(upper) !== "reference_to" ||
      this.isCurrentFunctionResult(upper) ||
      expr.isDereference
    ) {
      return false;
    }
    const first = expr.accessChain?.[0];
    if (first !== undefined) {
      return (
        first.kind === "subscript" ||
        (first.kind === "field" &&
          !/^\d+$/.test(first.name) &&
          !(expr.namedBitIndex === true && expr.accessChain!.length === 1))
      );
    }
    if (expr.subscripts.length > 0) return true;
    const field = expr.fieldAccess[0];
    return (
      field !== undefined &&
      !/^\d+$/.test(field) &&
      !(expr.namedBitIndex === true && expr.fieldAccess.length === 1)
    );
  }

  /**
   * A bare name inside a function block naming a PROPERTY of it or of a base
   * (`P`, no variable of that name in scope) as `THIS.P`; else undefined.
   */
  private selfPropertyAccess(
    expr: VariableExpression,
  ): VariableExpression | undefined {
    const upper = expr.name.toUpperCase();
    if (
      this.currentFBName === undefined ||
      expr.fieldAccess.length > 0 ||
      expr.subscripts.length > 0 ||
      expr.isDereference ||
      (expr.accessChain?.length ?? 0) > 0 ||
      this.currentScopeVarTypes.has(upper) ||
      this.isCurrentFunctionResult(upper) ||
      this.currentSetterProperty === upper ||
      this.resolvePropertyName(this.currentFBName, expr.name) === undefined
    ) {
      return undefined;
    }
    return {
      ...expr,
      name: "THIS",
      fieldAccess: [expr.name],
      accessChain: [{ kind: "field", name: expr.name }],
    };
  }

  /** `nameUpper` names the result variable of the function being generated. */
  private isCurrentFunctionResult(nameUpper: string): boolean {
    return this.currentFunctionName?.toUpperCase() === nameUpper;
  }

  /**
   * Render an expression's access chain (subscripts / field access / bit access /
   * dereference) onto a given base string. Factored out of
   * generateVariableExpression so the same access logic can be rendered onto a
   * different base — e.g. `(*p)` inside a composite shared-global `with_lock`
   * lambda.
   */
  private renderAccessTail(
    base: string,
    expr: VariableExpression,
    nameUpper: string,
    baseType?: string,
  ): string {
    let result = base;

    // Use ordered access chain when available (preserves interleaving)
    if (expr.accessChain && expr.accessChain.length > 0) {
      return this.generateAccessChain(
        result,
        expr.accessChain,
        nameUpper,
        baseType,
        expr.namedBitIndex === true,
      );
    }

    // Legacy path: flat subscripts/fieldAccess/dereference (no interleaving)
    // Subscripts (array access). Use the bounds-checked .at() accessor (1D and
    // 2D+) so an out-of-range index raises a clean fault — throw on exception
    // targets (caught by the runtime, stops the faulting task), or
    // iec_runtime_fault(ArrayBounds) on -fno-exceptions MCU targets — instead of
    // the unchecked operator[]/operator() that silently corrupts memory.
    if (expr.subscripts.length > 1) {
      const args = expr.subscripts.map((sub) => this.generateExpression(sub));
      result += `.at(${args.join(", ")})`;
    } else {
      for (const sub of expr.subscripts) {
        result += `.at(${this.generateExpression(sub)})`;
      }
    }

    // Field access (struct members) — detect property reads and bit access on last field
    if (expr.fieldAccess.length > 0) {
      let currentType = baseType ?? this.rootVariableType(nameUpper);
      for (let i = 0; i < expr.fieldAccess.length; i++) {
        const field = expr.fieldAccess[i]!;
        const isLast = i === expr.fieldAccess.length - 1;
        // Bit access: numeric field like .0, .15, .31 → ((var >> N) & 1)
        const bit = this.bitIndexCode(field, isLast && expr.namedBitIndex);
        if (bit !== undefined) {
          result = `((static_cast<uint64_t>(${result}) >> ${bit}) & 1)`;
          continue;
        }
        if (isLast) {
          const propName = this.resolvePropertyName(currentType, field);
          if (propName) {
            result = this.propertyRead(result, currentType, propName);
            continue;
          }
        }
        // Check if this field needs mangling (name == type or interface method in parent)
        const fieldType = this.resolveMemberType(currentType, field);
        const fieldCppName = this.needsFieldMangling(
          field,
          fieldType,
          currentType,
        )
          ? `${field}_`
          : field;
        result += `.${fieldCppName}`;
        if (this.isRefInOutMember(currentType, field)) {
          result = `(*${result})`;
        }
        if (!isLast) {
          currentType = fieldType;
        }
      }
    }

    // Dereference (^ operator → pointer dereference)
    if (expr.isDereference) {
      result = `(*${result})`;
    }

    return result;
  }

  /**
   * The C++ bit index a field selects: a numeric field as written, a named
   * constant (`w.C_BIT`, `named`) as its value; undefined for a member.
   */
  private bitIndexCode(
    field: string,
    named: boolean | undefined,
  ): string | undefined {
    if (/^\d+$/.test(field)) return field;
    if (named !== true) return undefined;
    const index = this.generateExpression({
      kind: "VariableExpression",
      sourceSpan: {
        file: "",
        startLine: 0,
        startCol: 0,
        endLine: 0,
        endCol: 0,
      },
      name: field,
      subscripts: [],
      fieldAccess: [],
      isDereference: false,
    });
    return `static_cast<uint64_t>(${index})`;
  }

  /** The bit index the last field of `expr` selects, if it is a bit access. */
  private lastFieldBitIndex(expr: VariableExpression): string | undefined {
    const last = expr.fieldAccess[expr.fieldAccess.length - 1];
    return last === undefined
      ? undefined
      : this.bitIndexCode(last, expr.namedBitIndex);
  }

  /**
   * Generate C++ code from an ordered access chain.
   * Handles correct interleaving of field accesses, subscripts, and dereferences.
   *
   * Key rules:
   * - field after subscript: use -> (because Array operator[] returns IECVar<T>&)
   * - field after field: use .
   * - field after dereference: use .
   * - subscript of 1 index: use [idx]
   * - subscript of 2+ indices: use (idx1, idx2) (multidim Array)
   * - dereference: wrap in (*...)
   */
  private generateAccessChain(
    base: string,
    chain: AccessStep[],
    baseNameUpper: string,
    baseType?: string,
    namedBit = false,
  ): string {
    let result = base;
    let currentType = baseType ?? this.rootVariableType(baseNameUpper);

    for (let i = 0; i < chain.length; i++) {
      const step = chain[i]!;
      const isLast = i === chain.length - 1;

      switch (step.kind) {
        case "field": {
          // Bit access: numeric field like .0, .15, .31
          const bit = this.bitIndexCode(step.name, isLast && namedBit);
          if (bit !== undefined) {
            result = `((static_cast<uint64_t>(${result}) >> ${bit}) & 1)`;
            continue;
          }
          // Property access on the last step
          if (isLast) {
            const propName = this.resolvePropertyName(currentType, step.name);
            if (propName) {
              return this.propertyRead(result, currentType, propName);
            }
          }
          const fieldType = this.resolveMemberType(currentType, step.name);
          const fieldCppName = this.needsFieldMangling(
            step.name,
            fieldType,
            currentType,
          )
            ? `${step.name}_`
            : step.name;
          // Array elements store T directly — always use . for field access
          result += `.${fieldCppName}`;
          if (this.isRefInOutMember(currentType, step.name)) {
            result = `(*${result})`;
          }
          currentType = fieldType;
          break;
        }
        case "subscript": {
          // Bounds-checked .at() (not operator[]/operator()): an out-of-range
          // IEC array index raises a clean fault — `throw` on exception targets
          // (the runtime v4 dispatcher catches it and stops just the faulting
          // task) and iec_runtime_fault(IecFault::ArrayBounds) on -fno-exceptions
          // MCU targets. operator[] stays unchecked+constexpr for the debug-table
          // generator's &arr[i] address-of expressions; POU bodies use .at().
          if (step.indices.length > 1) {
            const args = step.indices.map((idx) =>
              this.generateExpression(idx),
            );
            result += `.at(${args.join(", ")})`;
          } else if (step.indices.length === 1) {
            result += `.at(${this.generateExpression(step.indices[0]!)})`;
          }
          break;
        }
        case "dereference": {
          result = `(*${result})`;
          break;
        }
      }
    }

    return result;
  }

  /**
   * Operator mapping from ST to C++.
   */
  private static readonly BINARY_OP_MAP: Record<string, string> = {
    "+": "+",
    "-": "-",
    "*": "*",
    "/": "/",
    MOD: "%",
    AND: "&",
    OR: "|",
    XOR: "^",
    "=": "==",
    "<>": "!=",
    "<": "<",
    ">": ">",
    "<=": "<=",
    ">=": ">=",
  };

  /**
   * Generate C++ for a binary expression.
   */
  private generateBinaryExpression(expr: BinaryExpression): string {
    const left = this.generateExpression(expr.left);
    const right = this.generateExpression(expr.right);

    // STRUCT = / <> STRUCT: memberwise, each operand evaluated once
    // Not when a pointer or reference to the STRUCT is compared itself.
    if (
      (expr.operator === "=" || expr.operator === "<>") &&
      expr.comparesReferences !== true
    ) {
      const structName =
        this.comparedStructName(expr.left) ??
        this.comparedStructName(expr.right);
      if (structName !== undefined) {
        const l = this.structOperand(expr.left, left);
        const r = this.structOperand(expr.right, right);
        const eq = `[&](const auto& __l, const auto& __r) { return ${this.memberwiseEqual(structName, "__l", "__r", 0)}; }(${l}, ${r})`;
        return expr.operator === "=" ? eq : `!${eq}`;
      }
    }

    // Power operator needs special handling
    if (expr.operator === "**") {
      return `std::pow(static_cast<double>(${left}), static_cast<double>(${right}))`;
    }

    const cppOp = CodeGenerator.BINARY_OP_MAP[expr.operator] ?? expr.operator;

    // Date arithmetic: a DATE or LDATE holds days, a duration nanoseconds.
    const ldate = this.dateArithmetic(expr, left, right);
    if (ldate !== undefined) return ldate;

    // CHAR ordering compares Windows-1252 codes, not signed C++ chars.
    if (["<", ">", "<=", ">="].includes(expr.operator)) {
      if (this.isCharExpr(expr.left) || this.isCharExpr(expr.right)) {
        return `${this.charCode(expr.left, left)} ${cppOp} ${this.charCode(expr.right, right)}`;
      }
    }

    // IEC 61131-3 AND/OR/XOR are always bitwise. C++ bitwise & | ^ have
    // higher precedence than comparison operators (== != < >), unlike ST
    // where AND/OR have lower precedence. Parenthesize operands to preserve
    // the correct evaluation order.
    if (
      expr.operator === "AND" ||
      expr.operator === "OR" ||
      expr.operator === "XOR"
    ) {
      return `(${left}) ${cppOp} (${right})`;
    }

    // A comparison nested directly in a comparison comes from a chain such
    // as `a < b = c`; parenthesise it so C++ keeps the ST grouping.
    if (isComparison(expr.operator)) {
      const l = isComparisonExpr(expr.left) ? `(${left})` : left;
      const r = isComparisonExpr(expr.right) ? `(${right})` : right;
      return `${l} ${cppOp} ${r}`;
    }

    // MOD by a divisor that may be 0 gives 0 (Table 29, note e)
    if (expr.operator === "MOD" && !isNonZeroIntegerLiteral(expr.right)) {
      return `iec_mod(${left}, ${right})`;
    }

    return `${left} ${cppOp} ${right}`;
  }

  /**
   * `a - b` of two dates (DATE or LDATE) gives a duration in nanoseconds
   * (Table 35: DATE - DATE is a TIME), and a date plus or minus a duration
   * moves it by whole days; undefined for any other operation.
   */
  private dateArithmetic(
    expr: BinaryExpression,
    left: string,
    right: string,
  ): string | undefined {
    return dateArithmeticCpp(
      expr.operator,
      this.temporalBase(expr.left),
      this.temporalBase(expr.right),
      left,
      right,
    );
  }

  /**
   * The canonical elementary type of a temporal operand, through aliases, a
   * dereference, parentheses and the untyped CONCAT_DATE_TOD (a DT).
   */
  private temporalBase(e: Expression): string | undefined {
    if (e.kind === "ParenthesizedExpression")
      return this.temporalBase(e.expression);
    // SEL, MUX, LIMIT, MAX and MIN yield the type their operands share.
    const selected = this.selectionOperands(e);
    if (selected !== undefined) {
      const kinds = selected.map((a) => this.temporalBase(a));
      return kinds.length > 0 && kinds.every((k) => k === kinds[0])
        ? kinds[0]
        : undefined;
    }
    const literal = literalTemporalType(e);
    if (literal !== undefined && e.resolvedType === undefined) return literal;
    let t = e.resolvedType;
    if (t?.typeKind === "reference") t = (t as ReferenceType).referencedType;
    let name: string | undefined =
      t?.typeKind === "elementary"
        ? (t as ElementaryType).name.toUpperCase()
        : t === undefined
          ? this.inferExprType(e)
          : undefined;
    if (
      name === undefined &&
      e.kind === "FunctionCallExpression" &&
      e.functionName.toUpperCase() === "CONCAT_DATE_TOD"
    ) {
      name = "DT";
    }
    for (let i = 0; i < 32 && name !== undefined; i++) {
      const upper = name;
      const def = this.ast?.types.find(
        (d) => d.name.toUpperCase() === upper,
      )?.definition;
      if (def?.kind !== "TypeReference" || def.arrayDimensions !== undefined) {
        break;
      }
      name = def.name.toUpperCase();
    }
    return name === undefined ? undefined : canonicalElementaryName(name);
  }

  /** The selected or compared operands of a standard SEL, MUX, LIMIT, MAX or MIN call. */
  private selectionOperands(e: Expression): Expression[] | undefined {
    if (e.kind !== "FunctionCallExpression" || e.instance !== undefined) {
      return undefined;
    }
    const name = e.functionName.toUpperCase();
    const skip: Record<string, number> = {
      SEL: 1,
      MUX: 1,
      LIMIT: 0,
      MAX: 0,
      MIN: 0,
    };
    if (skip[name] === undefined) return undefined;
    if (
      this.ast?.functions.some((f) => f.name.toUpperCase() === name) === true
    ) {
      return undefined;
    }
    if (e.libraryFunction !== undefined) return undefined;
    return e.arguments
      .filter((a) => !isEnEnoArgument(a))
      .slice(skip[name])
      .map((a) => a.value);
  }

  /**
   * A standard MAX/MIN/LIMIT/comparison/SEL/MUX call with CHAR or WCHAR
   * operands; undefined for any other call. A nested EN/ENO runs the call
   * only when EN is TRUE and writes ENO, as the statement form does.
   */
  private charStdCall(
    stdFunc: { name: string; cppName: string },
    expr: FunctionCallExpression,
    args: readonly string[],
  ): string | undefined {
    const name = stdFunc.name.toUpperCase();
    const ordered = CHAR_ORDERED_FUNCTIONS.has(name);
    if (
      !ordered &&
      name !== "SEL" &&
      name !== "MUX" &&
      name !== "EQ" &&
      name !== "NE"
    ) {
      return undefined;
    }
    const all = expr.arguments;
    const operands = all.filter((a) => !isEnEnoArgument(a));
    const isChar = operands.some((a) => this.isCharExpr(a.value));
    if (!isChar && !operands.some((a) => this.isWcharExpr(a.value))) {
      return undefined;
    }
    let en: string | null = null;
    let eno: string | null = null;
    const coded: string[] = [];
    for (const [i, a] of all.entries()) {
      const code = args[i] ?? "";
      if (!isEnEnoArgument(a)) {
        coded.push(ordered ? this.charCode(a.value, code) : code);
      } else if (a.isOutput) {
        eno = code;
      } else {
        en = code;
      }
    }
    let call = `${stdFunc.cppName}(${coded.join(", ")})`;
    if (isChar && ["MAX", "MIN", "LIMIT"].includes(name)) {
      call = `static_cast<CHAR_t>(${call})`;
    }
    if (en === null && eno === null) return call;
    const setEno = (v: string): string =>
      eno === null ? "" : `${eno} = ${v}; `;
    if (en === null) return `[&]() { ${setEno("true")}return ${call}; }()`;
    return `[&]() { const bool en_ = ${en}; ${setEno("en_")}return en_ ? ${call} : decltype(${call}){}; }()`;
  }

  /** True when the expression is a WCHAR, through aliases of it. */
  private isWcharExpr(e: Expression): boolean {
    const t = e.resolvedType;
    if (t?.typeKind !== "elementary") return false;
    let name = (t as ElementaryType).name.toUpperCase();
    for (let i = 0; i < 32 && name !== "WCHAR"; i++) {
      const upper = name;
      const def = this.ast?.types.find(
        (d) => d.name.toUpperCase() === upper,
      )?.definition;
      if (def?.kind !== "TypeReference") return false;
      name = def.name.toUpperCase();
    }
    return name === "WCHAR";
  }

  /** True when the expression is a CHAR, through aliases of it. */
  private isCharExpr(e: Expression): boolean {
    const t = e.resolvedType;
    if (t?.typeKind !== "elementary") return false;
    let name = (t as ElementaryType).name.toUpperCase();
    for (let i = 0; i < 32 && name !== "CHAR"; i++) {
      const upper = name;
      const def = this.ast?.types.find(
        (d) => d.name.toUpperCase() === upper,
      )?.definition;
      if (def?.kind !== "TypeReference") return false;
      name = def.name.toUpperCase();
    }
    return name === "CHAR";
  }

  /** A CHAR operand as its unsigned Windows-1252 code; anything else unchanged. */
  private charCode(e: Expression, code: string): string {
    return this.isCharExpr(e)
      ? `static_cast<uint8_t>(iec_unwrap(${code}))`
      : code;
  }

  /** The fields of STRUCT `typeName` (through aliases), or undefined for any other type. */
  private structFieldsOf(typeName: string): VarDeclaration[] | undefined {
    const seen = new Set<string>();
    let name = typeName.toUpperCase();
    while (!seen.has(name)) {
      seen.add(name);
      const upper = name;
      const decl = this.ast?.types.find((t) => t.name.toUpperCase() === upper);
      const def = decl?.definition;
      if (def?.kind === "StructDefinition") {
        return def.isUnion === true ? undefined : def.fields;
      }
      if (
        def?.kind !== "TypeReference" ||
        def.referenceKind !== "none" ||
        def.arrayDimensions !== undefined
      ) {
        return undefined;
      }
      name = def.name.toUpperCase();
    }
    return undefined;
  }

  /** The element type of an ARRAY type (inline or named, through aliases), else undefined. */
  private arrayElementTypeOf(type: TypeReference): string | undefined {
    if (type.referenceKind !== "none") return undefined;
    if (type.arrayDimensions !== undefined) return type.elementTypeName;
    const seen = new Set<string>();
    let name = type.name.toUpperCase();
    while (!seen.has(name)) {
      seen.add(name);
      const upper = name;
      const def = this.ast?.types.find(
        (t) => t.name.toUpperCase() === upper,
      )?.definition;
      if (def?.kind === "ArrayDefinition") {
        return def.elementType.referenceKind === "none"
          ? def.elementType.name
          : undefined;
      }
      if (def?.kind !== "TypeReference" || def.referenceKind !== "none") {
        return undefined;
      }
      if (def.arrayDimensions !== undefined) return def.elementTypeName;
      name = def.name.toUpperCase();
    }
    return undefined;
  }

  /**
   * C++ for `l = r` on two values of type `typeName`: field by field for a
   * STRUCT, element by element for an ARRAY, else `==`.
   */
  /**
   * The STRUCT an operand of `=` / `<>` is a value of: by its checked type,
   * or for a variable reached through `^` or a REFERENCE TO, by its
   * declaration. Undefined for anything else.
   */
  /** The STRUCT type an operand of `=` / `<>` is compared as, if any. */
  protected structOperandName(expr: Expression): string | undefined {
    return this.comparedStructName(expr);
  }

  private comparedStructName(expr: Expression): string | undefined {
    const rt = expr.resolvedType;
    if (rt !== undefined && "name" in rt && typeof rt.name === "string") {
      if (this.structFieldsOf(rt.name) !== undefined) return rt.name;
    }
    if (expr.kind !== "VariableExpression") return undefined;
    const upper = expr.name.toUpperCase();
    const root = this.currentScopeVarTypeRefs.get(upper);
    if (root === undefined) return undefined;
    const hasAccess =
      expr.subscripts.length > 0 ||
      expr.fieldAccess.length > 0 ||
      expr.isDereference ||
      (expr.accessChain !== undefined && expr.accessChain.length > 0);
    const type = hasAccess
      ? resolveAccessType(root, expr, this.accessLookup)
      : root;
    if (type === undefined || type.arrayDimensions !== undefined) {
      return undefined;
    }
    const kind = type.referenceKind ?? "none";
    // A REF_TO / POINTER TO itself is compared as a reference.
    if (kind !== "none" && !(kind === "reference_to" && !hasAccess)) {
      return undefined;
    }
    return this.structFieldsOf(type.name) !== undefined ? type.name : undefined;
  }

  /** A STRUCT operand as its value: a plain REFERENCE TO is its target. */
  private structOperand(expr: Expression, generated: string): string {
    if (
      expr.kind === "VariableExpression" &&
      this.currentScopeVarRefKinds.get(expr.name.toUpperCase()) ===
        "reference_to" &&
      !expr.isDereference &&
      expr.fieldAccess.length === 0 &&
      expr.subscripts.length === 0 &&
      (expr.accessChain?.length ?? 0) === 0
    ) {
      return `${this.resolveVariableBaseName(expr.name)}.target()`;
    }
    return generated;
  }

  private memberwiseEqual(
    typeName: string,
    l: string,
    r: string,
    depth: number,
  ): string {
    const fields = this.structFieldsOf(typeName);
    if (fields === undefined) return `(${l} == ${r})`;
    const parts: string[] = [];
    for (const field of fields) {
      for (const name of field.names) {
        const member = this.needsFieldMangling(name, field.type.name, typeName)
          ? `${name}_`
          : name;
        const fl = `${l}.${member}`;
        const fr = `${r}.${member}`;
        const element = this.arrayElementTypeOf(field.type);
        if (element !== undefined) {
          const x = `__x${depth}`;
          const y = `__y${depth}`;
          parts.push(
            `::strucpp::iec_equal_each(${fl}, ${fr}, [&](const auto& ${x}, const auto& ${y}) { return ${this.memberwiseEqual(element, x, y, depth + 1)}; })`,
          );
        } else if (field.type.referenceKind !== "none") {
          parts.push(`(${fl} == ${fr})`);
        } else {
          parts.push(this.memberwiseEqual(field.type.name, fl, fr, depth));
        }
      }
    }
    return parts.length === 0 ? "true" : `(${parts.join(" && ")})`;
  }

  /**
   * Generate C++ for a unary expression.
   */
  private generateUnaryExpression(expr: UnaryExpression): string {
    const operand = this.generateExpression(expr.operand);

    switch (expr.operator) {
      case "NOT": {
        // NOT on non-BOOL ANY_BIT types must use bitwise complement (~)
        const opType = this.inferExprType(expr.operand);
        if (opType) {
          const cat = getTypeCategory(opType.toUpperCase());
          if (cat === "BIT" && opType.toUpperCase() !== "BOOL") {
            return `~${operand}`;
          }
        }
        return `!${operand}`;
      }
      case "-":
        return `-${operand}`;
      case "+":
        return `+${operand}`;
    }
  }

  /**
   * Generate C++ for a method call expression (chained method calls).
   * e.g., fb.method1(args).method2(args) → fb.method1(args).method2(args)
   */
  private generateMethodCallExpression(expr: MethodCallExpression): string {
    const obj = this.generateExpression(expr.object);
    // Try type-specific resolution first (avoids collisions when two FBs share a method name)
    const ownerType = this.methodCallOwnerType(expr.object);
    const resolvedName = ownerType
      ? this.resolveMethodName(ownerType, expr.methodName)
      : this.resolveMethodNameGlobal(expr.methodName);
    const args = this.generateMethodCallArgs(
      ownerType,
      expr.methodName,
      expr.arguments,
      expr.sourceSpan,
    ).join(", ");
    // Through an interface, the call goes to the instance it refers to.
    const receiver =
      ownerType !== undefined && this.isInterfaceType(ownerType)
        ? `itf_ref(${obj})`
        : obj;
    return `${receiver}.${resolvedName}(${args})`;
  }

  /**
   * The type that owns the method of a method call on `object`: a variable's
   * declared type, or the type a member chain lands on (`a.b`, `arr[i]`,
   * `THIS.f`, `SUPER.f`). Undefined for any other object or an unresolved step.
   */
  private methodCallOwnerType(object: Expression): string | undefined {
    if (object.kind !== "VariableExpression") return undefined;
    const root = object.name.toUpperCase();
    let type: string | undefined =
      root === "THIS" && object.fieldAccess.length > 0
        ? this.currentFBName
        : root === "SUPER" && object.fieldAccess.length > 0
          ? this.currentFBExtends
          : (this.currentScopeVarTypes.get(root) ??
            this.reachedProgramNamed(root));
    const steps: AccessStep[] = object.accessChain ?? [
      ...(object.subscripts.length > 0
        ? [{ kind: "subscript" as const, indices: object.subscripts }]
        : []),
      ...object.fieldAccess.map((name) => ({ kind: "field" as const, name })),
    ];
    for (const step of steps) {
      if (type === undefined) return undefined;
      if (step.kind === "field") {
        type = this.resolveMemberType(type, step.name);
      } else if (step.kind === "subscript") {
        type = this.ast
          ? resolveArrayElementTypeUtil(type, this.ast)
          : undefined;
      }
    }
    return type;
  }

  // ===========================================================================
  // Implicit type widening / argument coercion helpers
  // ===========================================================================

  /**
   * Returns true when `source` can be implicitly widened to `target`.
   * Covers same-category widening (BYTE→DWORD), BIT→INT crossover (BYTE→INT),
   * and integer→REAL promotion.
   */
  private canImplicitWiden(source: string, target: string): boolean {
    return isImplicitlyConvertible(source, target);
  }

  /**
   * Lightweight type inference for an expression using the current scope's
   * variable type map. Returns the IEC type name (upper case) or undefined.
   */
  private inferExprType(expr: Expression): string | undefined {
    // A 0 stored in an interface (interface_zero) is NULL, untyped like it
    if (expr.kind === "LiteralExpression" && expr.asNull === true) {
      return undefined;
    }
    // Use pre-computed type from semantic analysis when available
    if (expr.resolvedType) {
      const name = typeNameUtil(expr.resolvedType);
      if (name) return name.toUpperCase();
    }
    // Fallback to ad-hoc inference for standalone codegen (tests without semantic analysis)
    switch (expr.kind) {
      case "VariableExpression": {
        // Walk `fieldAccess` so `FB_INSTANCE.OUTPUT` resolves to the
        // output's element type rather than the FB's type — without
        // this, type-driven literal casts (see `harmonizeStdFuncArgs`)
        // would synthesise `static_cast<IEC_<FB_TYPE>>(literal)`, and
        // `IEC_<FB_TYPE>` aliases don't exist (only types emit them).
        let type = this.currentScopeVarTypes.get(expr.name.toUpperCase());
        if (!type) return undefined;
        for (const field of expr.fieldAccess ?? []) {
          const next = this.resolveMemberType(type, field);
          if (!next) return undefined;
          type = next;
        }
        return type.toUpperCase();
      }
      case "LiteralExpression": {
        if (expr.typePrefix) return expr.typePrefix.toUpperCase();
        // Map literal types to IEC names
        switch (expr.literalType) {
          case "INT":
            return "INT";
          case "REAL":
            return "REAL";
          case "BOOL":
            return "BOOL";
          case "STRING":
            return "STRING";
          default:
            return undefined;
        }
      }
      case "UnaryExpression":
        return this.inferExprType(expr.operand);
      case "BinaryExpression": {
        // For bitwise/arithmetic ops, infer from operands
        const lt = this.inferExprType(expr.left);
        const rt = this.inferExprType(expr.right);
        // Prefer variable types over literal types
        if (lt && rt) {
          const lBits = getTypeBits(lt) ?? 0;
          const rBits = getTypeBits(rt) ?? 0;
          return rBits > lBits ? rt : lt;
        }
        return lt ?? rt;
      }
      case "FunctionCallExpression": {
        const fnUpper = expr.functionName.toUpperCase();
        const ownMethod = this.ownMethodCalled(expr);
        if (ownMethod) return ownMethod.returnType?.name.toUpperCase();
        // Check user-defined functions
        if (this.ast) {
          const funcDecl = this.ast.functions.find(
            (f) => f.name.toUpperCase() === fnUpper,
          );
          if (funcDecl) return funcDecl.returnType?.name.toUpperCase();
        }
        // Check conversion functions (INT_TO_REAL → REAL)
        const conv = this.stdRegistry.resolveConversion(fnUpper);
        if (conv) return conv.toType.toUpperCase();
        // Check std functions with specific return type (and TRUNC_INT)
        const std =
          this.stdRegistry.lookup(fnUpper) ?? this.typedTrunc(fnUpper);
        if (std?.specificReturnType)
          return std.specificReturnType.toUpperCase();
        if (std?.returnTypeFor && expr.arguments.length > 0) {
          const at = this.inferExprType(expr.arguments[0]!.value);
          const mapped = at && std.returnTypeFor(at.toUpperCase());
          if (mapped === "LINT" && this.truncToDint(expr)) return "DINT";
          if (mapped) return mapped;
        }
        // For generic functions returning same type as first param, infer from first arg
        if (std?.returnMatchesFirstParam && expr.arguments.length > 0) {
          return this.inferExprType(expr.arguments[0]!.value);
        }
        return undefined;
      }
      case "MethodCallExpression": {
        // Resolve object type → find FB declaration → find method → return type
        if (expr.object.kind === "VariableExpression") {
          const objType = this.currentScopeVarTypes.get(
            expr.object.name.toUpperCase(),
          );
          if (objType && this.ast) {
            const fb = this.ast.functionBlocks.find(
              (f) => f.name.toUpperCase() === objType.toUpperCase(),
            );
            if (fb) {
              const method = fb.methods.find(
                (m) => m.name.toUpperCase() === expr.methodName.toUpperCase(),
              );
              if (method?.returnType) {
                return method.returnType.name.toUpperCase();
              }
            }
          }
        }
        return undefined;
      }
      case "ParenthesizedExpression":
        return this.inferExprType(expr.expression);
      default:
        return undefined;
    }
  }

  /**
   * Extract ordered parameter types from a user-defined function declaration.
   * Returns undefined if function not found.
   */
  private getParamTypes(funcName: string): string[] | undefined {
    if (!this.ast) return undefined;
    const nameUpper = funcName.toUpperCase();
    const funcDecl = this.ast.functions.find(
      (f) => f.name.toUpperCase() === nameUpper,
    );
    if (!funcDecl) return undefined;
    const types: string[] = [];
    for (const block of funcDecl.varBlocks) {
      if (
        block.blockType === "VAR_INPUT" ||
        block.blockType === "VAR_IN_OUT" ||
        block.blockType === "VAR_OUTPUT"
      ) {
        for (const decl of block.declarations) {
          for (let i = 0; i < decl.names.length; i++) {
            types.push(decl.type.name.toUpperCase());
          }
        }
      }
    }
    return types.length > 0 ? types : undefined;
  }

  /**
   * Apply implicit widening casts to a list of argument strings for a
   * user-defined function call. Modifies `args` in place.
   */
  private coerceUserFuncArgs(
    args: string[],
    argExprs: FunctionCallExpression["arguments"],
    paramTypes: string[],
  ): void {
    const exprCount = argExprs.length;
    for (let i = 0; i < args.length && i < paramTypes.length; i++) {
      if (i >= exprCount) break; // padded temp vars have no expr to infer from
      const expr = argExprs[i]!.value;
      const argType = this.inferExprType(expr);
      if (!argType) continue;
      const paramType = paramTypes[i]!;
      if (argType === paramType) continue;
      // Bare literals (no typePrefix) are untyped — always castable to param type
      if (
        this.isBareLiteral(expr) ||
        this.canImplicitWiden(argType, paramType)
      ) {
        args[i] = `static_cast<IEC_${paramType}>(${args[i]})`;
      }
    }
  }

  /** Returns true if expr is a bare literal (no typePrefix), possibly negated */
  private isBareLiteral(expr: Expression): boolean {
    const inner = expr.kind === "UnaryExpression" ? expr.operand : expr;
    return inner.kind === "LiteralExpression" && !inner.typePrefix;
  }

  /**
   * Scale the argument of a `TO_*` conversion when a temporal type is on
   * either side of it.
   *
   * Why this lives in codegen and not in the runtime:
   *  - `IEC_TIME`, `IEC_LTIME`, `IEC_TOD`, `IEC_LTOD`, `IEC_DT`,
   *    `IEC_LDT`, `IEC_DATE`, `IEC_LDATE` are all
   *    `using ... = IECVar<int64_t>` aliases — they collapse to the same
   *    C++ type after preprocessing.
   *  - A runtime overload `TO_UINT(IEC_TIME)` therefore CANNOT be
   *    distinguished from `TO_UINT(IEC_DATE)`, and `TO_DT(seconds)`
   *    cannot be distinguished from `TO_DT(IEC_DT)`.
   *  - The IEC type label only survives at the language layer, so the
   *    scaling has to happen here, before the type identity is erased.
   *
   * The units are CODESYS's, which is what the IEC libraries we ship are
   * written against. From its documentation: DATE, DT and TOD are held in a
   * 32-bit DWORD with a 1970-01-01 epoch, at SECONDS resolution for DATE and
   * DT and MILLISECONDS for TOD; TIME is 32-bit milliseconds; and the 64-bit
   * LDATE / LDT / LTOD / LTIME are all nanoseconds. Its own examples pin this
   * down: `DT_TO_DINT(DT#2019-9-1-12:0:0.0)` = 1567339200 (seconds),
   * `DATE_TO_DINT(D#1970-1-2)` = 86400 (seconds, NOT 1 day — the prose on
   * that page says "days" and is wrong, the example is right), and
   * `TOD_TO_DINT(TOD#12:0:0)` = 43200000 (milliseconds).
   *
   * Getting this wrong is not a cosmetic scaling error. Milliseconds since
   * the epoch overflow a DWORD every ~49.7 days, so the result comes back
   * aliased rather than merely a factor of 1000 out, and CODESYS's documented
   * DT range (to 2106) only holds when the unit is seconds. See DOPE-618.
   */
  private temporalConversionUnit(
    typeUpper: string,
  ): TemporalUnitInfo | undefined {
    return TEMPORAL_CONVERSION_UNITS.get(typeUpper);
  }

  /**
   * Temporal SOURCE, numeric target: internal representation → CODESYS unit.
   */
  private wrapTemporalArgForNumericConversion(
    argExpr: string,
    fromTypeUpper: string,
    toTypeUpper: string,
  ): string {
    // STRING targets need a separate format pipeline, not a scale.
    if (!NUMERIC_OR_BIT_CONVERSION_TARGETS.has(toTypeUpper)) {
      return argExpr;
    }
    const unit = this.temporalConversionUnit(fromTypeUpper);
    if (!unit) return argExpr;
    return unit.toUnit === undefined ? argExpr : `${unit.toUnit}(${argExpr})`;
  }

  /**
   * Numeric SOURCE, temporal target: CODESYS unit → internal representation.
   *
   * The mirror of the above, and it has to move with it: OSCAT round-trips
   * through both in a single expression — `DWORD_TO_DT(DT_TO_DWORD(mez) -
   * 7200)` in DCF77, for one — so a fix to one direction alone would leave
   * those worse off than before.
   */
  private wrapNumericArgForTemporalConversion(
    argExpr: string,
    fromTypeUpper: string,
    toTypeUpper: string,
  ): string {
    // Only a genuinely numeric source. A temporal source is a
    // temporal→temporal conversion, which is a semantic question (does
    // DT_TO_DATE truncate to the day?) rather than a unit one, and is left
    // alone here.
    if (!NUMERIC_OR_BIT_CONVERSION_TARGETS.has(fromTypeUpper)) {
      return argExpr;
    }
    const unit = this.temporalConversionUnit(toTypeUpper);
    if (!unit) return argExpr;
    return unit.fromUnit === undefined
      ? argExpr
      : `${unit.fromUnit}(${argExpr})`;
  }

  /**
   * Apply whichever of the two directions fits this conversion.
   *
   * Branches on which side is temporal rather than on whether the first call
   * changed the string. A row whose scaling is a legitimate no-op — the `L`
   * variants are exactly that shape — returns its argument untouched, so a
   * value comparison cannot distinguish "this direction did not apply" from
   * "it applied and had nothing to do", and would fall through to the other
   * direction on a correct answer.
   *
   * That fall-through is harmless today because
   * `NUMERIC_OR_BIT_CONVERSION_TARGETS` and `TEMPORAL_CONVERSION_UNITS` are
   * disjoint, so the second guard rejects what the first already handled. But
   * that is a property of two separate tables agreeing, and this reads the
   * question directly instead of relying on it.
   */
  private scaleConversionArg(
    argExpr: string,
    fromTypeUpper: string,
    toTypeUpper: string,
  ): string {
    const between = longTemporalConversion(argExpr, fromTypeUpper, toTypeUpper);
    if (between !== undefined) return between;
    // A CHAR converts to a number by its Windows-1252 code (0..255).
    if (
      fromTypeUpper === "CHAR" &&
      NUMERIC_OR_BIT_CONVERSION_TARGETS.has(toTypeUpper)
    ) {
      return `static_cast<uint8_t>(iec_unwrap(${argExpr}))`;
    }
    if (TEMPORAL_CONVERSION_UNITS.has(fromTypeUpper)) {
      return this.wrapTemporalArgForNumericConversion(
        argExpr,
        fromTypeUpper,
        toTypeUpper,
      );
    }
    if (TEMPORAL_CONVERSION_UNITS.has(toTypeUpper)) {
      return this.wrapNumericArgForTemporalConversion(
        argExpr,
        fromTypeUpper,
        toTypeUpper,
      );
    }
    return argExpr;
  }

  /**
   * For std-lib template functions (like LIMIT, MAX, MIN) where all params
   * share the same generic constraint, harmonize argument types so C++ template
   * deduction succeeds. Casts literals to the dominant variable type, or widens
   * all args to the widest type if variables differ.
   */
  private harmonizeStdFuncArgs(
    args: string[],
    argExprs: FunctionCallExpression["arguments"],
    stdFunc: { params: Array<{ constraint: string }> },
  ): void {
    // Only harmonize when all params share the same generic constraint
    if (stdFunc.params.length === 0) return;
    const firstConstraint = stdFunc.params[0]!.constraint;
    if (firstConstraint === "specific" || firstConstraint === "BOOL") return;
    const allSame = stdFunc.params.every(
      (p) => p.constraint === firstConstraint,
    );
    if (!allSame) return;

    // Infer types for all arguments
    const argTypes: (string | undefined)[] = argExprs.map((a) =>
      this.inferExprType(a.value),
    );

    // Separate variable types from literal types
    const varTypes: string[] = [];
    const literalIndices: number[] = [];
    for (let i = 0; i < argExprs.length && i < args.length; i++) {
      const expr = argExprs[i]!.value;
      const t = argTypes[i];
      if (!t) continue;
      if (
        expr.kind === "LiteralExpression" ||
        (expr.kind === "UnaryExpression" &&
          expr.operand.kind === "LiteralExpression")
      ) {
        literalIndices.push(i);
      } else {
        varTypes.push(t);
      }
    }

    // Find dominant type from variable types, or from literal types if all args are literals
    let dominant: string;
    if (varTypes.length === 0) {
      // All literals — pick the widest literal type as dominant
      const litTypes = literalIndices
        .map((i) => argTypes[i])
        .filter((t): t is string => !!t);
      if (litTypes.length === 0) return;
      dominant = litTypes[0]!;
      for (let i = 1; i < litTypes.length; i++) {
        const bits1 = getTypeBits(dominant) ?? 0;
        const bits2 = getTypeBits(litTypes[i]!) ?? 0;
        if (bits2 > bits1) dominant = litTypes[i]!;
      }
    } else {
      // Find dominant type: if all var types agree, use that; otherwise pick widest
      dominant = varTypes[0]!;
      for (let i = 1; i < varTypes.length; i++) {
        if (varTypes[i] !== dominant) {
          // Pick wider type
          const bits1 = getTypeBits(dominant) ?? 0;
          const bits2 = getTypeBits(varTypes[i]!) ?? 0;
          if (bits2 > bits1) dominant = varTypes[i]!;
        }
      }
    }

    // Cast literals to dominant type.
    // Bare literals (no typePrefix) are untyped — castable to dominant unless
    // this would narrow a REAL/LREAL literal to an integer type (losing
    // precision).  When the call also carries a variable argument we must
    // ALWAYS wrap bare literals: the variable side is an `IECVar<T>` but a
    // bare literal lowers to a raw `int`/`double`, so C++ template deduction
    // sees conflicting `T`s (`IECVar<int>` vs `int`) even when both share
    // the same IEC type name on our side.
    for (const i of literalIndices) {
      const litType = argTypes[i];
      if (!litType) continue;
      const expr = argExprs[i]!.value;
      const litCat = getTypeCategory(litType);
      const domCat = getTypeCategory(dominant);
      // Never narrow a REAL literal to integer — that truncates (e.g. 1.5 → 1)
      if (litCat === "REAL" && domCat !== "REAL" && this.isBareLiteral(expr)) {
        continue;
      }
      // Bare literal paired with at least one IEC variable: cast even when
      // the inferred IEC type matches `dominant`, to lift raw C++ literals
      // into the IECVar<> template space.
      if (this.isBareLiteral(expr) && varTypes.length > 0) {
        args[i] = `static_cast<IEC_${dominant}>(${args[i]})`;
        continue;
      }
      if (litType === dominant) continue;
      if (
        this.isBareLiteral(expr) ||
        this.canImplicitWiden(litType, dominant)
      ) {
        args[i] = `static_cast<IEC_${dominant}>(${args[i]})`;
      }
    }

    // Cast variable args that need widening to dominant type
    for (let i = 0; i < args.length && i < argExprs.length; i++) {
      if (literalIndices.includes(i)) continue;
      const t = argTypes[i];
      if (t && t !== dominant && this.canImplicitWiden(t, dominant)) {
        args[i] = `static_cast<IEC_${dominant}>(${args[i]})`;
      }
    }
  }

  /**
   * `code` wrapped as `IEC_REAL(...)` / `IEC_LREAL(...)` when `arg` checked
   * as REAL / LREAL (codegen emits REAL literals and expressions as double).
   */
  private atRealType(code: string, arg: Expression | undefined): string {
    const t = arg?.resolvedType;
    const tn = t && "name" in t ? (t.name as string).toUpperCase() : undefined;
    return tn === "REAL" || tn === "LREAL" ? `IEC_${tn}(${code})` : code;
  }

  /**
   * A TRUNC of an LREAL the checker typed DINT (the feature trunc_dint):
   * lowered to TRUNC_DINT, as TRUNC itself returns LINT for an LREAL.
   */
  private truncToDint(expr: FunctionCallExpression): boolean {
    const t = expr.resolvedType;
    const arg = expr.arguments[0]?.value.resolvedType;
    return (
      t !== undefined &&
      "name" in t &&
      t.name === "DINT" &&
      arg !== undefined &&
      "name" in arg &&
      arg.name === "LREAL"
    );
  }

  /**
   * The typed truncation `nameUpper` names (TRUNC_INT, REAL_TRUNC_INT),
   * unless a user or library function of that name shadows it.
   */
  private typedTrunc(nameUpper: string): StdFunctionDescriptor | undefined {
    const own = this.ast?.functions.some(
      (f) => f.name.toUpperCase() === nameUpper,
    );
    if (own === true) return undefined;
    if (this._symbolTables?.lookupFunction(nameUpper) !== undefined) {
      return undefined;
    }
    return this.stdRegistry.resolveTypedTrunc(nameUpper);
  }

  /**
   * Generate C++ for a function call expression.
   * Handles: dotted method calls (THIS.method, SUPER.method, instance.method),
   * standard functions, *_TO_* conversions, DELETE->DELETE_STR mapping,
   * named argument reordering, and user-defined function calls.
   */
  protected generateFunctionCallExpression(
    expr: FunctionCallExpression,
  ): string {
    return this.qualifyHiddenFunctionCall(
      expr,
      this.generateFunctionCallExpressionUnqualified(expr),
    );
  }

  /**
   * A FUNCTION or standard function called where a variable of its name (a
   * local, parameter or member, in any case) hides it in the C++ scope: the
   * call is qualified by the namespace the function lives in.
   */
  private qualifyHiddenFunctionCall(
    expr: FunctionCallExpression,
    call: string,
  ): string {
    const name = expr.functionName;
    if (expr.instance !== undefined || name.includes(".")) return call;
    const upper = name.toUpperCase();
    const hidden =
      this.currentScopeVarTypes.has(upper) ||
      this.inheritedMemberTypeName(upper) !== undefined;
    if (!hidden) return call;
    if (this.getFBInvocationType(name, undefined) !== undefined) return call;
    if (this.ownMethodCalled(expr) !== undefined) return call;
    if (this.reachedProgramNamed(name) !== undefined) return call;
    // Only a plain call `NAME(...)`; anything else is left as generated.
    if (!/^[A-Za-z_][A-Za-z0-9_]*\(/.test(call)) return call;
    const userFunction =
      this.ast?.functions.some((f) => f.name.toUpperCase() === upper) === true;
    const runtime =
      !userFunction &&
      this.libraryFunctionDeclaration(upper) === undefined &&
      (this.stdRegistry.lookup(upper) !== undefined ||
        this.stdRegistry.resolveConversion(upper) !== undefined ||
        this.typedTrunc(upper) !== undefined);
    const ns = runtime
      ? "strucpp"
      : this.projectModel
        ? getProjectNamespace(this.projectModel)
        : "strucpp";
    return `::${ns}::${call}`;
  }

  private generateFunctionCallExpressionUnqualified(
    expr: FunctionCallExpression,
  ): string {
    // Handle dotted method calls: THIS.method, SUPER.method, instance.method
    if (expr.functionName.includes(".")) {
      const dotIdx = expr.functionName.indexOf(".");
      const prefix = expr.functionName.substring(0, dotIdx);
      const methodName = expr.functionName.substring(dotIdx + 1);

      // Resolve method name case from declaration
      const varType = this.currentScopeVarTypes.get(prefix.toUpperCase());
      const ownerType = this.dottedCallOwnerType(prefix);
      const args = this.generateMethodCallArgs(
        ownerType,
        methodName,
        expr.arguments,
        expr.sourceSpan,
      );
      const reachedProgram = this.reachedProgramNamed(prefix);
      const resolvedMethod = varType
        ? this.resolveMethodName(varType, methodName)
        : reachedProgram !== undefined
          ? this.resolveMethodName(reachedProgram, methodName)
          : this.resolveMethodNameGlobal(methodName);

      if (
        prefix.toUpperCase() === "THIS" ||
        prefix.toUpperCase() === this.currentProgramName?.toUpperCase()
      ) {
        // THIS.M(), or MAIN.M() inside MAIN (the only place the analyzer
        // lets a program's method be called from)
        return `this->${resolvedMethod}(${args.join(", ")})`;
      } else if (prefix.toUpperCase() === "SUPER" && this.currentFBExtends) {
        return `${this.currentFBExtends}::${resolvedMethod}(${args.join(", ")})`;
      } else {
        // instance.method() call; through an interface, on the instance it refers to
        const instance = (): string =>
          this.generateExpression({
            kind: "VariableExpression",
            sourceSpan: expr.sourceSpan,
            name: prefix,
            subscripts: [],
            fieldAccess: [],
            isDereference: false,
          });
        const receiver =
          ownerType !== undefined && this.isInterfaceType(ownerType)
            ? `itf_ref(${instance()})`
            : reachedProgram !== undefined
              ? this.sharedProgramInstance(reachedProgram)
              : varType !== undefined &&
                  this.memberMangledNames.has(prefix.toUpperCase())
                ? instance()
                : this.currentScopeVarRefKinds.get(prefix.toUpperCase()) ===
                    "reference_to"
                  ? `${instance()}.target()`
                  : prefix;
        return `${receiver}.${resolvedMethod}(${args.join(", ")})`;
      }
    }

    const nameUpper = expr.functionName.toUpperCase();

    // SUPER^() — parent body call
    if (nameUpper === "SUPER" && this.currentFBExtends) {
      const args = expr.arguments.map((arg) =>
        this.generateExpression(arg.value),
      );
      return `${this.currentFBExtends}::operator()(${args.join(", ")})`;
    }

    // A method of the enclosing block wins, as the C++ member does.
    const ownMethod = this.ownMethodCalled(expr);
    if (ownMethod) {
      const bound = this.generateMethodCallArgs(
        this.currentFBName ?? this.currentProgramName,
        ownMethod.name,
        expr.arguments,
        expr.sourceSpan,
      );
      return `${expr.functionName}(${bound.join(", ")})`;
    }

    // A user FUNCTION wins over an operator or standard function of its name,
    // and so does the library FUNCTION the type checker resolved the call to.
    const userFunction =
      this.ast?.functions.some((f) => f.name.toUpperCase() === nameUpper) ===
      true;
    if (!userFunction && expr.libraryFunction === undefined) {
      // A built-in operator the type checker resolved (__ISVALIDREF, XSIZEOF).
      if (expr.vendorOperator !== undefined && expr.arguments.length === 1) {
        const kept = this.keepReferenceWrapper;
        this.keepReferenceWrapper = expr.vendorOperator === "__ISVALIDREF";
        let arg: string;
        try {
          arg = this.generateExpression(expr.arguments[0]!.value);
        } finally {
          this.keepReferenceWrapper = kept;
        }
        return vendorOperatorCpp(expr.vendorOperator, arg);
      }

      // 0. ADR(x) → &(x) (CODESYS address-of operator)
      if (nameUpper === "ADR") {
        const args = expr.arguments.map((arg) =>
          this.addressedOperand(arg.value, "ADR", expr),
        );
        return `&(${args[0] ?? ""})`;
      }

      // 0a. REF_LINK(x) → REF(x) — callable form of the REF() reference operator
      // (REF is a reserved token and can't take the graphical EN/IN/ENO call
      // form). Assigning the result to a REF_TO variable binds it.
      if (nameUpper === "REF_LINK") {
        const args = expr.arguments.map((arg) =>
          this.addressedOperand(arg.value, "REF_LINK", expr),
        );
        return `REF(${args[0] ?? ""})`;
      }

      // 0b. LOWER_BOUND/UPPER_BOUND(arr, dim) → arr.lower_bound() / arr.upper_bound()
      if (nameUpper === "LOWER_BOUND" || nameUpper === "UPPER_BOUND") {
        const method =
          nameUpper === "LOWER_BOUND" ? "lower_bound" : "upper_bound";
        const arrExpr = this.generateExpression(expr.arguments[0]!.value);
        if (expr.arguments.length >= 2) {
          const dimExpr = this.generateExpression(expr.arguments[1]!.value);
          return `${arrExpr}.${method}(${dimExpr})`;
        }
        return `${arrExpr}.${method}()`;
      }

      // 1. Check for *_TO_* conversion pattern (e.g., INT_TO_REAL -> TO_REAL)
      const conversion = this.stdRegistry.resolveConversion(nameUpper);
      if (conversion) {
        const args = expr.arguments.map((arg, idx) => {
          const generated = this.generateExpression(arg.value);
          if (idx !== 0) return generated;
          // Type-aware unit scaling, in whichever direction applies — a
          // temporal source going to an integer, or an integer going into a
          // temporal target. See `TEMPORAL_CONVERSION_UNITS` for the units and
          // why they are CODESYS's.
          //
          // It has to happen here rather than in the runtime because the C++
          // runtime aliases every temporal type to `IECVar<int64_t>`: a `TIME`
          // and a `DATE` are literally the same type after compilation, and the
          // codegen layer is the last place that still knows which one this
          // expression is. Without it `TO_UINT(time_var)` lowers to a
          // `static_cast<uint16_t>(raw_ns)` and the user sees the low 16 bits of
          // a nanosecond count.
          return this.scaleConversionArg(
            generated,
            conversion.fromType.toUpperCase(),
            conversion.toType.toUpperCase(),
          );
        });
        return `${conversion.cppName}(${args.join(", ")})`;
      }

      // 2. Check for standard function (may have different cppName)
      const stdFunc = this.stdRegistry.lookup(nameUpper);
      if (stdFunc) {
        const args = expr.arguments.map((arg, idx) => {
          let generated = this.generateExpression(arg.value);
          // For the bare `TO_xxx(temporal_var)` spelling, `nameUpper` is
          // a registered std function (not a `*_TO_*` form) so the source
          // type isn't in the name — infer it from the argument's IEC
          // type and apply the same temporal→ms wrap as the conversion
          // branch above.  Conversion std functions advertise
          // `isConversion: true` and carry the target in
          // `specificReturnType`, so we have everything needed without
          // adding a new schema field.
          if (idx === 0 && stdFunc.isConversion && stdFunc.specificReturnType) {
            const fromType =
              this.temporalBase(arg.value) ?? this.inferExprType(arg.value);
            if (fromType) {
              generated = this.scaleConversionArg(
                generated,
                fromType.toUpperCase(),
                stdFunc.specificReturnType.toUpperCase(),
              );
            }
          }
          return generated;
        });
        // CHAR and WCHAR operands: CHAR ordered by its unsigned Windows-1252
        // code, and EN/ENO of a nested call not taken as operands.
        const charCall = this.charStdCall(stdFunc, expr, args);
        if (charCall !== undefined) return charCall;
        this.harmonizeStdFuncArgs(args, expr.arguments, stdFunc);
        // TRUNC's C++ result type follows the C++ argument type, but codegen
        // emits REAL literals/expressions containing one as double.  Pass the
        // argument at its checked ST type so DINT (REAL) / LINT (LREAL) match.
        if (stdFunc.returnTypeFor && args.length > 0) {
          args[0] = this.atRealType(args[0]!, expr.arguments[0]?.value);
          if (this.truncToDint(expr)) return `TRUNC_DINT(${args.join(", ")})`;
        }
        return `${stdFunc.cppName}(${args.join(", ")})`;
      }

      // 2b. Typed truncation (TRUNC_INT, REAL_TRUNC_INT): runtime helpers of
      // the same name; the overloaded form takes its argument at its ST type.
      const typedTrunc = this.typedTrunc(nameUpper);
      if (typedTrunc) {
        const args = expr.arguments.map((arg) =>
          this.generateExpression(arg.value),
        );
        if (
          typedTrunc.params[0]?.specificType === undefined &&
          args.length > 0
        ) {
          args[0] = this.atRealType(args[0]!, expr.arguments[0]?.value);
        }
        return `${typedTrunc.cppName}(${args.join(", ")})`;
      }
    }

    // 3. Check for named arguments that may need reordering
    const hasNamedArgs = expr.arguments.some((arg) => arg.name !== undefined);
    if (hasNamedArgs && this.ast) {
      const reordered = this.reorderNamedArguments(expr);
      if (reordered) {
        return `${expr.functionName}(${reordered.join(", ")})`;
      }
    }

    // 3b. A bare call of a method of the enclosing block or program (the
    // member call needs no prefix): bind named arguments by name.
    if (
      hasNamedArgs &&
      !this.ast?.functions.some((f) => f.name.toUpperCase() === nameUpper)
    ) {
      const method = this.findMethodDeclaration(
        this.currentFBName ?? this.currentProgramName,
        nameUpper,
      );
      if (method) {
        const bound = this.generateMethodCallArgs(
          this.currentFBName ?? this.currentProgramName,
          nameUpper,
          expr.arguments,
          expr.sourceSpan,
        );
        return `${expr.functionName}(${bound.join(", ")})`;
      }
    }

    // 4. Default: emit as-is (with output argument validation)
    const args = expr.arguments.map((arg) => {
      const generated = this.generateExpression(arg.value);
      if (arg.isOutput && arg.value.kind !== "VariableExpression") {
        this.codegenWarnings.push({
          message: `Output argument '${arg.name ?? ""}' should be a variable, not an expression`,
          line: arg.sourceSpan.startLine,
          column: arg.sourceSpan.startCol,
          file: arg.sourceSpan.file,
        });
      }
      return generated;
    });

    // The callee: a function, or a method of the enclosing block called bare.
    const funcDecl = this.ast?.functions.find(
      (f) => f.name.toUpperCase() === nameUpper,
    );
    const calleeBlocks =
      funcDecl?.varBlocks ??
      this.libraryFunctionDeclaration(nameUpper, expr.libraryFunction)
        ?.varBlocks ??
      this.findMethodDeclaration(
        this.currentFBName ?? this.currentProgramName,
        nameUpper,
      )?.varBlocks;
    // Pad the parameters the call leaves out (outputs, defaulted inputs)
    const suppliedArgs = args.length;
    if (calleeBlocks) this.padOmittedArguments(args, calleeBlocks);

    // Apply implicit widening casts for user-defined function args
    const paramTypes = this.getParamTypes(nameUpper);
    if (paramTypes) {
      this.coerceUserFuncArgs(args, expr.arguments, paramTypes);
    }

    // Positional arguments bound to REFERENCE TO inputs.
    if (calleeBlocks) {
      const supplied = args.slice(0, suppliedArgs);
      this.bindPositionalReferenceInputs(supplied, calleeBlocks);
      args.splice(0, suppliedArgs, ...supplied);
    }

    return `${expr.functionName}(${args.join(", ")})`;
  }

  /**
   * The method of the enclosing FUNCTION_BLOCK (inherited ones included) or
   * PROGRAM a bare call `M(...)` names; an FB instance of the name is not one.
   */
  private ownMethodCalled(
    expr: FunctionCallExpression,
  ): MethodDeclaration | undefined {
    const name = expr.functionName;
    if (expr.instance || name.includes(".")) return undefined;
    if (this.getFBInvocationType(name, expr.instance) !== undefined) {
      return undefined;
    }
    return this.findMethodDeclaration(
      this.currentFBName ?? this.currentProgramName,
      name,
    );
  }

  /** The type that owns the method of a dotted call `prefix.M(...)`:
   *  THIS (or the program's own name) is the enclosing block, SUPER its base,
   *  anything else the declared type of the variable `prefix`. */
  private dottedCallOwnerType(prefix: string): string | undefined {
    const prefixUpper = prefix.toUpperCase();
    if (
      prefixUpper === "THIS" ||
      prefixUpper === this.currentProgramName?.toUpperCase()
    ) {
      return this.currentFBName ?? this.currentProgramName;
    }
    if (prefixUpper === "SUPER") return this.currentFBExtends;
    return (
      this.currentScopeVarTypes.get(prefixUpper) ??
      this.reachedProgramNamed(prefix)
    );
  }

  /**
   * Reorder named arguments to match function declaration parameter order.
   * Positional args are placed first (in declaration order, skipping named slots),
   * then named args fill their declared slots. Unfilled parameters get default values.
   * Returns null if function not found in AST.
   */
  private reorderNamedArguments(expr: FunctionCallExpression): string[] | null {
    if (!this.ast) return null;

    // Find the function declaration in the AST, else in a library
    const funcDecl =
      this.ast.functions.find(
        (f) => f.name.toUpperCase() === expr.functionName.toUpperCase(),
      ) ??
      this.libraryFunctionDeclaration(expr.functionName, expr.libraryFunction);
    if (!funcDecl) return null;
    return this.bindArgumentsByName(
      funcDecl.varBlocks,
      expr.arguments,
      `function '${expr.functionName}'`,
      expr.sourceSpan,
    );
  }

  /** The declaration of a library function, from its manifest entry; `library` picks a shadowed one. */
  private libraryFunctionDeclaration(
    name: string,
    library?: string,
  ): FunctionDeclaration | undefined {
    const upper = name.toUpperCase();
    const key =
      library !== undefined ? `${library.toUpperCase()}:${upper}` : upper;
    const entry =
      library !== undefined
        ? this.libraryFunctionsByLibrary.get(key)
        : this.libraryFunctions.get(upper);
    if (!entry) return undefined;
    if (!this.libraryFunctionDecls.has(key)) {
      this.libraryFunctionDecls.set(key, libraryFunctionDeclaration(entry));
    }
    return this.libraryFunctionDecls.get(key);
  }

  /**
   * Find a method's declaration on a function block, a program or an
   * interface, walking the base chain of function blocks. Undefined when the
   * type is not declared in this compilation unit (a library block).
   */
  /**
   * The type name (upper case) of the ENO an FB, its bases included, or a
   * PROGRAM declares; undefined when it has only the implicit one.
   */
  private declaredEnoType(typeName: string): string | undefined {
    const seen = new Set<string>();
    let current: string | undefined = typeName.toUpperCase();
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      const upper: string = current;
      const fb = this.ast?.functionBlocks.find(
        (f) => f.name.toUpperCase() === upper,
      );
      const owner =
        fb ?? this.ast?.programs.find((p) => p.name.toUpperCase() === upper);
      if (!owner) return undefined;
      for (const block of owner.varBlocks) {
        for (const decl of block.declarations) {
          if (decl.names.some((n) => n.toUpperCase() === "ENO")) {
            const plain =
              decl.type.arrayDimensions === undefined &&
              decl.type.referenceKind === "none";
            return plain ? decl.type.name.toUpperCase() : "";
          }
        }
      }
      current = fb?.extends?.toUpperCase();
    }
    return undefined;
  }

  private findMethodDeclaration(
    typeName: string | undefined,
    methodName: string,
  ): MethodDeclaration | undefined {
    if (!typeName || !this.ast) return undefined;
    const methodUpper = methodName.toUpperCase();
    const seen = new Set<string>();
    let current: string | undefined = typeName.toUpperCase();
    while (current && !seen.has(current)) {
      seen.add(current);
      const fb = this.ast.functionBlocks.find(
        (f) => f.name.toUpperCase() === current,
      );
      const owner =
        fb ??
        this.ast.programs.find((p) => p.name.toUpperCase() === current) ??
        this.ast.interfaces.find((i) => i.name.toUpperCase() === current);
      if (!owner) {
        // A library FB from an archive that lists its methods
        return this.libraryMethods
          .get(current)
          ?.find((m) => m.name.toUpperCase() === methodUpper);
      }
      const found = owner.methods.find(
        (m) => m.name.toUpperCase() === methodUpper,
      );
      if (found) return found;
      current = fb?.extends?.toUpperCase();
    }
    return undefined;
  }

  /**
   * Emit the arguments of a method call. Positional calls keep source order;
   * with a named argument they are bound to the method's parameters by name
   * and ordered as its C++ parameter list (VAR_INPUT, VAR_IN_OUT and
   * VAR_OUTPUT in declaration order). Falls back to source order when the
   * method's declaration is not in this unit.
   */
  private generateMethodCallArgs(
    ownerType: string | undefined,
    methodName: string,
    callArgs: Argument[],
    callSpan: SourceSpan,
  ): string[] {
    const method = this.findMethodDeclaration(ownerType, methodName);
    if (method && callArgs.some((a) => a.name !== undefined)) {
      return this.bindArgumentsByName(
        method.varBlocks,
        callArgs,
        `method '${method.name}'`,
        callSpan,
      );
    }
    const args = callArgs.map((a) => this.generateExpression(a.value));
    if (method) {
      this.bindPositionalReferenceInputs(args, method.varBlocks);
      this.padOmittedArguments(args, method.varBlocks);
    }
    return args;
  }

  /**
   * Wrap the positional arguments that land on a REFERENCE TO input in
   * `ref_bind(...)`, so the input refers to the argument for the call.
   * `varBlocks` is the callee's declaration (its C++ parameter order).
   */
  private bindPositionalReferenceInputs(
    args: string[],
    varBlocks: VarBlock[],
  ): void {
    let index = 0;
    for (const block of varBlocks) {
      if (
        block.blockType !== "VAR_INPUT" &&
        block.blockType !== "VAR_IN_OUT" &&
        block.blockType !== "VAR_OUTPUT"
      ) {
        continue;
      }
      for (const decl of block.declarations) {
        for (let n = 0; n < decl.names.length; n++, index++) {
          if (index < args.length && isReferenceInput(block, decl)) {
            args[index] = `ref_bind(${args[index]})`;
          }
        }
      }
    }
  }

  /**
   * Bind a call's arguments to a callee's parameters by name. `varBlocks` is
   * the callee's declaration, taken VAR_INPUT / VAR_IN_OUT / VAR_OUTPUT in
   * declaration order (the order of its C++ parameter list). Shared by
   * function calls and method calls.
   */
  private bindArgumentsByName(
    varBlocks: VarBlock[],
    callArgs: Argument[],
    calleeLabel: string,
    callSpan: SourceSpan,
  ): string[] {
    // Build parameter info from VAR_INPUT, VAR_IN_OUT, VAR_OUTPUT blocks
    const params: Array<{
      name: string;
      typeName: string;
      type: TypeReference;
      blockType: string;
      defaultExpr?: string;
      refInput?: TypeReference;
    }> = [];
    for (const block of varBlocks) {
      if (
        block.blockType === "VAR_INPUT" ||
        block.blockType === "VAR_IN_OUT" ||
        block.blockType === "VAR_OUTPUT"
      ) {
        for (const decl of block.declarations) {
          for (const name of decl.names) {
            const entry: {
              name: string;
              typeName: string;
              type: TypeReference;
              blockType: string;
              defaultExpr?: string;
              refInput?: TypeReference;
            } = {
              name: name.toUpperCase(),
              typeName: decl.type.name,
              type: decl.type,
              blockType: block.blockType,
            };
            if (isReferenceInput(block, decl)) entry.refInput = decl.type;
            if (decl.initialValue) {
              entry.defaultExpr = this.generateInitializer(
                decl.initialValue,
                this.mapTypeRefToCpp(decl.type),
                decl.type.name,
              );
            }
            params.push(entry);
          }
        }
      }
    }

    // Build set of parameter slots claimed by named arguments
    // (skip implicit EN/ENO — handled separately by EN/ENO codegen logic)
    const namedArgs = new Map<string, { expr: string; isOutput: boolean }>();
    const claimedSlots = new Set<string>();
    for (const arg of callArgs) {
      if (arg.name !== undefined) {
        const upperName = arg.name.toUpperCase();
        if (upperName === "EN" || upperName === "ENO") continue;
        namedArgs.set(upperName, {
          expr: this.generateExpression(arg.value),
          isOutput: arg.isOutput,
        });
        claimedSlots.add(upperName);

        // Validate output argument is a variable
        if (arg.isOutput && arg.value.kind !== "VariableExpression") {
          this.codegenWarnings.push({
            message: `Output argument '${arg.name}' should be a variable, not an expression`,
            line: arg.sourceSpan.startLine,
            column: arg.sourceSpan.startCol,
            file: arg.sourceSpan.file,
          });
        }
      }
    }

    // Warn about named args that don't match any declared parameter,
    // and check for direction mismatches (=> on VAR_INPUT)
    const paramLookup = new Map(params.map((p) => [p.name, p]));
    for (const [argName, argInfo] of namedArgs) {
      const param = paramLookup.get(argName);
      if (!param) {
        const span = callSpan;
        this.codegenWarnings.push({
          message: `Named argument '${argName}' does not match any parameter of ${calleeLabel}`,
          line: span.startLine,
          column: span.startCol,
          file: span.file,
        });
      } else if (argInfo.isOutput && param.blockType === "VAR_INPUT") {
        const span = callSpan;
        this.codegenWarnings.push({
          message: `Output argument '=>' used for input parameter '${param.name.toLowerCase()}' — did you mean ':='?`,
          line: span.startLine,
          column: span.startCol,
          file: span.file,
        });
      }
    }

    // Collect positional args (preserving source order)
    const positionalArgs: string[] = [];
    for (const arg of callArgs) {
      if (arg.name === undefined) {
        positionalArgs.push(this.generateExpression(arg.value));
      }
    }

    // Assign positional args to unclaimed parameter slots (in declaration order)
    const result: (string | undefined)[] = new Array<string | undefined>(
      params.length,
    );
    let positionalIdx = 0;
    for (let i = 0; i < params.length; i++) {
      const param = params[i]!;
      if (claimedSlots.has(param.name)) {
        // This slot is reserved for a named arg - skip it for positional fill
        continue;
      }
      if (positionalIdx < positionalArgs.length) {
        result[i] = positionalArgs[positionalIdx]!;
        positionalIdx++;
      }
    }

    // Fill named arg slots
    for (let i = 0; i < params.length; i++) {
      const param = params[i]!;
      const named = namedArgs.get(param.name);
      if (named !== undefined) {
        result[i] = named.expr;
      }
    }

    // A REFERENCE TO input binds to its argument; an omitted one stays unbound.
    for (let i = 0; i < params.length; i++) {
      const refType = params[i]!.refInput;
      if (refType === undefined) continue;
      if (result[i] !== undefined) {
        result[i] = `ref_bind(${result[i]})`;
      } else if (params[i]!.defaultExpr === undefined) {
        result[i] = `${this.mapTypeRefToCpp(refType)}()`;
      }
    }

    // Fill any remaining unfilled slots with defaults (or temp vars for output params)
    for (let i = 0; i < params.length; i++) {
      if (result[i] === undefined) {
        const param = params[i]!;
        if (
          param.blockType === "VAR_OUTPUT" ||
          param.blockType === "VAR_IN_OUT"
        ) {
          result[i] = this.emitOutputTempVar(param.typeName);
        } else {
          result[i] = param.defaultExpr ?? this.typeDefaultArgument(param.type);
        }
      }
    }

    return result.map((v, i) => {
      if (v !== undefined) return v;
      const param = params[i]!;
      if (
        param.blockType === "VAR_OUTPUT" ||
        param.blockType === "VAR_IN_OUT"
      ) {
        return this.emitOutputTempVar(param.typeName);
      }
      return param.defaultExpr ?? this.typeDefaultArgument(param.type);
    });
  }

  /**
   * C++ argument for an omitted input that declares no initial value: the
   * type's elementary default, else a value-initialised object (STRUCT,
   * enum, array, alias, pointer or reference).
   */
  private typeDefaultArgument(type: TypeReference): string {
    const elementary =
      type.referenceKind === "none" ? this.getTypeDefaultValue(type.name) : "";
    return elementary !== "" ? elementary : `${this.mapTypeRefToCpp(type)}()`;
  }

  /**
   * Append the arguments a positional call leaves out at the end: a
   * temporary for a VAR_OUTPUT / VAR_IN_OUT, else the input's declared
   * initial value, else its type's default. `varBlocks` is the callee's
   * declaration (its C++ parameter order).
   */
  private padOmittedArguments(args: string[], varBlocks: VarBlock[]): void {
    let index = 0;
    for (const block of varBlocks) {
      if (
        block.blockType !== "VAR_INPUT" &&
        block.blockType !== "VAR_IN_OUT" &&
        block.blockType !== "VAR_OUTPUT"
      ) {
        continue;
      }
      for (const decl of block.declarations) {
        for (let n = 0; n < decl.names.length; n++, index++) {
          if (index < args.length) continue;
          if (block.blockType !== "VAR_INPUT") {
            args.push(this.emitOutputTempVar(decl.type.name));
          } else if (decl.initialValue) {
            args.push(
              this.generateInitializer(
                decl.initialValue,
                this.mapTypeRefToCpp(decl.type),
                decl.type.name,
              ),
            );
          } else {
            args.push(this.typeDefaultArgument(decl.type));
          }
        }
      }
    }
  }

  // ===========================================================================
  // Helper Methods
  // ===========================================================================

  /**
   * Emit a temporary variable declaration for an omitted VAR_OUTPUT/VAR_IN_OUT argument.
   * The temp is emitted before the current statement line (since generateExpression()
   * runs before the statement's emit() call). Returns the temp variable name.
   */
  private emitOutputTempVar(typeName: string): string {
    const name = `__output_tmp_${this.tempVarCounter++}`;
    const cppType = this.mapVarTypeToCpp(typeName);
    this.emit(`${this.currentStatementIndent}${cppType} ${name};`);
    return name;
  }

  /**
   * Check if a type name refers to a known function block type.
   */
  private isFBType(typeName: string): boolean {
    return this.knownFBTypes.has(typeName.toUpperCase());
  }

  /**
   * When `typeName` (a member's declared type) is also the name of a sibling
   * member in the same scope, return the C++ elaborated-type-specifier keyword
   * (`class `/`struct `) needed so the bare type name isn't resolved to the data
   * member. Returns "" when there's no shadowing or the type isn't a composite.
   */
  private elaboratedTagIfShadowed(
    typeName: string,
    memberNames: Set<string>,
  ): string {
    const u = typeName.toUpperCase();
    if (!memberNames.has(u)) return "";
    // A member named like a user type is renamed (member-mangling.ts), so it
    // no longer hides the type.
    if (this.isUserDefinedType(typeName)) return "";
    // Enums are emitted as `using IEC_X = IEC_ENUM<X>` aliases, which cannot be
    // named with an elaborated `struct`/`class` specifier. They also never need
    // disambiguation here because the member is already mangled (name_).
    if (this.enumTypeMembers.has(u)) return "";
    if (this.knownFBTypes.has(u)) return "class ";
    if (this.knownStructTypes.has(u)) return "struct ";
    return "";
  }

  /**
   * How a function-block VAR_IN_OUT of `type` refers to the caller's variable:
   * `ref` an IEC_INOUT member (bound per call, used as `(*X)`), `view` an
   * ARRAY[*] view (already a reference), `itf` an interface variable (refers
   * to the caller's instance).
   */
  private inOutTypeKind(type: {
    name: string;
    arrayDimensions?: unknown;
    referenceKind?: string;
  }): "ref" | "view" | "itf" {
    if (VLA_TYPE_NAME.test(type.name)) return "view";
    if (
      type.arrayDimensions === undefined &&
      (type.referenceKind === undefined || type.referenceKind === "none") &&
      this.isInterfaceType(type.name)
    ) {
      return "itf";
    }
    return "ref";
  }

  /**
   * How a call of FB type `fbType` binds its parameter `name`: as
   * inOutTypeKind, `legacy` for a library FB whose archive still has by-value
   * in-out members (copy-in / copy-out), undefined when `name` is no in-out.
   * Inherited in-outs are found through EXTENDS.
   */
  private inOutKind(
    fbType: string | undefined,
    name: string,
  ): "ref" | "view" | "itf" | "legacy" | undefined {
    const upper = name.toUpperCase();
    let current = fbType?.toUpperCase();
    for (let depth = 0; current !== undefined && depth < 32; depth++) {
      const owner: string = current;
      const fb = this.ast?.functionBlocks.find(
        (f) => f.name.toUpperCase() === owner,
      );
      if (!fb) {
        if (this.fbInoutParams.get(owner)?.has(upper) !== true)
          return undefined;
        if (this.legacyInOutFBs.has(owner)) return "legacy";
        const typeName = this.libraryFBFieldTypes.get(`${owner}.${upper}`);
        if (typeName === undefined) return "ref";
        const shape = this.libraryFBFieldTypeRefs.get(`${owner}.${upper}`);
        return this.inOutTypeKind({
          name: typeName,
          ...(shape?.arrayDimensions
            ? { arrayDimensions: shape.arrayDimensions }
            : {}),
          ...(shape?.referenceKind
            ? { referenceKind: shape.referenceKind }
            : {}),
        });
      }
      for (const block of fb.varBlocks) {
        const decl = block.declarations.find((d) =>
          d.names.some((n) => n.toUpperCase() === upper),
        );
        if (!decl) continue;
        return block.blockType === "VAR_IN_OUT"
          ? this.inOutTypeKind(decl.type)
          : undefined;
      }
      current = fb.extends?.toUpperCase();
    }
    return undefined;
  }

  /** Member `field` of type `typeName` is a by-reference VAR_IN_OUT. */
  private isRefInOutMember(
    typeName: string | undefined,
    field: string,
  ): boolean {
    return (
      typeName !== undefined &&
      this.knownFBTypes.has(typeName.toUpperCase()) &&
      this.inOutKind(typeName, field) === "ref"
    );
  }

  /** The by-reference in-outs the current FB inherits through EXTENDS. */
  private inheritedInOutRefs(): Set<string> {
    const result = new Set<string>();
    if (this.currentFBName === undefined) return result;
    const own = this.currentFBName.toUpperCase();
    let current = this.ast?.functionBlocks
      .find((f) => f.name.toUpperCase() === own)
      ?.extends?.toUpperCase();
    for (let depth = 0; current !== undefined && depth < 32; depth++) {
      const owner: string = current;
      const fb = this.ast?.functionBlocks.find(
        (f) => f.name.toUpperCase() === owner,
      );
      if (!fb) {
        for (const name of this.fbInoutParams.get(owner) ?? []) {
          if (this.inOutKind(owner, name) === "ref") result.add(name);
        }
        break;
      }
      for (const block of fb.varBlocks) {
        if (block.blockType !== "VAR_IN_OUT") continue;
        for (const decl of block.declarations) {
          if (this.inOutTypeKind(decl.type) !== "ref") continue;
          for (const n of decl.names) result.add(n.toUpperCase());
        }
      }
      current = fb.extends?.toUpperCase();
    }
    return result;
  }

  /** Base-clause entry for an interface: virtual when it is a shared base. */
  private interfaceBaseSpec(name: string): string {
    return this.sharedInterfaceBases.has(name.toUpperCase())
      ? `public virtual ${name}`
      : `public ${name}`;
  }

  /**
   * Interfaces that some FB or interface of this compile reaches through more
   * than one chain of EXTENDS / IMPLEMENTS (a diamond). Without virtual
   * inheritance the instance would hold two copies and the conversion to the
   * interface would be ambiguous.
   */
  private findSharedInterfaceBases(ast: CompilationUnit): Set<string> {
    const direct = new Map<string, string[]>();
    for (const iface of ast.interfaces) {
      direct.set(
        iface.name.toUpperCase(),
        (iface.extends ?? []).map((e) => e.toUpperCase()),
      );
    }
    for (const fb of ast.functionBlocks) {
      direct.set(fb.name.toUpperCase(), [
        ...(fb.extends ? [fb.extends.toUpperCase()] : []),
        ...(fb.implements ?? []).map((i) => i.toUpperCase()),
      ]);
    }
    const shared = new Set<string>();
    for (const start of direct.keys()) {
      const paths = new Map<string, number>();
      const walk = (name: string, depth: number): void => {
        if (depth >= 32) return;
        for (const base of direct.get(name) ?? []) {
          paths.set(base, (paths.get(base) ?? 0) + 1);
          walk(base, depth + 1);
        }
      };
      walk(start, 0);
      for (const [name, count] of paths) {
        if (count > 1 && this.knownInterfaceTypes.has(name)) shared.add(name);
      }
    }
    return shared;
  }

  /**
   * The C++ type a VAR_IN_OUT binds by reference: the interface class itself
   * for an interface type (not its variable wrapper), else the declared type.
   */
  private inOutParamType(type: TypeShape): string {
    return !type.arrayDimensions &&
      (type.referenceKind === undefined || type.referenceKind === "none") &&
      this.isInterfaceType(type.name)
      ? type.name
      : this.mapTypeRefToCpp(this.byRefParamTypeRef(type));
  }

  /**
   * Check if a type name refers to a known interface type.
   */
  private isInterfaceType(typeName: string): boolean {
    return this.knownInterfaceTypes.has(typeName.toUpperCase());
  }

  /**
   * Resolve the declared case of a method name given the type and method name.
   * Returns the declared name if found, or the original name if not.
   */
  private resolveMethodName(typeName: string, methodName: string): string {
    const key = `${typeName.toUpperCase()}.${methodName.toUpperCase()}`;
    return this.methodNameMap.get(key) ?? methodName;
  }

  /**
   * Resolve method name case by searching all known types.
   * Used when the object type is not easily determined (e.g., chained calls).
   */
  private resolveMethodNameGlobal(methodName: string): string {
    const upper = methodName.toUpperCase();
    for (const [key, declaredName] of this.methodNameMap) {
      if (key.endsWith(`.${upper}`)) {
        return declaredName;
      }
    }
    return methodName;
  }

  /**
   * Resolve a property name from the property name map.
   * Returns the declared property name if the field is a property, undefined otherwise.
   */
  private resolvePropertyName(
    typeName: string | undefined,
    fieldName: string,
  ): string | undefined {
    if (!typeName) return undefined;
    // Own property, else one a base FB declares (nearest wins), unless this
    // FB declares a variable of that name.
    const field = fieldName.toUpperCase();
    const seen = new Set<string>();
    let current: string | undefined = typeName.toUpperCase();
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      const own = this.propertyNameMap.get(`${current}.${field}`);
      if (own !== undefined) return own;
      const owner: string = current;
      const fb: CompilationUnit["functionBlocks"][number] | undefined =
        this.ast?.functionBlocks.find((f) => f.name.toUpperCase() === owner);
      if (!fb && this.libraryFBExtends.has(owner)) {
        current = this.libraryFBExtends.get(owner);
        continue;
      }
      if (
        !fb ||
        fb.varBlocks.some((b) =>
          b.declarations.some((d) =>
            d.names.some((n) => n.toUpperCase() === field),
          ),
        )
      ) {
        return undefined;
      }
      current = fb.extends?.toUpperCase();
    }
    return undefined;
  }

  /**
   * Resolve the type of a member field on a given FB or struct type.
   * Used for chained access like ctrl.motor.Speed where we need to know
   * motor's type to check if Speed is a property.
   */
  protected resolveMemberType(
    typeName: string | undefined,
    memberName: string,
  ): string | undefined {
    if (!typeName) return undefined;
    if (this.ast) {
      const result = resolveFieldTypeUtil(typeName, memberName, this.ast);
      if (result) return result;
    }
    // Fallback: check library FB field types
    return this.libraryFBFieldTypes.get(
      `${typeName.toUpperCase()}.${memberName.toUpperCase()}`,
    );
  }

  /**
   * Detect if an assignment target is a property write (e.g., m.Speed := 75).
   * Returns the object code prefix and property name if so, undefined otherwise.
   */
  private detectPropertyWrite(
    target: Expression,
  ): { objectCode: string; propertyName: string } | undefined {
    if (target.kind !== "VariableExpression") return undefined;
    const expr = this.selfPropertyAccess(target) ?? target;
    if (expr.fieldAccess.length === 0) return undefined;

    const nameUpper = expr.name.toUpperCase();
    const lastField = expr.fieldAccess[expr.fieldAccess.length - 1]!;

    // Resolve the type at the point just before the last field
    let currentType: string | undefined;
    if (nameUpper === "THIS") currentType = this.currentFBName;
    else if (nameUpper === "SUPER") currentType = this.currentFBExtends;
    else currentType = this.rootVariableType(nameUpper);

    for (let i = 0; i < expr.fieldAccess.length - 1; i++) {
      if (!currentType) break;
      currentType = this.resolveMemberType(currentType, expr.fieldAccess[i]!);
    }

    if (!currentType) return undefined;
    const propName = this.resolvePropertyName(currentType, lastField);
    if (!propName) return undefined;

    // Build the object code (everything except the last field)
    let objectCode: string;
    if (nameUpper === "THIS") {
      objectCode = "this->";
      let ct: string | undefined = this.currentFBName;
      for (let i = 0; i < expr.fieldAccess.length - 1; i++) {
        const f = expr.fieldAccess[i]!;
        const ft = this.resolveMemberType(ct, f);
        objectCode += (this.needsFieldMangling(f, ft, ct) ? `${f}_` : f) + ".";
        ct = ft;
      }
    } else if (nameUpper === "SUPER" && this.currentFBExtends) {
      objectCode = this.currentFBExtends + "::";
      let ct: string | undefined = this.currentFBExtends;
      for (let i = 0; i < expr.fieldAccess.length - 1; i++) {
        const f = expr.fieldAccess[i]!;
        const ft = this.resolveMemberType(ct, f);
        objectCode += (this.needsFieldMangling(f, ft, ct) ? `${f}_` : f) + ".";
        ct = ft;
      }
    } else {
      // Generate a VariableExpression with fieldAccess trimmed to all-but-last
      // Also trim the accessChain if present
      const baseExpr: VariableExpression = {
        ...expr,
        fieldAccess: expr.fieldAccess.slice(0, -1),
      };
      if (expr.accessChain) {
        const trimmed = this.trimLastFieldFromAccessChain(expr.accessChain);
        if (trimmed) {
          baseExpr.accessChain = trimmed;
        } else {
          delete baseExpr.accessChain;
        }
      }
      const base = this.generateVariableExpression(baseExpr);
      // Through an interface, on the instance it refers to
      objectCode = this.isInterfaceType(currentType)
        ? `itf_ref(${base}).`
        : `${base}.`;
    }

    return { objectCode, propertyName: propName };
  }

  /**
   * Remove the last field step from an access chain (for bit access / property trim).
   * Returns undefined if the chain becomes empty.
   */
  private trimLastFieldFromAccessChain(
    chain: AccessStep[],
  ): AccessStep[] | undefined {
    const trimmed = [...chain];
    for (let i = trimmed.length - 1; i >= 0; i--) {
      if (trimmed[i]!.kind === "field") {
        trimmed.splice(i, 1);
        break;
      }
    }
    return trimmed.length > 0 ? trimmed : undefined;
  }

  /**
   * `{}` (or `{lower bound}` for a subrange) for a variable of a TYPE that is
   * an alias of an elementary or enumeration type, or a subrange. Its C++
   * type is the raw value type, which a member or local declared without an
   * initializer leaves indeterminate. Empty for every other type.
   */
  private scalarTypeInit(type: {
    name: string;
    referenceKind?: string;
    arrayDimensions?: unknown;
  }): string {
    if (
      (type.referenceKind !== undefined && type.referenceKind !== "none") ||
      type.arrayDimensions !== undefined
    ) {
      return "";
    }
    let name = type.name.toUpperCase();
    for (let depth = 0; depth < 32; depth++) {
      const td = this.ast?.types.find((t) => t.name.toUpperCase() === name);
      if (!td) {
        if (depth === 0 || name === "STRING" || name === "WSTRING") return "";
        return ELEMENTARY_TYPES[canonicalElementaryName(name)] ? "{}" : "";
      }
      const def = td.definition;
      if (def.kind === "SubrangeDefinition") {
        const lo = def.lowerBound;
        return lo.kind === "LiteralExpression" ||
          (lo.kind === "UnaryExpression" &&
            lo.operand.kind === "LiteralExpression")
          ? `{${this.generateExpression(lo)}}`
          : "{}";
      }
      // A variable of the enumeration itself is an IEC_ENUM wrapper.
      if (def.kind === "EnumDefinition") return depth === 0 ? "" : "{}";
      if (
        def.kind !== "TypeReference" ||
        def.referenceKind !== "none" ||
        def.arrayDimensions ||
        def.maxLength !== undefined
      ) {
        return "";
      }
      name = def.name.toUpperCase();
    }
    return "";
  }

  /**
   * Check if a type name refers to any user-defined type (FB, interface, or struct/UDT).
   * These types should NOT get the IEC_ prefix.
   */
  protected isUserDefinedType(typeName: string): boolean {
    const upper = typeName.toUpperCase();
    return (
      this.knownFBTypes.has(upper) ||
      this.knownInterfaceTypes.has(upper) ||
      this.knownStructTypes.has(upper) ||
      this.knownProgramTypes.has(upper)
    );
  }

  /**
   * Enter a new scope for code generation. Populates currentScopeVarTypes
   * from the variable blocks of a program or function block.
   */
  private enterScope(
    varBlocks: CompilationUnit["programs"][0]["varBlocks"],
    stackBlocks: readonly VarBlock[] = [],
  ): void {
    this.stackLocals = new Set(
      stackBlocks
        .filter(
          (b) => b.blockType !== "VAR_INST" && b.blockType !== "VAR_EXTERNAL",
        )
        .flatMap((b) => b.declarations.flatMap((d) => d.names))
        .map((n) => n.toUpperCase()),
    );
    this.currentScopeVarTypes.clear();
    this.currentScopeVarRefKinds.clear();
    this.currentScopeVarTypeRefs.clear();
    this.memberMangledNames.clear();
    this.scopeExternalNames = new Set(
      varBlocks
        .filter((b) => b.blockType === "VAR_EXTERNAL")
        .flatMap((b) => b.declarations.flatMap((d) => d.names))
        .map((n) => n.toUpperCase()),
    );
    this.scopeInOutRefs = this.inheritedInOutRefs();
    for (const block of varBlocks) {
      const fbInOut =
        block.blockType === "VAR_IN_OUT" &&
        this.currentFBName !== undefined &&
        this.knownFBTypes.has(this.currentFBName.toUpperCase()) &&
        this.currentFBVarBlocks.includes(block);
      for (const decl of block.declarations) {
        for (const name of decl.names) {
          if (fbInOut && this.inOutTypeKind(decl.type) === "ref") {
            this.scopeInOutRefs.add(name.toUpperCase());
          } else {
            this.scopeInOutRefs.delete(name.toUpperCase());
          }
        }
        const cppType = this.isUserDefinedType(decl.type.name)
          ? decl.type.name
          : `IEC_${decl.type.name}`;
        for (const name of decl.names) {
          this.currentScopeVarTypes.set(name.toUpperCase(), decl.type.name);
          this.currentScopeVarTypeRefs.set(name.toUpperCase(), decl.type);
          if (
            decl.type.referenceKind !== undefined &&
            decl.type.referenceKind !== "none"
          ) {
            this.currentScopeVarRefKinds.set(
              name.toUpperCase(),
              decl.type.referenceKind,
            );
          }
          // The shared rule: a name colliding with a user type or an
          // implemented interface method (see member-mangling.ts).
          // A parameter keeps its name (the signature spells it as written).
          const isParameter =
            stackBlocks.includes(block) &&
            (block.blockType === "VAR_INPUT" ||
              block.blockType === "VAR_OUTPUT" ||
              block.blockType === "VAR_IN_OUT");
          if (
            (this.isUserDefinedType(decl.type.name) &&
              name.toUpperCase() === cppType.toUpperCase()) ||
            (isParameter
              ? this.currentFBInterfaceMethods.has(name.toUpperCase())
              : needsMemberMangling(name, decl.type.name, {
                  isUserDefinedType: (t) => this.isUserDefinedType(t),
                  shadowingNames: this.shadowingNames(),
                  interfaceMethods: this.currentFBInterfaceMethods,
                }))
          ) {
            this.memberMangledNames.set(name.toUpperCase(), `${name}_`);
          }
        }
      }
    }
  }

  /**
   * Exit the current scope, clearing variable type tracking.
   */
  private exitScope(): void {
    this.currentScopeVarTypes.clear();
    this.scopeInOutRefs = new Set();
    this.stackLocals = new Set();
  }

  /**
   * Topologically sort function blocks and late structs (user STRUCTs holding
   * a function block) so that each is emitted after the FBs and late structs
   * it holds by value (Kahn's algorithm). An FB depends on its member types
   * and its EXTENDS parent; a late struct on the user FBs and late structs it
   * holds. A held type that is neither — an ARRAY or alias, emitted with the
   * other types — is resolved through to what it holds (`allTypes`), so a
   * member `pair : BeltPair` (`ARRAY[0..1] OF FB_Belt`) still orders FB_Belt
   * first. Library FBs and early types are emitted before all of these.
   */
  private topologicalSortFBs(
    fbs: CompilationUnit["functionBlocks"],
    lateTypes: readonly TypeDeclaration[] = [],
    allTypes: readonly TypeDeclaration[] = [],
  ): HeaderClassNode[] {
    const nodes: HeaderClassNode[] = [
      ...fbs.map((fb): HeaderClassNode => ({ kind: "functionBlock", fb })),
      ...lateTypes.map((type): HeaderClassNode => ({ kind: "type", type })),
    ];
    if (nodes.length <= 1) return nodes;

    // Build key → node mapping. Keys carry the kind so an FB and a TYPE of
    // the same name stay apart; a name resolves to an FB first.
    const nodeName = (n: HeaderClassNode): string =>
      (n.kind === "functionBlock" ? n.fb.name : n.type.name).toUpperCase();
    const keyOf = (n: HeaderClassNode): string => `${n.kind}:${nodeName(n)}`;
    const nodeMap = new Map<string, HeaderClassNode>();
    for (const n of nodes) nodeMap.set(keyOf(n), n);
    const resolve = (typeName: string): string | undefined => {
      const upper = typeName.toUpperCase();
      if (nodeMap.has(`functionBlock:${upper}`))
        return `functionBlock:${upper}`;
      if (nodeMap.has(`type:${upper}`)) return `type:${upper}`;
      return undefined;
    };
    const typeByName = new Map<string, TypeDeclaration>();
    for (const t of allTypes) typeByName.set(t.name.toUpperCase(), t);

    // Build adjacency: node → set of nodes it depends on (holds as members)
    const deps = new Map<string, Set<string>>();
    for (const n of nodes) {
      const self = keyOf(n);
      const nodeDeps = new Set<string>();
      const seen = new Set<string>();
      const addDep = (typeName: string | undefined): void => {
        if (typeName === undefined) return;
        const dep = resolve(typeName);
        if (dep !== undefined) {
          if (dep !== self) nodeDeps.add(dep);
          return;
        }
        // An early ARRAY or alias: depend on what it holds.
        const upper = typeName.toUpperCase();
        const type = typeByName.get(upper);
        if (type === undefined || seen.has(upper)) return;
        seen.add(upper);
        for (const held of typeNamesHeldByTypeDefinition(type.definition)) {
          addDep(held);
        }
      };
      if (n.kind === "functionBlock") {
        for (const block of n.fb.varBlocks) {
          for (const decl of block.declarations) {
            addDep(decl.type.name);
            // An inline ARRAY OF a late type or an FB holds its elements.
            addDep(decl.type.elementTypeName);
          }
        }
        // Also check EXTENDS (parent FB must come first)
        addDep(n.fb.extends);
      } else {
        for (const held of typeNamesHeldByTypeDefinition(n.type.definition)) {
          addDep(held);
        }
      }
      deps.set(self, nodeDeps);
    }

    // Kahn's algorithm
    const inDegree = new Map<string, number>();
    for (const n of nodes) {
      inDegree.set(keyOf(n), deps.get(keyOf(n))!.size);
    }

    const queue: string[] = [];
    for (const [key, degree] of inDegree) {
      if (degree === 0) queue.push(key);
    }

    const sorted: HeaderClassNode[] = [];
    while (queue.length > 0) {
      const key = queue.shift()!;
      sorted.push(nodeMap.get(key)!);

      // Reduce in-degree for nodes that depend on this one
      for (const [nodeKey, nodeDeps] of deps) {
        if (nodeDeps.has(key)) {
          nodeDeps.delete(key);
          const newDeg = inDegree.get(nodeKey)! - 1;
          inDegree.set(nodeKey, newDeg);
          if (newDeg === 0) queue.push(nodeKey);
        }
      }
    }

    // If cycle detected, append remaining in original order
    if (sorted.length < nodes.length) {
      for (const n of nodes) {
        if (!sorted.includes(n)) {
          sorted.push(n);
        }
      }
    }

    return sorted;
  }

  /**
   * Check if a function call statement is actually an FB invocation.
   * Returns the FB type name if it is, undefined otherwise.
   *
   * `isElementCall` distinguishes `units[0]()` from `units()`: there the
   * declared type is the array, so the instance type is its element type.
   */
  private getFBInvocationType(
    functionName: string,
    instance?: Expression,
  ): string | undefined {
    const isElementCall = instance !== undefined;
    // `pf^(…)`, `a.b.fb(…)`: the function block a pointer or reference
    // points at, or a member instance
    if (
      instance?.kind === "VariableExpression" &&
      (instance.isDereference ||
        (instance.accessChain ?? []).some((s) => s.kind !== "subscript"))
    ) {
      const rootUpper = instance.name.toUpperCase();
      const globalType = this.namespaceGlobalTypeRef(rootUpper);
      const base: TypeReference | undefined =
        rootUpper === "THIS" && this.currentFBName !== undefined
          ? {
              kind: "TypeReference",
              sourceSpan: instance.sourceSpan,
              name: this.currentFBName,
              isReference: false,
              referenceKind: "none",
            }
          : (this.currentScopeVarTypeRefs.get(rootUpper) ?? globalType);
      const target =
        base === undefined
          ? undefined
          : resolveAccessType(base, instance, this.accessLookup);
      return target !== undefined &&
        (target.referenceKind === undefined ||
          target.referenceKind === "none") &&
        target.arrayDimensions === undefined &&
        this.isFBType(target.name)
        ? target.name
        : undefined;
    }
    // `units[0](…)` on a file-level global array (not shadowed here)
    const globalArray = isElementCall
      ? this.namespaceGlobalTypeRef(functionName.toUpperCase())
      : undefined;
    if (globalArray?.arrayDimensions !== undefined) {
      const element = globalArray.elementTypeName ?? globalArray.name;
      return this.isFBType(element) ? element : undefined;
    }
    const declaredType = isElementCall
      ? (this.currentScopeVarTypes.get(functionName.toUpperCase()) ??
        globalArray?.name)
      : this.invocationTargetType(functionName);
    if (!declaredType) return undefined;
    const varType = isElementCall
      ? this.ast
        ? resolveArrayElementTypeUtil(declaredType, this.ast)
        : undefined
      : declaredType;
    if (
      varType &&
      (this.isFBType(varType) ||
        this.knownProgramTypes.has(varType.toUpperCase()))
    ) {
      return varType;
    }
    return undefined;
  }

  /**
   * `a.b.fb(args)` (a method call the type checker found to name a function
   * block member) as an invocation of the instance `a.b.fb`.
   */
  private memberInstanceCall(
    call: MethodCallExpression,
  ): FunctionCallExpression | undefined {
    const object = call.object;
    if (call.fbInstanceCall !== true || object.kind !== "VariableExpression") {
      return undefined;
    }
    if (object.name.toUpperCase() === "SUPER") return undefined;
    const steps: AccessStep[] = [
      ...(object.accessChain ??
        object.fieldAccess.map(
          (name): AccessStep => ({ kind: "field", name }),
        )),
      { kind: "field", name: call.methodName },
    ];
    const instance: VariableExpression = {
      ...object,
      fieldAccess: [...object.fieldAccess, call.methodName],
      accessChain: steps,
      sourceSpan: call.sourceSpan,
    };
    return {
      kind: "FunctionCallExpression",
      sourceSpan: call.sourceSpan,
      functionName: object.name,
      arguments: call.arguments,
      instance,
    };
  }

  /**
   * The declared type of a call target written as a name: a variable of the
   * scope, else a file-level or library VAR_GLOBAL; for `a.b.c` the type of
   * member `c` reached from `a` (undefined when any step is not a field).
   */
  private invocationTargetType(functionName: string): string | undefined {
    const [root, ...members] = functionName.split(".");
    const rootUpper = root!.toUpperCase();
    let type =
      this.currentScopeVarTypes.get(rootUpper) ??
      this.inheritedMemberTypeName(rootUpper) ??
      this.namespaceGlobalType(rootUpper);
    for (const member of members) type = this.resolveMemberType(type, member);
    return type;
  }

  /** Declared type name of a member the current FB inherits from a base. */
  private inheritedMemberTypeName(upper: string): string | undefined {
    const seen = new Set<string>();
    let current = this.currentFBExtends;
    while (current !== undefined && !seen.has(current.toUpperCase())) {
      const base = current.toUpperCase();
      seen.add(base);
      const fb = this.ast?.functionBlocks.find(
        (f) => f.name.toUpperCase() === base,
      );
      if (!fb) return undefined;
      for (const block of fb.varBlocks) {
        for (const d of block.declarations) {
          if (d.names.some((n) => n.toUpperCase() === upper)) {
            return d.type.name;
          }
        }
      }
      current = fb.extends;
    }
    return undefined;
  }

  /** Declared type of a file-level or library VAR_GLOBAL not shadowed here. */
  private namespaceGlobalTypeRef(upper: string): TypeReference | undefined {
    if (this.currentScopeVarTypes.has(upper)) return undefined;
    if (this.namespaceGlobalType(upper) === undefined) return undefined;
    const sym = this._symbolTables?.globalScope.lookup(upper);
    return sym?.kind === "variable" ? sym.declaration.type : undefined;
  }

  /** The type of the variable an access path starts at: a local or member, else a file-level or library global. */
  private rootVariableType(upper: string): string | undefined {
    const own = this.currentScopeVarTypes.get(upper);
    if (own !== undefined) return own;
    // A member a base FB declares shadows a global; a base this unit does not
    // declare (a library FB) has members unknown here, so no global is assumed.
    if (this.currentFBExtends !== undefined) {
      const inherited = this.inheritedMemberTypeName(upper);
      if (inherited !== undefined) return inherited;
      if (!this.baseChainDeclared()) return undefined;
    }
    return this.namespaceGlobalType(upper);
  }

  /** Every base of the current FB is declared in this unit. */
  private baseChainDeclared(): boolean {
    const seen = new Set<string>();
    let current = this.currentFBExtends;
    while (current !== undefined && !seen.has(current.toUpperCase())) {
      const base = current.toUpperCase();
      seen.add(base);
      const fb = this.ast?.functionBlocks.find(
        (f) => f.name.toUpperCase() === base,
      );
      if (!fb) return false;
      current = fb.extends;
    }
    return true;
  }

  /** Declared type name of a file-level or library VAR_GLOBAL not shadowed here. */
  private namespaceGlobalType(upper: string): string | undefined {
    if (this.isCurrentFunctionResult(upper)) return undefined;
    if (this.reachedProgramNamed(upper) !== undefined) return undefined;
    if (!this.isNamespaceGlobal(upper)) return undefined;
    const sym = this._symbolTables?.globalScope.lookup(upper);
    return sym?.kind === "variable" ? sym.declaration.type.name : undefined;
  }

  /**
   * Generate code for an FB invocation.
   * Pattern: assign inputs → call operator() → capture outputs
   */
  /**
   * Extract implicit EN/ENO arguments from a function/FB call.
   * Returns the EN condition expression, ENO target variable, and the
   * remaining arguments with EN/ENO stripped out.
   */
  private extractEnEno(args: Argument[]): {
    enExpr: string | null;
    enoVar: string | null;
    filteredArgs: Argument[];
  } {
    let enExpr: string | null = null;
    let enoVar: string | null = null;
    const filteredArgs: Argument[] = [];

    for (const arg of args) {
      const nameUpper = arg.name?.toUpperCase();
      if (nameUpper === "EN" && !arg.isOutput) {
        enExpr = this.generateExpression(arg.value);
      } else if (nameUpper === "ENO" && arg.isOutput) {
        enoVar = this.generateExpression(arg.value);
      } else {
        filteredArgs.push(arg);
      }
    }

    return { enExpr, enoVar, filteredArgs };
  }

  /**
   * Check if a function call argument list contains EN or ENO implicit parameters.
   */
  private hasEnEno(args: Argument[]): boolean {
    return args.some((a) => {
      const n = a.name?.toUpperCase();
      return (n === "EN" && !a.isOutput) || (n === "ENO" && a.isOutput);
    });
  }

  /**
   * Emit an EN/ENO wrapper around a body-emitting callback.
   *
   * Two ENO sinks are reflected uniformly:
   *   - `enoVar`              — the caller's `ENO => var` binding, if any.
   *   - `instanceEnoTarget`   — the FB instance's implicit ENO member
   *                             (e.g. `inst.ENO`), passed for FB calls so
   *                             `IF inst.ENO THEN ...` reads the right
   *                             value.  null for plain function calls.
   *
   * Both sinks are written every time so they can't carry stale values
   * across calls.  Per IEC 61131-3 §6.4.1.3, ENO defaults to TRUE when
   * EN is omitted — so an unguarded call writes TRUE to every sink it
   * has, which also overwrites any FALSE left behind by a prior gated
   * invocation.
   */
  private emitEnEnoWrapper(
    indent: string,
    enExpr: string | null,
    enoVar: string | null,
    emitBody: (bodyIndent: string) => void,
    instanceEnoTarget: string | null = null,
    instanceEnoDeclared = false,
  ): void {
    // A declared BOOL ENO: TRUE before the body, which may clear it; the
    // caller's ENO => target then reads it.
    if (instanceEnoDeclared && instanceEnoTarget !== null) {
      const copyOut = (atIndent: string, value: string): void => {
        if (enoVar !== null) this.emit(`${atIndent}${enoVar} = ${value};`);
      };
      const run = (atIndent: string): void => {
        this.emit(`${atIndent}${instanceEnoTarget} = true;`);
        emitBody(atIndent);
        copyOut(atIndent, instanceEnoTarget);
      };
      if (enExpr === null) {
        run(indent);
        return;
      }
      const bodyIndent = indent + this.options.indent;
      this.emit(`${indent}if (${enExpr}) {`);
      run(bodyIndent);
      this.emit(`${indent}} else {`);
      this.emit(`${bodyIndent}${instanceEnoTarget} = false;`);
      copyOut(bodyIndent, "false");
      this.emit(`${indent}}`);
      return;
    }
    const targets = [enoVar, instanceEnoTarget].filter(
      (t): t is string => t !== null,
    );
    const writeTargets = (atIndent: string, value: boolean): void => {
      for (const t of targets) {
        this.emit(`${atIndent}${t} = ${value};`);
      }
    };

    if (enExpr !== null) {
      const bodyIndent = indent + this.options.indent;
      this.emit(`${indent}if (${enExpr}) {`);
      emitBody(bodyIndent);
      writeTargets(bodyIndent, true);
      this.emit(`${indent}} else {`);
      writeTargets(bodyIndent, false);
      this.emit(`${indent}}`);
    } else {
      emitBody(indent);
      writeTargets(indent, true);
    }
  }

  private generateFBInvocation(
    call: FunctionCallExpression,
    indent: string,
    program?: string,
  ): void {
    const rawName = this.resolveVariableBaseName(call.functionName);

    // Calling a function-block instance that is a shared global: not yet
    // supported (see generateVariableExpression for the rationale). An FB call
    // mutates instance state and reads its outputs across several emitted
    // lines; doing that safely needs a single with_lock() spanning the whole
    // call, which is a follow-up phase. Fail loudly.
    if (this.compositeExternals.has(call.functionName.toUpperCase())) {
      throw new Error(
        `Shared global '${call.functionName}' is a function-block instance and ` +
          `is invoked in a program body. Calling a shared function-block global ` +
          `is not yet supported in the mutex-based shared-global model — scalar ` +
          `globals only for now.`,
      );
    }

    // `units[0](…)` invokes an element rather than a bare instance: the target
    // is the subscripted expression, and the FB type is the array's element
    // type. Everything below (input assignment, the call, inout copy-back,
    // output capture) then works against that expression unchanged.
    // `PRG_A(...)`: the body of a reached program's one shared instance.
    const instanceName =
      program !== undefined
        ? this.sharedProgramInstance(program)
        : call.instance !== undefined
          ? this.generateExpression(call.instance)
          : rawName.includes(".")
            ? this.generateExpression(this.dottedInstanceExpression(call))
            : this.currentScopeVarRefKinds.get(rawName.toUpperCase()) ===
                "reference_to"
              ? `${this.memberMangledNames.get(rawName.toUpperCase()) ?? rawName}.target()`
              : this.scopeInOutRefs.has(rawName.toUpperCase())
                ? `(*${this.memberMangledNames.get(rawName.toUpperCase()) ?? rawName})`
                : (this.memberMangledNames.get(rawName.toUpperCase()) ??
                  rawName);

    // Extract implicit EN/ENO parameters
    const { enExpr, enoVar, filteredArgs } = this.extractEnEno(call.arguments);

    // Resolve FB type for positional argument mapping
    const fbTypeName =
      program ?? this.getFBInvocationType(call.functionName, call.instance);
    // A PROGRAM's own instance or a variable of PROGRAM type: run() it.
    const programType =
      program ??
      (fbTypeName !== undefined &&
      this.knownProgramTypes.has(fbTypeName.toUpperCase())
        ? fbTypeName
        : undefined);
    // Parameters a positional argument binds, in declaration order.
    const positionalParams =
      programType !== undefined
        ? this.programInputNames(programType)
        : this.fbPositionalParams(fbTypeName);

    // Bind each argument to its parameter (named or positional) before the
    // call: an input is assigned, an in-out refers to the argument.
    const bindings: Array<{ arg: Argument; param: string }> = [];
    let positionalIndex = 0;
    for (const arg of filteredArgs) {
      if (arg.isOutput) continue;
      const param = arg.name ?? positionalParams?.[positionalIndex];
      if (arg.name === undefined) positionalIndex++;
      if (param === undefined) {
        // Positional argument without type info — emit as warning comment
        this.emit(
          `${indent}// WARNING: positional argument ${positionalIndex - 1} could not be resolved`,
        );
        continue;
      }
      bindings.push({ arg, param });
    }

    // An in-out passed by copy (another type, a UNION member) binds a
    // temporary that must outlive the call: the call then sits in a block.
    const kindOf = (param: string): ReturnType<CodeGenerator["inOutKind"]> =>
      programType === undefined ? this.inOutKind(fbTypeName, param) : undefined;
    const byCopy = (b: { arg: Argument; param: string }): boolean =>
      kindOf(b.param) === "ref" &&
      (b.arg.inOutCopy === true ||
        (b.arg.value.kind === "VariableExpression" &&
          b.arg.value.unionMember === true));
    const outerIndent = indent;
    if (bindings.some(byCopy)) {
      this.emit(`${indent}{`);
      indent = indent + this.options.indent;
    }

    const copyOuts: Array<{ target: Expression; source: string }> = [];
    const unbinds: string[] = [];
    for (const binding of bindings) {
      const { arg, param } = binding;
      const member = `${instanceName}.${this.fbParamMemberName(param, fbTypeName)}`;
      const kind = kindOf(param);
      if (kind === "legacy") {
        // A library built before by-reference in-outs: copy in and back.
        this.warnLegacyInOutLibrary(fbTypeName, call);
        this.emit(
          `${indent}${member} = ${this.generateExpression(arg.value)};`,
        );
        copyOuts.push({ target: arg.value, source: member });
      } else if (kind === "view") {
        // ARRAY[*]: the view refers to the caller's array.
        this.emit(
          `${indent}${member} = ${this.inOutBindTarget(arg.value, param, call)};`,
        );
        if (this.isStackRooted(arg.value)) {
          unbinds.push(`${member} = decltype(${member})();`);
        }
      } else if (kind === "ref" && byCopy(binding)) {
        const tmp = `__io_${this.tempVarCounter++}`;
        const read = this.generateLvalue(arg.value);
        const copyIn =
          arg.value.kind === "VariableExpression" &&
          arg.value.unionMember === true
            ? `union_value(${read})`
            : read;
        this.emit(`${indent}decltype(${member})::value_type ${tmp};`);
        this.emit(`${indent}${tmp} = ${copyIn};`);
        this.emit(`${indent}${member}.bind(${tmp});`);
        copyOuts.push({ target: arg.value, source: tmp });
        unbinds.push(`${member}.unbind();`);
      } else if (kind === "ref") {
        this.emit(
          `${indent}${member}.bind(${this.inOutBindTarget(arg.value, param, call)});`,
        );
        if (this.isStackRooted(arg.value)) unbinds.push(`${member}.unbind();`);
      } else {
        this.emit(
          `${indent}${member} = ${this.fbInputArgument(fbTypeName, param, arg.value)};`,
        );
      }
    }

    // Call the FB/program execution body, wrapped with EN/ENO logic.
    // Pass the FB instance's ENO field so source code can read
    // `inst.ENO` after the invocation and see the right value.
    this.emitEnEnoWrapper(
      indent,
      enExpr,
      enoVar,
      (bi) => {
        if (programType !== undefined) {
          this.emit(`${bi}${instanceName}.run();`);
        } else {
          this.emitPOUCallLine(instanceName, call.functionName, bi);
        }
      },
      `${instanceName}.ENO`,
      fbTypeName !== undefined && this.declaredEnoType(fbTypeName) === "BOOL",
    );

    // Copy-outs of in-outs passed by copy, then the bindings that end with
    // the call (their targets live on this body's stack).
    for (const { target, source } of copyOuts) {
      this.emitCaptureToLvalue(target, source, indent);
    }
    for (const line of unbinds) this.emit(`${indent}${line}`);
    if (indent !== outerIndent) this.emit(`${outerIndent}}`);
    indent = outerIndent;

    // Capture output arguments (=> syntax), excluding ENO (already handled)
    for (const arg of filteredArgs) {
      if (arg.name && arg.isOutput) {
        const member = `${instanceName}.${this.fbParamMemberName(arg.name, fbTypeName)}`;
        this.emitCaptureToLvalue(
          arg.value,
          kindOf(arg.name) === "ref" ? `(*${member})` : member,
          indent,
        );
      }
    }
  }

  /** `a.b(...)` on a member instance `b`: the instance as a variable access `a.b`. */
  private dottedInstanceExpression(
    call: FunctionCallExpression,
  ): VariableExpression {
    const [root, ...members] = call.functionName.split(".");
    return {
      kind: "VariableExpression",
      sourceSpan: call.sourceSpan,
      name: root!,
      subscripts: [],
      fieldAccess: members,
      isDereference: false,
      accessChain: members.map((name) => ({ kind: "field", name })),
    };
  }

  /**
   * The parameters a positional argument of a call of FB type `fbTypeName`
   * binds, in order: VAR_INPUT and VAR_IN_OUT in declaration order, inherited
   * ones first (as the type checker matches them); for a library FB its
   * inputs, then its in-outs.
   */
  private fbPositionalParams(
    fbTypeName: string | undefined,
  ): string[] | undefined {
    if (fbTypeName === undefined) return undefined;
    const chain: CompilationUnit["functionBlocks"] = [];
    let current: string | undefined = fbTypeName.toUpperCase();
    while (current !== undefined && chain.length < 32) {
      const owner: string = current;
      const fb = this.ast?.functionBlocks.find(
        (f) => f.name.toUpperCase() === owner,
      );
      if (!fb) break;
      chain.unshift(fb);
      current = fb.extends?.toUpperCase();
    }
    if (chain.length === 0) {
      const upper = fbTypeName.toUpperCase();
      const inputs = this.fbInputParams.get(upper) ?? [];
      const inouts = [...(this.fbInoutParams.get(upper) ?? [])];
      return inputs.length + inouts.length > 0
        ? [...inputs, ...inouts]
        : undefined;
    }
    return chain.flatMap((fb) =>
      fb.varBlocks
        .filter(
          (b) => b.blockType === "VAR_INPUT" || b.blockType === "VAR_IN_OUT",
        )
        .flatMap((b) => b.declarations.flatMap((d) => d.names)),
    );
  }

  /**
   * The C++ lvalue a VAR_IN_OUT binds for argument `value`: the variable
   * itself; a shared global's canonical storage (`g->value`, unlocked — see
   * warnSharedGlobalInOut); the target of a REFERENCE TO.
   */
  private inOutBindTarget(
    value: Expression,
    param: string,
    call: FunctionCallExpression | MethodCallExpression,
  ): string {
    if (value.kind !== "VariableExpression")
      return this.generateExpression(value);
    if (
      this.programExternals.has(value.name.toUpperCase()) &&
      !value.isDereference
    ) {
      this.warnSharedGlobalInOut(value.name, param, call);
    }
    return this.renderInOutBound(value);
  }

  /**
   * An in-out argument as the lvalue the parameter refers to: a shared
   * global's canonical storage (`g->value`), a REFERENCE TO's target, else
   * the variable as written.
   */
  private renderInOutBound(value: VariableExpression): string {
    const upper = value.name.toUpperCase();
    if (this.programExternals.has(upper) && !value.isDereference) {
      return this.renderAccessTail(
        `${this.resolveVariableBaseName(value.name)}->value`,
        value,
        upper,
      );
    }
    if (
      this.currentScopeVarRefKinds.get(upper) === "reference_to" &&
      value.fieldAccess.length === 0 &&
      value.subscripts.length === 0 &&
      (value.accessChain?.length ?? 0) === 0 &&
      !value.isDereference
    ) {
      return `${this.resolveVariableBaseName(value.name)}.target()`;
    }
    const saved = this.inOutBindExprs.delete(value);
    const rendered = this.generateLvalue(value);
    if (saved) this.inOutBindExprs.add(value);
    return rendered;
  }

  /**
   * `value` lives on the C++ stack of the body being generated (a parameter,
   * VAR or VAR_TEMP of a method or function, or a function result), or is
   * itself an in-out of the enclosing block (whose target may): a binding to
   * it must end with the call.
   */
  private isStackRooted(value: Expression): boolean {
    if (value.kind !== "VariableExpression") return false;
    const upper = value.name.toUpperCase();
    return (
      this.stackLocals.has(upper) ||
      this.scopeInOutRefs.has(upper) ||
      this.isCurrentFunctionResult(upper)
    );
  }

  /**
   * A CONFIGURATION global bound to a VAR_IN_OUT: the in-out refers to its
   * storage for the call, outside the global's lock.
   */
  private warnSharedGlobalInOut(
    global: string,
    param: string,
    call: FunctionCallExpression | MethodCallExpression,
  ): void {
    if (!this.tasksMayRace()) return;
    this.codegenWarnings.push({
      message:
        `VAR_IN_OUT '${param}' refers to the shared global '${global}' during the call: ` +
        `in a build with STRUCPP_THREADED, accesses through it are not serialized by the global's lock, ` +
        `so another task using '${global}' at the same time races with them`,
      line: call.sourceSpan.startLine,
      column: call.sourceSpan.startCol,
      file: call.sourceSpan.file,
    });
  }

  /** A call of a library FB whose archive predates by-reference in-outs. */
  private warnLegacyInOutLibrary(
    fbTypeName: string | undefined,
    call: FunctionCallExpression,
  ): void {
    const upper = fbTypeName?.toUpperCase();
    if (upper === undefined || this.legacyInOutWarned.has(upper)) return;
    this.legacyInOutWarned.add(upper);
    this.codegenWarnings.push({
      message:
        `Function block '${fbTypeName}' comes from a library built before VAR_IN_OUT was bound by reference: ` +
        `its in-outs are copied in and back around the call. Rebuild the library with this compiler`,
      line: call.sourceSpan.startLine,
      column: call.sourceSpan.startCol,
      file: call.sourceSpan.file,
    });
  }

  /** VAR_INPUT names of a PROGRAM, in declaration order (positional call arguments). */
  private programInputNames(program: string): string[] {
    const upper = program.toUpperCase();
    const prog = this.ast?.programs.find((p) => p.name.toUpperCase() === upper);
    return (prog?.varBlocks ?? [])
      .filter((b) => b.blockType === "VAR_INPUT")
      .flatMap((b) => b.declarations.flatMap((d) => d.names));
  }

  /**
   * The C++ value an FB call assigns to input `paramName`: the argument, or
   * for a REFERENCE TO input `ref_bind(arg)`, so the assignment rebinds the
   * input to the argument instead of writing through it.
   */
  private fbInputArgument(
    fbTypeName: string | undefined,
    paramName: string,
    value: Expression,
  ): string {
    const generated = this.generateExpression(value);
    if (fbTypeName === undefined) return generated;
    const inout = this.fbInoutParams.get(fbTypeName.toUpperCase());
    if (inout?.has(paramName.toUpperCase()) === true) return generated;
    const field = this.accessLookup.field(fbTypeName, paramName);
    return field?.type.referenceKind === "reference_to"
      ? `ref_bind(${generated})`
      : generated;
  }

  /**
   * Emit `<target> = <source>` where `source` is an already-rendered C++
   * expression. If `target` is a composite / array shared global (VAR_EXTERNAL
   * to a composite VAR_GLOBAL), the write goes through the global's mutex via
   * with_lock (a with_lock read result is an rvalue and can't be assigned to).
   * Used for FB VAR_IN_OUT copy-back and `=>` output capture.
   */
  private emitCaptureToLvalue(
    target: Expression,
    source: string,
    indent: string,
  ): void {
    if (
      target.kind === "VariableExpression" &&
      !target.isDereference &&
      this.compositeExternals.has(target.name.toUpperCase())
    ) {
      const ptr = this.resolveVariableBaseName(target.name);
      const lv = this.renderAccessTail(
        "(*__glk)",
        target,
        target.name.toUpperCase(),
      );
      this.emit(
        `${indent}${ptr}->with_lock([&](auto* __glk){ ${lv} = ${source}; });`,
      );
      return;
    }
    // Scalar VAR_EXTERNAL capture → the shared global is a pointer, so its value
    // is read via `->read()` (an rvalue) and written via `->write()`. Assigning
    // to `->read()` fails to compile, so route the write through the pointer,
    // mirroring the scalar-external branch of generateAssignmentStatement.
    if (
      target.kind === "VariableExpression" &&
      target.fieldAccess.length === 0 &&
      !target.isDereference &&
      this.programExternals.has(target.name.toUpperCase())
    ) {
      this.emit(`${indent}${target.name}->write(${source});`);
      return;
    }
    this.emit(`${indent}${this.generateLvalue(target)} = ${source};`);
  }

  /**
   * Collect all interface method names (UPPER case) for a FB's IMPLEMENTS list.
   */
  protected getInterfaceMethodNames(fb: {
    implements?: string[];
  }): Set<string> {
    const result = new Set<string>();
    if (!fb.implements) return result;
    for (const ifaceName of fb.implements) {
      const methods = this.interfaceMethodsByInterface.get(
        ifaceName.toUpperCase(),
      );
      if (methods) {
        for (const m of methods) result.add(m);
      }
    }
    return result;
  }

  /**
   * If a member variable name collides with its C++ type name or an interface
   * method name (case-insensitive), append '_' to avoid C++ errors.
   * Populates memberMangledNames map and returns the (possibly mangled) name.
   */
  private mangleMemberIfNeeded(name: string, stTypeName: string): string {
    // Declaring a member of the FB currently being generated, so the interface
    // methods in scope are that FB's.
    const mangled = mangledMemberName(name, stTypeName, {
      isUserDefinedType: (t) => this.isUserDefinedType(t),
      shadowingNames: this.shadowingNames(),
      interfaceMethods: this.currentFBInterfaceMethods,
    });
    if (mangled !== name) {
      this.memberMangledNames.set(name.toUpperCase(), mangled);
    }
    return mangled;
  }

  /**
   * C++ member name for a parameter of the function block being invoked, by the
   * same rule its declaration used (see member-mangling.ts).
   *
   * An FB whose input is named after its own type, or after an interface method
   * it implements, is declared with a trailing underscore — so assigning through
   * the bare name reaches a member that does not exist. Left alone when the FB
   * type is unknown, which only disables the check.
   */
  private fbParamMemberName(
    paramName: string,
    fbTypeName: string | undefined,
  ): string {
    if (fbTypeName === undefined) return paramName;
    return this.needsFieldMangling(
      paramName,
      this.resolveMemberType(fbTypeName, paramName),
      fbTypeName,
    )
      ? `${paramName}_`
      : paramName;
  }

  /**
   * Check if a field access needs mangling — true when the field name collides
   * with its type name (GCC -Wchanges-meaning) or with an interface method name.
   *
   * Reaching a member through a named owner rather than from inside it, so the
   * interface methods come from that owner's entry.
   */
  protected needsFieldMangling(
    fieldName: string,
    fieldTypeName: string | undefined,
    parentTypeName?: string,
  ): boolean {
    return needsMemberMangling(fieldName, fieldTypeName, {
      isUserDefinedType: (t) => this.isUserDefinedType(t),
      shadowingNames: this.shadowingNames(),
      interfaceMethods:
        parentTypeName !== undefined
          ? this.fbInterfaceMethodNames.get(parentTypeName.toUpperCase())
          : undefined,
    });
  }

  /**
   * Resolve the base name for a variable. Subclasses can override to add
   * prefixes (e.g., "s." for SETUP variables in test codegen).
   */
  protected resolveVariableBaseName(name: string): string {
    const upper = name.toUpperCase();
    if (
      !RUNTIME_NAMESPACE_NAMES.has(upper) ||
      (this.currentScopeVarTypes.has(upper) &&
        !this.scopeExternalNames.has(upper)) ||
      !this.isNamespaceGlobal(upper)
    ) {
      return name;
    }
    return globalCppName(name);
  }

  /** A file-level VAR_GLOBAL of this compile or of a library (not a CONFIGURATION one). */
  private isNamespaceGlobal(upper: string): boolean {
    if (this.fileScopeGlobalNames().has(upper)) return true;
    const sym = this._symbolTables?.globalScope.lookup(upper);
    if (sym?.kind !== "variable") return false;
    return !(this.ast?.configurations ?? []).some((c) =>
      c.varBlocks.some((b) =>
        b.declarations.some((d) =>
          d.names.some((n) => n.toUpperCase() === upper),
        ),
      ),
    );
  }

  /**
   * Emit the call line for a POU (FB or program) invocation.
   * Subclasses can override to change the call pattern (e.g., ".run()" for programs).
   */
  protected emitPOUCallLine(
    instanceName: string,
    _rawName: string,
    indent: string,
  ): void {
    this.emit(`${indent}${instanceName}();`);
  }

  /**
   * Initialiser for a project-model variable, or undefined when the member
   * should be left to its default constructor.
   *
   * Shared by the PROGRAM constructor initialiser lists and the file-scope
   * VAR_GLOBAL definitions so all three agree on how a declaration initialises.
   */
  private projectVarInitializer(
    decl: ProjectVarDeclaration,
  ): string | undefined {
    // References (REF_TO / REFERENCE TO) and pointers (POINTER TO) wrap a
    // pointer internally and must be default-constructed (unbound/null) —
    // `name(0)` is ambiguous for IEC_REF_TO, and also for IEC_Ptr, which has an
    // integer-address ctor (the `0` literal matches both the nullptr_t and the
    // uintptr_t overload). The default ctor sets the pointer to nullptr, which
    // is exactly the IEC default. References are bound later via REF= / :=
    // REF(); pointers via := ADR()/&.
    if (
      decl.referenceKind === "ref_to" ||
      decl.referenceKind === "reference_to" ||
      decl.referenceKind === "pointer_to"
    ) {
      // `p : POINTER TO T := ADR(x);` and `r : REF_TO T := REF(x);` bind
      // the pointer or reference as it is created.
      const value = decl.initialValue;
      const binds =
        (decl.referenceKind === "pointer_to" &&
          value?.kind === "FunctionCallExpression" &&
          value.functionName.toUpperCase() === "ADR") ||
        (decl.referenceKind === "ref_to" && value?.kind === "RefExpression");
      return binds && value !== undefined
        ? this.generateExpression(value)
        : undefined;
    }
    if (decl.initialValue) {
      return this.generateInitializer(
        decl.initialValue,
        this.mapTypeRefToCpp(this.projectVarToTypeRef(decl)),
        decl.typeName,
      );
    }
    // Composite types (struct, enum, array, FB instance) report no default here
    // (empty string) and are skipped, so their own default constructor runs.
    const typeDefault = this.getTypeDefaultValue(decl.typeName);
    return typeDefault === "" ? undefined : typeDefault;
  }

  /**
   * Emit C++ for a declaration initialiser.
   *
   * Everything but a structure initializer is an ordinary expression;
   * `structure_initialization` additionally needs the target's C++ type, which
   * only the declaration site knows, so it routes through
   * {@link generateInitializerValue}.
   */
  protected generateInitializer(
    value: Expression,
    cppType: string,
    stTypeName: string | undefined,
  ): string {
    if (!isStructInitializerValue(value)) {
      return this.generateExpression(value);
    }
    return generateInitializerValue(
      value,
      cppType,
      stTypeName,
      this.getStructInitEmitter(),
    );
  }

  /**
   * Hooks {@link generateInitializerValue} uses to resolve element names and
   * nested element types. Reuses the same member-mangling and field-resolution
   * helpers the statement path uses, so `p.X` in a body and `X :=` in an
   * initializer always name the same C++ member.
   */
  private getStructInitEmitter(): StructInitEmitter {
    this.structInitEmitter ??= {
      emitValue: (value: Expression): string => this.generateExpression(value),
      memberName: (
        fieldName: string,
        ownerTypeName: string | undefined,
      ): string =>
        this.needsFieldMangling(
          fieldName,
          this.resolveMemberType(ownerTypeName, fieldName),
          ownerTypeName,
        )
          ? `${fieldName}_`
          : fieldName,
      fieldTypeName: (
        fieldName: string,
        ownerTypeName: string | undefined,
      ): string | undefined => this.resolveMemberType(ownerTypeName, fieldName),
      arrayElementTypeName: (
        typeName: string | undefined,
      ): string | undefined =>
        typeName !== undefined && typeName !== "" && this.ast
          ? resolveArrayElementTypeUtil(typeName, this.ast)
          : undefined,
    };
    return this.structInitEmitter;
  }

  /**
   * Value-initialisation for a type that has no declared initialiser.
   *
   * Returns an empty string for composite types (structs, enums, arrays, FB
   * instances), whose default constructor already does the right thing — the
   * callers use that to skip the member entirely in a constructor initialiser
   * list.
   */
  private getTypeDefaultValue(typeName: string): string {
    const upperType = typeName.toUpperCase();
    if (upperType === "BOOL") return "false";
    if (upperType === "REAL" || upperType === "LREAL") return "0.0";
    if (upperType === "STRING") return '""';
    if (upperType === "WSTRING") return 'u""';

    // Check if it's an elementary type that uses numeric default
    const numericTypes = [
      "SINT",
      "INT",
      "DINT",
      "LINT",
      "USINT",
      "UINT",
      "UDINT",
      "ULINT",
      "BYTE",
      "WORD",
      "DWORD",
      "LWORD",
      "TIME",
      "DATE",
      "TOD",
      "DT",
      "LTIME",
      "LDATE",
      "LTOD",
      "LDT",
      "CHAR",
      "WCHAR",
    ];
    if (numericTypes.includes(upperType)) {
      return "0";
    }

    // User-defined types (structs, enums, arrays, subranges, type aliases)
    // use default initialization - return empty string to skip in initializer list
    return "";
  }

  /**
   * Collect all program instances from a configuration.
   */
  private collectProgramInstances(
    config: ConfigurationDecl,
  ): Array<{ instanceName: string; programType: string; taskName?: string }> {
    const instances: Array<{
      instanceName: string;
      programType: string;
      taskName?: string;
    }> = [];
    for (const resource of config.resources) {
      for (const task of resource.tasks) {
        for (const inst of task.programInstances) {
          instances.push(inst);
        }
      }
    }
    return instances;
  }

  /**
   * Another task can run at the same time as this code: the build is threaded
   * (STRUCPP_THREADED), or a CONFIGURATION runs more than one task.
   */
  private tasksMayRace(): boolean {
    if (this.options.threaded === true) return true;
    return (
      this.projectModel?.configurations.some((c) => this.countTasks(c) > 1) ===
      true
    );
  }

  /**
   * Count total tasks in a configuration.
   */
  private countTasks(config: ConfigurationDecl): number {
    let count = 0;
    for (const resource of config.resources) {
      count += resource.tasks.length;
    }
    return count;
  }

  /**
   * Push the descriptor(s) one located declaration produces.
   *
   * A scalar produces one. An ARRAY produces one PER ELEMENT, walking the
   * address forward by one slot each time, so `AT %MW60 : ARRAY [0..66] OF
   * WORD` fills %MW60..%MW126 (openplc-editor#565). The runtime table is flat
   * and knows nothing about aggregates -- the expansion happens here so that
   * every consumer of `locatedVars[]` (the descriptor array, the count, the
   * per-program range, the located-globals list) gets the element-level view
   * without any of them having to understand arrays.
   *
   * Bit addresses advance across the byte boundary (%IX0.7 -> %IX1.0), which
   * is why the step is computed on the linearised index rather than on
   * `byteIndex` alone.
   *
   * `dims` is `undefined` for a non-array. The semantic analyzer has already
   * rejected the array shapes that cannot be laid out linearly (multi-
   * dimensional, non-constant bounds), so anything reaching here with bounds
   * is a single dimension with a known extent.
   */
  /**
   * The dimensions a located declaration actually has, resolving a NAMED
   * ARRAY type the way the semantic analyzer already does.
   *
   * The AST builder writes bounds onto the TypeReference only for an INLINE
   * `ARRAY [a..b] OF T`. A named type (`TYPE Buf : ARRAY [0..9] OF WORD`) has
   * none, so reading `decl.type.arrayDimensions` alone made codegen see a
   * scalar where the analyzer had seen ten slots: one descriptor was emitted
   * and the pointer initialiser called `.raw_ptr()` on the array itself, which
   * does not compile. Resolving by name here keeps the two passes agreeing.
   *
   * Answers `undefined` for anything that is not a single fixed dimension --
   * multi-dimensional and variable-length shapes are rejected in semantics and
   * never reach codegen, so this is a fallback rather than a second opinion.
   */
  private resolveLocatedDims(
    typeName: string,
    dims: Array<{ start: number; end: number }> | undefined,
  ): Array<{ start: number; end: number }> | undefined {
    if (dims && dims.length > 0) return dims;
    if (!this.ast) return undefined;

    const shape = resolveArrayShapeByName(typeName, this.ast);
    if (!shape || shape.dims.length !== 1) return undefined;

    const dim = shape.dims[0];
    return dim ? [dim] : undefined;
  }

  private pushLocatedDescriptors(
    varName: string,
    address: string,
    typeName: string,
    programName: string,
    dims: Array<{ start: number; end: number }> | undefined,
  ): void {
    const parsed = parseLocatedAddress(address);
    if (!parsed) return;

    const resolved = this.resolveLocatedDims(typeName, dims);
    const dim = resolved?.length === 1 ? resolved[0] : undefined;
    if (!dim) {
      this.locatedVars.push({
        varName,
        address,
        area: parsed.area,
        size: parsed.size,
        byteIndex: parsed.byteIndex,
        bitIndex: parsed.bitIndex,
        typeName,
        programName,
      });
      return;
    }

    const isBit = parsed.size === "Bit";
    const baseSlot = isBit
      ? parsed.byteIndex * 8 + parsed.bitIndex
      : parsed.byteIndex;

    for (let iecIndex = dim.start; iecIndex <= dim.end; iecIndex++) {
      const slot = baseSlot + (iecIndex - dim.start);
      this.locatedVars.push({
        varName,
        address,
        area: parsed.area,
        size: parsed.size,
        byteIndex: isBit ? Math.floor(slot / 8) : slot,
        bitIndex: isBit ? slot % 8 : 0,
        typeName,
        programName,
        elementIndex: iecIndex,
      });
    }
  }

  /**
   * Collect a located variable for descriptor array generation.
   */
  private collectLocatedVar(
    varName: string,
    decl: VarDeclaration,
    programName: string,
  ): void {
    if (!decl.address) return;

    this.pushLocatedDescriptors(
      varName,
      decl.address,
      decl.type.name,
      programName,
      // Inline `ARRAY [a..b] OF T`: the AST builder resolves the bounds onto
      // the TypeReference. A named ARRAY type carries none here and is
      // handled by the model path, which resolves the alias first.
      decl.type.arrayDimensions,
    );
  }

  /**
   * Collect a located variable from project model for descriptor array generation.
   */
  private collectLocatedVarFromModel(
    decl: {
      name: string;
      typeName: string;
      address?: string;
      // Explicit `| undefined` (not just `?`): exactOptionalPropertyTypes is
      // on, and callers forward an optional field straight through.
      arrayDimensions?: Array<{ start: number; end: number }> | undefined;
    },
    programName: string,
  ): void {
    if (!decl.address) return;

    this.pushLocatedDescriptors(
      decl.name,
      decl.address,
      decl.typeName,
      programName,
      decl.arrayDimensions,
    );
  }

  /**
   * Generate the located variables descriptor array in the header.
   */
  private generateLocatedVarsDeclaration(): void {
    // Library compilations (no PROGRAM, no CONFIGURATION — only FBs /
    // functions / types) must NOT emit these symbols, otherwise the
    // consumer's program would see two definitions when its preamble
    // includes the library. Top-level program builds always emit them so
    // the runtime sketch can reference `locatedVars` / `locatedVarsCount`
    // unconditionally — including when the user has zero `AT %...`
    // declarations (then we emit a 1-element placeholder array because
    // C++ disallows zero-length arrays at namespace scope; the sketch's
    // binding loop iterates `i < locatedVarsCount` so the placeholder is
    // never accessed at runtime).
    const hasPrograms =
      !!this.projectModel && this.projectModel.programs.size > 0;
    if (!hasPrograms) return;

    const isEmpty = this.locatedVars.length === 0;
    const arrayLen = isEmpty ? 1 : this.locatedVars.length;

    this.emitHeader(
      "// =============================================================================",
    );
    this.emitHeader("// Located Variables Descriptor Array");
    this.emitHeader(
      "// =============================================================================",
    );
    this.emitHeader("");
    this.emitHeader("/**");
    this.emitHeader(" * Located variable descriptors for runtime I/O binding.");
    this.emitHeader(
      " * The runtime iterates this array to bind variables to I/O image tables.",
    );
    this.emitHeader(" */");
    this.emitHeader("");

    // Forward declarations for program instances.
    //
    // One line per DECLARATION, not per descriptor: a located array expands to
    // one descriptor per element, and repeating the same "AT %MW60" line 67
    // times would bury the rest of the header in noise.
    const listed = new Set<string>();
    for (const locVar of this.locatedVars) {
      const scope =
        locVar.programName === "@config"
          ? "configuration"
          : `Program_${locVar.programName}`;
      const line = `// Forward: ${locVar.varName} AT ${locVar.address} in ${scope}`;
      if (listed.has(line)) continue;
      listed.add(line);
      this.emitHeader(line);
    }
    if (isEmpty) {
      this.emitHeader("// (no located variables — placeholder entry only)");
    }
    this.emitHeader("");

    // The actual array will be defined in the implementation file
    // and initialized in the constructor
    this.emitHeader(`extern LocatedVar locatedVars[${arrayLen}];`);
    this.emitHeader(
      `constexpr uint32_t locatedVarsCount = ${this.locatedVars.length};`,
    );
    this.emitHeader("");

    // Located CONFIGURATION VAR_GLOBALs — see generateLocatedGlobalsDefinition()
    // for why the scope has to be stated rather than inferred by the runtime.
    const globalCount = this.locatedVars.filter(
      (v) => v.programName === "@config",
    ).length;
    this.emitHeader("#ifdef STRUCPP_THREADED");
    this.emitHeader(
      `extern void *locatedGlobals[${globalCount === 0 ? 1 : globalCount}];`,
    );
    this.emitHeader(`constexpr uint32_t locatedGlobalsCount = ${globalCount};`);
    this.emitHeader("#endif");
    this.emitHeader("");
  }

  /**
   * Generate the located variables array definition in the implementation.
   */
  private generateLocatedVarsDefinition(): void {
    // Mirror the declaration's library-skip + placeholder logic.
    const hasPrograms =
      !!this.projectModel && this.projectModel.programs.size > 0;
    if (!hasPrograms) return;

    const isEmpty = this.locatedVars.length === 0;
    const arrayLen = isEmpty ? 1 : this.locatedVars.length;

    this.emit(
      "// =============================================================================",
    );
    this.emit("// Located Variables Descriptor Array");
    this.emit(
      "// =============================================================================",
    );
    this.emit("");
    this.emit(`LocatedVar locatedVars[${arrayLen}] = {`);

    if (isEmpty) {
      this.emit(
        `    { LocatedArea::Input, LocatedSize::Bit, 0, 0, {0, 0, 0}, nullptr }  // placeholder; locatedVarsCount is 0`,
      );
    } else {
      for (let i = 0; i < this.locatedVars.length; i++) {
        const locVar = this.locatedVars[i]!;
        const comma = i < this.locatedVars.length - 1 ? "," : "";
        this.emit(
          `    { LocatedArea::${locVar.area}, LocatedSize::${locVar.size}, ` +
            `${locVar.byteIndex}, ${locVar.bitIndex}, {0, 0, 0}, nullptr }${comma}  // ${this.describeLocatedDescriptor(locVar)}`,
        );
      }
    }

    this.emit("};");
    this.emit("");

    this.generateLocatedGlobalsDefinition();
  }

  /**
   * Emit the located-globals pointer array plus its C-linkage accessors.
   *
   * `locatedVars[]` mixes two ownership classes: POU-local `VAR ... AT` (serviced
   * by the owning IEC task around run()) and CONFIGURATION `VAR_GLOBAL ... AT`
   * (owned by no task, so a host dispatcher must copy them at a quiescent frame
   * boundary). The descriptors carry no scope, and a runtime cannot recover it:
   * globals are file-scope singletons that appear nowhere in the configuration
   * object graph. Runtimes previously *inferred* the split from each entry's
   * position in locatedVars[], which broke as soon as a POU declared a located
   * variable and silently stopped servicing every located global.
   *
   * So state it here instead. locatedGlobals[] holds the canonical storage
   * pointer of every located VAR_GLOBAL — the same raw_ptr() value written into
   * locatedVars[].pointer — letting a runtime identify the config-scope entries by
   * pointer identity, independent of array order. Located variables are always
   * elementary types, so every entry is a scalar IECVar and raw_ptr() exists.
   *
   * Emitted only under STRUCPP_THREADED: freestanding targets bind every located
   * variable directly and have no dispatcher, so they would pay RAM for nothing.
   *
   * The accessors are emitted here rather than left to a host runtime's shim so
   * the generated code stays self-contained. A shim referencing these symbols
   * would fail to COMPILE against an older project's generated header, whereas an
   * accessor emitted beside its own array always matches. A runtime predating
   * this simply never resolves the symbols and skips located globals.
   */
  private generateLocatedGlobalsDefinition(): void {
    const globals = this.locatedVars.filter((v) => v.programName === "@config");
    // C++ forbids zero-length arrays at namespace scope; emit a placeholder and
    // report count 0, exactly as locatedVars[] does. That lets a runtime tell
    // "accessors absent" (older project — cannot service globals) apart from
    // "present but count 0" (project genuinely has no located globals).
    const arrayLen = globals.length === 0 ? 1 : globals.length;

    this.emit("#ifdef STRUCPP_THREADED");
    this.emit(
      "// Canonical storage pointers of the located CONFIGURATION VAR_GLOBALs.",
    );
    this.emit(
      "// Populated in the configuration constructor (like locatedVars[] above).",
    );
    this.emit(`void *locatedGlobals[${arrayLen}] = {`);
    if (globals.length === 0) {
      this.emit(`    nullptr  // placeholder; locatedGlobalsCount is 0`);
    } else {
      for (let i = 0; i < globals.length; i++) {
        const g = globals[i]!;
        const comma = i < globals.length - 1 ? "," : "";
        this.emit(
          `    nullptr${comma}  // ${this.describeLocatedDescriptor(g)}`,
        );
      }
    }
    this.emit("};");
    this.emit("");
    this.emit(
      "// C linkage: a host runtime is built once and loads many .so files, so it",
    );
    this.emit(
      "// cannot reach namespaced C++ symbols by mangled name portably.",
    );
    this.emit(
      'extern "C" void *const *strucpp_get_located_globals(void) { return locatedGlobals; }',
    );
    this.emit(
      'extern "C" uint32_t strucpp_get_located_global_count(void) { return locatedGlobalsCount; }',
    );
    this.emit("#endif  // STRUCPP_THREADED");
    this.emit("");
  }

  /**
   * Open a PROGRAM's run() with a force::Scope (iec_force.hpp): forced values
   * are written in when the cycle starts and again when it ends, on every
   * return path and on a fault.
   */
  private emitForceScope(): void {
    this.emit("    force::Scope __force_scope(this, sizeof(*this));");
  }

  /**
   * This program's contiguous slice [offset, offset+count) of the project-wide
   * locatedVars[] table. The table is built in program-iteration order, so a
   * single program's located vars are contiguous. Used by the STRUCPP_THREADED
   * located_range() override so the runtime can scope located I/O copy-in/out
   * to the owning task.
   */
  private locatedRangeForProgram(programName: string): {
    offset: number;
    count: number;
  } {
    let offset = -1;
    let count = 0;
    for (let i = 0; i < this.locatedVars.length; i++) {
      if (this.locatedVars[i]!.programName === programName) {
        if (offset < 0) offset = i;
        count++;
      }
    }
    return { offset: offset < 0 ? 0 : offset, count };
  }

  /**
   * Generate initialization code for located variable pointers.
   * Called from within a program constructor.
   */
  private generateLocatedVarPointerInit(
    programName: string,
    indent: string = "    ",
    // Member accessor between the variable name and `.raw_ptr()`. Empty for
    // program-local `VAR AT` (the member is the IEC value directly); ".value"
    // for configuration VAR_GLOBAL (the member is a GlobalVar<V> wrapper).
    memberAccess: string = "",
  ): void {
    const progVars = this.locatedVars.filter(
      (v) => v.programName === programName,
    );
    if (progVars.length === 0) return;

    this.emit(`${indent}// Initialize located variable pointers`);
    // Walk the global array by position rather than looking each entry back
    // up by name. A located ARRAY contributes one descriptor per element, all
    // sharing a varName, so a name lookup (`findIndex`) resolves every one of
    // them to the FIRST slot: element 0 would be bound N times and elements
    // 1..N-1 left null (openplc-editor#565). The index is right here anyway.
    for (let index = 0; index < this.locatedVars.length; index++) {
      const locVar = this.locatedVars[index]!;
      if (locVar.programName !== programName) continue;
      this.emit(
        `${indent}locatedVars[${index}].pointer = ${this.locatedStorageExpr(locVar, memberAccess)};`,
      );
    }

    // Configuration VAR_GLOBALs additionally record their storage pointer in
    // locatedGlobals[], which is what lets a host runtime tell config-scope
    // entries from POU-local ones without guessing from array position. Emitted
    // here (rather than as a static initializer) because raw_ptr() is not a
    // constant expression, and to keep it beside the locatedVars[] population it
    // must agree with.
    if (programName === "@config") {
      this.emit("#ifdef STRUCPP_THREADED");
      this.emit(`${indent}// Initialize located-global pointers`);
      for (let g = 0; g < progVars.length; g++) {
        const locVar = progVars[g]!;
        this.emit(
          `${indent}locatedGlobals[${g}] = ${this.locatedStorageExpr(locVar, memberAccess)};`,
        );
      }
      this.emit("#endif");
    }
  }

  /**
   * The C++ expression yielding the storage a descriptor binds to.
   *
   * Scalar: `name[.value].raw_ptr()`. Array element: `name[.value][i].raw_ptr()`,
   * where `i` is the IEC index — `IEC_ARRAY_1D::operator[]` maps the declared
   * index range onto its internal storage, so the declared index is what goes
   * in, not a zero-based offset.
   */
  private locatedStorageExpr(
    locVar: LocatedVarDescriptor,
    memberAccess: string,
  ): string {
    const element =
      locVar.elementIndex === undefined ? "" : `[${locVar.elementIndex}]`;
    const name =
      locVar.programName === "@config"
        ? globalCppName(locVar.varName)
        : locVar.varName;
    return `${name}${memberAccess}${element}.raw_ptr()`;
  }

  /**
   * How a descriptor labels itself in the generated table's trailing comment.
   *
   * For an array element this is the address the element actually occupies,
   * not the array's declared base — 67 rows all reading `AT %MW60` would tell
   * a reader nothing about which slot each row binds.
   */
  private describeLocatedDescriptor(locVar: LocatedVarDescriptor): string {
    if (locVar.elementIndex === undefined) {
      return `${locVar.varName} AT ${locVar.address}`;
    }
    const areaChar = { Input: "I", Output: "Q", Memory: "M" }[locVar.area];
    const sizeChar = {
      Bit: "X",
      Byte: "B",
      Word: "W",
      DWord: "D",
      LWord: "L",
    }[locVar.size];
    const offset =
      locVar.size === "Bit"
        ? `${locVar.byteIndex}.${locVar.bitIndex}`
        : `${locVar.byteIndex}`;
    return `${locVar.varName}[${locVar.elementIndex}] AT %${areaChar}${sizeChar}${offset}`;
  }

  /**
   * Emit a line to the implementation output.
   */
  protected emit(line: string): void {
    this.output.push(line);
    this.currentLine++;
  }

  /**
   * Emit a line to the header output.
   */
  private emitHeader(line: string): void {
    this.headerOutput.push(line);
    this.currentHeaderLine++;
  }

  /**
   * Emit a #line directive before implementation code for source-level debugging.
   */
  private emitLineDirective(stLine: number): void {
    if (this.options.lineDirectives) {
      const fn = (
        this.options.lineDirectiveFileName ?? this.options.fileName
      ).replaceAll("\\", "/");
      this.emit(`#line ${stLine} "${fn}"`);
      this.cppStLineActive = true;
    }
  }

  /**
   * After a body's closing brace: hand the following lines back to the
   * generated file, so code after the body (the next POU's constructor, the
   * configuration) is not attributed to the body's last ST line. Emits a
   * placeholder that `generate()` resolves per output file (its own name and
   * line). No-op unless an ST directive is in force.
   */
  private emitLineReset(): void {
    if (!this.cppStLineActive) return;
    this.emit(LINE_RESET_PLACEHOLDER);
    this.cppStLineActive = false;
  }

  /**
   * Emit a #line directive before header code for source-level debugging.
   */
  private emitHeaderLineDirective(stLine: number): void {
    if (this.options.lineDirectives) {
      const fn = (
        this.options.lineDirectiveFileName ?? this.options.fileName
      ).replaceAll("\\", "/");
      this.emitHeader(`#line ${stLine} "${fn}"`);
      this.headerStLineActive = true;
    }
  }

  /** The header's `emitLineReset`, resolved to `headerFileName`. */
  private emitHeaderLineReset(): void {
    if (!this.headerStLineActive) return;
    this.emitHeader(LINE_RESET_PLACEHOLDER);
    this.headerStLineActive = false;
  }

  /**
   * Record a line mapping from ST to C++.
   * Used in Phase 3+ for debugging support.
   */
  private recordLineMapping(stLine: number, cppStartLine: number): void {
    // currentLine points to the *next* line to be emitted, so the last
    // emitted line is currentLine - 1.
    const lastEmittedLine = this.currentLine - 1;
    const existing = this.lineMap.get(stLine);
    if (existing !== undefined) {
      existing.cppEndLine = lastEmittedLine;
    } else {
      this.lineMap.set(stLine, {
        cppStartLine,
        cppEndLine: lastEmittedLine,
      });
    }
  }

  private recordHeaderLineMapping(
    stLine: number,
    headerStartLine: number,
  ): void {
    const lastEmittedHeaderLine = this.currentHeaderLine - 1;
    const existing = this.headerLineMap.get(stLine);
    if (existing !== undefined) {
      existing.cppEndLine = lastEmittedHeaderLine;
    } else {
      this.headerLineMap.set(stLine, {
        cppStartLine: headerStartLine,
        cppEndLine: lastEmittedHeaderLine,
      });
    }
  }
}

/**
 * Generate C++ code from a compilation unit.
 * Convenience function that creates a generator and runs code generation.
 */
export function generateCode(
  ast: CompilationUnit,
  symbolTables: SymbolTables,
  options?: Partial<CodeGenOptions>,
): CodeGenResult {
  const generator = new CodeGenerator(symbolTables, options);
  return generator.generate(ast);
}
