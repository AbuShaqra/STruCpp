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
 * with their methods and accessors, initial values, and the PROGRAMs that
 * code names, creationPrograms) adds the addresses it stores or the cells it
 * copies. Flow-insensitive: the union over all of them. A cell whose value
 * cannot be followed (an input or in/out, a library call, arithmetic on no
 * known pointer, a pointer whose own address is taken) may point to any
 * global whose address is taken anywhere. A PROGRAM no such code names runs
 * after every global exists, so its assignments are not counted.
 *
 * An access with a path (`fb.p`, `THIS^.p`, `arr[i].p`, `ps^.p`) is followed
 * through its types: a pointer member of a function block is that member's
 * cell (one per declaring type, shared by every instance); a STRUCT field or
 * an array element is no cell, and a value read from it may point anywhere.
 * Taking the address of a place makes the pointer members of the function
 * blocks held there point anywhere (raw access, MEMCPY). Only a store whose
 * place cannot be told (one a dereference ends at, a library type) makes
 * every dereference read every address.
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
  ProgramDeclaration,
  RefAssignStatement,
  RefExpression,
  StructDefinition,
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
/** A place that is no cell: a STRUCT field, an array element, a non-pointer. */
const NONE = "-";

/** A type as far as access paths need it: an array, or a name behind references. */
type PathType =
  | { array: PathType }
  | {
      /** Upper-case type name. */
      name: string;
      /** Reference levels, outermost first. */
      refs: readonly string[];
    };

export class PointerFlow {
  private readonly fbs = new Map<string, FunctionBlockDeclaration>();
  private readonly aliases = new Map<string, TypeReference>();
  private readonly structs = new Map<string, StructDefinition>();
  /** Named array types → their element type. */
  private readonly arrays = new Map<string, TypeReference>();
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
      const upper = t.name.toUpperCase();
      if (t.definition.kind === "TypeReference") {
        this.aliases.set(upper, t.definition);
      } else if (t.definition.kind === "StructDefinition") {
        this.structs.set(upper, t.definition);
      } else if (t.definition.kind === "ArrayDefinition") {
        this.arrays.set(upper, t.definition.elementType);
      }
    }
    const scopes: Array<[PointerScope, readonly ASTNode[]]> = [];
    // A PROGRAM that code run at creation names is one more instance
    const blocks = [
      ...ast.functionBlocks,
      ...creationPrograms(ast).map(programAsBlock),
    ];
    for (const f of ast.functions) {
      const pou = `FN:${f.name}`;
      this.functions.set(f.name.toUpperCase(), f);
      scopes.push([{ pou, blocks: f.varBlocks, result: f.name }, f.body]);
    }
    for (const fb of blocks) {
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
    for (const decl of new Set(globals.values())) this.declare(decl, global);
    for (const fb of blocks) {
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
        // A VAR_EXTERNAL names the global itself
        if (
          g !== undefined &&
          !prog.varBlocks.some(
            (b) =>
              b.blockType !== "VAR_EXTERNAL" && declares(b, baseName(operand)),
          )
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

  /**
   * The globals the pointer reached by `name` and `steps` (an access path
   * of a body) may point to: its cell's, or every address taken when the
   * place is no cell or cannot be told.
   */
  pathTargets(
    name: string,
    steps: readonly AccessStepKind[],
    scope: PointerScope,
  ): ReadonlySet<string> {
    const place = this.place(name.toUpperCase(), steps, scope);
    return place === undefined || place === NONE
      ? this.addressed
      : this.pointsTo(place);
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
      } else if (
        node.kind === "VariableExpression" &&
        (node as VariableExpression).name.toUpperCase() === "THIS" &&
        stepsOf(node as VariableExpression).length === 0 &&
        (node as VariableExpression).selfCaret !== true
      ) {
        // THIS as a value is the instance's address: any type it may have
        for (const fb of scope.fb ? this.instanceTypes(scope.fb) : []) {
          this.rawAccess({ name: fb.name.toUpperCase(), refs: [] });
        }
      } else if (node.kind === "AssignmentStatement") {
        const s = node as AssignmentStatement;
        const cell = this.targetCell(s.target, scope);
        if (cell !== undefined && cell !== NONE) {
          this.assign(cell, s.value, scope);
        } else if (
          cell === undefined &&
          hasPath(s.target) &&
          this.mayBePointer(s.value, scope)
        ) {
          this.imprecise = true;
        }
      } else if (node.kind === "RefAssignStatement") {
        const s = node as RefAssignStatement;
        const cell = this.targetCell(s.target, scope);
        if (cell !== undefined && cell !== NONE) {
          this.store(cell, s.source, scope);
        } else if (cell === undefined && hasPath(s.target)) {
          this.imprecise = true;
        }
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
      const cell = this.targetCell(arg.value, scope);
      if (cell === undefined && hasPath(arg.value)) this.imprecise = true;
      else if (cell !== undefined && cell !== ANY && cell !== NONE) {
        this.unknown.add(cell);
      }
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

  /**
   * The cell an assignment target is: a pointer variable, or a pointer
   * member reached by a path; `NONE` for a place that is no cell (a path
   * only), undefined for a variable that is no pointer or a path whose
   * place cannot be told.
   */
  private targetCell(
    target: Expression,
    scope: PointerScope,
  ): string | undefined {
    if (target.kind !== "VariableExpression") return undefined;
    const upper = target.name.toUpperCase();
    return hasPath(target)
      ? this.place(upper, stepsOf(target), scope)
      : this.cellOf(upper, scope);
  }

  /**
   * Where the access `upper` + `steps` ends: a pointer member's cell (or
   * `ANY` for one whose value is not followed), `NONE` for a place that is
   * no cell, or undefined when it cannot be told: a type not known, or a
   * dereference ending the path, which may reach any memory.
   */
  private place(
    upper: string,
    steps: readonly AccessStepKind[],
    scope: PointerScope,
  ): string | undefined {
    return this.placeOf(upper, steps, scope)?.at;
  }

  /** As place(), with the type of the place reached (undefined: not told). */
  private placeOf(
    upper: string,
    steps: readonly AccessStepKind[],
    scope: PointerScope,
  ): { at: string | undefined; ty: PathType | undefined } | undefined {
    let ty: PathType | undefined;
    let from = 0;
    if (upper === "THIS" || upper === "SUPER") {
      // THIS^ is the instance itself (its caret may be folded into the
      // access); SUPER^ reaches the same members
      if (scope.fb === undefined) return undefined;
      ty = { name: scope.fb.name.toUpperCase(), refs: [] };
      from = steps[0]?.kind === "dereference" ? 1 : 0;
    } else {
      const decl = this.declarationOf(upper, scope);
      if (decl === undefined) return undefined;
      ty = this.pathType(decl.type);
    }
    let last: string | undefined;
    for (const step of steps.slice(from)) {
      ty = this.unwrap(ty, step.kind !== "dereference");
      if (ty === undefined) return undefined;
      last = undefined;
      if (step.kind === "dereference") {
        if ("array" in ty || ty.refs.length === 0) return undefined;
        ty = { name: ty.name, refs: ty.refs.slice(1) };
        last = "deref";
      } else if (step.kind === "subscript") {
        if (!("array" in ty)) return undefined;
        ty = ty.array;
        last = NONE;
      } else {
        if ("array" in ty || ty.refs.length > 0) return undefined;
        const fb = this.fbs.get(ty.name);
        const field = step.name.toUpperCase();
        if (fb !== undefined) {
          const member = this.memberOf(fb, field);
          if (member === undefined) {
            // A property: its accessors' own cells hold what it stores
            if (this.hasProperty(fb, field)) return { at: NONE, ty: undefined };
            return undefined;
          }
          ty = this.pathType(member.decl.type);
          last = !this.isPointer(member.decl.type)
            ? NONE
            : member.block.blockType === "VAR_EXTERNAL"
              ? this.globalCell(field)
              : member.block.blockType === "VAR_INPUT" ||
                  member.block.blockType === "VAR_IN_OUT"
                ? ANY
                : `M:${member.fb.name.toUpperCase()}.${field}`;
          if (last === undefined) return undefined;
          continue;
        }
        const struct = this.structs.get(ty.name);
        const decl = struct?.fields.find((d) =>
          d.names.some((n) => n.toUpperCase() === field),
        );
        if (decl === undefined) return undefined;
        ty = this.pathType(decl.type);
        last = NONE;
      }
    }
    // A dereference ending the path may reach any memory, as any type
    if (last === undefined || last === "deref") return undefined;
    return { at: last, ty };
  }

  /**
   * The cells of the pointer members of the function blocks held by value
   * in a place of type `ty` (as members, STRUCT fields or elements, at any
   * depth); undefined when a type there cannot be told.
   */
  private memberCellsIn(
    ty: PathType | undefined,
    seen = new Set<string>(),
  ): string[] | undefined {
    const t = this.unwrap(ty, false);
    if (t === undefined) return undefined;
    if ("array" in t) return this.memberCellsIn(t.array, seen);
    if (t.refs.length > 0 || seen.has(t.name)) return [];
    seen.add(t.name);
    const fb = this.fbs.get(t.name);
    const out: string[] = [];
    if (fb !== undefined) {
      for (const owner of this.chain(fb)) {
        for (const block of owner.varBlocks) {
          if (
            block.blockType === "VAR_EXTERNAL" ||
            block.blockType === "VAR_IN_OUT"
          ) {
            continue;
          }
          for (const decl of block.declarations) {
            if (this.isPointer(decl.type)) {
              if (block.blockType === "VAR_INPUT") continue;
              for (const n of decl.names) {
                out.push(`M:${owner.name.toUpperCase()}.${n.toUpperCase()}`);
              }
              continue;
            }
            const inner = this.memberCellsIn(this.pathType(decl.type), seen);
            if (inner === undefined) return undefined;
            out.push(...inner);
          }
        }
      }
      return out;
    }
    const struct = this.structs.get(t.name);
    if (struct !== undefined) {
      for (const field of struct.fields) {
        if (this.isPointer(field.type)) continue;
        const inner = this.memberCellsIn(this.pathType(field.type), seen);
        if (inner === undefined) return undefined;
        out.push(...inner);
      }
    }
    // An elementary type, an interface, or a library type: no project cells
    return out;
  }

  /** `ty` with aliases resolved and, when `through`, a REFERENCE TO taken off. */
  private unwrap(
    ty: PathType | undefined,
    through: boolean,
  ): PathType | undefined {
    let current = ty;
    for (let i = 0; i < 64 && current !== undefined; i++) {
      if ("array" in current) return current;
      if (through && current.refs[0] === "reference_to") {
        current = { name: current.name, refs: current.refs.slice(1) };
        continue;
      }
      const element = this.arrays.get(current.name);
      if (element !== undefined) {
        return current.refs.length === 0
          ? { array: this.pathType(element) }
          : current;
      }
      const target = this.aliases.get(current.name);
      if (target === undefined) return current;
      const next = this.pathType(target);
      if ("array" in next) return current.refs.length === 0 ? next : undefined;
      current = { name: next.name, refs: [...current.refs, ...next.refs] };
    }
    return undefined;
  }

  private pathType(type: TypeReference): PathType {
    if (
      type.arrayDimensions !== undefined &&
      type.elementTypeName !== undefined
    ) {
      return {
        array: {
          name: type.elementTypeName.toUpperCase(),
          refs: type.elementReferenceChain ?? [],
        },
      };
    }
    const kind = type.referenceKind ?? "none";
    return {
      name: type.name.toUpperCase(),
      refs: type.referenceChain ?? (kind === "none" ? [] : [kind]),
    };
  }

  /** The member `upper` of `fb` or a base, with its block and declaring type. */
  private memberOf(
    fb: FunctionBlockDeclaration,
    upper: string,
  ):
    | { fb: FunctionBlockDeclaration; block: VarBlock; decl: VarDeclaration }
    | undefined {
    for (const owner of this.chain(fb)) {
      for (const block of owner.varBlocks) {
        const decl = block.declarations.find((d) =>
          d.names.some((n) => n.toUpperCase() === upper),
        );
        if (decl !== undefined) return { fb: owner, block, decl };
      }
    }
    return undefined;
  }

  /** `fb` and its project descendants. */
  private instanceTypes(
    fb: FunctionBlockDeclaration,
  ): FunctionBlockDeclaration[] {
    return [fb, ...(this.descendants.get(fb.name.toUpperCase()) ?? [])];
  }

  private hasProperty(fb: FunctionBlockDeclaration, upper: string): boolean {
    return this.chain(fb).some((owner) =>
      owner.properties.some((p) => p.name.toUpperCase() === upper),
    );
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
    const cell = this.targetCell(v, scope);
    if (cell === undefined && steps.length > 0) this.imprecise = true;
    else if (cell !== undefined && cell !== ANY && cell !== NONE) {
      this.unknown.add(cell);
    }
    // Raw access through the address (MEMCPY, a cast pointer) may change the
    // pointer members of any function block held there; ADR of a REFERENCE
    // TO is the address of what it refers to
    const decl =
      steps.length === 0 ? this.declarationOf(upper, scope) : undefined;
    if (steps.length > 0 || decl !== undefined) {
      const ty =
        decl !== undefined
          ? this.pathType(decl.type)
          : this.placeOf(upper, steps, scope)?.ty;
      this.rawAccess(ty === undefined ? undefined : this.unwrap(ty, true));
    }
    if (steps.some((s) => s.kind === "dereference")) return;
    const g = this.globalOf(upper, scope);
    if (g !== undefined) this.addressed.add(g);
  }

  /** Code may write a place of type `ty` as raw memory. */
  private rawAccess(ty: PathType | undefined): void {
    const cells = this.memberCellsIn(ty);
    if (cells === undefined) this.imprecise = true;
    else for (const c of cells) this.unknown.add(c);
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
      // A pointer member is followed; a field or element is not
      const from = this.place(v.name.toUpperCase(), steps, scope);
      if (from === undefined || from === ANY || from === NONE) return "fail";
      this.edge(from, cell);
      return "pointer";
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

/** A PROGRAM as a function block: its one instance's members and methods. */
export function programAsBlock(
  program: ProgramDeclaration,
): FunctionBlockDeclaration {
  return {
    kind: "FunctionBlockDeclaration",
    name: program.name,
    isAbstract: false,
    isFinal: true,
    varBlocks: program.varBlocks,
    methods: program.methods,
    properties: [],
    actions: program.actions,
    body: program.body,
    sourceSpan: program.sourceSpan,
  };
}

/**
 * The PROGRAMs the code run while globals are created may run: those named
 * (called, or a method, action or member of them) in FUNCTIONs, function
 * blocks, TYPE defaults and global initial values, and those named in turn
 * in such PROGRAMs. Any name counts, hidden by a local or not.
 */
export function creationPrograms(ast: CompilationUnit): ProgramDeclaration[] {
  const programs = new Map(ast.programs.map((p) => [p.name.toUpperCase(), p]));
  const found = new Set<ProgramDeclaration>();
  const queue: ASTNode[] = [
    ...ast.functions,
    ...ast.functionBlocks,
    ...ast.types,
    ...ast.globalVarBlocks,
    ...ast.configurations.flatMap((c) => c.varBlocks),
  ];
  for (let i = 0; i < queue.length; i++) {
    walkAST(queue[i]!, (node) => {
      let name: string | undefined;
      if (node.kind === "VariableExpression") {
        name = (node as VariableExpression).name;
      } else if (node.kind === "FunctionCallExpression") {
        name = (node as FunctionCallExpression).functionName.split(".")[0];
      }
      const program =
        name === undefined ? undefined : programs.get(name.toUpperCase());
      if (program !== undefined && !found.has(program)) {
        found.add(program);
        queue.push(program);
      }
    });
  }
  return ast.programs.filter((p) => found.has(p));
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

/** One step of an access path. */
export type AccessStepKind =
  | { kind: "field"; name: string }
  | { kind: "subscript" }
  | { kind: "dereference" };

/** A variable access's steps, in source order. */
export function stepsOf(v: VariableExpression): AccessStepKind[] {
  if (v.accessChain !== undefined) return v.accessChain;
  return [
    ...(v.isDereference ? [{ kind: "dereference" as const }] : []),
    ...(v.subscripts.length > 0 ? [{ kind: "subscript" as const }] : []),
    ...v.fieldAccess.map((name) => ({ kind: "field" as const, name })),
  ];
}
