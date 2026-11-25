// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * The file-level globals a global's creation reads, through the code it runs.
 *
 * `x : INT := f.M()` runs M when x is created, so x must be created after f
 * and after every global M reads, also through the methods, functions,
 * function block bodies and property accessors M calls in turn. Creating an
 * FB instance runs its members' initial values (and those of FB members, at
 * any depth), so an FB global is created after the globals they read.
 *
 * Each body is one unit, for the exact function block instance it runs on:
 * the globals it reads itself, the globals whose address it takes, and the
 * units it runs. A global's reads are those of every unit reachable from it,
 * found with an explicit queue, so call depth and recursion between methods
 * cost no stack and give the same result in any order.
 *
 * A method runs on the instance's own type when the instance is a variable
 * of a function block type; through a pointer, a reference, a VAR_IN_OUT or
 * an interface it may run on any type that can be there (the declared type
 * and its descendants, or an interface's implementers), and each is
 * followed. A property read runs its getter, a write its setter. Taking an
 * address is not a read: it orders, but a cycle through it is not reported
 * (global-order.ts). A method called on a call result is reported. Library
 * code cannot read the project's globals, so it is not followed. A PROGRAM
 * that code calls (its body, a method or an action) runs on its one
 * instance, as a function block's code does.
 */

import type {
  Argument,
  AssignmentStatement,
  ASTNode,
  CompilationUnit,
  Expression,
  FunctionBlockDeclaration,
  FunctionCallExpression,
  FunctionDeclaration,
  InterfaceDeclaration,
  MethodCallExpression,
  MethodDeclaration,
  PropertyDeclaration,
  RefAssignStatement,
  RefExpression,
  StructDefinition,
  TypeReference,
  VarBlock,
  VarDeclaration,
  VariableExpression,
} from "../frontend/ast.js";
import { walkAST } from "../ast-utils.js";
import {
  PointerFlow,
  type PointerScope,
  creationPrograms,
  programAsBlock,
} from "./pointer-flow.js";

/** What a global's creation reads. */
export interface CallReads {
  /** The globals read, as `owner` maps them (upper-case). */
  globals: Set<string>;
  /** The globals stored into by name (an assignment or output capture). */
  writes?: Set<string>;
  /** The first call met whose code cannot be known, and why. */
  unresolved?: { node: ASTNode; reason: string };
}

/** One body: what it reads itself, and which bodies it runs. */
interface Unit {
  reads: Set<string>;
  writes: Set<string>;
  runs: Set<string>;
  unresolved?: { node: ASTNode; reason: string };
}

/** The variables a body sees besides the globals. */
interface Context {
  /** The function block whose code this is (its members are in scope). */
  fb?: FunctionBlockDeclaration;
  /** The exact type of the instance the code runs on (`fb` or a descendant). */
  self?: FunctionBlockDeclaration;
  /** The blocks of the method or function itself. */
  blocks: readonly VarBlock[];
  /** The method, function or accessor name, which holds its result. */
  result?: string;
  /** The body's key for its locals' pointer cells (pointer-flow.ts). */
  pou?: string;
  /** Accesses written to (assignment targets, output captures). */
  writes: ReadonlySet<ASTNode>;
}

/** A type as far as calls need it: an array, or a name behind references. */
type Ty =
  | { array: Ty }
  | {
      /** Upper-case type name. */
      name: string;
      /** Reference levels, outermost first (`pointer_to`, `reference_to`, ...). */
      refs: readonly string[];
    };

/** A type the walk cannot follow, in a project type, so a call on it is unknown. */
const UNKNOWN = "unknown";
type Typed = Ty | typeof UNKNOWN | undefined;

/** A value's type and the function blocks its instance may have. */
interface Receiver {
  ty: Typed;
  /** The instance may be of a descendant (or implementer) of the type. */
  dynamic: boolean;
  /** The exact instance types, when known otherwise (an interface bound to one). */
  exact?: FunctionBlockDeclaration[];
}

/** Follows what globals' creation reads through the POUs of `ast`. */
export class CallReadTracer {
  private readonly fbs = new Map<string, FunctionBlockDeclaration>();
  /** Each PROGRAM as its one instance (pointer-flow.ts programAsBlock). */
  private readonly programs = new Map<string, FunctionBlockDeclaration>();
  private readonly functions = new Map<string, FunctionDeclaration>();
  private readonly interfaces = new Map<string, InterfaceDeclaration>();
  private readonly structs = new Map<string, StructDefinition>();
  private readonly aliases = new Map<string, TypeReference>();
  /** Named array types → their element type. */
  private readonly arrays = new Map<string, TypeReference>();
  /** Each function block's project descendants (upper-case keys). */
  private readonly descendants = new Map<string, FunctionBlockDeclaration[]>();
  /** Interface names any project function block implements (upper-case). */
  private readonly implemented = new Set<string>();
  private readonly units = new Map<string, Unit>();
  /** Each unit's full reach, computed once by a whole walk. */
  private readonly closures = new Map<string, CallReads>();
  /** How each unit key is built, registered when first named. */
  private readonly builders = new Map<string, () => Unit>();
  /** What each pointer may point to. */
  private readonly flow: PointerFlow;
  /** The code that can run while globals are created, and their initial values. */
  private readonly creationCode: ASTNode[] = [];
  /** Globals (upper-case) that code may store into, bind or take the address of. */
  private settable?: Set<string>;

  constructor(
    ast: CompilationUnit,
    /** Every name a global is reached by → the global (upper-case). */
    private readonly owner: ReadonlyMap<string, string>,
    /** Each global's declaration (upper-case keys). */
    private readonly globals: ReadonlyMap<string, VarDeclaration>,
  ) {
    this.flow = new PointerFlow(ast, owner, globals);
    // A PROGRAM no such code names runs after every global exists
    this.creationCode.push(
      ...ast.functions,
      ...ast.functionBlocks,
      ...ast.functionBlocks.flatMap((fb) => [
        ...fb.actions,
        ...fb.properties.flatMap((p) => [
          ...(p.getterVarBlocks ?? []),
          ...(p.setterVarBlocks ?? []),
        ]),
      ]),
      ...ast.actions,
      ...ast.types,
      ...ast.globalVarBlocks,
      ...ast.configurations.flatMap((c) => c.varBlocks),
      ...creationPrograms(ast),
    );
    for (const p of ast.programs) {
      this.programs.set(p.name.toUpperCase(), programAsBlock(p));
    }
    for (const fb of ast.functionBlocks) {
      this.fbs.set(fb.name.toUpperCase(), fb);
    }
    for (const f of ast.functions) this.functions.set(f.name.toUpperCase(), f);
    for (const i of ast.interfaces) {
      this.interfaces.set(i.name.toUpperCase(), i);
    }
    for (const t of ast.types) {
      const def = t.definition;
      const upper = t.name.toUpperCase();
      if (def.kind === "StructDefinition") this.structs.set(upper, def);
      else if (def.kind === "TypeReference") this.aliases.set(upper, def);
      else if (def.kind === "ArrayDefinition") {
        this.arrays.set(upper, def.elementType);
      }
    }
    for (const fb of ast.functionBlocks) {
      for (const base of this.chain(fb).slice(1)) {
        const key = base.name.toUpperCase();
        this.descendants.set(key, [...(this.descendants.get(key) ?? []), fb]);
      }
      for (const i of fb.implements ?? []) {
        this.implemented.add(i.toUpperCase());
      }
    }
  }

  /** What creating the global `decl`, named `self`, reads through code. */
  globalReads(decl: VarDeclaration, self: string): CallReads {
    const start = `g:${self}`;
    this.builders.set(start, () => {
      const unit = this.newUnit();
      const ctx: Context = { blocks: [], writes: new Set() };
      if (decl.initialValue) this.walk(decl.initialValue, ctx, unit);
      for (const a of decl.fbInitArguments ?? []) this.walk(a.value, ctx, unit);
      for (const key of this.typeUnits(this.tyOf(decl.type))) {
        unit.runs.add(key);
      }
      return unit;
    });
    this.units.delete(start);
    const unit = this.unit(start);
    const out: CallReads = { globals: new Set(), writes: new Set(unit.writes) };
    // The value naming itself is not a read through code
    for (const g of unit.reads) {
      if (g !== self) out.globals.add(g);
    }
    if (unit.unresolved) out.unresolved = unit.unresolved;
    for (const key of unit.runs) {
      const reached = this.closure(key);
      for (const g of reached.globals) out.globals.add(g);
      for (const g of reached.writes ?? []) out.writes!.add(g);
      if (reached.unresolved) out.unresolved ??= reached.unresolved;
    }
    return out;
  }

  /**
   * What creating the instance of PROGRAM `upper` reads: its members'
   * initial values and FB members' creation (programKey names it), and the
   * globals its VAR_EXTERNALs bind by address.
   */
  programReads(upper: string): CallReads {
    const program = this.programs.get(upper);
    if (program === undefined) return { globals: new Set() };
    const key = `I:${programKey(upper)}`;
    if (!this.builders.has(key)) {
      this.builders.set(key, () => this.instanceUnit(program));
    }
    const reached = this.closure(key);
    const out: CallReads = {
      globals: new Set(
        [...reached.globals].filter((g) => g !== programKey(upper)),
      ),
      ...(reached.unresolved ? { unresolved: reached.unresolved } : {}),
    };
    for (const block of program.varBlocks) {
      if (block.blockType !== "VAR_EXTERNAL") continue;
      for (const decl of block.declarations) {
        for (const name of decl.names) {
          const g = this.owner.get(name.toUpperCase());
          if (g !== undefined) out.globals.add(g);
        }
      }
    }
    return out;
  }

  /** What every unit reachable from `key` reads (cached whole). */
  private closure(key: string): CallReads {
    const known = this.closures.get(key);
    if (known) return known;
    const out: CallReads = { globals: new Set(), writes: new Set() };
    const seen = new Set<string>([key]);
    const queue = [key];
    for (let i = 0; i < queue.length; i++) {
      const unit = this.unit(queue[i]!);
      for (const g of unit.reads) out.globals.add(g);
      for (const g of unit.writes) out.writes!.add(g);
      if (unit.unresolved) out.unresolved ??= unit.unresolved;
      for (const next of unit.runs) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    this.closures.set(key, out);
    return out;
  }

  private newUnit(): Unit {
    return { reads: new Set(), writes: new Set(), runs: new Set() };
  }

  private unit(key: string): Unit {
    let unit = this.units.get(key);
    if (unit === undefined) {
      unit = this.builders.get(key)?.() ?? this.newUnit();
      this.units.set(key, unit);
    }
    return unit;
  }

  /** Name a unit, registering how it is built. */
  private run(unit: Unit, key: string, build: () => Unit): void {
    const upper = key.toUpperCase();
    if (!this.builders.has(upper)) this.builders.set(upper, build);
    unit.runs.add(upper);
  }

  private bodyUnit(
    roots: readonly ASTNode[],
    ctx: Omit<Context, "writes">,
  ): Unit {
    const unit = this.newUnit();
    const full: Context = { ...ctx, writes: writtenAccesses(roots) };
    for (const block of ctx.blocks) {
      for (const decl of block.declarations) {
        if (decl.initialValue) this.walk(decl.initialValue, full, unit);
        // A local instance is created on each call
        if (
          block.blockType !== "VAR_EXTERNAL" &&
          block.blockType !== "VAR_IN_OUT"
        ) {
          for (const key of this.typeUnits(this.tyOf(decl.type))) {
            unit.runs.add(key);
          }
        }
      }
    }
    for (const root of roots) this.walk(root, full, unit);
    return unit;
  }

  /** Method `method` of `fb`, run on an instance of exact type `self`. */
  private runMethod(
    unit: Unit,
    fb: FunctionBlockDeclaration,
    method: MethodDeclaration,
    self: FunctionBlockDeclaration,
  ): void {
    this.run(unit, `m:${fb.name}.${method.name}@${self.name}`, () =>
      this.bodyUnit(method.body, {
        fb,
        self,
        blocks: method.varBlocks,
        result: method.name,
        pou: `${fb.name}.${method.name}`,
      }),
    );
  }

  private runFunction(unit: Unit, f: FunctionDeclaration): void {
    this.run(unit, `fn:${f.name}`, () =>
      this.bodyUnit(f.body, {
        blocks: f.varBlocks,
        result: f.name,
        pou: `FN:${f.name}`,
      }),
    );
  }

  /** A call of an instance of exact type `self`: each body of its chain runs. */
  private runBody(unit: Unit, self: FunctionBlockDeclaration): void {
    for (const owner of this.chain(self)) {
      this.run(unit, `b:${owner.name}@${self.name}`, () =>
        this.bodyUnit(owner.body, { fb: owner, self, blocks: [] }),
      );
    }
  }

  /** The accessor of `name` a read (or a write) runs on an instance of `self`. */
  private runProperty(
    unit: Unit,
    self: FunctionBlockDeclaration,
    name: string,
    write: boolean,
  ): void {
    const found = this.findProperty(self, name);
    if (found === undefined) return;
    const { fb, prop } = found;
    const body = write ? prop.setter : prop.getter;
    const lowered = write ? prop.setterMethod : prop.getterMethod;
    const method =
      lowered === undefined ? undefined : this.findMethod(fb, lowered);
    if (method !== undefined) {
      this.runMethod(unit, fb, method, self);
    } else if (body !== undefined) {
      const blocks =
        (write ? prop.setterVarBlocks : prop.getterVarBlocks) ?? [];
      this.run(
        unit,
        `${write ? "set" : "get"}:${fb.name}.${prop.name}@${self.name}`,
        () =>
          this.bodyUnit(body, {
            fb,
            self,
            blocks,
            pou: `${write ? "set" : "get"}:${fb.name}.${prop.name}`,
            ...(write ? {} : { result: prop.name }),
          }),
      );
    }
  }

  /** The units creating a value of `ty` runs: member initial values. */
  private typeUnits(ty: Typed): string[] {
    if (ty === undefined || ty === UNKNOWN) return [];
    if ("array" in ty) return this.typeUnits(ty.array);
    if (ty.refs.length > 0) return [];
    const base = this.deAlias(ty);
    if (base !== ty) return this.typeUnits(base);
    const fb = this.fbs.get(ty.name);
    if (fb !== undefined) {
      const key = `I:${fb.name.toUpperCase()}`;
      if (!this.builders.has(key)) {
        this.builders.set(key, () => this.instanceUnit(fb));
      }
      return [key];
    }
    const struct = this.structs.get(ty.name);
    if (struct !== undefined) {
      const key = `S:${ty.name}`;
      if (!this.builders.has(key)) {
        this.builders.set(key, () => {
          const unit = this.newUnit();
          const ctx: Context = { blocks: [], writes: new Set() };
          for (const field of struct.fields) {
            if (field.initialValue) this.walk(field.initialValue, ctx, unit);
            for (const k of this.typeUnits(this.tyOf(field.type))) {
              unit.runs.add(k);
            }
          }
          return unit;
        });
      }
      return [key];
    }
    return [];
  }

  /**
   * Creating an instance of `fb`: its own and its bases' member initial
   * values. FB_init runs later, once every global exists, so it is not here.
   */
  private instanceUnit(fb: FunctionBlockDeclaration): Unit {
    const unit = this.newUnit();
    for (const owner of this.chain(fb)) {
      const ctx: Context = {
        fb: owner,
        self: fb,
        blocks: [],
        writes: new Set(),
      };
      for (const block of owner.varBlocks) {
        if (
          block.blockType === "VAR_EXTERNAL" ||
          block.blockType === "VAR_IN_OUT"
        ) {
          continue;
        }
        for (const decl of block.declarations) {
          if (decl.initialValue) this.walk(decl.initialValue, ctx, unit);
          for (const a of decl.fbInitArguments ?? []) {
            this.walk(a.value, ctx, unit);
          }
          for (const key of this.typeUnits(this.tyOf(decl.type))) {
            unit.runs.add(key);
          }
        }
      }
    }
    return unit;
  }

  private walk(root: ASTNode, ctx: Context, unit: Unit): void {
    walkAST(root, (node): boolean | void => {
      if (node.kind === "RefExpression") {
        return this.address((node as RefExpression).operand, ctx, unit);
      }
      if (node.kind === "VariableExpression") {
        this.receiverOf(node as VariableExpression, ctx, unit);
      } else if (node.kind === "FunctionCallExpression") {
        const call = node as FunctionCallExpression;
        const upper = call.functionName.toUpperCase();
        if (
          (upper === "ADR" || upper === "REF") &&
          !this.functions.has(upper) &&
          call.arguments.length === 1
        ) {
          return this.address(call.arguments[0]!.value, ctx, unit);
        }
        this.call(call, ctx, unit);
      } else if (node.kind === "MethodCallExpression") {
        this.methodCall(node as MethodCallExpression, ctx, unit);
      }
    });
  }

  /**
   * `ADR(g)` / `REF(g)`: the address of g, not a read of it (a dereference
   * of it reads g, pointer-flow.ts). Its indices are read, and a dereference
   * in it reads the pointer.
   */
  private address(operand: Expression, ctx: Context, unit: Unit): false {
    if (operand.kind !== "VariableExpression") {
      this.walk(operand, ctx, unit);
      return false;
    }
    const v = operand;
    // ADR(p^) reads the pointer p, not what it points to
    if (stepsOf(v).some((s) => s.kind === "dereference")) {
      const resolved = this.resolve(v.name.toUpperCase(), ctx);
      if (resolved?.global !== undefined) unit.reads.add(resolved.global);
    }
    for (const step of v.accessChain ?? []) {
      if (step.kind === "subscript") {
        for (const index of step.indices) this.walk(index, ctx, unit);
      }
    }
    if (v.accessChain === undefined) {
      for (const index of v.subscripts) this.walk(index, ctx, unit);
    }
    return false;
  }

  private unresolved(unit: Unit, node: ASTNode, reason: string): void {
    unit.unresolved ??= { node, reason };
  }

  /** The type of a variable access, running the accessors it reaches. */
  private receiverOf(
    v: VariableExpression,
    ctx: Context,
    unit: Unit,
  ): Receiver {
    const upper = v.name.toUpperCase();
    const self = upper === "THIS" || upper === "SUPER";
    // THIS^ is the instance itself
    const all = stepsOf(v);
    const steps = self && all[0]?.kind === "dereference" ? all.slice(1) : all;
    const written = ctx.writes.has(v);
    let r: Receiver;
    if (upper === "THIS" && ctx.self) {
      r = this.exactly(ctx.self);
    } else if (upper === "SUPER" && ctx.fb && ctx.self) {
      // SUPER^.x reaches the same instance
      r = this.exactly(ctx.self);
    } else {
      const resolved = this.resolve(upper, ctx);
      if (resolved?.global !== undefined) unit.reads.add(resolved.global);
      if (resolved?.global !== undefined && written) {
        unit.writes.add(resolved.global);
      }
      if (resolved !== undefined) {
        // `p^...` reads what p points to; so does any use of a REFERENCE TO
        // other than rebinding or writing it whole
        const ty = this.tyOf(resolved.type);
        const reference =
          ty !== undefined &&
          ty !== UNKNOWN &&
          !("array" in ty) &&
          this.isReference(ty);
        if (
          steps[0]?.kind === "dereference" ||
          (reference && !(written && steps.length === 0))
        ) {
          this.readTargets(upper, ctx, unit);
        }
        r = {
          ty: reference ? this.dereferenced(ty) : ty,
          dynamic: resolved.dynamic,
          ...(resolved.exact ? { exact: resolved.exact } : {}),
        };
      } else if (this.programs.has(upper)) {
        // A PROGRAM's instance, through its members and methods
        unit.reads.add(programKey(upper));
        r = this.exactly(this.programs.get(upper)!);
      } else {
        // A property of the function block, read or written bare
        const self = ctx.self;
        const prop = self && this.findProperty(self, upper);
        if (self === undefined || prop === undefined) {
          return { ty: undefined, dynamic: false };
        }
        this.runProperty(unit, self, upper, written && steps.length === 0);
        r = { ty: this.tyOf(prop.prop.type), dynamic: false };
      }
    }
    // A dereference further along reads what the pointer before it may hold
    all.forEach((step, i) => {
      if (step.kind !== "dereference" || i === 0) return;
      const scope = this.scopeOf(ctx);
      for (const g of this.flow.pathTargets(upper, all.slice(0, i), scope)) {
        unit.reads.add(g);
      }
    });
    steps.forEach((step, i) => {
      if (r.ty === undefined || r.ty === UNKNOWN) return;
      if (step.kind === "subscript") {
        const base = "array" in r.ty ? r.ty : this.deAlias(r.ty);
        // A character of a STRING, or an element of a library array
        r = {
          ty:
            base !== undefined && base !== UNKNOWN && "array" in base
              ? base.array
              : undefined,
          dynamic: false,
        };
      } else if (step.kind === "dereference") {
        const base = this.deAlias(r.ty);
        r =
          base === UNKNOWN ||
          base === undefined ||
          "array" in base ||
          base.refs.length === 0
            ? { ty: UNKNOWN, dynamic: false }
            : {
                ty: { name: base.name, refs: base.refs.slice(1) },
                dynamic: true,
              };
      } else {
        r = this.field(
          r,
          step.name,
          written && i === steps.length - 1,
          v,
          unit,
        );
      }
    });
    return r;
  }

  /** Where pointer-flow.ts looks up the names of the body `ctx`. */
  private scopeOf(ctx: Context): PointerScope {
    return {
      blocks: ctx.blocks,
      ...(ctx.fb ? { fb: ctx.fb } : {}),
      ...(ctx.pou !== undefined ? { pou: ctx.pou } : {}),
      ...(ctx.result !== undefined ? { result: ctx.result } : {}),
    };
  }

  /** A dereference of the variable `upper`: it reads what it may point to. */
  private readTargets(upper: string, ctx: Context, unit: Unit): void {
    const cell = this.flow.cellOf(upper, this.scopeOf(ctx));
    const targets =
      cell === undefined
        ? this.flow.everyAddressed()
        : this.flow.pointsTo(cell);
    for (const g of targets) unit.reads.add(g);
  }

  /** A called name's type; a REFERENCE TO is dereferenced, reading its targets. */
  private headType(
    upper: string,
    type: TypeReference | undefined,
    ctx: Context,
    unit: Unit,
  ): Typed {
    const ty = this.tyOf(type);
    if (ty === undefined || ty === UNKNOWN || "array" in ty) return ty;
    if (!this.isReference(ty)) return ty;
    this.readTargets(upper, ctx, unit);
    return this.dereferenced(ty);
  }

  /** `ty` (a REFERENCE TO) with its reference taken off. */
  private dereferenced(ty: Ty): Typed {
    const base = this.deAlias(ty);
    return base === undefined || base === UNKNOWN || "array" in base
      ? base
      : { name: base.name, refs: base.refs.slice(1) };
  }

  /** `ty` is a REFERENCE TO, through aliases. */
  private isReference(ty: Ty): boolean {
    const base = this.deAlias(ty);
    return (
      base !== undefined &&
      base !== UNKNOWN &&
      !("array" in base) &&
      base.refs[0] === "reference_to"
    );
  }

  private exactly(fb: FunctionBlockDeclaration): Receiver {
    return {
      ty: { name: fb.name.toUpperCase(), refs: [] },
      dynamic: false,
      exact: [fb],
    };
  }

  /** Member `name` of a value reached as `r`, running a property's accessor. */
  private field(
    r: Receiver,
    name: string,
    write: boolean,
    node: ASTNode,
    unit: Unit,
  ): Receiver {
    const upper = name.toUpperCase();
    const targets = this.targets(r, node, unit);
    if (targets === UNKNOWN) return { ty: UNKNOWN, dynamic: false };
    if (targets !== undefined) {
      let ty: Typed;
      for (const fb of targets) {
        const member = this.findMember(fb, upper);
        if (member !== undefined) {
          ty ??= this.tyOf(member.type);
          continue;
        }
        const prop = this.findProperty(fb, upper);
        if (prop !== undefined) {
          this.runProperty(unit, fb, upper, write);
          ty ??= this.tyOf(prop.prop.type);
        }
      }
      return { ty, dynamic: false };
    }
    const base =
      r.ty === undefined || r.ty === UNKNOWN ? r.ty : this.deAlias(r.ty);
    if (base === undefined || base === UNKNOWN || "array" in base) {
      return { ty: base === undefined ? undefined : UNKNOWN, dynamic: false };
    }
    if (base.refs.some((k) => k !== "reference_to")) {
      return { ty: UNKNOWN, dynamic: false };
    }
    if (base.refs.length > 0) {
      for (const g of this.flow.everyAddressed()) unit.reads.add(g);
    }
    const struct = this.structs.get(base.name);
    if (struct !== undefined) {
      const f = struct.fields.find((d) =>
        d.names.some((n) => n.toUpperCase() === upper),
      );
      return {
        ty: f === undefined ? UNKNOWN : this.tyOf(f.type),
        dynamic: false,
      };
    }
    return { ty: undefined, dynamic: false }; // a library type
  }

  /**
   * The exact function block types an instance reached as `r` may have:
   * undefined when it is no project function block (or interface), UNKNOWN
   * when it cannot be told.
   */
  private targets(
    r: Receiver,
    node: ASTNode,
    unit: Unit,
  ): FunctionBlockDeclaration[] | typeof UNKNOWN | undefined {
    if (r.exact !== undefined) return r.exact;
    if (r.ty === UNKNOWN) {
      this.unresolved(unit, node, "a call whose receiver cannot be followed");
      return UNKNOWN;
    }
    const base = r.ty === undefined ? undefined : this.deAlias(r.ty);
    if (base === undefined || base === UNKNOWN || "array" in base) {
      return undefined;
    }
    let dynamic = r.dynamic;
    let refs = base.refs;
    if (refs[0] === "reference_to") {
      // A REFERENCE TO reached through a member: what it holds is not known
      for (const g of this.flow.everyAddressed()) unit.reads.add(g);
      refs = refs.slice(1);
      dynamic = true;
    }
    if (refs.length > 0) return undefined;
    if (this.interfaces.has(base.name) || this.implemented.has(base.name)) {
      return this.implementers(base.name);
    }
    const fb = this.fbs.get(base.name);
    if (fb === undefined) return undefined;
    return dynamic ? [fb, ...(this.descendants.get(base.name) ?? [])] : [fb];
  }

  /** The project function blocks implementing interface `upper`, at any depth. */
  private implementers(upper: string): FunctionBlockDeclaration[] {
    const names = new Set([upper]);
    // Interfaces extending it, transitively
    for (let grew = true; grew; ) {
      grew = false;
      for (const [name, i] of this.interfaces) {
        if (
          !names.has(name) &&
          (i.extends ?? []).some((e) => names.has(e.toUpperCase()))
        ) {
          names.add(name);
          grew = true;
        }
      }
    }
    return [...this.fbs.values()].filter((fb) =>
      this.chain(fb).some((owner) =>
        (owner.implements ?? []).some((i) => names.has(i.toUpperCase())),
      ),
    );
  }

  private call(c: FunctionCallExpression, ctx: Context, unit: Unit): void {
    const parts = c.functionName.split(".").map((p) => p.toUpperCase());
    if (c.instance !== undefined) {
      // `units[0]()`: the element's FB body runs
      const r: Receiver =
        c.instance.kind === "VariableExpression"
          ? this.receiverOf(c.instance, ctx, unit)
          : { ty: UNKNOWN, dynamic: false };
      return this.callInstance(r, c, unit);
    }
    if (parts.length === 1) {
      const name = parts[0]!;
      // THIS^() runs the instance's bodies, SUPER^() the base's
      if ((name === "THIS" || name === "SUPER") && ctx.self && ctx.fb) {
        const from =
          name === "THIS"
            ? ctx.self
            : this.fbs.get((ctx.fb.extends ?? "").toUpperCase());
        for (const owner of from ? this.chain(from) : []) {
          const self = ctx.self;
          this.run(unit, `b:${owner.name}@${self.name}`, () =>
            this.bodyUnit(owner.body, { fb: owner, self, blocks: [] }),
          );
        }
        return;
      }
      if (ctx.self && this.findMethodInChain(ctx.self, name)) {
        return this.memberCall(this.exactly(ctx.self), name, c, unit);
      }
      const resolved = this.resolve(name, ctx);
      if (resolved !== undefined) {
        if (resolved.global !== undefined) unit.reads.add(resolved.global);
        return this.callInstance(
          {
            ty: this.headType(name, resolved.type, ctx, unit),
            dynamic: resolved.dynamic,
            ...(resolved.exact ? { exact: resolved.exact } : {}),
          },
          c,
          unit,
        );
      }
      // A PROGRAM called: its body runs on its one instance
      const program = this.programs.get(name);
      if (program !== undefined) {
        unit.reads.add(programKey(name));
        return this.runBody(unit, program);
      }
      const f = this.functions.get(name);
      if (f !== undefined) this.runFunction(unit, f);
      return;
    }
    const head = parts[0]!;
    let r: Receiver;
    if ((head === "THIS" || head === "SUPER") && ctx.fb && ctx.self) {
      if (head === "SUPER") {
        // SUPER^.M() calls the base's own M, on the same instance
        const base = this.fbs.get((ctx.fb.extends ?? "").toUpperCase());
        const found =
          base && parts.length === 2
            ? this.findMethodInChain(base, parts[1]!)
            : undefined;
        if (found) this.runMethod(unit, found.fb, found.method, ctx.self);
        return;
      }
      r = this.exactly(ctx.self);
    } else {
      const resolved = this.resolve(head, ctx);
      const program = this.programs.get(head);
      if (resolved === undefined && program !== undefined) {
        // `PRG.M()`, an action, or a member of the PROGRAM's instance
        const last = parts[parts.length - 1]!;
        if (
          parts.length === 2 &&
          !this.findMethodInChain(program, last) &&
          !this.findMember(program, last)
        ) {
          return this.unresolved(
            unit,
            c,
            "a PROGRAM call that cannot be followed",
          );
        }
        unit.reads.add(programKey(head));
        r = this.exactly(program);
        for (const name of parts.slice(1, -1)) {
          if (r.ty === undefined || r.ty === UNKNOWN) break;
          r = this.field(r, name, false, c, unit);
        }
        return this.memberCall(r, last, c, unit);
      }
      if (resolved === undefined) return; // a namespace or library call
      if (resolved.global !== undefined) unit.reads.add(resolved.global);
      r = {
        ty: this.headType(head, resolved.type, ctx, unit),
        dynamic: resolved.dynamic,
        ...(resolved.exact ? { exact: resolved.exact } : {}),
      };
    }
    for (const name of parts.slice(1, -1)) {
      if (r.ty === undefined || r.ty === UNKNOWN) break;
      r = this.field(r, name, false, c, unit);
    }
    this.memberCall(r, parts[parts.length - 1]!, c, unit);
  }

  private methodCall(c: MethodCallExpression, ctx: Context, unit: Unit): void {
    let object: Expression = c.object;
    while (object.kind === "ParenthesizedExpression")
      object = object.expression;
    if (object.kind !== "VariableExpression") {
      return this.unresolved(unit, c, "a method called on a call result");
    }
    const r = this.receiverOf(object, ctx, unit);
    this.memberCall(r, c.methodName.toUpperCase(), c, unit);
  }

  /** A call of the instance reached as `r` itself: its FB bodies run. */
  private callInstance(r: Receiver, node: ASTNode, unit: Unit): void {
    const targets = this.targets(r, node, unit);
    if (targets === undefined || targets === UNKNOWN) return;
    for (const fb of targets) this.runBody(unit, fb);
  }

  /** `a.M()` with `a` reached as `r`. */
  private memberCall(
    r: Receiver,
    name: string,
    node: ASTNode,
    unit: Unit,
  ): void {
    const targets = this.targets(r, node, unit);
    if (targets === undefined || targets === UNKNOWN) return;
    for (const fb of targets) {
      const found = this.findMethodInChain(fb, name);
      if (found !== undefined) {
        this.runMethod(unit, found.fb, found.method, fb);
        continue;
      }
      // `a.b()`: a function block member b of a, called
      const member = this.findMember(fb, name);
      if (member !== undefined) {
        this.callInstance(
          { ty: this.tyOf(member.type), dynamic: false },
          node,
          unit,
        );
      }
    }
  }

  /** A name of a body: a local, a member, or a global (by VAR_EXTERNAL too). */
  private resolve(
    upper: string,
    ctx: Context,
  ):
    | {
        type: TypeReference | undefined;
        dynamic: boolean;
        global?: string;
        exact?: FunctionBlockDeclaration[];
      }
    | undefined {
    if (ctx.result?.toUpperCase() === upper) {
      return { type: undefined, dynamic: false };
    }
    const blocks = [
      ...ctx.blocks,
      ...(ctx.fb ? this.chain(ctx.fb).flatMap((f) => f.varBlocks) : []),
    ];
    for (const block of blocks) {
      for (const decl of block.declarations) {
        if (!decl.names.some((n) => n.toUpperCase() === upper)) continue;
        // A VAR_IN_OUT may be bound to an instance of a derived type
        const dynamic = block.blockType === "VAR_IN_OUT";
        const global =
          block.blockType === "VAR_EXTERNAL"
            ? this.owner.get(upper)
            : undefined;
        return global === undefined
          ? { type: decl.type, dynamic }
          : this.globalOf(global, decl.type);
      }
    }
    if (ctx.self && this.findProperty(ctx.self, upper)) return undefined;
    const global = this.owner.get(upper);
    return global === undefined
      ? undefined
      : this.globalOf(global, this.globals.get(global)?.type);
  }

  /**
   * A global: an interface global whose initial value names a function block
   * global is that instance.
   */
  private globalOf(
    global: string,
    type: TypeReference | undefined,
  ): {
    type: TypeReference | undefined;
    dynamic: boolean;
    global: string;
    exact?: FunctionBlockDeclaration[];
  } {
    const value = this.globals.get(global)?.initialValue;
    const ty = this.tyOf(type);
    if (
      ty !== undefined &&
      ty !== UNKNOWN &&
      !("array" in ty) &&
      ty.refs.length === 0 &&
      (this.interfaces.has(ty.name) || this.implemented.has(ty.name)) &&
      value?.kind === "VariableExpression" &&
      stepsOf(value).length === 0
    ) {
      const target = this.owner.get(value.name.toUpperCase());
      const targetTy = this.tyOf(
        target === undefined ? undefined : this.globals.get(target)?.type,
      );
      const fb =
        targetTy !== undefined &&
        targetTy !== UNKNOWN &&
        !("array" in targetTy) &&
        targetTy.refs.length === 0
          ? this.fbs.get(targetTy.name)
          : undefined;
      if (fb !== undefined) {
        return { type, dynamic: false, global, exact: [fb] };
      }
    }
    // An interface global holding NULL while globals are created: a call
    // through it runs no implementer
    if (
      ty !== undefined &&
      ty !== UNKNOWN &&
      !("array" in ty) &&
      ty.refs.length === 0 &&
      this.interfaces.has(ty.name) &&
      isNullValue(value) &&
      !this.mayBeSet(global)
    ) {
      return { type, dynamic: false, global, exact: [] };
    }
    return { type, dynamic: false, global };
  }

  /**
   * Whether code that can run while globals are created may change the
   * global `upper`: it is assigned, bound to an output or in/out (any call
   * argument naming it), or its address is taken. Any variable of that name
   * counts, hidden by a local or not.
   */
  private mayBeSet(upper: string): boolean {
    if (this.settable === undefined) {
      const settable = new Set<string>();
      const add = (e: Expression): void => {
        if (e.kind !== "VariableExpression") return;
        const g = this.owner.get(e.name.toUpperCase());
        if (g !== undefined) settable.add(g);
      };
      for (const root of this.creationCode) {
        walkAST(root, (node) => {
          if (node.kind === "AssignmentStatement") {
            add((node as AssignmentStatement).target);
          } else if (node.kind === "RefAssignStatement") {
            // `r REF= g` lets a write through r change g
            add((node as RefAssignStatement).target);
            add((node as RefAssignStatement).source);
          } else if (node.kind === "Argument") {
            add((node as Argument).value);
          } else if (node.kind === "RefExpression") {
            add((node as RefExpression).operand);
          }
        });
      }
      this.settable = settable;
    }
    return this.settable.has(upper);
  }

  private tyOf(type: TypeReference | undefined): Typed {
    if (type === undefined) return undefined;
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
    return { name: type.name.toUpperCase(), refs: refsOf(type) };
  }

  /**
   * `ty` with its TYPE aliases and named array types replaced by what they
   * name; a reference to an array is not followed.
   */
  private deAlias(ty: Ty): Typed {
    let current: Ty = ty;
    for (let i = 0; i < 64; i++) {
      if ("array" in current) return current;
      const element = this.arrays.get(current.name);
      if (element !== undefined) {
        const inner = this.tyOf(element);
        if (
          current.refs.length > 0 ||
          inner === undefined ||
          inner === UNKNOWN
        ) {
          return UNKNOWN;
        }
        return { array: inner };
      }
      const target = this.aliases.get(current.name);
      if (target === undefined) return current;
      const next = this.tyOf(target);
      if (next === undefined || next === UNKNOWN) return next;
      if ("array" in next) return current.refs.length === 0 ? next : UNKNOWN;
      current = { name: next.name, refs: [...current.refs, ...next.refs] };
    }
    return UNKNOWN;
  }

  /** `fb` and its project base function blocks, most derived first. */
  private chain(fb: FunctionBlockDeclaration): FunctionBlockDeclaration[] {
    const out: FunctionBlockDeclaration[] = [];
    let current: FunctionBlockDeclaration | undefined = fb;
    while (current && !out.includes(current)) {
      out.push(current);
      current = this.fbs.get((current.extends ?? "").toUpperCase());
    }
    return out;
  }

  private findMember(
    fb: FunctionBlockDeclaration,
    upper: string,
  ): VarDeclaration | undefined {
    for (const owner of this.chain(fb)) {
      for (const block of owner.varBlocks) {
        const decl = block.declarations.find((d) =>
          d.names.some((n) => n.toUpperCase() === upper),
        );
        if (decl !== undefined) return decl;
      }
    }
    return undefined;
  }

  private findProperty(
    fb: FunctionBlockDeclaration,
    upper: string,
  ): { fb: FunctionBlockDeclaration; prop: PropertyDeclaration } | undefined {
    for (const owner of this.chain(fb)) {
      const prop = owner.properties.find((p) => p.name.toUpperCase() === upper);
      if (prop !== undefined) return { fb: owner, prop };
    }
    return undefined;
  }

  private findMethod(
    fb: FunctionBlockDeclaration,
    name: string,
  ): MethodDeclaration | undefined {
    const upper = name.toUpperCase();
    return fb.methods.find((m) => m.name.toUpperCase() === upper);
  }

  private findMethodInChain(
    fb: FunctionBlockDeclaration,
    name: string,
  ): { fb: FunctionBlockDeclaration; method: MethodDeclaration } | undefined {
    for (const owner of this.chain(fb)) {
      const method = this.findMethod(owner, name);
      if (method) return { fb: owner, method };
    }
    return undefined;
  }
}

/**
 * The name a global's reads give a PROGRAM whose instance its creation uses
 * (it runs the PROGRAM's code or reads its members): no identifier has a space.
 */
export function programKey(name: string): string {
  return `PROGRAM ${name.toUpperCase()}`;
}

/** No initial value, NULL, or 0 (an interface holding no instance). */
function isNullValue(value: Expression | undefined): boolean {
  if (value === undefined) return true;
  let e = value;
  while (e.kind === "ParenthesizedExpression") e = e.expression;
  return (
    e.kind === "LiteralExpression" &&
    (e.literalType === "NULL" || e.value === 0)
  );
}

function refsOf(type: TypeReference): string[] {
  if (type.referenceChain !== undefined) return [...type.referenceChain];
  const kind = type.referenceKind ?? "none";
  return kind === "none" ? [] : [kind];
}

/** The accesses `roots` write: assignment targets and output captures. */
function writtenAccesses(roots: readonly ASTNode[]): Set<ASTNode> {
  const out = new Set<ASTNode>();
  for (const root of roots) {
    walkAST(root, (node) => {
      if (node.kind === "AssignmentStatement") {
        out.add((node as AssignmentStatement).target);
      } else if (node.kind === "RefAssignStatement") {
        out.add((node as RefAssignStatement).target);
      } else if (node.kind === "Argument" && (node as Argument).isOutput) {
        out.add((node as Argument).value);
      }
    });
  }
  return out;
}

/** A variable access's steps, in source order. */
function stepsOf(
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
