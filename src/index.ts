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
import { CodeGenerator } from "./backend/codegen.js";
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
} from "./frontend/ast.js";
import { mergeCompilationUnits } from "./merge.js";
import { lowerInlineTypes } from "./frontend/lower-inline-types.js";
import { resolveArrayBounds } from "./semantic/array-bounds.js";
import { foldStructFieldDefaults } from "./semantic/struct-defaults.js";
import { lowerActions } from "./semantic/lower-actions.js";
import { lowerAccessorLocals } from "./semantic/lower-accessor-locals.js";
import { lowerProgramSelfMembers } from "./semantic/program-access.js";
import { unionLoweringErrors } from "./semantic/union.js";
import { fbInitLoweringErrors } from "./semantic/fb-init.js";
import { walkAST } from "./ast-utils.js";
import { registerLibrarySymbols } from "./library/library-loader.js";
import { renameRuntimeCollidingPous } from "./backend/pou-naming.js";
import type { LibraryChunk, StlibArchive } from "./library/library-manifest.js";
import { annotateErrorsWithPouContext } from "./diagnostic-pou-context.js";
import {
  DialectError,
  resolveDialect,
  type DialectRequest,
  type ResolvedDialect,
} from "./dialect.js";
import type { ILexingResult } from "chevrotain";
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
): { byLibrary: Map<string, Set<string>>; conflicts: ShadowConflict[] } {
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
      symbolIndex.set(chunk.name.toUpperCase(), { ...entry, kind: chunk.kind });
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
        const ve = node as unknown as { name: string };
        variableNames.add(ve.name.toUpperCase());
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

  return { byLibrary, conflicts };
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
): {
  text: string;
  errors: CompileError[];
  stopsOnError: boolean;
  blankedLines: number[];
} {
  const errors: CompileError[] = [];
  let out = text;
  let stopsOnError = false;
  let blankedLines: number[] = [];
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
  if (ilResult.hasIL) {
    out = ilResult.stSource;
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
  }
  return { text: out, errors, stopsOnError, blankedLines };
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
}

/**
 * Run phases 1-5 of the compilation pipeline (parse → AST → project model →
 * library loading → semantic analysis).
 *
 * @param continueOnError - When true (analyze mode), wraps each phase in
 *   try/catch and never aborts early so partial results are returned.
 *   When false (compile mode), aborts at each phase boundary on errors.
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
  try {
    dialect = resolveDialect(
      dialectRequestFromOptions(mergedOptions),
      mergedOptions.dialectIO?.readFile,
      mergedOptions.dialectIO?.listDir,
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
    };
  }
  fbInit = dialect.features.has("fb_init");

  const prep = sourcePrepFor(dialect, mergedOptions.pragmaDefines);
  const pragmaHint = prep.enabled ? "" : conditionalPragmaHint(dialect);

  // Phase 0: conditional pragmas, then IL→ST transpilation
  let effectiveSource = source;
  /** File name → lines the conditional-pragma pass blanked. */
  const blankedByFile = new Map<string, ReadonlySet<number>>();
  {
    const prepared = prepareFile(
      source,
      mergedOptions.fileName,
      prep,
      tokenize,
      mergedOptions.filePragmaDefines,
    );
    effectiveSource = prepared.text;
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
      };
    }
  }

  // Phase 1: Parse ST source to CST. Lexer errors do not stop the parse,
  // so analyze mode still sees the rest of the file.
  const parseResult = parseSource(effectiveSource);
  warnings.push(
    ...pragmaWarnings(
      parseResult.pragmas,
      effectiveSource,
      mergedOptions.fileName,
    ),
  );
  if (parseResult.errors.length > 0) {
    errors.push(
      ...withPragmaHint(
        toCompileErrors(parseResult.errors, mergedOptions.fileName),
        pragmaHint,
      ),
    );
    // In analyze mode, continue with partial CST from Chevrotain recovery.
    // In compile mode, abort immediately.
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
      };
    }
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
    if (mergedOptions.additionalSources) {
      for (const addlSource of mergedOptions.additionalSources) {
        const prepared = prepareFile(
          addlSource.source,
          addlSource.fileName,
          prep,
          tokenize,
          addlSource.pragmaDefines,
        );
        const effectiveAddlSource = prepared.text;
        if (prepared.blankedLines.length > 0) {
          blankedByFile.set(
            addlSource.fileName,
            new Set(prepared.blankedLines),
          );
        }
        errors.push(...prepared.errors);
        if (prepared.stopsOnError && errors.length > 0 && !continueOnError) {
          continue;
        }

        const addlParseResult = parseSource(effectiveAddlSource);
        warnings.push(
          ...pragmaWarnings(
            addlParseResult.pragmas,
            effectiveAddlSource,
            addlSource.fileName,
          ),
        );
        if (addlParseResult.errors.length > 0) {
          errors.push(
            ...withPragmaHint(
              toCompileErrors(addlParseResult.errors, addlSource.fileName),
              pragmaHint,
            ),
          );
          // In compile mode, skip files with parse errors.
          // In analyze mode, try to build from the partial CST.
          if (!continueOnError) {
            continue;
          }
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

    if (!continueOnError && errors.length > 0) {
      return {
        ast,
        projectModel,
        symbolTables,
        errors,
        warnings,
        allArchives,
        mergedOptions,
        fbInit,
      };
    }

    ast = mergeCompilationUnits(units);
    // Actions first, so lowerInlineTypes qualifies inline enum members in
    // action bodies as it does in the owner's methods.
    const loweringErrors = [
      ...resolveArrayBounds(ast, mergedOptions.globalConstants ?? {}),
      ...foldStructFieldDefaults(ast, mergedOptions.globalConstants ?? {}),
      ...lowerActions(ast),
      ...lowerAccessorLocals(ast),
      ...lowerInlineTypes(ast),
    ];
    // After the actions, so `PRG_A.x` in an action of PRG_A is lowered too.
    if (dialect.features.has("program_methods")) lowerProgramSelfMembers(ast);
    errors.push(...loweringErrors);
    if (!continueOnError && loweringErrors.length > 0) {
      return {
        ast,
        projectModel,
        symbolTables,
        errors,
        warnings,
        allArchives,
        mergedOptions,
        fbInit,
      };
    }
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
    };
  }
  try {
    const projectModelResult = buildProjectModel(ast);
    projectModel = projectModelResult.model;
    for (const err of projectModelResult.errors) {
      errors.push({
        message: err.message,
        line: err.line ?? 0,
        column: err.column ?? 0,
        severity: "error",
        ...(err.file ? { file: err.file } : {}),
      });
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
    if (!continueOnError) {
      errors.push({
        message: `Project model failed: ${e instanceof Error ? e.message : String(e)}`,
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
      };
    }
    // In analyze mode, project model failure is non-fatal
  }

  if (!continueOnError && errors.length > 0) {
    return {
      ast,
      projectModel,
      symbolTables,
      errors,
      warnings,
      allArchives,
      mergedOptions,
      fbInit,
    };
  }

  // Phase 4: Library loading.  Archives arrive pre-loaded;
  // fs-based discovery lives in `strucpp/node`.
  // The Table 36 FUNCTIONs of the bundled library give way to another library's name.
  allArchives.push(...withYieldedFunctions(mergedOptions.libraries ?? []));

  if (!continueOnError && errors.length > 0) {
    return {
      ast,
      projectModel,
      symbolTables,
      errors,
      warnings,
      allArchives,
      mergedOptions,
      fbInit,
    };
  }

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

  // Phase 5: Semantic analysis
  let semanticSymbolTables: SymbolTables | undefined;
  if (allArchives.length > 0) {
    semanticSymbolTables = new SymbolTables();
    for (const archive of allArchives) {
      registerLibrarySymbols(archive.manifest, semanticSymbolTables);
    }
  }

  // Register global constants in symbol tables
  if (mergedOptions.globalConstants) {
    if (!semanticSymbolTables) {
      semanticSymbolTables = new SymbolTables();
    }
    for (const name of Object.keys(mergedOptions.globalConstants)) {
      try {
        semanticSymbolTables.globalScope.define({
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

  try {
    const analyzer = new SemanticAnalyzer({
      strict: mergedOptions.strict === true,
      features: dialect.features,
      dialect,
    });
    const semanticResult = analyzer.analyze(ast, semanticSymbolTables);
    symbolTables = semanticResult.symbolTables;
    for (const err of semanticResult.errors) {
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
    if (!continueOnError) {
      errors.push({
        message: `Semantic analysis failed: ${e instanceof Error ? e.message : String(e)}`,
        line: 0,
        column: 0,
        severity: "error",
      });
    }
    // In analyze mode, semantic failure is non-fatal — return whatever we have
  }

  errors.push(...libraryShadowErrors(ast, allArchives));

  // Annotate errors/warnings with POU + section context so programmatic
  // consumers (e.g. the OpenPLC Editor) can route diagnostics to the
  // right POU tab and remap body-line numbers to the user's view.
  // Skipped silently when no AST is available — the fields remain unset
  // and downstream code falls back to plain (file, line) display.
  if (ast) {
    annotateErrorsWithPouContext(errors, ast, blankedByFile);
    annotateErrorsWithPouContext(warnings, ast, blankedByFile);
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

  // UNION, FB_init and alias-variable REFERENCE TO uses analysis accepts but code generation cannot lower yet.
  const unionErrors = [
    ...unionCompileErrors(pipeline.ast, pipeline.symbolTables),
    ...aliasReferenceCompileErrors(pipeline.ast),
    ...(pipeline.fbInit
      ? fbInitCompileErrors(pipeline.ast, pipeline.symbolTables)
      : []),
  ];
  if (unionErrors.length > 0) {
    return {
      success: false,
      cppFiles: [],
      cppCode: "",
      headerCode: "",
      lineMap: new Map(),
      headerLineMap: new Map(),
      errors: unionErrors,
      warnings: pipeline.warnings,
    };
  }

  // Phase 6: Generate C++ code
  // POUs and types named like a runtime function are emitted as NAME_.
  const pouDisplayNames =
    pipeline.mergedOptions.cppNamesAsDeclared === true
      ? new Map<string, string>()
      : renameRuntimeCollidingPous(
          pipeline.ast,
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
    pipeline.ast,
    pipeline.allArchives,
    isTestBuild,
  );

  for (const archive of pipeline.allArchives) {
    const reachable = reachableByArchive.get(archive.manifest.name);
    if (!reachable || reachable.size === 0) continue;
    codegen.addLibraryChunks(archive, reachable);
  }

  const codeResult = codegen.generate(pipeline.ast);

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
      { md5: pipeline.mergedOptions.md5 ?? "" },
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
        message: withDeclaredNames(item.reason, pouDisplayNames),
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
export {
  generateTestMain,
  buildPOUInfoFromAST,
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
