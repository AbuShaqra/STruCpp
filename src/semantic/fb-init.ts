// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * FB_init (feature fb_init): a METHOD named FB_init on a FUNCTION_BLOCK runs
 * once per instance at start-up, and an instance declaration may pass it
 * init arguments: `fb : FB_A(p := 1);`.
 *
 * Every FB_init of an instance's EXTENDS chain runs, base first. Its inputs
 * are the implicit BOOL flags `bInitRetains` and `bInCopyCode` (always FALSE)
 * plus the VAR_INPUTs it declares, which the init arguments set by name. This
 * module holds the rules: the feature refusal and the warning with the
 * feature off, FB_init's signature, the init arguments, and what code
 * generation cannot do yet (refused by compile only).
 */

import type {
  AssignmentStatement,
  CompilationUnit,
  FunctionBlockDeclaration,
  FunctionCallExpression,
  MethodDeclaration,
  TypeReference,
  VarBlock,
  VarDeclaration,
} from "../frontend/ast.js";
import { walkAST } from "../ast-utils.js";
import type { SourceSpan } from "../types.js";
import { Scope, type SymbolTables } from "./symbol-table.js";

/** Upper-case name of the start-up method. */
export const FB_INIT = "FB_INIT";

/** The implicit flags, in parameter order; both are always FALSE. */
export const FB_INIT_FLAGS = ["BINITRETAINS", "BINCOPYCODE"] as const;

/** Reports one diagnostic at `span`. */
export type FbInitReporter = (message: string, span: SourceSpan) => void;

/** Var blocks whose FB instances are members of their PROGRAM or FUNCTION_BLOCK. */
export const INSTANCE_BLOCKS: ReadonlySet<string> = new Set([
  "VAR",
  "VAR_INPUT",
  "VAR_OUTPUT",
]);

/** The FB_init a FUNCTION_BLOCK declares itself. */
export function ownFbInit(
  fb: FunctionBlockDeclaration,
): MethodDeclaration | undefined {
  return fb.methods.find((m) => m.name.toUpperCase() === FB_INIT);
}

/** The FUNCTION_BLOCKs of the unit by upper-case name (first declaration wins). */
export function fbIndex(
  ast: CompilationUnit,
): Map<string, FunctionBlockDeclaration> {
  const map = new Map<string, FunctionBlockDeclaration>();
  for (const fb of ast.functionBlocks) {
    const upper = fb.name.toUpperCase();
    if (!map.has(upper)) map.set(upper, fb);
  }
  return map;
}

/** `name` and its EXTENDS bases in the unit, base first; empty when not an FB of the unit. */
export function fbChain(
  fbs: Map<string, FunctionBlockDeclaration>,
  name: string,
): FunctionBlockDeclaration[] {
  const chain: FunctionBlockDeclaration[] = [];
  const seen = new Set<string>();
  let current: string | undefined = name.toUpperCase();
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    const fb = fbs.get(current);
    if (!fb) break;
    chain.unshift(fb);
    current = fb.extends?.toUpperCase();
  }
  return chain;
}

/** The FB_init methods of `name`'s chain, base first, each with its owner. */
export function fbInitChain(
  fbs: Map<string, FunctionBlockDeclaration>,
  name: string,
): { fb: FunctionBlockDeclaration; method: MethodDeclaration }[] {
  const result: { fb: FunctionBlockDeclaration; method: MethodDeclaration }[] =
    [];
  for (const fb of fbChain(fbs, name)) {
    const method = ownFbInit(fb);
    if (method) result.push({ fb, method });
  }
  return result;
}

/** The VAR_INPUT declaration of `method` that declares `upperName`. */
export function fbInitInput(
  method: MethodDeclaration,
  upperName: string,
): VarDeclaration | undefined {
  for (const block of method.varBlocks) {
    if (block.blockType !== "VAR_INPUT") continue;
    for (const decl of block.declarations) {
      if (decl.names.some((n) => n.toUpperCase() === upperName)) return decl;
    }
  }
  return undefined;
}

/**
 * The FB_init inputs of `name`'s chain, base first, one single-name
 * declaration per name (the first level that declares it), without the flags.
 * A member's init arguments may name them (see {@link fbInitArgumentScope}).
 */
export function fbInitInputs(
  fbs: Map<string, FunctionBlockDeclaration>,
  name: string,
): VarDeclaration[] {
  const out: VarDeclaration[] = [];
  const seen = new Set<string>();
  for (const { method } of fbInitChain(fbs, name)) {
    for (const block of method.varBlocks) {
      if (block.blockType !== "VAR_INPUT") continue;
      for (const decl of block.declarations) {
        for (const n of decl.names) {
          const upper = n.toUpperCase();
          if (seen.has(upper)) continue;
          if ((FB_INIT_FLAGS as readonly string[]).includes(upper)) continue;
          seen.add(upper);
          const single: VarDeclaration = { ...decl, names: [n] };
          delete single.nameSpans;
          out.push(single);
        }
      }
    }
  }
  return out;
}

/**
 * The scope a member's init arguments resolve in: the holder FB's scope with
 * its FB_init inputs ({@link fbInitInputs}) in front, so an input shadows a
 * member or global of the same name, as it does in the FB_init body.
 */
export function fbInitArgumentScope(
  symbolTables: SymbolTables,
  fbs: Map<string, FunctionBlockDeclaration>,
  fb: FunctionBlockDeclaration,
  fbScope: Scope,
): Scope {
  const inputs = fbInitInputs(fbs, fb.name);
  if (inputs.length === 0) return fbScope;
  const scope = new Scope(`${fb.name}.FB_init inputs`, fbScope);
  for (const { fb: owner } of fbInitChain(fbs, fb.name)) {
    const methodScope = symbolTables.getMethodScope(owner.name, FB_INIT);
    for (const input of inputs) {
      const name = input.names[0] ?? "";
      if (scope.lookupLocal(name)) continue;
      const symbol = methodScope?.lookupLocal(name);
      if (symbol) scope.define(symbol);
    }
  }
  return scope;
}

/** Upper-case names of the variables an FB_init of `name`'s chain assigns directly (`x := ...`). */
export function fbInitAssignedNames(
  fbs: Map<string, FunctionBlockDeclaration>,
  name: string,
): Set<string> {
  const names = new Set<string>();
  for (const { method } of fbInitChain(fbs, name)) {
    for (const stmt of method.body) {
      walkAST(stmt, (node) => {
        if (node.kind !== "AssignmentStatement") return;
        const target = (node as AssignmentStatement).target;
        if (target.kind === "VariableExpression") {
          names.add(target.name.toUpperCase());
        }
      });
    }
  }
  return names;
}

/** What an instance declaration stores: the stored type name and its array rank (0 = no array). */
export interface StoredInstance {
  name: string;
  dims: number;
}

/**
 * The type a declaration stores by value, looking through inline arrays and
 * array TYPEs of the unit; undefined for a pointer or reference.
 */
export function storedInstance(
  ast: CompilationUnit,
  ref: TypeReference,
): StoredInstance | undefined {
  if ((ref.referenceKind ?? "none") !== "none") return undefined;
  let dims = 0;
  let name = ref.name;
  if (ref.arrayDimensions) {
    if ((ref.elementReferenceChain ?? []).length > 0) return undefined;
    dims = ref.arrayDimensions.length;
    name = ref.elementTypeName ?? ref.name;
  }
  const seen = new Set<string>();
  for (;;) {
    const upper = name.toUpperCase();
    if (seen.has(upper)) break;
    seen.add(upper);
    const def = ast.types.find(
      (t) => t.name.toUpperCase() === upper,
    )?.definition;
    if (def?.kind !== "ArrayDefinition") break;
    const element = def.elementType;
    if ((element.referenceKind ?? "none") !== "none") return undefined;
    dims += def.dimensions.length;
    name = element.elementTypeName ?? element.name;
    dims += element.arrayDimensions?.length ?? 0;
  }
  return { name, dims };
}

/** Every VAR block of the unit with the place it belongs to. */
interface PlacedBlock {
  block: VarBlock;
  /** Text after "it is local to", or undefined for global, PROGRAM and FB blocks. */
  localTo?: string;
}

function placedBlocks(ast: CompilationUnit): PlacedBlock[] {
  const out: PlacedBlock[] = [];
  for (const block of ast.globalVarBlocks) out.push({ block });
  for (const config of ast.configurations) {
    for (const block of config.varBlocks) out.push({ block });
  }
  for (const pou of [...ast.programs, ...ast.functionBlocks]) {
    for (const block of pou.varBlocks) out.push({ block });
    for (const method of pou.methods) {
      for (const block of method.varBlocks) {
        out.push({ block, localTo: `METHOD '${method.name}'` });
      }
    }
  }
  for (const func of ast.functions) {
    for (const block of func.varBlocks) {
      out.push({ block, localTo: `FUNCTION '${func.name}'` });
    }
  }
  return out;
}

/** Every declaration with init arguments, STRUCT fields included. */
function declarationsWithArguments(ast: CompilationUnit): VarDeclaration[] {
  const out: VarDeclaration[] = [];
  for (const { block } of placedBlocks(ast)) {
    for (const decl of block.declarations) {
      if (decl.fbInitArguments) out.push(decl);
    }
  }
  for (const t of ast.types) {
    if (t.definition.kind !== "StructDefinition") continue;
    for (const field of t.definition.fields) {
      if (field.fbInitArguments) out.push(field);
    }
  }
  return out;
}

/** Diagnostics callbacks of {@link prepareFbInit}. */
export interface FbInitPrepareReport {
  error: FbInitReporter;
  warning: FbInitReporter;
  /** Refuse `construct` because the feature is off (adds the profiles hint). */
  needFeature: (construct: string, span: SourceSpan) => void;
}

function boolType(span: SourceSpan): TypeReference {
  return {
    kind: "TypeReference",
    sourceSpan: span,
    name: "BOOL",
    isReference: false,
    referenceKind: "none",
  };
}

/**
 * Runs before the symbol tables. Feature off: refuse each init argument list
 * and warn at each FB_init. Feature on: check each FB_init's signature and
 * declare the flags it leaves out, as BOOL VAR_INPUTs before its own.
 */
export function prepareFbInit(
  ast: CompilationUnit,
  enabled: boolean,
  report: FbInitPrepareReport,
): void {
  for (const decl of declarationsWithArguments(ast)) {
    if (!enabled) {
      report.needFeature(
        `The init argument list of '${decl.names[0] ?? ""}'`,
        decl.fbInitSpan ?? decl.sourceSpan,
      );
    }
  }
  for (const fb of ast.functionBlocks) {
    const method = ownFbInit(fb);
    if (!method) continue;
    if (!enabled) {
      report.warning(
        "FB_init is not run unless the feature fb_init is on",
        method.nameSpan ?? method.sourceSpan,
      );
      continue;
    }
    checkSignature(method, report.error);
    const missing = FB_INIT_FLAGS.filter((flag) =>
      method.varBlocks.every((b) =>
        b.declarations.every(
          (d) => !d.names.some((n) => n.toUpperCase() === flag),
        ),
      ),
    );
    if (missing.length === 0) continue;
    const span = method.nameSpan ?? method.sourceSpan;
    method.varBlocks.unshift({
      kind: "VarBlock",
      sourceSpan: span,
      blockType: "VAR_INPUT",
      isConstant: false,
      isRetain: false,
      isNonRetain: false,
      declarations: missing.map((flag) => ({
        kind: "VarDeclaration",
        sourceSpan: span,
        names: [flag],
        type: boolType(span),
      })),
    });
  }
}

/** FB_init returns BOOL or nothing, declares no VAR_OUTPUT or VAR_IN_OUT, and its flags are BOOL VAR_INPUTs. */
function checkSignature(
  method: MethodDeclaration,
  error: FbInitReporter,
): void {
  const ret = method.returnType;
  if (ret && ret.name.toUpperCase() !== "BOOL") {
    error(
      `FB_init must return BOOL or nothing, not ${ret.name}`,
      ret.sourceSpan,
    );
  }
  for (const block of method.varBlocks) {
    if (block.blockType === "VAR_OUTPUT" || block.blockType === "VAR_IN_OUT") {
      error(
        `FB_init cannot declare ${block.blockType}: nothing is passed to it or read from it at start-up`,
        block.sourceSpan,
      );
    }
    for (const decl of block.declarations) {
      for (const name of decl.names) {
        const upper = name.toUpperCase();
        if (!(FB_INIT_FLAGS as readonly string[]).includes(upper)) continue;
        const ok =
          block.blockType === "VAR_INPUT" &&
          decl.type.name.toUpperCase() === "BOOL" &&
          (decl.type.referenceKind ?? "none") === "none" &&
          !decl.type.arrayDimensions;
        if (!ok) {
          error(
            `'${upper}' of FB_init must be a BOOL VAR_INPUT`,
            decl.sourceSpan,
          );
        }
      }
    }
  }
}

/**
 * Feature on, after the symbol tables: where init arguments may stand and
 * what they name. `isLibraryFB` tells an FB from a library (its FB_init is
 * not known, so its arguments are left to compile). Type mismatches are the
 * type checker's.
 */
export function validateFbInitArguments(
  ast: CompilationUnit,
  isLibraryFB: (upperName: string) => boolean,
  error: FbInitReporter,
): void {
  const fbs = fbIndex(ast);
  const check = (decl: VarDeclaration, blockType: string | undefined): void => {
    const args = decl.fbInitArguments;
    if (!args) return;
    const at = decl.fbInitSpan ?? decl.sourceSpan;
    if (blockType === "VAR_IN_OUT" || blockType === "VAR_EXTERNAL") {
      error(`Init arguments are not allowed in ${blockType}`, at);
      return;
    }
    const stored = storedInstance(ast, decl.type);
    const upper = stored?.name.toUpperCase();
    if (upper !== undefined && !fbs.has(upper) && isLibraryFB(upper)) return;
    if (upper === undefined || !fbs.has(upper)) {
      error(
        `Init arguments need a FUNCTION_BLOCK instance, but '${decl.names[0] ?? ""}' is of type '${stored?.name ?? decl.type.name}'`,
        at,
      );
      return;
    }
    const inits = fbInitChain(fbs, upper);
    if (inits.length === 0) {
      error(
        `'${fbs.get(upper)!.name}' has no FB_init method to take init arguments`,
        at,
      );
      return;
    }
    const seen = new Set<string>();
    for (const arg of args) {
      if (arg.name === undefined) {
        error(
          "Init arguments must be named: write 'input := value'",
          arg.sourceSpan,
        );
        continue;
      }
      const name = arg.name.toUpperCase();
      if (arg.isOutput) {
        error(
          `Init argument '${name}' must use ':=': init arguments set FB_init inputs`,
          arg.sourceSpan,
        );
        continue;
      }
      if ((FB_INIT_FLAGS as readonly string[]).includes(name)) {
        error(
          `'${name}' is set by the compiler and cannot be an init argument`,
          arg.sourceSpan,
        );
        continue;
      }
      if (seen.has(name)) {
        error(`Duplicate init argument '${name}'`, arg.sourceSpan);
        continue;
      }
      seen.add(name);
      if (!inits.some((i) => fbInitInput(i.method, name))) {
        error(
          `'${fbs.get(upper)!.name}' has no FB_init input '${name}'`,
          arg.sourceSpan,
        );
      }
    }
  };
  for (const { block } of placedBlocks(ast)) {
    for (const decl of block.declarations) check(decl, block.blockType);
  }
  for (const t of ast.types) {
    if (t.definition.kind !== "StructDefinition") continue;
    for (const field of t.definition.fields) check(field, undefined);
  }
}

/**
 * Decides which FB types need start-up work: an FB of the unit needs it when
 * its chain has an FB_init or it holds such an instance as a member.
 */
export class FbInitPlan {
  readonly fbs: Map<string, FunctionBlockDeclaration>;
  private readonly memo = new Map<string, boolean>();

  constructor(readonly ast: CompilationUnit) {
    this.fbs = fbIndex(ast);
  }

  /** True when an instance of FB `name` (of this unit) has FB_init work. */
  needs(name: string): boolean {
    const upper = name.toUpperCase();
    const known = this.memo.get(upper);
    if (known !== undefined) return known;
    this.memo.set(upper, false);
    let result = fbInitChain(this.fbs, upper).length > 0;
    if (!result) {
      result = fbChain(this.fbs, upper).some((fb) =>
        this.memberDeclarations(fb).some((d) => {
          const s = storedInstance(this.ast, d.type);
          return s !== undefined && this.needs(s.name);
        }),
      );
    }
    this.memo.set(upper, result);
    return result;
  }

  /** True when an FB of the unit's own member list holds an instance that needs work. */
  needsMembers(fb: FunctionBlockDeclaration): boolean {
    return this.memberDeclarations(fb).some((d) => {
      const s = storedInstance(this.ast, d.type);
      return s !== undefined && this.needs(s.name);
    });
  }

  /** The declarations of `fb` (not its bases) that are instance members. */
  memberDeclarations(fb: FunctionBlockDeclaration): VarDeclaration[] {
    return fb.varBlocks
      .filter((b) => INSTANCE_BLOCKS.has(b.blockType))
      .flatMap((b) => b.declarations);
  }

  /** STRUCT `name` of the unit that holds, through fields or arrays, an instance that needs work. */
  structHolding(name: string, seen = new Set<string>()): boolean {
    const upper = name.toUpperCase();
    if (seen.has(upper)) return false;
    seen.add(upper);
    const def = this.ast.types.find(
      (t) => t.name.toUpperCase() === upper,
    )?.definition;
    if (def?.kind !== "StructDefinition") return false;
    return def.fields.some((f) => {
      if (f.fbInitArguments) return true;
      const s = storedInstance(this.ast, f.type);
      return (
        s !== undefined &&
        (this.needs(s.name) || this.structHolding(s.name, seen))
      );
    });
  }
}

/**
 * What compile cannot do yet although analysis accepts it (feature on): an
 * instance with FB_init work local to a FUNCTION or METHOD, in VAR_TEMP, held
 * in a STRUCT, or of a library FB with init arguments; and an explicit SUPER.FB_init call in an FB_init.
 */
export function fbInitLoweringErrors(
  ast: CompilationUnit,
  isLibraryFB: (upperName: string) => boolean,
  report: FbInitReporter,
): void {
  const plan = new FbInitPlan(ast);
  const refuse = (decl: VarDeclaration, why: string): void => {
    report(
      `FB_init of '${decl.names[0] ?? ""}' is not supported yet: ${why}`,
      decl.sourceSpan,
    );
  };
  for (const { block, localTo } of placedBlocks(ast)) {
    if (
      block.blockType === "VAR_IN_OUT" ||
      block.blockType === "VAR_EXTERNAL"
    ) {
      continue;
    }
    for (const decl of block.declarations) {
      const stored = storedInstance(ast, decl.type);
      if (!stored) continue;
      const upper = stored.name.toUpperCase();
      const ownFB = plan.fbs.has(upper);
      if (!ownFB && decl.fbInitArguments && isLibraryFB(upper)) {
        refuse(decl, `'${stored.name}' comes from a library`);
        continue;
      }
      const needs = ownFB && plan.needs(upper);
      if (plan.structHolding(upper)) {
        refuse(decl, `it is held in STRUCT '${stored.name}'`);
        continue;
      }
      if (!needs) continue;
      if (localTo !== undefined) {
        if (block.blockType !== "VAR_INPUT") {
          refuse(decl, `it is local to ${localTo}`);
        }
        continue;
      }
      if (block.blockType === "VAR_TEMP") {
        refuse(decl, "it is in VAR_TEMP");
      }
    }
  }
  for (const t of ast.types) {
    if (t.definition.kind !== "StructDefinition") continue;
    for (const field of t.definition.fields) {
      if (field.fbInitArguments)
        refuse(field, `it is a field of STRUCT '${t.name}'`);
    }
  }
  for (const fb of ast.functionBlocks) {
    const method = ownFbInit(fb);
    if (!method) continue;
    for (const stmt of method.body) {
      walkAST(stmt, (node) => {
        if (node.kind !== "FunctionCallExpression") return;
        const call = node as FunctionCallExpression;
        if (call.functionName.toUpperCase() !== `SUPER.${FB_INIT}`) return;
        report(
          "FB_init of the base runs automatically; remove the explicit call SUPER.FB_init",
          call.sourceSpan,
        );
      });
    }
  }
}
