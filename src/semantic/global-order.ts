// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * The order in which the file-level VAR_GLOBALs are created.
 *
 * A global's initial value may name another global, as a value or as the
 * target of ADR(), wherever that one is declared: later in the same file or
 * in another global variable list. A global is therefore created after the
 * globals its initial value names. Without such a dependency the declaration
 * order is kept. A cycle has no order and is reported.
 */

import type {
  CompilationUnit,
  ConfigurationDeclaration,
  VarBlock,
  VarDeclaration,
  VariableExpression,
} from "../frontend/ast.js";
import { walkAST } from "../ast-utils.js";

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
}

/** The upper-case names of the globals `decl`'s initial value names. */
function namedGlobals(
  decl: VarDeclaration,
  owner: ReadonlyMap<string, string>,
): string[] {
  const names: string[] = [];
  if (!decl.initialValue) return names;
  walkAST(decl.initialValue, (node) => {
    if (node.kind !== "VariableExpression") return;
    const target = owner.get((node as VariableExpression).name.toUpperCase());
    if (target !== undefined && !names.includes(target)) names.push(target);
  });
  return names;
}

export function orderGlobals(ast: CompilationUnit): GlobalOrder {
  return orderGlobalBlocks(ast.globalVarBlocks);
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
export function orderGlobalBlocks(blocks: readonly VarBlock[]): GlobalOrder {
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
  const dependencies = new Map<string, string[]>();
  for (const item of items) {
    const self = item.name.toUpperCase();
    dependencies.set(
      self,
      namedGlobals(item.decl, owner).filter((n) => n !== self),
    );
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
  return { order, dependencies, cycles };
}
