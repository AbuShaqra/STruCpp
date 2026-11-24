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
 * kept. A cycle has no order and is reported.
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

export function orderGlobals(ast: CompilationUnit): GlobalOrder {
  return orderGlobalBlocks(ast.globalVarBlocks, ast);
}

/**
 * The VAR_GLOBALs of one CONFIGURATION, its RESOURCEs' included, each after
 * the globals of the configuration its initial value names.
 */
export function orderConfigurationGlobals(
  config: ConfigurationDeclaration,
): GlobalOrder {
  return orderGlobalBlocks(
    config.varBlocks.filter((b) => b.blockType === "VAR_GLOBAL"),
  );
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
  // Dependencies only through an address taken in code the creation runs
  const soft = new Map<string, Set<string>>();
  const unresolved = new Map<string, { node: ASTNode; reason: string }>();
  for (const item of items) {
    const self = item.name.toUpperCase();
    const named = namedGlobals(item.decl, owner).filter((n) => n !== self);
    if (tracer !== undefined) {
      // Code reading the global itself while creating it is a cycle
      const reads = tracer.globalReads(item.decl, self);
      for (const g of reads.globals) {
        if (!named.includes(g)) named.push(g);
      }
      const addressed = [...reads.addresses].filter(
        (g) => g !== self && !named.includes(g),
      );
      named.push(...addressed);
      if (addressed.length > 0) soft.set(self, new Set(addressed));
      if (reads.unresolved) unresolved.set(self, reads.unresolved);
    }
    dependencies.set(self, named);
  }

  const order: GlobalItem[] = [];
  const cycles: string[][] = [];
  const done = new Set<string>();
  const path: string[] = [];
  // Whether the edge into each `path` entry is an address only
  const softPath: boolean[] = [];
  /** Whether `from` reaches a global on `path` through globals not yet ordered. */
  const reachesPath = (from: string): boolean => {
    const seen = new Set<string>([from]);
    const queue = [from];
    for (let i = 0; i < queue.length; i++) {
      const at = queue[i]!;
      if (path.includes(at)) return true;
      for (const next of dependencies.get(at) ?? []) {
        if (!done.has(next) && !seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return false;
  };
  const visit = (name: string, viaAddress: boolean): void => {
    if (done.has(name)) return;
    const at = path.indexOf(name);
    if (at >= 0) {
      // A cycle through an address taken in code is ordered best-effort
      if (!viaAddress && !softPath.slice(at + 1).some(Boolean)) {
        cycles.push(path.slice(at));
      }
      return;
    }
    path.push(name);
    softPath.push(viaAddress);
    const deps = dependencies.get(name) ?? [];
    const addressOnly = soft.get(name);
    for (const dep of deps) {
      if (addressOnly?.has(dep) !== true) visit(dep, false);
    }
    // An address-only dependency orders only when that closes no cycle
    for (const dep of deps) {
      if (addressOnly?.has(dep) === true && !reachesPath(dep)) {
        visit(dep, true);
      }
    }
    path.pop();
    softPath.pop();
    if (done.has(name)) return;
    done.add(name);
    const item = byName.get(name);
    if (item) order.push(item);
  };
  for (const item of items) visit(item.name.toUpperCase(), false);
  return { order, dependencies, cycles, duplicates, unresolved };
}
