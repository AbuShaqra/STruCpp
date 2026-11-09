// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * Lower ACTION blocks to methods of their owner.
 *
 *   PROGRAM MAIN ... ACTION Count: n := n + 1; END_ACTION END_PROGRAM
 *   ACTION MAIN.Count: n := n + 1; END_ACTION
 *     →  METHOD PUBLIC Count  n := n + 1;  END_METHOD   (fromAction: true)
 *
 * Each action becomes a parameterless, value-less PUBLIC METHOD of its
 * PROGRAM or FUNCTION_BLOCK, marked `fromAction`, so scope, calls (`Name()`,
 * `THIS.Name()`, `inst.Name()`), strict checks and code generation treat it
 * as any other method. Compilation calls this once on the merged unit, so a
 * top-level `ACTION Owner.Name` finds an owner declared in another file.
 *
 * An action is not part of the OOP surface: it cannot override or be
 * overridden, and it never implements an INTERFACE method (the analyzer's
 * interface check skips `fromAction` methods).
 */

import type {
  ActionDeclaration,
  CompilationUnit,
  FunctionBlockDeclaration,
  MethodDeclaration,
  ProgramDeclaration,
  VarBlock,
} from "../frontend/ast.js";
import type { CompileError } from "../types.js";

type Owner = ProgramDeclaration | FunctionBlockDeclaration;

function error(
  message: string,
  span: { startLine: number; startCol: number; file?: string },
): CompileError {
  return {
    message,
    line: span.startLine,
    column: span.startCol,
    severity: "error",
    ...(span.file !== undefined ? { file: span.file } : {}),
  };
}

function declaresVariable(blocks: readonly VarBlock[], upper: string): boolean {
  return blocks.some((block) =>
    block.declarations.some((decl) =>
      decl.names.some((n) => n.toUpperCase() === upper),
    ),
  );
}

/** The FUNCTION_BLOCKs `fb` extends, nearest first (stops on a cycle). */
function baseChain(
  fb: FunctionBlockDeclaration,
  fbs: ReadonlyMap<string, FunctionBlockDeclaration>,
): FunctionBlockDeclaration[] {
  const chain: FunctionBlockDeclaration[] = [];
  const seen = new Set<string>([fb.name.toUpperCase()]);
  let next = fb.extends;
  while (next !== undefined) {
    const upper = next.toUpperCase();
    if (seen.has(upper)) break;
    seen.add(upper);
    const base = fbs.get(upper);
    if (!base) break;
    chain.push(base);
    next = base.extends;
  }
  return chain;
}

function lowerOne(
  owner: Owner,
  action: ActionDeclaration,
  errors: CompileError[],
): void {
  const upper = action.name.toUpperCase();
  const existing = owner.methods.find((m) => m.name.toUpperCase() === upper);
  if (existing) {
    errors.push(
      error(
        existing.fromAction === true
          ? `ACTION ${action.name} is defined twice for ${owner.name}`
          : `ACTION ${action.name} has the same name as a METHOD of ${owner.name}`,
        action.sourceSpan,
      ),
    );
    return;
  }
  if (declaresVariable(owner.varBlocks, upper)) {
    errors.push(
      error(
        `ACTION ${action.name} has the same name as a variable of ${owner.name}`,
        action.sourceSpan,
      ),
    );
    return;
  }
  const method: MethodDeclaration = {
    kind: "MethodDeclaration",
    sourceSpan: action.sourceSpan,
    name: action.name,
    visibility: "PUBLIC",
    isAbstract: false,
    isFinal: false,
    isOverride: false,
    varBlocks: [],
    body: action.body,
    fromAction: true,
  };
  owner.methods.push(method);
}

/**
 * Inheritance checks once every action is lowered: a base action is never
 * overridden (by a METHOD or an ACTION), and an action does not take the name
 * of an inherited METHOD or variable.
 */
function checkInheritance(
  unit: CompilationUnit,
  fbs: ReadonlyMap<string, FunctionBlockDeclaration>,
  errors: CompileError[],
): void {
  for (const fb of unit.functionBlocks) {
    const chain = baseChain(fb, fbs);
    if (chain.length === 0) continue;
    for (const method of fb.methods) {
      const upper = method.name.toUpperCase();
      let inherited:
        | { base: FunctionBlockDeclaration; m: MethodDeclaration }
        | undefined;
      for (const base of chain) {
        const m = base.methods.find((x) => x.name.toUpperCase() === upper);
        if (m) {
          inherited = { base, m };
          break;
        }
      }
      if (inherited?.m.fromAction === true) {
        const kind = method.fromAction === true ? "an ACTION" : "a METHOD";
        errors.push(
          error(
            `ACTION ${inherited.m.name} of ${inherited.base.name} cannot be overridden by ${kind} of ${fb.name}`,
            method.sourceSpan,
          ),
        );
      } else if (method.fromAction === true && inherited) {
        errors.push(
          error(
            `ACTION ${method.name} has the same name as a METHOD of ${fb.name}`,
            method.sourceSpan,
          ),
        );
      } else if (
        method.fromAction === true &&
        chain.some((base) => declaresVariable(base.varBlocks, upper))
      ) {
        errors.push(
          error(
            `ACTION ${method.name} has the same name as a variable of ${fb.name}`,
            method.sourceSpan,
          ),
        );
      }
    }
  }
}

/**
 * Append every ACTION of `unit` (in-POU and top-level) to its owner's
 * `methods` as a `fromAction` method. Mutates `unit`. Returns the owner and
 * name errors it found; an action with an error is not lowered.
 */
export function lowerActions(unit: CompilationUnit): CompileError[] {
  const errors: CompileError[] = [];
  const owners = new Map<string, Owner>();
  const fbs = new Map<string, FunctionBlockDeclaration>();
  for (const program of unit.programs) {
    owners.set(program.name.toUpperCase(), program);
  }
  for (const fb of unit.functionBlocks) {
    owners.set(fb.name.toUpperCase(), fb);
    fbs.set(fb.name.toUpperCase(), fb);
  }

  for (const owner of owners.values()) {
    for (const action of owner.actions) lowerOne(owner, action, errors);
  }
  for (const action of unit.actions) {
    const ownerName = action.owner ?? "";
    const owner = owners.get(ownerName.toUpperCase());
    if (!owner) {
      errors.push(
        error(
          `ACTION ${ownerName}.${action.name}: ${ownerName} is not a PROGRAM or FUNCTION_BLOCK of this program`,
          action.sourceSpan,
        ),
      );
      continue;
    }
    lowerOne(owner, action, errors);
  }

  checkInheritance(unit, fbs, errors);
  return errors;
}
