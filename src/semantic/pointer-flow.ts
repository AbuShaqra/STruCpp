// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * Which globals a pointer may point to, for ordering the creation of globals.
 *
 * Taking an address (`ADR(g)`, `REF(g)`, `r REF= g`) reads nothing; a
 * dereference (`p^`, the use of a REFERENCE TO) reads what `p` points to. A
 * pointer variable (a global, a function block member, a local, a method's,
 * function's or getter's result) is a cell; every assignment to it in the
 * code that can run while globals are created (FUNCTIONs, function blocks
 * with their methods and accessors, initial values) adds the addresses it
 * stores or the cells it copies. Flow-insensitive: the union over all of
 * them. A cell whose value cannot be followed (an input or in/out, a library
 * call, arithmetic on no known pointer, a pointer whose own address is
 * taken) may point to any global whose address is taken anywhere. PROGRAMs
 * run after every global exists, so their assignments are not counted.
 */

import type {
  ASTNode,
  AssignmentStatement,
  CompilationUnit,
  Expression,
  FunctionBlockDeclaration,
  FunctionCallExpression,
  FunctionDeclaration,
  MethodCallExpression,
  MethodDeclaration,
  RefAssignStatement,
  RefExpression,
  TypeReference,
  VarBlock,
  VarDeclaration,
  VariableExpression,
} from "../frontend/ast.js";
import { walkAST } from "../ast-utils.js";

/** Where a name of a body is looked up. */
export interface PointerScope {
  /** The body's key, naming its locals' cells (`FN:F`, `FB.M`, `get:FB.P`). */
  pou?: string;
  /** The function block whose members are in scope. */
  fb?: FunctionBlockDeclaration;
  /** The blocks of the method, function or accessor itself. */
  blocks: readonly VarBlock[];
  /** The method, function or getter name, which holds its result. */
  result?: string;
}

/** A cell that may point anywhere: its value cannot be followed. */
const ANY = "?";

export class PointerFlow {
  private readonly fbs = new Map<string, FunctionBlockDeclaration>();
  private readonly aliases = new Map<string, TypeReference>();
  /** Globals whose address is taken anywhere (upper-case). */
  private readonly addressed = new Set<string>();
  /** Addresses each cell stores directly. */
  private readonly direct = new Map<string, Set<string>>();
  /** Cells each cell copies from. */
  private readonly copies = new Map<string, Set<string>>();
  private readonly unknown = new Set<string>();
  private readonly functions = new Map<string, FunctionDeclaration>();
  /** Each function block's project descendants (upper-case keys). */
  private readonly descendants = new Map<string, FunctionBlockDeclaration[]>();
  /**
   * A pointer store or pointer address the analysis cannot map to a cell was
   * met: every dereference may then reach any address taken.
   */
  private imprecise = false;
  private solved?: Map<string, Set<string> | typeof ANY>;

  constructor(
    ast: CompilationUnit,
    /** Every name a global is reached by → the global (upper-case). */
    private readonly owner: ReadonlyMap<string, string>,
    /** Each global's declaration (upper-case keys). */
    private readonly globals: ReadonlyMap<string, VarDeclaration>,
  ) {
    for (const fb of ast.functionBlocks) {
      this.fbs.set(fb.name.toUpperCase(), fb);
    }
    for (const t of ast.types) {
      if (t.definition.kind === "TypeReference") {
        this.aliases.set(t.name.toUpperCase(), t.definition);
      }
    }
    const scopes: Array<[PointerScope, readonly ASTNode[]]> = [];
    for (const f of ast.functions) {
      const pou = `FN:${f.name}`;
      this.functions.set(f.name.toUpperCase(), f);
      scopes.push([{ pou, blocks: f.varBlocks, result: f.name }, f.body]);
    }
    for (const fb of ast.functionBlocks) {
      scopes.push([{ fb, blocks: [] }, fb.body]);
      for (const m of fb.methods) {
        const pou = `${fb.name}.${m.name}`;
        scopes.push([{ pou, fb, blocks: m.varBlocks, result: m.name }, m.body]);
      }
      for (const p of fb.properties) {
        if (p.getter !== undefined) {
          const pou = `get:${fb.name}.${p.name}`;
          scopes.push([
            { pou, fb, blocks: p.getterVarBlocks ?? [], result: p.name },
            p.getter,
          ]);
        }
        if (p.setter !== undefined) {
          scopes.push([
            {
              pou: `set:${fb.name}.${p.name}`,
              fb,
              blocks: p.setterVarBlocks ?? [],
            },
            p.setter,
          ]);
        }
      }
    }
    for (const fb of ast.functionBlocks) {
      for (const base of this.chain(fb).slice(1)) {
        const key = base.name.toUpperCase();
        this.descendants.set(key, [...(this.descendants.get(key) ?? []), fb]);
      }
    }
    // Initial values: globals', members', locals'
    const global: PointerScope = { blocks: [] };
    for (const block of ast.globalVarBlocks) {
      for (const decl of block.declarations) this.declare(decl, global);
    }
    for (const fb of ast.functionBlocks) {
      for (const block of fb.varBlocks) {
        for (const decl of block.declarations)
          this.declare(decl, { fb, blocks: [] });
      }
    }
    for (const [scope, body] of scopes) {
      for (const block of scope.blocks) {
        for (const decl of block.declarations) this.declare(decl, scope);
      }
      for (const statement of body) this.collect(statement, scope);
    }
    // Every address taken, also in a PROGRAM, may be what an unknown pointer holds
    for (const prog of ast.programs) {
      walkAST(prog, (node) => {
        const operand = addressOperand(node);
        if (operand === undefined) return;
        const g = this.owner.get(baseName(operand));
        if (
          g !== undefined &&
          !prog.varBlocks.some((b) => declares(b, baseName(operand)))
        ) {
          this.addressed.add(g);
        }
      });
    }
  }

  /**
   * The cell a name of a body is, when it is a pointer or reference
   * variable; `ANY` for one whose value cannot be followed.
   */
  cellOf(upper: string, scope: PointerScope): string | undefined {
    if (scope.result?.toUpperCase() === upper && scope.pou !== undefined) {
      return `R:${scope.pou.toUpperCase()}`;
    }
    for (const block of scope.blocks) {
      const decl = block.declarations.find((d) =>
        d.names.some((n) => n.toUpperCase() === upper),
      );
      if (decl === undefined) continue;
      if (!this.isPointer(decl.type)) return undefined;
      if (block.blockType === "VAR_EXTERNAL") return this.globalCell(upper);
      if (block.blockType === "VAR_INPUT" || block.blockType === "VAR_IN_OUT") {
        return ANY;
      }
      return `L:${(scope.pou ?? "").toUpperCase()}.${upper}`;
    }
    for (const fb of scope.fb ? this.chain(scope.fb) : []) {
      for (const block of fb.varBlocks) {
        const decl = block.declarations.find((d) =>
          d.names.some((n) => n.toUpperCase() === upper),
        );
        if (decl === undefined) continue;
        if (!this.isPointer(decl.type)) return undefined;
        if (block.blockType === "VAR_EXTERNAL") return this.globalCell(upper);
        if (
          block.blockType === "VAR_INPUT" ||
          block.blockType === "VAR_IN_OUT"
        ) {
          return ANY;
        }
        return `M:${fb.name.toUpperCase()}.${upper}`;
      }
    }
    return this.globalCell(upper);
  }

  /** The globals `cell` may point to. */
  pointsTo(cell: string): ReadonlySet<string> {
    const solved = this.solve().get(cell);
    if (this.imprecise || cell === ANY || solved === ANY) {
      return this.addressed;
    }
    return solved ?? new Set();
  }

  /** Every global whose address is taken. */
  everyAddressed(): ReadonlySet<string> {
    return this.addressed;
  }

  private globalCell(upper: string): string | undefined {
    const g = this.owner.get(upper);
    const decl = g === undefined ? undefined : this.globals.get(g);
    return decl !== undefined && this.isPointer(decl.type)
      ? `G:${g}`
      : undefined;
  }

  private declare(decl: VarDeclaration, scope: PointerScope): void {
    if (decl.initialValue === undefined) return;
    this.collect(decl.initialValue, scope);
    for (const name of decl.names) {
      const cell = this.cellOf(name.toUpperCase(), scope);
      if (cell !== undefined) this.assign(cell, decl.initialValue, scope);
    }
  }

  private collect(root: ASTNode, scope: PointerScope): void {
    walkAST(root, (node) => {
      const operand = addressOperand(node);
      if (operand !== undefined) {
        this.address(operand, scope);
      } else if (node.kind === "AssignmentStatement") {
        const s = node as AssignmentStatement;
        const cell = this.targetCell(s.target, scope);
        if (cell !== undefined) this.assign(cell, s.value, scope);
        else if (hasPath(s.target) && this.mayBePointer(s.value, scope)) {
          this.imprecise = true;
        }
      } else if (node.kind === "RefAssignStatement") {
        const s = node as RefAssignStatement;
        const cell = this.targetCell(s.target, scope);
        if (cell !== undefined) this.store(cell, s.source, scope);
        else if (hasPath(s.target)) this.imprecise = true;
        this.address(s.source, scope);
      } else if (
        node.kind === "FunctionCallExpression" ||
        node.kind === "MethodCallExpression"
      ) {
        this.bindings(
          node as FunctionCallExpression | MethodCallExpression,
          scope,
        );
      }
    });
  }

  /**
   * A call's arguments that may be written: output captures and in/outs.
   * When the callee's parameters are not known, every argument may be.
   */
  private bindings(
    call: FunctionCallExpression | MethodCallExpression,
    scope: PointerScope,
  ): void {
    const params = this.parameters(call, scope);
    let position = 0;
    for (const arg of call.arguments) {
      let written: boolean;
      if (arg.isOutput) {
        written = true;
      } else if (params === undefined) {
        written = true;
      } else if (arg.name !== undefined) {
        const upper = arg.name.toUpperCase();
        const p = params.find((q) => q.name === upper);
        written = p === undefined || p.inOut;
      } else {
        written = params[position]?.inOut !== false;
      }
      if (!arg.isOutput && arg.name === undefined) position++;
      if (!written || arg.value.kind !== "VariableExpression") continue;
      const v = arg.value;
      if (hasPath(v)) {
        this.imprecise = true;
        continue;
      }
      const cell = this.cellOf(v.name.toUpperCase(), scope);
      if (cell !== undefined && cell !== ANY) this.unknown.add(cell);
    }
  }

  /**
   * The inputs and in/outs of a call's callee, in order, when it is known: a
   * project FUNCTION, a method of the body's own function block, or an
   * instance of a project function block named bare.
   */
  private parameters(
    call: FunctionCallExpression | MethodCallExpression,
    scope: PointerScope,
  ): Array<{ name: string; inOut: boolean }> | undefined {
    if (call.kind !== "FunctionCallExpression" || call.instance !== undefined) {
      return undefined;
    }
    const name = call.functionName.toUpperCase();
    if (name.includes(".")) return undefined;
    const decl = this.declarationOf(name, scope);
    let blocks: readonly VarBlock[] | undefined;
    if (decl !== undefined) {
      const fb = this.instanceType(decl.type);
      blocks =
        fb === undefined
          ? undefined
          : this.chain(fb)
              .reverse()
              .flatMap((f) => f.varBlocks);
    } else if (scope.fb && this.methodsNamed(scope.fb, name).length > 0) {
      const methods = this.methodsNamed(scope.fb, name);
      blocks = methods.length === 1 ? methods[0]!.varBlocks : undefined;
    } else {
      blocks = this.functions.get(name)?.varBlocks;
    }
    if (blocks === undefined) return undefined;
    const out: Array<{ name: string; inOut: boolean }> = [];
    for (const block of blocks) {
      if (block.blockType !== "VAR_INPUT" && block.blockType !== "VAR_IN_OUT") {
        continue;
      }
      for (const d of block.declarations) {
        for (const n of d.names) {
          out.push({
            name: n.toUpperCase(),
            inOut: block.blockType === "VAR_IN_OUT",
          });
        }
      }
    }
    return out;
  }

  /** The cell an assignment target is, when it is a pointer variable itself. */
  private targetCell(
    target: Expression,
    scope: PointerScope,
  ): string | undefined {
    if (target.kind !== "VariableExpression" || hasPath(target)) {
      return undefined;
    }
    return this.cellOf(target.name.toUpperCase(), scope);
  }

  /**
   * `ADR(x)` / `REF(x)`: x's global is addressed. A pointer x may now change
   * through that address; through an access path it may be any pointer.
   */
  private address(operand: Expression, scope: PointerScope): void {
    if (operand.kind !== "VariableExpression") return;
    const v = operand;
    const upper = v.name.toUpperCase();
    const steps = stepsOf(v);
    if (steps.length === 0) {
      const cell = this.cellOf(upper, scope);
      if (cell !== undefined && cell !== ANY) this.unknown.add(cell);
    } else {
      this.imprecise = true;
    }
    if (steps.some((s) => s.kind === "dereference")) return;
    const g = this.globalOf(upper, scope);
    if (g !== undefined) this.addressed.add(g);
  }

  /** Whether `value` may be a pointer: anything but numbers and non-pointer variables. */
  private mayBePointer(value: Expression, scope: PointerScope): boolean {
    let e = value;
    while (e.kind === "ParenthesizedExpression") e = e.expression;
    if (e.kind === "LiteralExpression") return false;
    if (e.kind === "VariableExpression" && !hasPath(e)) {
      return (
        this.declarationOf(e.name.toUpperCase(), scope) === undefined ||
        this.cellOf(e.name.toUpperCase(), scope) !== undefined
      );
    }
    if (e.kind === "BinaryExpression") {
      return (
        this.mayBePointer(e.left, scope) || this.mayBePointer(e.right, scope)
      );
    }
    if (e.kind === "UnaryExpression") {
      return this.mayBePointer(e.operand, scope);
    }
    return true;
  }

  /** The global a name of a body names, unless a local or member hides it. */
  private globalOf(upper: string, scope: PointerScope): string | undefined {
    if (scope.result?.toUpperCase() === upper) return undefined;
    for (const block of [
      ...scope.blocks,
      ...(scope.fb ? this.chain(scope.fb).flatMap((f) => f.varBlocks) : []),
    ]) {
      if (declares(block, upper)) {
        return block.blockType === "VAR_EXTERNAL"
          ? this.owner.get(upper)
          : undefined;
      }
    }
    return this.owner.get(upper);
  }

  /** `cell := value`. */
  private assign(cell: string, value: Expression, scope: PointerScope): void {
    if (cell === ANY) return;
    if (!this.source(cell, value, scope)) this.unknown.add(cell);
  }

  /** `cell REF= operand`: the address of operand. */
  private store(cell: string, operand: Expression, scope: PointerScope): void {
    if (cell === ANY) return;
    if (!this.addressOf(cell, operand, scope)) this.unknown.add(cell);
  }

  /** Record what `value` gives `cell`; false when it cannot be followed. */
  private source(
    cell: string,
    value: Expression,
    scope: PointerScope,
  ): boolean {
    // A number stored as a pointer (other than NULL or 0) points anywhere
    const kind = this.flow(cell, value, scope);
    return kind === "pointer" || kind === "null";
  }

  /**
   * What `value` gives `cell`: a pointer it records (`"pointer"`), a literal
   * (`"null"`: NULL, 0 or an offset), another number (`"number"`, an offset),
   * or `"fail"` when it cannot be followed.
   */
  private flow(
    cell: string,
    value: Expression,
    scope: PointerScope,
  ): "pointer" | "null" | "number" | "fail" {
    let e = value;
    while (e.kind === "ParenthesizedExpression") e = e.expression;
    const operand = addressOperand(e);
    if (operand !== undefined) {
      return this.addressOf(cell, operand, scope) ? "pointer" : "fail";
    }
    if (e.kind === "LiteralExpression") return "null";
    if (e.kind === "BinaryExpression") {
      const b = e;
      if (b.operator !== "+" && b.operator !== "-") return "fail";
      const sides = [b.left, b.right].map((side) =>
        this.flow(cell, side, scope),
      );
      if (sides.includes("fail")) return "fail";
      // Arithmetic on no pointer gives an address nothing tells
      return sides.includes("pointer") ? "pointer" : "fail";
    }
    if (e.kind === "VariableExpression") {
      const v = e;
      const steps = stepsOf(v);
      if (steps.length === 0) {
        const from = this.cellOf(v.name.toUpperCase(), scope);
        if (from === ANY) return "fail";
        if (from === undefined) return "number";
        this.edge(from, cell);
        return "pointer";
      }
      return "fail"; // a field or element: not followed
    }
    if (e.kind === "FunctionCallExpression") {
      return this.fromCall(cell, e, scope) ? "pointer" : "fail";
    }
    return "fail";
  }

  /** The address of `operand` stored into `cell`. */
  private addressOf(
    cell: string,
    operand: Expression,
    scope: PointerScope,
  ): boolean {
    if (operand.kind !== "VariableExpression") return false;
    const v = operand;
    const steps = stepsOf(v);
    const upper = v.name.toUpperCase();
    // ADR(p^...) points where p points
    if (steps[0]?.kind === "dereference") {
      const from = this.cellOf(upper, scope);
      if (from === undefined || from === ANY) return false;
      this.edge(from, cell);
      return true;
    }
    if (steps.some((s) => s.kind === "dereference")) return false;
    const g = this.globalOf(upper, scope);
    if (g !== undefined) {
      this.addressed.add(g);
      const set = this.direct.get(cell) ?? new Set<string>();
      set.add(g);
      this.direct.set(cell, set);
    }
    return true; // a local's or member's address points to no global
  }

  /**
   * A bare call's result: a project FUNCTION's, or a method of the body's own
   * function block (any override of it). Any other call is not followed.
   */
  private fromCall(
    cell: string,
    call: FunctionCallExpression,
    scope: PointerScope,
  ): boolean {
    const name = call.functionName.toUpperCase();
    if (name.includes(".") || call.instance !== undefined) return false;
    if (this.declarationOf(name, scope) !== undefined) return false;
    if (scope.fb) {
      const owners = [
        ...this.chain(scope.fb),
        ...(this.descendants.get(scope.fb.name.toUpperCase()) ?? []),
      ];
      const found = owners.flatMap((fb) =>
        this.methodsNamed(fb, name).map((m) => `R:${fb.name}.${m.name}`),
      );
      if (found.length > 0) {
        for (const r of found) this.edge(r.toUpperCase(), cell);
        return true;
      }
    }
    const f = this.functions.get(name);
    if (f === undefined) return false;
    this.edge(`R:FN:${f.name}`.toUpperCase(), cell);
    return true;
  }

  private methodsNamed(
    fb: FunctionBlockDeclaration,
    upper: string,
  ): MethodDeclaration[] {
    return fb.methods.filter((m) => m.name.toUpperCase() === upper);
  }

  /** The declaration a name of a body is (local, member, VAR_EXTERNAL or global). */
  private declarationOf(
    upper: string,
    scope: PointerScope,
  ): VarDeclaration | undefined {
    for (const block of [
      ...scope.blocks,
      ...(scope.fb ? this.chain(scope.fb).flatMap((f) => f.varBlocks) : []),
    ]) {
      const decl = block.declarations.find((d) =>
        d.names.some((n) => n.toUpperCase() === upper),
      );
      if (decl !== undefined) return decl;
    }
    const g = this.owner.get(upper);
    return g === undefined ? undefined : this.globals.get(g);
  }

  /** The project function block a variable of `type` is an instance of. */
  private instanceType(
    type: TypeReference,
  ): FunctionBlockDeclaration | undefined {
    let current: TypeReference | undefined = type;
    for (let i = 0; i < 64 && current !== undefined; i++) {
      if (
        current.arrayDimensions !== undefined ||
        current.referenceChain !== undefined ||
        (current.referenceKind ?? "none") !== "none"
      ) {
        return undefined;
      }
      const fb = this.fbs.get(current.name.toUpperCase());
      if (fb !== undefined) return fb;
      current = this.aliases.get(current.name.toUpperCase());
    }
    return undefined;
  }

  private edge(from: string, to: string): void {
    const set = this.copies.get(to) ?? new Set<string>();
    set.add(from);
    this.copies.set(to, set);
  }

  /** Every cell's targets, by a worklist over the copy edges. */
  private solve(): Map<string, Set<string> | typeof ANY> {
    if (this.solved) return this.solved;
    const out = new Map<string, Set<string> | typeof ANY>();
    const users = new Map<string, string[]>();
    for (const [to, froms] of this.copies) {
      for (const from of froms) {
        users.set(from, [...(users.get(from) ?? []), to]);
      }
    }
    const cells = new Set([
      ...this.direct.keys(),
      ...this.copies.keys(),
      ...this.unknown,
      ...users.keys(),
    ]);
    for (const cell of cells) {
      out.set(
        cell,
        this.unknown.has(cell) ? ANY : new Set(this.direct.get(cell) ?? []),
      );
    }
    const queue = [...cells];
    const queued = new Set(queue);
    for (let i = 0; i < queue.length; i++) {
      const from = queue[i]!;
      queued.delete(from);
      const value = out.get(from)!;
      for (const to of users.get(from) ?? []) {
        const target = out.get(to)!;
        if (target === ANY) continue;
        let changed = false;
        if (value === ANY) {
          out.set(to, ANY);
          changed = true;
        } else {
          for (const g of value) {
            if (!target.has(g)) {
              target.add(g);
              changed = true;
            }
          }
        }
        if (changed && !queued.has(to)) {
          queued.add(to);
          queue.push(to);
        }
      }
    }
    this.solved = out;
    return out;
  }

  private isPointer(type: TypeReference): boolean {
    let current: TypeReference | undefined = type;
    for (let i = 0; i < 64 && current !== undefined; i++) {
      if (current.arrayDimensions !== undefined) return false;
      if (
        current.referenceChain !== undefined ||
        (current.referenceKind ?? "none") !== "none"
      ) {
        return true;
      }
      current = this.aliases.get(current.name.toUpperCase());
    }
    return false;
  }

  private chain(fb: FunctionBlockDeclaration): FunctionBlockDeclaration[] {
    const out: FunctionBlockDeclaration[] = [];
    let current: FunctionBlockDeclaration | undefined = fb;
    while (current && !out.includes(current)) {
      out.push(current);
      current = this.fbs.get((current.extends ?? "").toUpperCase());
    }
    return out;
  }
}

/** The operand of `ADR(x)`, `REF(x)` or a REF expression. */
function addressOperand(node: ASTNode): Expression | undefined {
  if (node.kind === "RefExpression") return (node as RefExpression).operand;
  if (node.kind !== "FunctionCallExpression") return undefined;
  const call = node as FunctionCallExpression;
  const upper = call.functionName.toUpperCase();
  return (upper === "ADR" || upper === "REF") && call.arguments.length === 1
    ? call.arguments[0]!.value
    : undefined;
}

function baseName(e: Expression): string {
  return e.kind === "VariableExpression" ? e.name.toUpperCase() : "";
}

function declares(block: VarBlock, upper: string): boolean {
  return block.declarations.some((d) =>
    d.names.some((n) => n.toUpperCase() === upper),
  );
}

/** An access with a path: a field, an element or a dereference. */
function hasPath(e: Expression): boolean {
  return e.kind === "VariableExpression" && stepsOf(e).length > 0;
}

/** A variable access's steps, in source order. */
export function stepsOf(
  v: VariableExpression,
): Array<
  | { kind: "field"; name: string }
  | { kind: "subscript" }
  | { kind: "dereference" }
> {
  if (v.accessChain !== undefined) return v.accessChain;
  return [
    ...(v.isDereference ? [{ kind: "dereference" as const }] : []),
    ...(v.subscripts.length > 0 ? [{ kind: "subscript" as const }] : []),
    ...v.fieldAccess.map((name) => ({ kind: "field" as const, name })),
  ];
}
