// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * The order in which the file-level VAR_GLOBALs are created.
 *
 * A global's initial value may name another global, as a value, as the
 * target of ADR() or as the instance of a method call (`f.M()`), wherever
 * that one is declared: later in the same file or in another global variable
 * list. A global is therefore created after the globals its initial value
 * names, and after those the code its creation runs reads: the methods,
 * functions and accessors it calls, and an FB instance's member initial
 * values (call-reads.ts). Without such a dependency the declaration order is
 * kept. A cycle has no order and is reported. The file-level globals and
 * those of every CONFIGURATION are created as one graph (orderAllGlobals):
 * the code of either may read the other's globals (VAR_EXTERNAL).
 */

import type {
  ASTNode,
  CompilationUnit,
  ConfigurationDeclaration,
  FunctionCallExpression,
  VarBlock,
  VarDeclaration,
  VariableExpression,
} from "../frontend/ast.js";
import { walkAST } from "../ast-utils.js";
import { CallReadTracer } from "./call-reads.js";

/** One declared global: a name of a declaration of a block. */
export interface GlobalItem {
  block: VarBlock;
  decl: VarDeclaration;
  name: string;
}

export interface GlobalOrder {
  /** Every global, each after the globals its initial value names. */
  order: GlobalItem[];
  /** The globals named by each global's initial value (upper-case keys). */
  dependencies: Map<string, string[]>;
  /** Each dependency cycle, as the upper-case names along it (first not repeated). */
  cycles: string[][];
  /**
   * Upper-case names declared more than once outside distinct global variable
   * lists: an error of its own, and `order` keeps only the last of them.
   */
  duplicates: Set<string>;
  /**
   * Globals (upper-case) whose initial value calls code whose reads cannot
   * be followed: the call and why. Their order is not known to be right.
   */
  unresolved: Map<string, { node: ASTNode; reason: string }>;
  /**
   * What each global's creation reads (upper-case), through code or in its
   * initial value: no address taken. A PROGRAM whose instance it uses is
   * there as its programKey, with that instance's own needs in
   * `dependencies`.
   */
  reads: Map<string, string[]>;
}

/** Every global of a unit as one graph: a CONFIGURATION's are marked. */
export interface AllGlobalsOrder extends GlobalOrder {
  /** The CONFIGURATION declaring each of its globals (upper-case keys). */
  configurationOf: Map<string, ConfigurationDeclaration>;
}

/** The upper-case names of the globals `decl`'s initial value names. */
function namedGlobals(
  decl: VarDeclaration,
  owner: ReadonlyMap<string, string>,
): string[] {
  const names: string[] = [];
  if (!decl.initialValue) return names;
  walkAST(decl.initialValue, (node) => {
    // `f.M()` calls a method of the global f
    const callee =
      node.kind === "FunctionCallExpression"
        ? (node as FunctionCallExpression).functionName.split(".")
        : [];
    const name =
      node.kind === "VariableExpression"
        ? (node as VariableExpression).name
        : callee.length > 1
          ? callee[0]!
          : undefined;
    if (name === undefined) return;
    const target = owner.get(name.toUpperCase());
    if (target !== undefined && !names.includes(target)) names.push(target);
  });
  return names;
}

/** The file-level globals, each after the globals its initial value names. */
export function orderGlobals(ast: CompilationUnit): GlobalOrder {
  return orderGlobalBlocks(ast.globalVarBlocks);
}

/**
 * The file-level globals and those of every CONFIGURATION (and RESOURCE) as
 * one graph, each after the globals its initial value names and those the
 * code its creation runs reads, through the POUs of `ast`. A CONFIGURATION
 * global named like a file-level one (an error of its own), or like one of
 * an earlier CONFIGURATION (the same storage), is left out.
 */
export function orderAllGlobals(ast: CompilationUnit): AllGlobalsOrder {
  const taken = new Set<string>();
  const configurationOf = new Map<string, ConfigurationDeclaration>();
  for (const block of ast.globalVarBlocks) {
    for (const decl of block.declarations) {
      for (const name of decl.names) taken.add(name.toUpperCase());
    }
  }
  const blocks: VarBlock[] = [...ast.globalVarBlocks];
  for (const config of ast.configurations) {
    for (const block of configurationBlocks(config)) {
      const declarations = block.declarations.filter((d) =>
        d.names.every((n) => !taken.has(n.toUpperCase())),
      );
      for (const decl of declarations) {
        for (const name of decl.names) {
          taken.add(name.toUpperCase());
          configurationOf.set(name.toUpperCase(), config);
        }
      }
      blocks.push({ ...block, declarations });
    }
  }
  return { ...orderGlobalBlocks(blocks, ast), configurationOf };
}

/** A CONFIGURATION's VAR_GLOBAL blocks, its RESOURCEs' included. */
function configurationBlocks(config: ConfigurationDeclaration): VarBlock[] {
  return config.varBlocks.filter((b) => b.blockType === "VAR_GLOBAL");
}

/**
 * The VAR_GLOBALs of one CONFIGURATION, its RESOURCEs' included, each after
 * the globals of the configuration its initial value names.
 */
export function orderConfigurationGlobals(
  config: ConfigurationDeclaration,
): GlobalOrder {
  return orderGlobalBlocks(configurationBlocks(config));
}

/** `blocks`' globals, each after the globals of `blocks` its initial value names. */
export function orderGlobalBlocks(
  blocks: readonly VarBlock[],
  /** The unit whose POUs the initial values' calls are followed into. */
  pous?: CompilationUnit,
): GlobalOrder {
  const items: GlobalItem[] = [];
  // Every name a global is reached by (its own, its list aliases) → the global.
  const owner = new Map<string, string>();
  for (const block of blocks) {
    for (const decl of block.declarations) {
      for (const name of decl.names) {
        items.push({ block, decl, name });
        owner.set(name.toUpperCase(), name.toUpperCase());
        for (const alias of decl.listAliases ?? []) {
          if (alias.name === name) {
            owner.set(alias.alias.toUpperCase(), name.toUpperCase());
          }
        }
      }
    }
  }
  const byName = new Map(items.map((i) => [i.name.toUpperCase(), i]));
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const item of items) {
    const upper = item.name.toUpperCase();
    if (seen.has(upper) && item.block.globalListName === undefined) {
      duplicates.add(upper);
    }
    seen.add(upper);
  }
  for (const item of items) {
    const upper = item.name.toUpperCase();
    if (item.block.globalListName === undefined && byName.get(upper) !== item) {
      duplicates.add(upper);
    }
  }
  const tracer =
    pous === undefined
      ? undefined
      : new CallReadTracer(
          pous,
          owner,
          new Map(items.map((i) => [i.name.toUpperCase(), i.decl])),
        );
  const dependencies = new Map<string, string[]>();
  const readsOf = new Map<string, string[]>();
  const unresolved = new Map<string, { node: ASTNode; reason: string }>();
  const programs = new Set<string>();
  const writesOf = new Map<string, ReadonlySet<string>>();
  for (const item of items) {
    const self = item.name.toUpperCase();
    const named = namedGlobals(item.decl, owner).filter((n) => n !== self);
    if (tracer !== undefined) {
      // Code reading the global itself while creating it is a cycle
      const reads = tracer.globalReads(item.decl, self);
      readsOf.set(self, [...reads.globals]);
      writesOf.set(self, reads.writes ?? new Set());
      for (const g of reads.globals) {
        if (g.startsWith("PROGRAM ")) programs.add(g);
        if (!named.includes(g)) named.push(g);
      }
      if (reads.unresolved) unresolved.set(self, reads.unresolved);
    }
    dependencies.set(self, named);
  }
  // Code a global's creation runs storing into a global another, declared
  // later, reads: the declaration order is kept between the two
  if (tracer !== undefined) {
    items.forEach((later, i) => {
      const self = later.name.toUpperCase();
      const reads = new Set(readsOf.get(self) ?? []);
      const deps = dependencies.get(self)!;
      for (const earlier of items.slice(0, i)) {
        const name = earlier.name.toUpperCase();
        if (name === self || deps.includes(name)) continue;
        if ([...(writesOf.get(name) ?? [])].some((g) => reads.has(g))) {
          deps.push(name);
        }
      }
    });
  }
  // A PROGRAM instance a global's creation uses is created after what it
  // needs; it is created after every global that does not use one, so it
  // cannot need one that does (or another PROGRAM instance).
  for (const key of programs) {
    dependencies.set(key, [
      ...tracer!.programReads(key.slice("PROGRAM ".length)).globals,
    ]);
  }
  const usesProgram = new Map<string, boolean>();
  const uses = (name: string): boolean => {
    if (name.startsWith("PROGRAM ")) return true;
    const known = usesProgram.get(name);
    if (known !== undefined) return known;
    usesProgram.set(name, false);
    const result = (dependencies.get(name) ?? []).some(uses);
    usesProgram.set(name, result);
    return result;
  };
  const unplaceable = new Set(
    [...programs].filter((key) => (dependencies.get(key) ?? []).some(uses)),
  );
  for (const item of items) {
    const self = item.name.toUpperCase();
    const key = (readsOf.get(self) ?? []).find((g) => unplaceable.has(g));
    if (key === undefined || unresolved.has(self)) continue;
    unresolved.set(self, {
      node: item.decl.initialValue ?? item.decl,
      // The reason names the PROGRAM (type-checker.ts words the error)
      reason: key,
    });
  }

  const order: GlobalItem[] = [];
  const cycles: string[][] = [];
  const done = new Set<string>();
  const path: string[] = [];
  const visit = (name: string): void => {
    if (done.has(name)) return;
    const at = path.indexOf(name);
    if (at >= 0) {
      cycles.push(path.slice(at));
      return;
    }
    path.push(name);
    for (const dep of dependencies.get(name) ?? []) visit(dep);
    path.pop();
    if (done.has(name)) return;
    done.add(name);
    const item = byName.get(name);
    if (item) order.push(item);
  };
  for (const item of items) visit(item.name.toUpperCase());
  return {
    order,
    dependencies,
    // A cycle through a PROGRAM instance is reported as that instance
    cycles: cycles.filter((c) => !c.some((n) => unplaceable.has(n))),
    duplicates,
    unresolved,
    reads: readsOf,
  };
}
