// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * Library namespaces (feature library_namespaces): a library's POUs, types,
 * globals and enumerations named through its namespace, `NS.F(...)`,
 * `t : NS.TON`, `NS.G`, `NS.E.Member`. With the feature on, each qualified
 * name is replaced by the bare name before semantic analysis, so it is then
 * checked and generated as the bare name is. A namespace is the manifest's
 * `stNamespace`, or for an archive without one its name with every character
 * other than a letter, digit or underscore as `_`. See docs/DIALECTS.md.
 */

import type {
  ASTNode,
  CompilationUnit,
  FunctionCallExpression,
  TypeReference,
  VariableExpression,
  VarBlock,
} from "../frontend/ast.js";
import type { StlibArchive } from "../library/library-manifest.js";
import type { CompileError, SourceSpan } from "../types.js";
import { walkAST } from "../ast-utils.js";

/** The ST namespace of a library archive (manifest `stNamespace`, else from its name). */
export function libraryStNamespace(archive: StlibArchive): string {
  const recorded = archive.manifest.stNamespace;
  return typeof recorded === "string" && recorded.length > 0
    ? recorded
    : stNamespaceOfName(archive.manifest.name);
}

/** The ST namespace a library name gives: non-identifier characters become `_`. */
export function stNamespaceOfName(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}

interface NamespaceInfo {
  /** The library's name, for messages. */
  library: string;
  /** The namespace as the library records it, for messages. */
  spelled: string;
  /** Upper-cased names the library declares: POUs, types, globals. */
  names: Set<string>;
  /** Upper-cased enumeration names. */
  enums: Set<string>;
}

export interface LibraryNamespaceOptions {
  /** The feature library_namespaces is on. */
  enabled: boolean;
  /** The message for a qualified name written without the feature. */
  featureMessage: (construct: string) => string;
}

/**
 * Replace each library-namespace-qualified name in `ast` by its bare name
 * (the feature on), or report it (the feature off). A namespace that names a
 * declaration of the sources (a variable, POU, type or global list) is not
 * taken as one.
 */
export function lowerLibraryNamespaces(
  ast: CompilationUnit,
  archives: readonly StlibArchive[],
  options: LibraryNamespaceOptions,
): CompileError[] {
  const namespaces = new Map<string, NamespaceInfo>();
  /** Each upper-cased name → the library whose declaration is used (the first). */
  const owner = new Map<string, string>();
  for (const archive of archives) {
    const ns = libraryStNamespace(archive).toUpperCase();
    const m = archive.manifest;
    const info = namespaces.get(ns) ?? {
      library: m.name,
      spelled: libraryStNamespace(archive),
      names: new Set<string>(),
      enums: new Set<string>(),
    };
    for (const d of [
      ...m.functions,
      ...m.functionBlocks,
      ...m.types,
      ...(m.globals ?? []),
    ]) {
      const upper = d.name.toUpperCase();
      info.names.add(upper);
      if (!owner.has(upper)) owner.set(upper, m.name);
    }
    for (const t of m.types) {
      if (t.kind === "enum") info.enums.add(t.name.toUpperCase());
    }
    namespaces.set(ns, info);
  }
  if (namespaces.size === 0) return [];

  const declared = sourceDeclaredNames(ast);
  const errors: CompileError[] = [];
  const report = (message: string, span: SourceSpan): void => {
    errors.push({
      message,
      line: span.startLine,
      column: span.startCol,
      ...(span.file !== undefined ? { file: span.file } : {}),
      severity: "error",
    });
  };

  /**
   * The bare name for `ns.name`, or undefined (not a namespace, or refused).
   * `locals` are the variable names of the POU the reference is in.
   */
  const resolve = (
    ns: string,
    name: string,
    span: SourceSpan,
    locals: ReadonlySet<string>,
  ): string | undefined => {
    const nsUpper = ns.toUpperCase();
    const info = namespaces.get(nsUpper);
    if (info === undefined || locals.has(nsUpper) || declared.has(nsUpper)) {
      return undefined;
    }
    const upper = name.toUpperCase();
    const written = `${info.spelled}.${name}`;
    if (!options.enabled) {
      report(
        options.featureMessage(
          `Qualifying '${name}' by the namespace of library ${info.library}`,
        ),
        span,
      );
      return undefined;
    }
    if (!info.names.has(upper)) {
      report(
        `Library ${info.library} (namespace '${info.spelled}') declares no '${name}'`,
        span,
      );
      return undefined;
    }
    if (declared.has(upper) || locals.has(upper)) {
      report(
        `'${written}' names the '${name}' of library ${info.library}, which a declaration of the same name hides here`,
        span,
      );
      return undefined;
    }
    const used = owner.get(upper);
    if (used !== undefined && used !== info.library) {
      report(
        `'${written}' names the '${name}' of library ${info.library}, but library ${used} also declares '${name}' and its one is used; a name two libraries declare cannot be qualified`,
        span,
      );
      return undefined;
    }
    return name;
  };

  const none: ReadonlySet<string> = new Set();
  const lowerNode = (node: ASTNode, locals: ReadonlySet<string>): void => {
    walkAST(node, (n) => {
      switch (n.kind) {
        case "FunctionCallExpression": {
          const call = n as FunctionCallExpression;
          const dot = call.functionName.indexOf(".");
          if (dot <= 0 || call.functionName.indexOf(".", dot + 1) !== -1) {
            break;
          }
          const bare = resolve(
            call.functionName.slice(0, dot),
            call.functionName.slice(dot + 1),
            call.sourceSpan,
            locals,
          );
          if (bare !== undefined) call.functionName = bare;
          break;
        }
        case "VariableExpression": {
          const v = n as VariableExpression;
          const first = v.fieldAccess[0];
          const step = v.accessChain?.[0];
          if (
            first === undefined ||
            (step !== undefined && step.kind !== "field")
          ) {
            break;
          }
          const bare = resolve(v.name, first, v.sourceSpan, locals);
          if (bare === undefined) break;
          v.name = bare;
          v.fieldAccess = v.fieldAccess.slice(1);
          if (v.accessChain !== undefined) {
            const rest = v.accessChain.slice(1);
            if (rest.length > 0) v.accessChain = rest;
            else delete v.accessChain;
          }
          break;
        }
        case "TypeReference": {
          const t = n as TypeReference;
          // An inline ARRAY's synthetic name carries its element type too.
          for (const key of ["name", "elementTypeName"] as const) {
            const text = t[key];
            if (text === undefined) continue;
            const m = /^(__INLINE_ARRAY_|__VLA_\d+D_)?([^.]+)\.([^.]+)$/.exec(
              text,
            );
            if (m === null) continue;
            const bare = resolve(m[2]!, m[3]!, t.sourceSpan, none);
            if (bare !== undefined) t[key] = `${m[1] ?? ""}${bare}`;
          }
          break;
        }
      }
    });
  };

  for (const p of ast.programs) lowerNode(p, variableNames(p.varBlocks, p));
  for (const f of ast.functions) lowerNode(f, variableNames(f.varBlocks, f));
  for (const fb of ast.functionBlocks) {
    lowerNode(fb, variableNames(fb.varBlocks, fb));
  }
  for (const a of ast.actions) lowerNode(a, none);
  for (const i of ast.interfaces) lowerNode(i, none);
  for (const t of ast.types) lowerNode(t, none);
  for (const b of ast.globalVarBlocks) lowerNode(b, none);
  for (const c of ast.configurations) lowerNode(c, none);
  return errors;
}

/** Upper-cased names of the variables of `blocks` and of every block nested in `pou` (methods, accessors). */
function variableNames(blocks: readonly VarBlock[], pou: ASTNode): Set<string> {
  const names = new Set<string>();
  const add = (list: readonly VarBlock[]): void => {
    for (const b of list) {
      for (const d of b.declarations) {
        for (const n of d.names) names.add(n.toUpperCase());
      }
    }
  };
  add(blocks);
  walkAST(pou, (n) => {
    if (n.kind === "VarBlock") add([n as VarBlock]);
  });
  return names;
}

/** Upper-cased names the sources declare at the top: POUs, types, globals, global lists. */
function sourceDeclaredNames(ast: CompilationUnit): Set<string> {
  const names = new Set<string>();
  for (const d of [
    ...ast.programs,
    ...ast.functions,
    ...ast.functionBlocks,
    ...ast.interfaces,
    ...ast.types,
    ...ast.configurations,
  ]) {
    names.add(d.name.toUpperCase());
  }
  const blocks = [
    ...ast.globalVarBlocks,
    ...ast.configurations.flatMap((c) => c.varBlocks),
  ];
  for (const b of blocks) {
    if (b.globalListName !== undefined) {
      names.add(b.globalListName.toUpperCase());
    }
    for (const d of b.declarations) {
      for (const n of d.names) names.add(n.toUpperCase());
    }
  }
  return names;
}
