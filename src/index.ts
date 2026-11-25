// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * STruC++ - IEC 61131-3 Structured Text to C++ Compiler
 *
 * Main entry point for the STruC++ compiler library.
 * This module exports the public API for programmatic usage.
 */

import {
  CompileOptions,
  CompileResult,
  CompileError,
  AnalysisResult,
} from "./types.js";
import { withYieldedFunctions } from "./library/yield-library.js";
import { parse as parseSource } from "./frontend/parser.js";
import { toCompileErrors, pragmaWarnings } from "./frontend/parse-errors.js";
import { buildAST } from "./frontend/ast-builder.js";
import { transpileILSource } from "./il/il-transpiler.js";
import { buildProjectModel } from "./project-model.js";
import { SymbolTables } from "./semantic/symbol-table.js";
import { SemanticAnalyzer } from "./semantic/analyzer.js";
import {
  defaultGlobalListName,
  isGlobalListName,
  nameGlobalLists,
} from "./semantic/global-lists.js";
import {
  CodeGenerator,
  isSharedGlobalRaceWarning,
  tasksMayRace,
} from "./backend/codegen.js";
import {
  generateDebugTable,
  type DebugMapV2,
} from "./backend/debug-table-gen.js";
import { StdFunctionRegistry } from "./semantic/std-function-registry.js";
import type {
  CompilationUnit,
  FunctionCallExpression,
  FunctionBlockDeclaration,
  InterfaceDeclaration,
  TypeReference,
  ASTNode,
  VariableExpression,
  VarBlock,
  Expression,
  MethodCallExpression,
  RefExpression,
  RefAssignStatement,
} from "./frontend/ast.js";
import { mergeCompilationUnits } from "./merge.js";
import { lowerInlineTypes } from "./frontend/lower-inline-types.js";
import { resolveArrayBounds } from "./semantic/array-bounds.js";
import { foldStructFieldDefaults } from "./semantic/struct-defaults.js";
import { lowerActions } from "./semantic/lower-actions.js";
import { lowerAccessorLocals } from "./semantic/lower-accessor-locals.js";
import { lowerProgramSelfMembers } from "./semantic/program-access.js";
import { lowerPlatformTypes } from "./semantic/platform-types.js";
import {
  defaultStringLength,
  IEC_DEFAULT_STRING_LENGTH,
  lowerDefaultStringLength,
} from "./semantic/string-default-length.js";
import {
  implicitParameterPragmas,
  markImplicitParameters,
} from "./semantic/implicit-parameters.js";
import { lowerPouOperators } from "./semantic/vendor-pou-operators.js";
import { lowerLibraryNamespaces } from "./semantic/library-namespaces.js";
import { applyTypeDefaults } from "./frontend/type-defaults.js";
import { libraryTypeDefault } from "./library/library-methods.js";
import { lowerBitType } from "./semantic/bit-type.js";
import { unionLoweringErrors } from "./semantic/union.js";
import { fbInitLoweringErrors } from "./semantic/fb-init.js";
import { walkAST } from "./ast-utils.js";
import { registerLibrarySymbols } from "./library/library-loader.js";
import { renameRuntimeCollidingPous } from "./backend/pou-naming.js";
import type { LibraryChunk, StlibArchive } from "./library/library-manifest.js";
import { annotateErrorsWithPouContext } from "./diagnostic-pou-context.js";
import {
  iec3IdentifierErrors,
  iec3IlLabelErrors,
  iec3IlWarningMessage,
  literalUnderscoreErrors,
  sourceNameLocator,
} from "./semantic/iec3-rules.js";
import {
  DialectError,
  IEC_PROFILE,
  profilesWithFeature,
  resolveDialect,
  type DialectRequest,
  type ResolvedDialect,
} from "./dialect.js";
import type { ILexingResult, IToken } from "chevrotain";
import {
  declaredSpellings,
  respellDiagnostics,
  spellingsOf,
} from "./semantic/declared-spellings.js";
import { tokenize } from "./frontend/lexer.js";
import {
  applyConditionalPragmas,
  conditionalPragmaHint,
  sourcePrepFor,
  validatePragmaDefines,
  withPragmaHint,
  type SourcePrep,
} from "./frontend/conditional-pragmas.js";

/**
 * Default compilation options
 */
export const defaultOptions: CompileOptions = {
  debug: false,
  lineMapping: true,
  optimizationLevel: 0,
};

/** Conservative include-path character set: alphanumerics, dot, slash,
 *  hyphen, underscore, plus.  Disallows quotes, backslashes, and newlines
 *  so a `pouIncludes` entry can never break out of `#include "..."` and
 *  splice unintended directives into a generated TU. */
const INCLUDE_PATH_RE = /^[\w./+-]+$/;

/**
 * Reject obviously-malformed option values up front so misuse surfaces as
 * a thrown error from the API entry point, not as broken C++ later in
 * the pipeline.  Keep the checks narrow: the goal is to close foot-guns
 * without becoming a schema validator.
 */
function validateCompileOptions(options: CompileOptions): void {
  for (const include of options.pouIncludes ?? []) {
    if (typeof include !== "string" || !INCLUDE_PATH_RE.test(include)) {
      throw new TypeError(
        `pouIncludes entry ${JSON.stringify(include)} is not a valid include filename ` +
          `(allowed characters: alphanumerics, '.', '/', '-', '_', '+').`,
      );
    }
  }
  const listNames = [
    options.globalListName,
    ...(options.additionalSources ?? []).map((s) => s.globalListName),
  ];
  for (const name of listNames) {
    if (name !== undefined && !isGlobalListName(name)) {
      throw new TypeError(
        `globalListName ${JSON.stringify(name)} is not an identifier`,
      );
    }
  }
  validatePragmaDefines(options.pragmaDefines);
  validatePragmaDefines(options.filePragmaDefines);
  for (const addl of options.additionalSources ?? []) {
    validatePragmaDefines(addl.pragmaDefines);
  }
}

/** The dialect fields of the compile options, as a resolveDialect request. */
function dialectRequestFromOptions(
  options: Partial<CompileOptions>,
): DialectRequest {
  const req: DialectRequest = {};
  if (options.dialect !== undefined) req.dialect = options.dialect;
  if (options.dialectFiles) req.dialectFiles = options.dialectFiles;
  if (options.dialectPath) req.dialectPath = options.dialectPath;
  if (options.features) req.features = options.features;
  return req;
}

// ---------------------------------------------------------------------------
// Library tree-shaking: only include libraries whose symbols are referenced
// ---------------------------------------------------------------------------

/**
 * Function-level tree-shake: determine which library chunks are
 * reachable from the user's AST and need to be emitted into the
 * final `generated.hpp` / `generated.cpp`.
 *
 * Walks every kind of cross-symbol reference the codegen relies on
 * (function calls, variable & inline-global reads, type references,
 * FB inheritance / interface implements), maps each name through a
 * symbol→chunk index built across all archives, then BFS-traverses
 * the chunk dep graph baked into each archive at library compile
 * time.
 *
 * Returns a `Map<libraryName, Set<chunkName>>` describing the
 * reachable subset of each archive. Archives whose entry is empty
 * (or absent) contribute nothing to the user's output.
 *
 * Test builds bypass the shake: every chunk of every archive is
 * declared reachable so the test harness sees the full symbol set
 * regardless of what the source AST happens to reference.
 */
function collectUsedSymbols(
  ast: CompilationUnit,
  archives: StlibArchive[],
  includeEverything: boolean,
): Map<string, Set<string>> {
  const shadowed = userDeclaredNames(ast);
  // When asked to include everything (test builds), short-circuit, leaving out
  // the library chunks a user declaration shadows and every chunk needing one.
  if (includeEverything) {
    const all = new Map<string, Set<string>>();
    const byKey = new Map<string, LibraryChunk>();
    for (const archive of archives) {
      for (const c of archive.chunks ?? []) {
        byKey.set(`${archive.manifest.name}:${c.name}`, c);
      }
    }
    for (const archive of archives) {
      const chunkNames = new Set<string>();
      for (const chunk of archive.chunks ?? []) {
        if (
          shadowed.size === 0 ||
          !needsShadowedChunk(chunk, byKey, shadowed)
        ) {
          chunkNames.add(chunk.name);
        }
      }
      all.set(archive.manifest.name, chunkNames);
    }
    return all;
  }
  return shakeLibraryChunks(ast, archives, shadowed).byLibrary;
}

/**
 * Upper-cased names the user's AST declares at global level: POUs,
 * interfaces, types and top-level / CONFIGURATION globals. A library chunk of
 * the same name is shadowed: it is never emitted, since its C++ declaration
 * would collide with the user's.
 */
function userDeclaredNames(ast: CompilationUnit): Set<string> {
  const names = new Set<string>();
  const add = (n: string): void => {
    names.add(n.toUpperCase());
  };
  for (const pou of [
    ...ast.programs,
    ...ast.functions,
    ...ast.functionBlocks,
    ...ast.interfaces,
    ...ast.types,
  ]) {
    add(pou.name);
  }
  const blocks = [
    ...ast.globalVarBlocks,
    ...ast.configurations.flatMap((c) => c.varBlocks),
  ];
  for (const block of blocks) {
    for (const decl of block.declarations) decl.names.forEach(add);
  }
  return names;
}

/**
 * True when `chunk` is shadowed by a user declaration, or reaches one through
 * its dependency edges.
 */
function needsShadowedChunk(
  chunk: LibraryChunk,
  byKey: Map<string, LibraryChunk>,
  shadowed: Set<string>,
): boolean {
  const seen = new Set<string>();
  const stack = [chunk];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (shadowed.has(cur.name.toUpperCase())) return true;
    for (const dep of cur.deps) {
      const key = `${dep.library}:${dep.name}`;
      const next = byKey.get(key);
      if (next && !seen.has(key)) {
        seen.add(key);
        stack.push(next);
      }
    }
  }
  return false;
}

/**
 * A library chunk the program needs whose name a user declaration shadows:
 * `needer` is the reachable chunk that depends on it.
 */
interface ShadowConflict {
  name: string;
  library: string;
  needer: string;
}

/**
 * Tree-shake the archives from the names the user's AST references. A name
 * the user declares never seeds a library chunk; a reachable chunk that still
 * depends on one is reported as a conflict and left out.
 */
function shakeLibraryChunks(
  ast: CompilationUnit,
  archives: StlibArchive[],
  shadowed: Set<string>,
): {
  byLibrary: Map<string, Set<string>>;
  conflicts: ShadowConflict[];
  /** A name declared by more than one library that the program needs from each. */
  clashes: Array<{ name: string; libraries: string[] }>;
} {
  const conflicts: ShadowConflict[] = [];

  // Build symbol→{library, chunk} index across every archive.  Names
  // are uppercased to match how chunks are keyed (the codegen
  // normalises every emitted identifier to uppercase before sealing
  // chunk boundaries).
  const symbolIndex = new Map<
    string,
    { library: string; chunk: string; kind: LibraryChunk["kind"] }
  >();
  // Per-library chunk-name lookup so the dep BFS can resolve chunks
  // it already named when the consumer didn't reference them directly.
  const chunkByKey = new Map<string, { library: string; chunk: string }>();

  for (const archive of archives) {
    const libName = archive.manifest.name;
    for (const chunk of archive.chunks ?? []) {
      const entry = { library: libName, chunk: chunk.name };
      // A name two libraries declare is the first one's, as it resolves
      if (!symbolIndex.has(chunk.name.toUpperCase())) {
        symbolIndex.set(chunk.name.toUpperCase(), {
          ...entry,
          kind: chunk.kind,
        });
      }
      chunkByKey.set(`${libName}:${chunk.name}`, entry);
    }
  }

  // Seed the reachable set from names the user AST references.
  const referencedNames = new Set<string>();
  // Names read as variables: they seed only a global or a type, never a
  // function or block that merely shares a local's or parameter's name.
  const variableNames = new Set<string>();
  walkAST(ast, (node: ASTNode): void => {
    switch (node.kind) {
      case "FunctionCallExpression": {
        const fc = node as FunctionCallExpression;
        referencedNames.add(fc.functionName.toUpperCase());
        break;
      }
      case "VariableExpression": {
        // Inline-global reads (e.g. `MATH.PI2`) show up as
        // VariableExpression with name="MATH".
        const ve = node as VariableExpression;
        variableNames.add(ve.name.toUpperCase());
        // `SIZEOF(T)` of a library type needs its class
        if (ve.namesType === true) referencedNames.add(ve.name.toUpperCase());
        break;
      }
      case "TypeReference": {
        const tr = node as TypeReference;
        referencedNames.add(tr.name.toUpperCase());
        if (tr.elementTypeName) {
          referencedNames.add(tr.elementTypeName.toUpperCase());
        }
        break;
      }
      case "FunctionBlockDeclaration": {
        const fbd = node as FunctionBlockDeclaration;
        if (fbd.extends) referencedNames.add(fbd.extends.toUpperCase());
        if (fbd.implements) {
          for (const iface of fbd.implements) {
            referencedNames.add(iface.toUpperCase());
          }
        }
        break;
      }
      case "InterfaceDeclaration": {
        const id = node as InterfaceDeclaration;
        if (id.extends) {
          for (const base of id.extends) {
            referencedNames.add(base.toUpperCase());
          }
        }
        break;
      }
    }
  });

  // BFS through the chunk dep graph.
  const reachable = new Set<string>(); // keys: "<library>:<chunk>"
  const queue: Array<{ library: string; chunk: string }> = [];

  const seed = (name: string, asVariable: boolean): void => {
    if (shadowed.has(name)) return;
    const entry = symbolIndex.get(name);
    if (!entry) return;
    if (asVariable && entry.kind !== "inlineGlobal" && entry.kind !== "type") {
      return;
    }
    const key = `${entry.library}:${entry.chunk}`;
    if (!reachable.has(key)) {
      reachable.add(key);
      queue.push({ library: entry.library, chunk: entry.chunk });
    }
  };
  for (const name of referencedNames) seed(name, false);
  for (const name of variableNames) seed(name, true);

  // Build a fast lookup from "<library>:<chunk>" → chunk object so
  // the BFS can read each chunk's pre-computed deps without rescanning.
  const chunkLookup = new Map<
    string,
    {
      archive: StlibArchive;
      chunk: NonNullable<StlibArchive["chunks"]>[number];
    }
  >();
  for (const archive of archives) {
    for (const chunk of archive.chunks ?? []) {
      chunkLookup.set(`${archive.manifest.name}:${chunk.name}`, {
        archive,
        chunk,
      });
    }
  }

  while (queue.length > 0) {
    const cur = queue.shift()!;
    const lookup = chunkLookup.get(`${cur.library}:${cur.chunk}`);
    if (!lookup) continue;
    for (const dep of lookup.chunk.deps) {
      const depKey = `${dep.library}:${dep.name}`;
      if (reachable.has(depKey)) continue;
      const target = chunkByKey.get(depKey);
      if (!target) continue;
      if (shadowed.has(dep.name.toUpperCase())) {
        conflicts.push({
          name: dep.name,
          library: dep.library,
          needer: cur.chunk,
        });
        continue;
      }
      reachable.add(depKey);
      queue.push(target);
    }
  }

  // Group reachable chunks by library.
  const byLibrary = new Map<string, Set<string>>();
  for (const key of reachable) {
    const sepIdx = key.indexOf(":");
    const lib = key.slice(0, sepIdx);
    const name = key.slice(sepIdx + 1);
    let set = byLibrary.get(lib);
    if (!set) {
      set = new Set();
      byLibrary.set(lib, set);
    }
    set.add(name);
  }

  // A chunk name reachable in two libraries: one C++ name for both
  const owners = new Map<string, string[]>();
  for (const [lib, names] of byLibrary) {
    for (const name of names) {
      const upper = name.toUpperCase();
      owners.set(upper, [...(owners.get(upper) ?? []), lib]);
    }
  }
  const clashes = [...owners]
    .filter(([, libs]) => libs.length > 1)
    .map(([name, libs]) => ({ name, libraries: libs }));

  return { byLibrary, conflicts, clashes };
}

/** `message` with each C++ name of a renamed POU shown as declared. */
function withDeclaredNames(
  message: string,
  names: ReadonlyMap<string, string>,
): string {
  if (names.size === 0) return message;
  const re = new RegExp(`\\b(${[...names.keys()].join("|")})\\b`, "gi");
  return message.replace(re, (m) => names.get(m.toUpperCase()) ?? m);
}

/**
 * Errors for library chunks the program needs but a user declaration shadows:
 * both would be emitted under one C++ name.
 */
function libraryShadowErrors(
  ast: CompilationUnit,
  archives: StlibArchive[],
): CompileError[] {
  // Two libraries' declarations of one name the program needs from both
  const clashErrors: CompileError[] = shakeLibraryChunks(
    ast,
    archives,
    userDeclaredNames(ast),
  ).clashes.map((c) => ({
    message:
      `'${c.name}' is declared by the libraries ${c.libraries.map((l) => `'${l}'`).join(" and ")}, ` +
      `and this program needs each one's: they cannot share one C++ name`,
    line: 0,
    column: 0,
    severity: "error" as const,
  }));
  return [...clashErrors, ...libraryShadowErrorsOnly(ast, archives)];
}

/** {@link libraryShadowErrors} for a user declaration shadowing a needed chunk. */
function libraryShadowErrorsOnly(
  ast: CompilationUnit,
  archives: StlibArchive[],
): CompileError[] {
  const shadowed = userDeclaredNames(ast);
  if (shadowed.size === 0) return [];
  const errors: CompileError[] = [];
  const reported = new Set<string>();
  for (const c of shakeLibraryChunks(ast, archives, shadowed).conflicts) {
    const key = c.name.toUpperCase();
    if (reported.has(key)) continue;
    reported.add(key);
    const decl = userDeclarationSpan(ast, key);
    errors.push({
      message:
        `'${c.name}' is declared here and also by library '${c.library}', ` +
        `where '${c.needer}', which this program uses, depends on it. ` +
        `Rename the declaration.`,
      line: decl?.startLine ?? 0,
      column: decl?.startCol ?? 0,
      severity: "error",
      ...(decl?.file !== undefined ? { file: decl.file } : {}),
    });
  }
  return errors;
}

/** Source span of the user's global-level declaration of `upperName`. */
function userDeclarationSpan(
  ast: CompilationUnit,
  upperName: string,
): ASTNode["sourceSpan"] | undefined {
  for (const pou of [
    ...ast.programs,
    ...ast.functions,
    ...ast.functionBlocks,
    ...ast.interfaces,
    ...ast.types,
  ]) {
    if (pou.name.toUpperCase() === upperName) return pou.sourceSpan;
  }
  const blocks = [
    ...ast.globalVarBlocks,
    ...ast.configurations.flatMap((c) => c.varBlocks),
  ];
  for (const block of blocks) {
    for (const decl of block.declarations) {
      if (decl.names.some((n) => n.toUpperCase() === upperName)) {
        return decl.sourceSpan;
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Source preparation: conditional pragmas, then IL
// ---------------------------------------------------------------------------

/**
 * One source file before parsing: conditional pragmas resolved (when the
 * feature is on), then IL bodies transpiled to ST, so IL only sees active
 * text. `stopsOnError` is true when either step had something to report or
 * rewrite; compile mode stops there on errors.
 */
function prepareFile(
  text: string,
  fileName: string | undefined,
  prep: SourcePrep,
  lex: (s: string) => ILexingResult,
  fileDefines?: Record<string, string>,
  /** The iec-3 rules: warn at each IL body, check IL label spelling. `--dialect iec-3` only. */
  warnIl = false,
): {
  text: string;
  errors: CompileError[];
  warnings: CompileError[];
  /** Ed. 3 spelling errors of IL labels, which stop no later phase. */
  labelErrors: CompileError[];
  stopsOnError: boolean;
  blankedLines: number[];
  /** The text before IL→ST, when the file has IL: positions moved to IL read it. */
  ilText?: string;
  /** IL operands in the generated ST and the IL positions naming them. */
  operandOrigins: NonNullable<
    ReturnType<typeof transpileILSource>["operandOrigins"]
  >;
} {
  const errors: CompileError[] = [];
  const warnings: CompileError[] = [];
  const labelErrors: CompileError[] = [];
  let out = text;
  let stopsOnError = false;
  let blankedLines: number[] = [];
  let operandOrigins: NonNullable<
    ReturnType<typeof transpileILSource>["operandOrigins"]
  > = [];
  if (prep.enabled) {
    const pragmaResult = applyConditionalPragmas(
      text,
      prep.defines,
      lex,
      new Map(Object.entries(fileDefines ?? {})),
    );
    out = pragmaResult.text;
    blankedLines = pragmaResult.blankedLines;
    if (pragmaResult.errors.length > 0) {
      errors.push(...toCompileErrors(pragmaResult.errors, fileName));
      stopsOnError = true;
    }
  }
  const ilResult = transpileILSource(out, fileName);
  const beforeIl = out;
  if (ilResult.hasIL) {
    out = ilResult.stSource;
    operandOrigins = ilResult.operandOrigins ?? [];
    stopsOnError = true;
    for (const err of ilResult.errors) {
      const entry: CompileError = {
        message: err.message,
        line: err.line,
        column: err.column,
        severity: err.severity,
      };
      if (err.file) entry.file = err.file;
      else if (fileName !== undefined) entry.file = fileName;
      errors.push(entry);
    }
    for (const body of warnIl ? (ilResult.ilBodies ?? []) : []) {
      warnings.push({
        message: iec3IlWarningMessage(body.pou),
        line: body.line,
        column: body.column,
        severity: "warning",
        ...(fileName !== undefined ? { file: fileName } : {}),
      });
    }
    if (warnIl) {
      labelErrors.push(...iec3IlLabelErrors(ilResult.ilLabels ?? [], fileName));
    }
  }
  return {
    text: out,
    errors,
    warnings,
    labelErrors,
    stopsOnError,
    blankedLines,
    operandOrigins,
    ...(ilResult.hasIL ? { ilText: beforeIl } : {}),
  };
}

/** Origins of IL operands by file, as prepareFile gives them. */
type OperandOrigins = Map<
  string,
  ReturnType<typeof prepareFile>["operandOrigins"]
>;

/**
 * Each diagnostic at an IL operand of the generated ST moved to the IL line
 * and column naming that operand; a statement's own diagnostics stay on the
 * line of the IL instruction that ends it.
 */
function moveToIlOperands(
  diagnostics: CompileError[],
  origins: OperandOrigins,
  primaryFile: string,
): void {
  if (origins.size === 0) return;
  for (const d of diagnostics) {
    const list = origins.get(d.file ?? primaryFile);
    const o = list?.find(
      (x) =>
        x.line === d.line &&
        d.column >= x.column &&
        d.column < x.column + x.length,
    );
    if (o === undefined) continue;
    d.line = o.ilLine;
    d.column = o.ilColumn + (d.column - o.column);
  }
}

/**
 * True when some POU passes a VAR_EXTERNAL it declares as a call argument
 * (a VAR_IN_OUT binding, `ADR(g)`, `REF(g)`) or takes its reference: only
 * then can code generation give a shared-global race warning.
 */
function mayBindSharedGlobal(ast: CompilationUnit): boolean {
  for (const pou of [
    ...ast.programs,
    ...ast.functionBlocks,
    ...ast.functions,
  ]) {
    const blocks = [
      ...pou.varBlocks,
      ...("methods" in pou ? pou.methods.flatMap((m) => m.varBlocks) : []),
    ];
    const externals = new Set(
      blocks
        .filter((b) => b.blockType === "VAR_EXTERNAL")
        .flatMap((b) => b.declarations.flatMap((d) => d.names))
        .map((n) => n.toUpperCase()),
    );
    if (externals.size === 0) continue;
    const isExternal = (e: Expression | undefined): boolean =>
      e?.kind === "VariableExpression" && externals.has(e.name.toUpperCase());
    let found = false;
    walkAST(pou, (node) => {
      if (
        ((node.kind === "FunctionCallExpression" ||
          node.kind === "MethodCallExpression") &&
          (
            node as FunctionCallExpression | MethodCallExpression
          ).arguments.some((a) => isExternal(a.value))) ||
        (node.kind === "RefExpression" &&
          isExternal((node as RefExpression).operand)) ||
        (node.kind === "RefAssignStatement" &&
          isExternal((node as RefAssignStatement).source))
      ) {
        found = true;
      }
      return !found;
    });
    if (found) return true;
  }
  return false;
}

/**
 * The starts (`file:line:column`) of the names in a declaration that the
 * lexer read without a character it refused, or that are spelled as one
 * such name: `ıx : INT` is read as `x`, and what analysis says at a
 * declaration of `x` (declared twice, an undefined type `NT` for `ınt`)
 * follows from the refused character, which is reported.
 */
function refusedNameDeclarations(
  ast: CompilationUnit,
  sources: ReadonlyMap<string, string>,
  lexErrors: ReadonlyMap<string, readonly CompileError[]>,
): Set<string> {
  const starts: Array<{ file: string; line: number; col: number }> = [];
  for (const [file, errs] of lexErrors) {
    const text = sources.get(file);
    if (text === undefined) continue;
    const lineStart = [0];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\n") lineStart.push(i + 1);
    }
    const refusedAt = errs.filter((e) => {
      const code =
        text.codePointAt((lineStart[e.line - 1] ?? 0) + e.column - 1) ?? 0;
      return code >= 0x7f || (code < 0x20 && code !== 0x09);
    });
    if (refusedAt.length === 0) continue;
    const names = tokenize(text).tokens.filter(
      (t) => t.tokenType.name === "Identifier",
    );
    // A name read without a refused character, and every other token of
    // that name: the declaration it now collides with is one of them.
    const touched = new Set(
      names
        .filter((t) => {
          const start = t.startColumn ?? 0;
          const end = t.endColumn ?? start;
          return refusedAt.some(
            (e) =>
              t.startLine === e.line &&
              start <= e.column + 1 &&
              e.column <= end + 1,
          );
        })
        .map((t) => t.image.toUpperCase()),
    );
    for (const t of names) {
      if (touched.has(t.image.toUpperCase())) {
        starts.push({ file, line: t.startLine ?? 0, col: t.startColumn ?? 0 });
      }
    }
  }
  const declared = new Set<string>();
  if (starts.length === 0) return declared;
  walkAST(ast, (node) => {
    if (node.kind !== "VarDeclaration" && node.kind !== "TypeDeclaration") {
      return;
    }
    const span = node.sourceSpan;
    for (const { file, line: l, col: c } of starts) {
      if (
        file === span.file &&
        (l > span.startLine || (l === span.startLine && c >= span.startCol)) &&
        (l < span.endLine || (l === span.endLine && c <= span.endCol))
      ) {
        declared.add(`${file}:${l}:${c}`);
      }
    }
  });
  return declared;
}

/** The declarations of one scope: a POU's, a method's, or the global lists'. */
function declarationScopes(ast: CompilationUnit): VarBlock[][] {
  return [
    ast.globalVarBlocks,
    ...[...ast.programs, ...ast.functionBlocks].flatMap((pou) => [
      pou.varBlocks,
      ...pou.methods.map((m) => m.varBlocks),
    ]),
    ...ast.functions.map((f) => f.varBlocks),
  ];
}

/**
 * Each variable one scope declares twice with two types (the symbol table
 * keeps the first, and its type checks run against that one): its scope's
 * index in {@link declarationScopes} and its upper-case name. Two
 * CONFIGURATIONs declaring a global are not one scope and are not listed.
 */
function variablesDeclaredTwice(
  ast: CompilationUnit,
): Array<{ scope: number; name: string }> {
  const found: Array<{ scope: number; name: string }> = [];
  declarationScopes(ast).forEach((blocks, scope) => {
    const shapes = new Map<string, string[]>();
    for (const block of blocks) {
      for (const d of block.declarations) {
        const shape = `${d.type.name.toUpperCase()}|${d.type.referenceKind ?? ""}|${d.type.arrayDimensions?.length ?? 0}`;
        for (const n of d.names) {
          const upper = n.toUpperCase();
          shapes.set(upper, [...(shapes.get(upper) ?? []), shape]);
        }
      }
    }
    for (const [name, list] of shapes) {
      if (new Set(list).size > 1) found.push({ scope, name });
    }
  });
  return found;
}

/**
 * The type errors of `result` that depend on which declaration of a doubled
 * variable the analysis took: `other` (the tree before analysis) is checked
 * again with the first declaration of each such variable left out, and a
 * type error it does not give at the same position, with the same text, is
 * one. The duplicate itself, and every error both checks give, stay.
 */
function pickedEchoes(
  result: { typeErrors?: ReadonlySet<CompileError> },
  other: CompilationUnit,
  analyze: (unit: CompilationUnit) => { errors: CompileError[] },
): Set<CompileError> {
  const echoes = new Set<CompileError>();
  const typeErrors = result.typeErrors;
  if (typeErrors === undefined || typeErrors.size === 0) return echoes;
  const scopes = declarationScopes(other);
  for (const { scope, name } of variablesDeclaredTwice(other)) {
    const blocks = scopes[scope] ?? [];
    const decl = blocks
      .flatMap((b) => b.declarations)
      .find((d) => d.names.some((n) => n.toUpperCase() === name));
    if (decl === undefined) continue;
    decl.names = decl.names.filter((n) => n.toUpperCase() !== name);
    if (decl.names.length === 0) {
      for (const b of blocks) {
        b.declarations = b.declarations.filter((d) => d !== decl);
      }
    }
  }
  const key = (e: CompileError): string =>
    `${e.file ?? ""}:${e.line}:${e.column}:${e.message}`;
  let again: Set<string>;
  try {
    again = new Set(analyze(other).errors.map(key));
  } catch {
    return echoes;
  }
  for (const e of typeErrors) if (!again.has(key(e))) echoes.add(e);
  return echoes;
}

/**
 * Drop the diagnostics from `start` on at the position of an error in
 * `earlier` (lowering and project-model errors): there the later phase finds
 * the same problem again (a negative task INTERVAL is the task's error, not
 * also the literal's). The same for a declared name in `refusedNames`.
 */
function dropEchoes(
  diags: CompileError[],
  start: number,
  earlier: readonly CompileError[],
  primaryFile: string,
  /** Positions of names read without a refused character (refusedNameDeclarations). */
  refusedNames: ReadonlySet<string>,
): void {
  if (earlier.length === 0 && refusedNames.size === 0) return;
  const at = (d: CompileError): string =>
    `${d.file ?? primaryFile}:${d.line}:${d.column}`;
  const taken = new Set([
    ...earlier.filter((d) => d.line > 0).map(at),
    ...refusedNames,
  ]);
  const kept = diags.slice(start).filter((d) => !taken.has(at(d)));
  diags.splice(start, diags.length - start, ...kept);
}

// ---------------------------------------------------------------------------
// Shared pipeline
// ---------------------------------------------------------------------------

interface PipelineResult {
  ast: CompilationUnit | undefined;
  projectModel: import("./project-model.js").ProjectModel | undefined;
  symbolTables: SymbolTables | undefined;
  errors: CompileError[];
  warnings: CompileError[];
  allArchives: StlibArchive[];
  mergedOptions: CompileOptions;
  /** True when the resolved dialect has the feature fb_init. */
  fbInit: boolean;
  /** The length of a STRING or WSTRING declared without one. */
  stringDefaultLength: number;
  /** File name → lines the conditional-pragma pass blanked (set once analysis ran). */
  blankedByFile?: ReadonlyMap<string, ReadonlySet<number>>;
}

/**
 * Run phases 1-5 of the compilation pipeline (parse → AST → project model →
 * library loading → semantic analysis).
 *
 * Both modes run every phase the input allows, so a file's errors are
 * reported together (docs/CLI.md, "Reported in one pass", lists what stops a later phase).
 *
 * @param continueOnError - When true (analyze mode), a file whose conditional
 *   pragmas or IL failed is still parsed, and an AST build that throws leaves
 *   the phases after it running. When false (compile mode), both stop there.
 */
function runPipeline(
  source: string,
  options: Partial<CompileOptions>,
  continueOnError: boolean,
): PipelineResult {
  const mergedOptions = { ...defaultOptions, ...options };
  validateCompileOptions(mergedOptions);
  const errors: CompileError[] = [];
  const warnings: CompileError[] = [];
  let ast: CompilationUnit | undefined;
  let projectModel: import("./project-model.js").ProjectModel | undefined;
  let symbolTables: SymbolTables | undefined;
  const allArchives: StlibArchive[] = [];

  let dialect: ResolvedDialect;
  let fbInit = false;
  let stringDefaultLength = IEC_DEFAULT_STRING_LENGTH;
  try {
    dialect = resolveDialect(
      dialectRequestFromOptions(mergedOptions),
      mergedOptions.dialectIO?.readFile,
      mergedOptions.dialectIO?.listDir,
      mergedOptions.dialectIO?.realPath,
      mergedOptions.dialectIO?.foldCase,
    );
  } catch (e) {
    if (!(e instanceof DialectError)) throw e;
    errors.push({ message: e.message, line: 0, column: 0, severity: "error" });
    return {
      ast,
      projectModel,
      symbolTables,
      errors,
      warnings,
      allArchives,
      mergedOptions,
      fbInit,
      stringDefaultLength,
    };
  }
  for (const message of dialect.warnings) {
    warnings.push({
      message,
      line: 0,
      column: 0,
      severity: "warning",
      code: "dialect",
    });
  }
  fbInit = dialect.features.has("fb_init");
  stringDefaultLength = defaultStringLength(dialect.features);

  /** The rules of the built-in iec-3 profile itself (not of one extending it). */
  const iec3Rules = dialect.id === IEC_PROFILE.id;
  const prep = sourcePrepFor(dialect, mergedOptions.pragmaDefines);
  const pragmaHint = prep.enabled ? "" : conditionalPragmaHint(dialect);

  // Phase 0: conditional pragmas, then IL→ST transpilation
  let effectiveSource = source;
  /** File name → lines the conditional-pragma pass blanked. */
  const blankedByFile = new Map<string, ReadonlySet<number>>();
  /** File name → its IL operands in the generated ST. */
  const ilOrigins: OperandOrigins = new Map();
  /** File name → its text as written where it differs from the parsed one (IL bodies). */
  const writtenByFile = new Map<string, string>();
  {
    const prepared = prepareFile(
      source,
      mergedOptions.fileName,
      prep,
      tokenize,
      mergedOptions.filePragmaDefines,
      iec3Rules,
    );
    effectiveSource = prepared.text;
    if (prepared.operandOrigins.length > 0) {
      ilOrigins.set(
        mergedOptions.fileName ?? "main.st",
        prepared.operandOrigins,
      );
    }
    if (prepared.ilText !== undefined) {
      writtenByFile.set(mergedOptions.fileName ?? "main.st", prepared.ilText);
    }
    warnings.push(...prepared.warnings);
    if (prepared.blankedLines.length > 0) {
      blankedByFile.set(
        mergedOptions.fileName ?? "main.st",
        new Set(prepared.blankedLines),
      );
    }
    errors.push(...prepared.errors);
    if (prepared.stopsOnError && errors.length > 0 && !continueOnError) {
      return {
        ast,
        projectModel,
        symbolTables,
        errors,
        warnings,
        allArchives,
        mergedOptions,
        fbInit,
        stringDefaultLength,
      };
    }
    errors.push(...prepared.labelErrors);
  }

  // Phase 1: Parse ST source to CST. Lexer errors do not stop the parse,
  // so analyze mode still sees the rest of the file.
  const parseResult = parseSource(effectiveSource);
  const implicitPragmas = implicitParameterPragmas(
    parseResult.pragmas,
    effectiveSource,
    mergedOptions.fileName ?? "main.st",
  );
  /** File name → the text the parser read, for spellings the AST upper-cases. */
  const sourcesByFile = new Map<string, string>([
    [mergedOptions.fileName ?? "main.st", effectiveSource],
  ]);
  /** File name → the parser's tokens of that text, so no check lexes it again. */
  const tokensByFile = new Map<string, readonly IToken[]>([
    [mergedOptions.fileName ?? "main.st", parseResult.tokens],
  ]);
  warnings.push(
    ...pragmaWarnings(
      parseResult.pragmas,
      effectiveSource,
      mergedOptions.fileName,
    ),
  );
  /** True when a file's parse recovered: analysis sees a repaired tree. */
  let recovered = false;
  /** File name → its lexer and parse errors. */
  const parseErrorsByFile = new Map<string, CompileError[]>();
  /** Lowering and project-model errors, which semantic analysis may find again. */
  const echoed: CompileError[] = [];
  if (parseResult.errors.length > 0) {
    const parseErrors = toCompileErrors(
      parseResult.errors,
      mergedOptions.fileName,
    );
    errors.push(...withPragmaHint(parseErrors, pragmaHint));
    recovered = true;
    parseErrorsByFile.set(mergedOptions.fileName ?? "main.st", parseErrors);
    // Both modes go on with the CST Chevrotain recovered.
  }

  // Phase 2: Build AST from CST (supports multi-file via additionalSources)
  if (!parseResult.cst) {
    errors.push({
      message: "Parse failed: no CST produced",
      line: 0,
      column: 0,
      severity: "error",
    });
    return {
      ast,
      projectModel,
      symbolTables,
      errors,
      warnings,
      allArchives,
      mergedOptions,
      fbInit,
      stringDefaultLength,
    };
  }

  try {
    const globalConstants = mergedOptions.globalConstants;
    const primaryFileName = mergedOptions.fileName ?? "main.st";
    const primaryAst = buildAST(
      parseResult.cst,
      primaryFileName,
      globalConstants,
    );
    nameGlobalLists(
      primaryAst,
      mergedOptions.globalListName ?? defaultGlobalListName(primaryFileName),
    );
    const units: CompilationUnit[] = [primaryAst];

    // Parse additional source files. Each gets the same Phase 0
    // IL→ST transpilation as the primary source — without it, an IL
    // POU surfaced through `additionalSources` (e.g. the editor's
    // per-POU split of program.st) would reach the ST parser as
    // raw IL and fail with a confusing "expecting Identifier but
    // found 'LD'" error.
    /** A file whose conditional pragmas or IL failed: compile mode analyses none. */
    let prepStopped = false;
    if (mergedOptions.additionalSources) {
      for (const addlSource of mergedOptions.additionalSources) {
        const prepared = prepareFile(
          addlSource.source,
          addlSource.fileName,
          prep,
          tokenize,
          addlSource.pragmaDefines,
          iec3Rules,
        );
        const effectiveAddlSource = prepared.text;
        if (prepared.operandOrigins.length > 0) {
          ilOrigins.set(addlSource.fileName, prepared.operandOrigins);
        }
        if (prepared.ilText !== undefined) {
          writtenByFile.set(addlSource.fileName, prepared.ilText);
        }
        warnings.push(...prepared.warnings);
        if (prepared.blankedLines.length > 0) {
          blankedByFile.set(
            addlSource.fileName,
            new Set(prepared.blankedLines),
          );
        }
        errors.push(...prepared.errors);
        if (prepared.stopsOnError && prepared.errors.length > 0) {
          if (!continueOnError) {
            prepStopped = true;
            continue;
          }
        }
        errors.push(...prepared.labelErrors);

        const addlParseResult = parseSource(effectiveAddlSource);
        implicitPragmas.push(
          ...implicitParameterPragmas(
            addlParseResult.pragmas,
            effectiveAddlSource,
            addlSource.fileName,
          ),
        );
        sourcesByFile.set(addlSource.fileName, effectiveAddlSource);
        tokensByFile.set(addlSource.fileName, addlParseResult.tokens);
        warnings.push(
          ...pragmaWarnings(
            addlParseResult.pragmas,
            effectiveAddlSource,
            addlSource.fileName,
          ),
        );
        if (addlParseResult.errors.length > 0) {
          const parseErrors = toCompileErrors(
            addlParseResult.errors,
            addlSource.fileName,
          );
          errors.push(...withPragmaHint(parseErrors, pragmaHint));
          recovered = true;
          parseErrorsByFile.set(addlSource.fileName, parseErrors);
          // Built from the CST Chevrotain recovered, in both modes.
        }
        if (addlParseResult.cst) {
          try {
            const addlAst = buildAST(
              addlParseResult.cst,
              addlSource.fileName,
              globalConstants,
            );
            nameGlobalLists(
              addlAst,
              addlSource.globalListName ??
                defaultGlobalListName(addlSource.fileName),
            );
            units.push(addlAst);
          } catch (e) {
            errors.push({
              message: `AST build failed for ${addlSource.fileName}: ${e instanceof Error ? e.message : String(e)}`,
              line: 0,
              column: 0,
              severity: "error",
              file: addlSource.fileName,
            });
          }
        }
      }
    }

    if (prepStopped) {
      return {
        ast,
        projectModel,
        symbolTables,
        errors,
        warnings,
        allArchives,
        mergedOptions,
        fbInit,
        stringDefaultLength,
      };
    }

    ast = mergeCompilationUnits(units);
    markImplicitParameters(ast, implicitPragmas);
    // Before lowering, which adds names of its own: messages name them as declared.
    {
      // The names a library declares (POUs, types, globals) keep the library's spelling,
      // and so do the members and parameters of its POUs where a message names the POU
      const libraryNames = new Set<string>();
      const libraryMembers = new Map<string, Set<string>>();
      const members = (pou: string, names: Array<{ name: string }>): void => {
        const set = libraryMembers.get(pou.toUpperCase()) ?? new Set<string>();
        for (const n of names) set.add(n.name.toUpperCase());
        libraryMembers.set(pou.toUpperCase(), set);
      };
      for (const a of mergedOptions.libraries ?? []) {
        const m = a.manifest;
        for (const d of [
          ...m.functions,
          ...m.functionBlocks,
          ...m.types,
          ...(m.globals ?? []),
        ]) {
          libraryNames.add(d.name.toUpperCase());
        }
        for (const f of m.functions) members(f.name, f.parameters);
        for (const fb of m.functionBlocks) {
          members(fb.name, [
            ...fb.inputs,
            ...fb.outputs,
            ...fb.inouts,
            ...(fb.locals ?? []),
            ...(fb.methods ?? []),
            ...(fb.properties ?? []),
          ]);
        }
        for (const t of m.types) members(t.name, t.fields ?? []);
      }
      declaredSpellings(
        ast,
        sourcesByFile,
        (upper) => libraryNames.has(upper),
        libraryMembers,
      );
    }
    // Before lowering, which adds names of its own: only names as written.
    if (iec3Rules) {
      const spelling = iec3IdentifierErrors(
        ast,
        sourceNameLocator(sourcesByFile),
      );
      errors.push(...spelling);
    }
    // Ed. 3 Table 5: an underscore in a numeric literal stands between two digits.
    if (iec3Rules || mergedOptions.strict === true) {
      for (const [file, text] of sourcesByFile) {
        const literal = literalUnderscoreErrors(
          text,
          tokensByFile.get(file) ?? tokenize(text).tokens,
          file,
        );
        errors.push(...literal);
      }
    }
    // Actions first, so lowerInlineTypes qualifies inline enum members in
    // action bodies as it does in the owner's methods.
    const loweringErrors = [
      // First: a qualified library name is its bare name for every pass after.
      ...lowerLibraryNamespaces(ast, mergedOptions.libraries ?? [], {
        enabled: dialect.features.has("library_namespaces"),
        featureMessage: (construct) => {
          const message = `${construct} needs the feature library_namespaces`;
          const profiles = profilesWithFeature(dialect, "library_namespaces");
          return profiles.length > 0
            ? `${message} (profiles: ${profiles.join(", ")})`
            : message;
        },
      }),
      ...(dialect.features.has("vendor_operators")
        ? lowerPouOperators(ast, {
            sources: sourcesByFile,
            declaredByLibrary: (name) =>
              (mergedOptions.libraries ?? []).some((a) =>
                [
                  ...a.manifest.functions,
                  ...a.manifest.functionBlocks,
                  ...a.manifest.types,
                  ...(a.manifest.globals ?? []),
                ].some((d) => d.name.toUpperCase() === name),
              ),
            libraryFB: (name) => {
              for (const a of mergedOptions.libraries ?? []) {
                const fb = a.manifest.functionBlocks.find(
                  (f) => f.name.toUpperCase() === name,
                );
                if (fb === undefined) continue;
                const members = [
                  ...fb.inputs,
                  ...fb.outputs,
                  ...fb.inouts,
                  ...(fb.locals ?? []),
                  ...(fb.temps ?? []),
                  ...(fb.methods ?? []),
                ].map((m) => m.name.toUpperCase());
                return fb.extends === undefined
                  ? { members }
                  : { members, extends: fb.extends };
              }
              return undefined;
            },
          })
        : []),
      ...resolveArrayBounds(ast, mergedOptions.globalConstants ?? {}),
      ...foldStructFieldDefaults(ast, mergedOptions.globalConstants ?? {}),
      ...lowerActions(ast),
      ...lowerAccessorLocals(ast),
      ...lowerInlineTypes(ast),
    ];
    // After the actions, so `PRG_A.x` in an action of PRG_A is lowered too.
    if (dialect.features.has("program_methods")) lowerProgramSelfMembers(ast);
    if (dialect.features.has("string_default_80")) {
      lowerDefaultStringLength(ast, defaultStringLength(dialect.features));
    }
    if (dialect.features.has("platform_types")) {
      const libraryTypes = new Set<string>();
      for (const archive of mergedOptions.libraries ?? []) {
        for (const t of archive.manifest.types) {
          libraryTypes.add(t.name.toUpperCase());
        }
        for (const fb of archive.manifest.functionBlocks) {
          libraryTypes.add(fb.name.toUpperCase());
        }
      }
      lowerPlatformTypes(ast, (name) => libraryTypes.has(name));
    }
    loweringErrors.push(
      ...lowerBitType(
        ast,
        dialect.features.has("bit_type"),
        (name) =>
          (mergedOptions.libraries ?? []).some((a) =>
            [...a.manifest.types, ...a.manifest.functionBlocks].some(
              (d) => d.name.toUpperCase() === name,
            ),
          ),
        profilesWithFeature(dialect, "bit_type"),
      ),
    );
    // A library alias TYPE's default, onto this compile's declarations of it
    applyTypeDefaults(ast, libraryTypeDefaults(mergedOptions.libraries ?? []));
    errors.push(...loweringErrors);
    echoed.push(...loweringErrors);
  } catch (e) {
    errors.push({
      message: `AST building failed: ${e instanceof Error ? e.message : String(e)}`,
      line: 0,
      column: 0,
      severity: "error",
    });
    if (!continueOnError) {
      return {
        ast,
        projectModel,
        symbolTables,
        errors,
        warnings,
        allArchives,
        mergedOptions,
        fbInit,
        stringDefaultLength,
      };
    }
    // In analyze mode, AST building failure is non-fatal — continue with
    // whatever partial ast is available (may be undefined)
  }

  // Phase 3: Build project model and validate
  if (!ast) {
    // No AST available (parse/build failed completely) — skip remaining phases
    return {
      ast,
      projectModel,
      symbolTables,
      errors,
      warnings,
      allArchives,
      mergedOptions,
      fbInit,
      stringDefaultLength,
    };
  }
  try {
    const projectModelResult = buildProjectModel(ast);
    projectModel = projectModelResult.model;
    for (const err of projectModelResult.errors) {
      const entry: CompileError = {
        message: err.message,
        line: err.line ?? 0,
        column: err.column ?? 0,
        severity: "error",
        ...(err.file ? { file: err.file } : {}),
      };
      errors.push(entry);
      echoed.push(entry);
    }
    for (const warn of projectModelResult.warnings) {
      warnings.push({
        message: warn.message,
        line: warn.line ?? 0,
        column: warn.column ?? 0,
        severity: "warning",
        ...(warn.file ? { file: warn.file } : {}),
      });
    }
  } catch (e) {
    // Reported; semantic analysis does not need the project model
    errors.push({
      message: `Project model failed: ${e instanceof Error ? e.message : String(e)}`,
      line: 0,
      column: 0,
      severity: "error",
    });
  }

  // Phase 4: Library loading.  Archives arrive pre-loaded;
  // fs-based discovery lives in `strucpp/node`.
  // The Table 36 FUNCTIONs of the bundled library give way to another library's name.
  allArchives.push(...withYieldedFunctions(mergedOptions.libraries ?? []));

  // Auto-merge library globalConstants into effective constants.
  // Library values provide defaults; user-provided values take priority.
  for (const archive of allArchives) {
    if (archive.globalConstants) {
      if (!mergedOptions.globalConstants) {
        mergedOptions.globalConstants = {};
      }
      for (const [key, value] of Object.entries(archive.globalConstants)) {
        if (!(key in mergedOptions.globalConstants)) {
          mergedOptions.globalConstants[key] = value;
        }
      }
    }
  }

  // Phase 5: Semantic analysis. Each run gets its own tables: analysis adds to them.
  const freshSymbolTables = (): SymbolTables | undefined => {
    let tables: SymbolTables | undefined;
    if (allArchives.length > 0) {
      tables = new SymbolTables();
      for (const archive of allArchives) {
        registerLibrarySymbols(archive.manifest, tables);
      }
    }
    // Register global constants in symbol tables
    if (mergedOptions.globalConstants) {
      tables ??= new SymbolTables();
      tables.globalConstants = mergedOptions.globalConstants;
      for (const name of Object.keys(mergedOptions.globalConstants)) {
        try {
          tables.globalScope.define({
            name,
            kind: "constant",
            declaration:
              undefined as unknown as import("./frontend/ast.js").VarDeclaration,
            type: {
              typeKind: "elementary",
              name: "ULINT",
              sizeBits: 64,
            } as import("./frontend/ast.js").ElementaryType,
          });
        } catch {
          // Ignore duplicate
        }
      }
    }
    return tables;
  };
  const newAnalyzer = (): SemanticAnalyzer =>
    new SemanticAnalyzer({
      strict: mergedOptions.strict === true,
      features: dialect.features,
      dialect,
      sources: sourcesByFile,
    });
  // A variable declared twice with two types: the tree as it is before
  // analysis, to check it again with the other declaration (pickedEchoes).
  const doubled = variablesDeclaredTwice(ast);
  let other: CompilationUnit | undefined;
  try {
    other = doubled.length > 0 ? structuredClone(ast) : undefined;
  } catch {
    // A tree that does not copy is checked once, as development did
  }

  // Semantic diagnostics start here; dropEchoes filters them.
  const earlierErrors = errors.length;
  const semanticWarnings = warnings.length;
  try {
    const semanticResult = newAnalyzer().analyze(ast, freshSymbolTables());
    const echoes =
      other === undefined
        ? new Set<CompileError>()
        : pickedEchoes(semanticResult, other, (unit) =>
            newAnalyzer().analyze(unit, freshSymbolTables()),
          );
    // Incomplete tables after a pass threw are not handed on (as when it threw out)
    if (semanticResult.passFailed !== true) {
      symbolTables = semanticResult.symbolTables;
    }
    for (const err of semanticResult.errors) {
      // A pass that threw on a tree the parser repaired says nothing new
      if (recovered && err === semanticResult.failure) continue;
      if (echoes.has(err)) continue;
      errors.push({
        message: err.message,
        line: err.line ?? 0,
        column: err.column ?? 0,
        severity: "error",
        ...(err.file ? { file: err.file } : {}),
      });
    }
    for (const warn of semanticResult.warnings) {
      warnings.push({
        message: warn.message,
        line: warn.line ?? 0,
        column: warn.column ?? 0,
        severity: "warning",
        ...(warn.file ? { file: warn.file } : {}),
      });
    }
  } catch (e) {
    // The analyzer reports a pass that throws itself; this is anything else
    errors.push({
      message: `Semantic analysis failed: ${e instanceof Error ? e.message : String(e)}`,
      line: 0,
      column: 0,
      severity: "error",
    });
  }

  errors.push(...libraryShadowErrors(ast, allArchives));
  const primaryFile = mergedOptions.fileName ?? "main.st";
  const refusedNames = refusedNameDeclarations(
    ast,
    sourcesByFile,
    parseErrorsByFile,
  );
  dropEchoes(errors, earlierErrors, echoed, primaryFile, refusedNames);
  dropEchoes(warnings, semanticWarnings, echoed, primaryFile, refusedNames);

  // Annotate errors/warnings with POU + section context so programmatic
  // consumers (e.g. the OpenPLC Editor) can route diagnostics to the
  // right POU tab and remap body-line numbers to the user's view.
  // Skipped silently when no AST is available — the fields remain unset
  // and downstream code falls back to plain (file, line) display.
  moveToIlOperands(errors, ilOrigins, primaryFile);
  moveToIlOperands(warnings, ilOrigins, primaryFile);
  if (ast) {
    annotateErrorsWithPouContext(errors, ast, blankedByFile);
    annotateErrorsWithPouContext(warnings, ast, blankedByFile);
    const written = new Map([...sourcesByFile, ...writtenByFile]);
    respellDiagnostics(errors, spellingsOf(ast), written, primaryFile);
    respellDiagnostics(warnings, spellingsOf(ast), written, primaryFile);
  }

  return {
    ast,
    projectModel,
    symbolTables,
    errors,
    warnings,
    allArchives,
    mergedOptions,
    fbInit,
    stringDefaultLength,
    blankedByFile,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compile IEC 61131-3 Structured Text source code to C++.
 *
 * @param source - The ST source code to compile
 * @param options - Compilation options
 * @returns The compilation result containing C++ code and metadata
 *
 * @example
 * ```typescript
 * import { compile } from 'strucpp';
 *
 * const stSource = `
 * PROGRAM Main
 *   VAR counter : INT; END_VAR
 *   counter := counter + 1;
 * END_PROGRAM
 * `;
 *
 * const result = compile(stSource, { debug: true, lineMapping: true });
 * console.log(result.cppCode);
 * console.log(result.lineMap);
 * ```
 */
/** The defaults and alias targets the library archives record for their alias TYPEs. */
function libraryTypeDefaults(archives: readonly StlibArchive[]): {
  defaults: Map<string, Expression>;
  aliasTargets: Map<string, string>;
} {
  const defaults = new Map<string, Expression>();
  const aliasTargets = new Map<string, string>();
  for (const archive of archives) {
    for (const t of archive.manifest.types) {
      const key = t.name.toUpperCase();
      if (t.kind !== "alias" || typeof t.baseType !== "string") continue;
      if (!aliasTargets.has(key)) {
        aliasTargets.set(key, t.baseType.toUpperCase());
      }
      if (typeof t.defaultValue !== "string" || defaults.has(key)) continue;
      const value = libraryTypeDefault(t.name, t.baseType, t.defaultValue);
      if (value !== undefined) defaults.set(key, value);
    }
  }
  return { defaults, aliasTargets };
}

export function compile(
  source: string,
  options: Partial<CompileOptions> = {},
): CompileResult {
  const pipeline = runPipeline(source, options, false);

  if (pipeline.errors.length > 0 || !pipeline.ast) {
    return {
      success: false,
      cppFiles: [],
      cppCode: "",
      headerCode: "",
      lineMap: new Map(),
      headerLineMap: new Map(),
      errors: pipeline.errors,
      warnings: pipeline.warnings,
    };
  }

  const generated = generateCode(pipeline, pipeline.ast);
  if (generated.loweringErrors !== undefined) {
    respellDiagnostics(generated.loweringErrors, spellingsOf(pipeline.ast));
    return {
      success: false,
      cppFiles: [],
      cppCode: "",
      headerCode: "",
      lineMap: new Map(),
      headerLineMap: new Map(),
      errors: generated.loweringErrors,
      warnings: pipeline.warnings,
    };
  }
  const { codeResult, pouDisplayNames } = generated;
  if (codeResult.errors.length > 0) {
    const errors: CompileError[] = codeResult.errors.map((err) => ({
      message: withDeclaredNames(err.message, pouDisplayNames),
      line: err.line ?? 0,
      column: err.column ?? 0,
      severity: "error",
      ...(err.file !== undefined ? { file: err.file } : {}),
    }));
    respellDiagnostics(errors, spellingsOf(pipeline.ast));
    return {
      success: false,
      cppFiles: [],
      cppCode: "",
      headerCode: "",
      lineMap: new Map(),
      headerLineMap: new Map(),
      errors,
      warnings: pipeline.warnings,
    };
  }

  // Collect codegen warnings
  for (const warn of codeResult.warnings) {
    const entry: CompileError = {
      message: withDeclaredNames(warn.message, pouDisplayNames),
      line: warn.line ?? 0,
      column: warn.column ?? 0,
      severity: "warning",
    };
    if (warn.file !== undefined) {
      entry.file = warn.file;
    }
    pipeline.warnings.push(entry);
  }

  respellDiagnostics(pipeline.warnings, spellingsOf(pipeline.ast));

  // Emit debugger pointer tables + editor manifest. This is best-effort:
  // if projectModel or symbolTables are missing (malformed input), we still
  // return the primary compile output; the debug artifacts are just omitted.
  let debugTableCpp: string | undefined;
  let debugMap: DebugMapV2 | undefined;
  if (pipeline.projectModel && pipeline.symbolTables) {
    const dbg = generateDebugTable(
      pipeline.ast,
      pipeline.projectModel,
      pipeline.symbolTables,
      {
        md5: pipeline.mergedOptions.md5 ?? "",
        stringDefaultLength: pipeline.stringDefaultLength,
        ...(pipeline.mergedOptions.globalConstants !== undefined
          ? { globalConstants: pipeline.mergedOptions.globalConstants }
          : {}),
      },
    );
    debugTableCpp = dbg.debugTableCpp;
    debugMap = dbg.debugMap;

    // A RETAIN the walk could not follow all the way down is a WARNING, not an
    // error. The program still builds and its visible surface is still
    // retained; refusing would strand anyone using a third-party .stlib they
    // have no way to rebuild. But the retain is partial, and a partial retain
    // nobody is told about is a fault discovered after a power cycle with
    // nothing in the build to point at — so it is said, every build.
    for (const item of dbg.incomplete) {
      pipeline.warnings.push({
        message: withDeclaredNames(
          `${item.path} is retained in part: ${item.reason}`,
          pouDisplayNames,
        ),
        line: 0,
        column: 0,
        severity: "warning",
      });
    }

    // A leaf the walk could not register is not debuggable: it is absent from
    // the debugger's watch list and from anything built on the debug table,
    // OPC-UA included. That was silent — `skipped` was collected and dropped —
    // so a variable simply was not there, with nothing in the build to say why
    // or which. Same reasoning as `incomplete` above: the program still builds,
    // but a drop nobody is told about is found later, at a debugger that shows
    // nothing, with no thread back to the cause.
    for (const item of dbg.skipped) {
      pipeline.warnings.push({
        message: withDeclaredNames(
          `${item.path} is not debuggable: ${item.reason}`,
          pouDisplayNames,
        ),
        line: 0,
        column: 0,
        severity: "warning",
      });
    }
  }

  return {
    success: true,
    cppFiles: codeResult.cppFiles,
    cppCode: codeResult.cppCode,
    headerCode: codeResult.headerCode,
    lineMap: codeResult.lineMap,
    headerLineMap: codeResult.headerLineMap,
    errors: pipeline.errors,
    warnings: pipeline.warnings,
    ast: pipeline.ast,
    ...(pipeline.projectModel ? { projectModel: pipeline.projectModel } : {}),
    ...(pipeline.symbolTables ? { symbolTables: pipeline.symbolTables } : {}),
    ...(pipeline.allArchives.length > 0
      ? { resolvedLibraries: pipeline.allArchives }
      : {}),
    ...(debugTableCpp !== undefined ? { debugTableCpp } : {}),
    ...(debugMap !== undefined ? { debugMap } : {}),
  };
}

/**
 * Phase 6 on an analysed pipeline: the lowering refusals of analysis-accepted
 * forms, or the generated code with the renamed POUs' declared names.
 * `keepNames` leaves the tree and tables unrenamed (the code is not used).
 */
function generateCode(
  pipeline: PipelineResult,
  ast: CompilationUnit,
  keepNames = false,
):
  | { loweringErrors: CompileError[] }
  | {
      loweringErrors?: undefined;
      codeResult: ReturnType<CodeGenerator["generate"]>;
      pouDisplayNames: Map<string, string>;
    } {
  // UNION, FB_init and alias-variable REFERENCE TO uses analysis accepts but code generation cannot lower yet.
  const unionErrors = [
    ...unionCompileErrors(ast, pipeline.symbolTables),
    ...aliasReferenceCompileErrors(ast),
    ...(pipeline.fbInit ? fbInitCompileErrors(ast, pipeline.symbolTables) : []),
  ];
  if (unionErrors.length > 0) return { loweringErrors: unionErrors };

  // Phase 6: Generate C++ code
  // POUs and types named like a runtime function are emitted as NAME_.
  const pouDisplayNames =
    pipeline.mergedOptions.cppNamesAsDeclared === true || keepNames
      ? new Map<string, string>()
      : renameRuntimeCollidingPous(
          ast,
          pipeline.symbolTables,
          pipeline.projectModel,
        );
  // Collect library headers for #include directives
  const libraryHeaders: string[] = [];
  for (const archive of pipeline.allArchives) {
    for (const header of archive.manifest.headers) {
      if (!libraryHeaders.includes(header)) {
        libraryHeaders.push(header);
      }
    }
  }

  // Pass semantic symbol tables to codegen so it can use type info from semantic analysis
  const codegen = new CodeGenerator(pipeline.symbolTables, {
    sourceComments: pipeline.mergedOptions.debug,
    lineDirectives: pipeline.mergedOptions.lineDirectives ?? false,
    headerFileName: pipeline.mergedOptions.headerFileName ?? "generated.hpp",
    cppFileName: pipeline.mergedOptions.cppFileName ?? "generated.cpp",
    fileName: pipeline.mergedOptions.fileName ?? "main.st",
    ...(pipeline.mergedOptions.lineDirectiveFileName
      ? { lineDirectiveFileName: pipeline.mergedOptions.lineDirectiveFileName }
      : {}),
    libraryHeaders,
    pouIncludes: pipeline.mergedOptions.pouIncludes ?? [],
    isTestBuild: pipeline.mergedOptions.isTestBuild ?? false,
    globalConstants: pipeline.mergedOptions.globalConstants ?? {},
    ...(pipeline.mergedOptions.emitChunkMarkers
      ? { emitChunkMarkers: true }
      : {}),
    ...(pipeline.fbInit ? { fbInit: true } : {}),
    ...(pipeline.mergedOptions.threaded === true ? { threaded: true } : {}),
  });
  codegen.setProjectModel(pipeline.projectModel!);

  // Register all library metadata (FB types, field mappings, enum/struct types)
  codegen.registerLibraryArchives(pipeline.allArchives);

  // Function-level tree-shake: figure out which library chunks the
  // user's AST actually reaches (transitively through chunk dep
  // edges), then hand the reachable subset of each archive to the
  // codegen for emission. Test builds bypass the shake — the test
  // harness may reference symbols not present in the source AST.
  const isTestBuild = pipeline.mergedOptions.isTestBuild ?? false;
  const reachableByArchive = collectUsedSymbols(
    ast,
    pipeline.allArchives,
    isTestBuild,
  );

  for (const archive of pipeline.allArchives) {
    const reachable = reachableByArchive.get(archive.manifest.name);
    if (!reachable || reachable.size === 0) continue;
    codegen.addLibraryChunks(archive, reachable);
  }

  return { codeResult: codegen.generate(ast), pouDisplayNames };
}

/** The UNION uses compile refuses as not supported yet (see unionLoweringErrors). */
function unionCompileErrors(
  ast: CompilationUnit,
  symbolTables: SymbolTables | undefined,
): CompileError[] {
  const errors: CompileError[] = [];
  unionLoweringErrors(
    ast,
    (upper) => symbolTables?.lookupType(upper)?.declaration?.definition,
    (message, span) =>
      errors.push({
        message,
        line: span.startLine,
        column: span.startCol,
        severity: "error",
        ...(span.file !== undefined ? { file: span.file } : {}),
      }),
  );
  return errors;
}

/** REFERENCE TO bindings to alias-typed variables, refused by compile (see aliasReferenceBinding). */
function aliasReferenceCompileErrors(ast: CompilationUnit): CompileError[] {
  const errors: CompileError[] = [];
  walkAST(ast, (node) => {
    if (node.kind !== "VariableExpression") return;
    const message = (node as VariableExpression).aliasReferenceBinding;
    if (message === undefined) return;
    const span = node.sourceSpan;
    errors.push({
      message,
      line: span.startLine,
      column: span.startCol,
      severity: "error",
      ...(span.file !== undefined ? { file: span.file } : {}),
    });
  });
  return errors;
}

/** The FB_init uses compile refuses as not supported yet (see fbInitLoweringErrors). */
function fbInitCompileErrors(
  ast: CompilationUnit,
  symbolTables: SymbolTables | undefined,
): CompileError[] {
  const errors: CompileError[] = [];
  fbInitLoweringErrors(
    ast,
    (upper) => symbolTables?.lookupFunctionBlock(upper) !== undefined,
    (message, span) =>
      errors.push({
        message,
        line: span.startLine,
        column: span.startCol,
        severity: "error",
        ...(span.file !== undefined ? { file: span.file } : {}),
      }),
  );
  return errors;
}

/**
 * Analyze ST source code without code generation.
 * Unlike compile(), returns partial results (AST, symbol tables, project model)
 * even when errors are present, making it suitable for IDE/LSP integration.
 *
 * @param source - The ST source code to analyze
 * @param options - Compilation options (codegen options are ignored)
 * @returns Analysis result with AST, symbol tables, and diagnostics
 */
export function analyze(
  source: string,
  options: Partial<CompileOptions> = {},
): AnalysisResult {
  const pipeline = runPipeline(source, options, true);
  // Code generation finds a shared global's in-out or address use; run it
  // when tasks may race, so the analysis gives the warnings the build would.
  if (
    pipeline.errors.length === 0 &&
    pipeline.ast !== undefined &&
    tasksMayRace(pipeline.projectModel, options.threaded === true) &&
    mayBindSharedGlobal(pipeline.ast)
  ) {
    let racy: CompileError[] = [];
    try {
      // On this pipeline's tree: no second parse and analysis, no renaming
      const generated = generateCode(pipeline, pipeline.ast, true);
      if (generated.loweringErrors === undefined) {
        racy = generated.codeResult.warnings
          .filter((w) => isSharedGlobalRaceWarning(w.message))
          .map((w) => ({
            message: w.message,
            line: w.line ?? 0,
            column: w.column ?? 0,
            severity: "warning" as const,
            ...(w.file !== undefined ? { file: w.file } : {}),
          }));
      }
    } catch {
      // Code generation failing adds nothing the analysis can report
    }
    annotateErrorsWithPouContext(
      racy,
      pipeline.ast,
      pipeline.blankedByFile ?? new Map(),
    );
    respellDiagnostics(racy, spellingsOf(pipeline.ast));
    pipeline.warnings.push(...racy);
  }

  return {
    ...(pipeline.ast ? { ast: pipeline.ast } : {}),
    ...(pipeline.symbolTables ? { symbolTables: pipeline.symbolTables } : {}),
    ...(pipeline.projectModel ? { projectModel: pipeline.projectModel } : {}),
    errors: pipeline.errors,
    warnings: pipeline.warnings,
    stdFunctionRegistry: new StdFunctionRegistry(),
  };
}

/**
 * Parse ST source code and return the AST without code generation.
 * Useful for syntax checking and IDE integration.
 *
 * @param source - The ST source code to parse
 * @returns The parsed AST or parse errors
 */
export function parse(source: string): {
  ast?: CompilationUnit;
  errors: CompileError[];
} {
  const errors: CompileError[] = [];

  // Parse ST source to CST
  const parseResult = parseSource(source);
  if (parseResult.errors.length > 0) {
    errors.push(
      ...withPragmaHint(
        toCompileErrors(parseResult.errors),
        conditionalPragmaHint(resolveDialect({})),
      ),
    );
    return { errors };
  }

  // Build AST from CST
  if (!parseResult.cst) {
    errors.push({
      message: "Parse failed: no CST produced",
      line: 0,
      column: 0,
      severity: "error",
    });
    return { errors };
  }
  try {
    const ast = buildAST(parseResult.cst);
    return { ast, errors };
  } catch (e) {
    errors.push({
      message: `AST building failed: ${e instanceof Error ? e.message : String(e)}`,
      line: 0,
      column: 0,
      severity: "error",
    });
    return { errors };
  }
}

/**
 * Resolve the conditional pragmas of one ST source as if the dialect had the
 * feature `conditional_pragmas`: directives and inactive branches are blanked
 * line-preservingly. For tools that show or search sources compiled with
 * defines (for example a library's persisted sources).
 *
 * @param source - The ST source text
 * @param pragmaDefines - Define names and values (`''` for a bare name)
 * @returns The blanked text and positioned errors
 */
export function resolveConditionalPragmas(
  source: string,
  pragmaDefines?: Record<string, string>,
): { text: string; errors: CompileError[] } {
  validatePragmaDefines(pragmaDefines);
  const defines = new Map(Object.entries(pragmaDefines ?? {}));
  const result = applyConditionalPragmas(source, defines, tokenize);
  return { text: result.text, errors: toCompileErrors(result.errors) };
}

export {
  isPragmaDefineName,
  validatePragmaDefines,
} from "./frontend/conditional-pragmas.js";

/**
 * Get the version of the STruC++ compiler.
 *
 * Three sources, in priority order:
 *   1. STRUCPP_VERSION — esbuild --define constant set by
 *      scripts/bundle.mjs for the standalone binary build.
 *   2. STRUCPP_VERSION_BUILD — value baked into src/version-build.ts
 *      by scripts/rebuild-libs.mjs before tsc runs; ships in the
 *      npm tarball and survives downstream bundling (webpack, asar).
 *   3. Runtime read of package.json — last-resort fallback for
 *      unbundled dev environments. Fails inside re-bundled consumers
 *      because import.meta.url no longer points at the strucpp
 *      module directory; kept only so a hand-built dist/ without
 *      version-build.ts still reports something.
 */
declare const STRUCPP_VERSION: string | undefined;

import { STRUCPP_VERSION_BUILD } from "./version-build.js";

export function getVersion(): string {
  if (typeof STRUCPP_VERSION !== "undefined") {
    return STRUCPP_VERSION;
  }
  if (STRUCPP_VERSION_BUILD) {
    return STRUCPP_VERSION_BUILD;
  }
  return "0.0.0";
}

// Re-export types
export type {
  CompileOptions,
  CompileResult,
  CompileError,
  AnalysisResult,
} from "./types.js";
export type { SourceSpan, LineMapEntry, Severity } from "./types.js";

// Re-export diagnostic formatting helpers
export {
  buildSourceMap,
  formatDiagnostic,
  formatDiagnostics,
} from "./diagnostic-formatter.js";
export type { DiagnosticSource } from "./diagnostic-formatter.js";

// Re-export AST types for LSP integration
export type {
  ASTNode,
  TypedNode,
  CompilationUnit,
  ProgramDeclaration,
  FunctionDeclaration,
  FunctionBlockDeclaration,
  InterfaceDeclaration,
  MethodDeclaration,
  PropertyDeclaration,
  TypeDeclaration,
  VarDeclaration,
  VarBlock,
  VarBlockType,
  Statement,
  Expression,
  VariableExpression,
  FunctionCallExpression,
  MethodCallExpression,
  LiteralExpression,
  TypeReference,
  IECType,
  ElementaryType,
  ArrayType,
  StructType,
  EnumType,
  ReferenceType,
  FunctionBlockType,
  AccessStep,
  StructDefinition,
  EnumDefinition,
  EnumMember,
} from "./frontend/ast.js";

// Re-export symbol table types
export { SymbolTables, Scope } from "./semantic/symbol-table.js";
export type {
  AnySymbol,
  VariableSymbol,
  ConstantSymbol,
  FunctionSymbol,
  FunctionBlockSymbol,
  ProgramSymbol,
  TypeSymbol,
  EnumValueSymbol,
  SymbolKind,
} from "./semantic/symbol-table.js";

// Re-export standard function registry
export { StdFunctionRegistry } from "./semantic/std-function-registry.js";
export type {
  StdFunctionDescriptor,
  StdFunctionParam,
  TypeConstraint,
} from "./semantic/std-function-registry.js";

// Re-export type utilities
export {
  typeName,
  resolveFieldType,
  resolveArrayElementType,
  ELEMENTARY_TYPES,
  TYPE_CATEGORIES,
  matchesConstraint,
  isAssignable,
  isImplicitlyConvertible,
  getCommonType,
} from "./semantic/type-utils.js";
export { isElementaryType } from "./semantic/type-registry.js";

// Canonical IEC base-type registry — same data published as
// libs/iec-types.json. Downstream tooling that prefers a typed
// import over the JSON artefact can pull these directly.
export {
  IEC_BASE_TYPES,
  lookupBaseType,
  isBaseTypeName,
} from "./semantic/iec-types-data.js";
export type {
  IECTypeMetadata,
  IECWireFormat,
} from "./semantic/iec-types-data.js";

// Re-export project model
export type { ProjectModel } from "./project-model.js";

// Re-export AST utilities
export {
  walkAST,
  findNodeAtPosition,
  findInnermostExpression,
  collectReferences,
  findEnclosingPOU,
} from "./ast-utils.js";
export type { EnclosingScope } from "./ast-utils.js";

// Re-export dialect profiles
export {
  KNOWN_FEATURES,
  DEFAULT_FEATURES,
  IEC_PROFILE,
  DialectError,
  resolveDialect,
  profilesWithFeature,
} from "./dialect.js";
export type {
  FeatureId,
  DialectProfile,
  DialectRequest,
  ResolvedDialect,
  DialectIO,
} from "./dialect.js";

// Conditional pragmas (feature conditional_pragmas)
export {
  applyConditionalPragmas,
  sourcePrepFor,
} from "./frontend/conditional-pragmas.js";
export type {
  PragmaDirectiveError,
  ConditionalPragmaResult,
  SourcePrep,
} from "./frontend/conditional-pragmas.js";

// Re-export library system
export { compileLibrary, compileStlib } from "./library/library-compiler.js";
export {
  loadLibraryManifest,
  loadStlibArchive,
  loadStlibFromBuffer,
  loadStlibFromString,
  registerLibrarySymbols,
  LibraryManifestError,
} from "./library/library-loader.js";
export { getBuiltinStdlibManifest } from "./library/builtin-stdlib.js";
export { extractNamespaceBody } from "./library/library-utils.js";
export type {
  LibraryManifest,
  LibraryCompileError,
  LibraryCompileResult,
  StlibArchive,
  StlibCompileResult,
  LibraryFunctionEntry,
  LibraryFBEntry,
  LibraryTypeEntry,
} from "./library/library-manifest.js";

// Re-export CODESYS import
export {
  detectFormat,
  importCodesysLibraryFromBytes,
} from "./library/codesys-import/index.js";
export type {
  CodesysFormat,
  CodesysImportResult,
} from "./library/codesys-import/index.js";

// REPL main generator (for build command)
export { generateReplMain } from "./backend/repl-main-gen.js";
export type { ReplMainGenOptions } from "./backend/repl-main-gen.js";

// Pure C++ flag parsers (Node-only build helpers live in `strucpp/node`).
export { extractIncludePaths, splitCxxFlags } from "./cxx-flags.js";

// Test framework
export { parseTestFile } from "./testing/test-parser.js";
export type { TestFileParseOptions } from "./testing/test-parser.js";
export { analyzeTestFile } from "./semantic/analyzer.js";
export { decodeStringLiteral } from "./literal-utils.js";
export {
  generateTestMain,
  buildPOUInfoFromAST,
  TestMainCodegenError,
} from "./backend/test-main-gen.js";
export type { TestMainGenOptions, POUInfo } from "./backend/test-main-gen.js";
export type {
  TestFile,
  TestCase,
  SetupBlock,
  TeardownBlock,
  AssertType,
  AssertCall,
  TestStatement,
} from "./testing/test-model.js";
