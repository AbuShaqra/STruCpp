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
 * Each body is one unit: the globals it reads itself and the units it runs.
 * A global's reads are those of every unit reachable from it, found by a
 * walk with an explicit queue, so call depth and recursion between methods
 * (a cycle of units) cost no stack and give the same result in any order.
 * A call whose code cannot be known (through an interface, or on a call
 * result) is reported. Library code cannot read the project's globals, so it
 * is not followed.
 */

import type {
  ASTNode,
  CompilationUnit,
  Expression,
  FunctionBlockDeclaration,
  FunctionCallExpression,
  FunctionDeclaration,
  MethodCallExpression,
  MethodDeclaration,
  PropertyDeclaration,
  StructDefinition,
  TypeReference,
  VarBlock,
  VarDeclaration,
  VariableExpression,
} from "../frontend/ast.js";
import { walkAST } from "../ast-utils.js";

/** What a global's creation reads. */
export interface CallReads {
  /** The globals read, as `owner` maps them (upper-case). */
  globals: Set<string>;
  /** The first call met whose code cannot be known, and why. */
  unresolved?: { node: ASTNode; reason: string };
}

/** One body: what it reads itself and which bodies it runs. */
interface Unit {
  reads: Set<string>;
  runs: Set<string>;
  unresolved?: { node: ASTNode; reason: string };
}

/** The variables a body sees besides the globals. */
interface Context {
  /** The function block whose members, methods and properties are in scope. */
  fb?: FunctionBlockDeclaration;
  /** The blocks of the method or function itself. */
  blocks: readonly VarBlock[];
  /** The method, function or accessor name, which holds its result. */
  result?: string;
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

/** Follows what globals' creation reads through the POUs of `ast`. */
export class CallReadTracer {
  private readonly fbs = new Map<string, FunctionBlockDeclaration>();
  private readonly functions = new Map<string, FunctionDeclaration>();
  private readonly interfaces = new Set<string>();
  private readonly structs = new Map<string, StructDefinition>();
  private readonly aliases = new Map<string, TypeReference>();
  /** Named array types → their element type. */
  private readonly arrays = new Map<string, TypeReference>();
  /** Each function block's project descendants (upper-case keys). */
  private readonly descendants = new Map<string, FunctionBlockDeclaration[]>();
  private readonly units = new Map<string, Unit>();
  /** How each unit key is built, registered when first named. */
  private readonly builders = new Map<string, () => Unit>();

  constructor(
    ast: CompilationUnit,
    /** Every name a global is reached by → the global (upper-case). */
    private readonly owner: ReadonlyMap<string, string>,
    /** Each global's declared type (upper-case keys). */
    private readonly globalTypes: ReadonlyMap<string, TypeReference>,
  ) {
    for (const fb of ast.functionBlocks) {
      this.fbs.set(fb.name.toUpperCase(), fb);
    }
    for (const f of ast.functions) this.functions.set(f.name.toUpperCase(), f);
    for (const i of ast.interfaces) this.interfaces.add(i.name.toUpperCase());
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
    }
  }

  /** What creating the global `decl` declares reads, besides `self` itself named. */
  globalReads(decl: VarDeclaration, self: string): CallReads {
    const start = `g:${self}`;
    this.builders.set(start, () => {
      const unit = this.newUnit();
      const ctx: Context = { blocks: [] };
      if (decl.initialValue) this.walk(decl.initialValue, ctx, unit);
      for (const a of decl.fbInitArguments ?? []) this.walk(a.value, ctx, unit);
      for (const key of this.typeUnits(this.tyOf(decl.type))) {
        unit.runs.add(key);
      }
      return unit;
    });
    this.units.delete(start);
    const out: CallReads = { globals: new Set() };
    const seen = new Set<string>([start]);
    const queue = [start];
    for (let i = 0; i < queue.length; i++) {
      const key = queue[i]!;
      const unit = this.unit(key);
      for (const g of unit.reads) {
        // The value naming itself is not a read through code
        if (key !== start || g !== self) out.globals.add(g);
      }
      if (unit.unresolved) out.unresolved ??= unit.unresolved;
      for (const next of unit.runs) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return out;
  }

  private newUnit(): Unit {
    return { reads: new Set(), runs: new Set() };
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
    ctx: Context,
    extra?: (unit: Unit) => void,
  ): Unit {
    const unit = this.newUnit();
    for (const block of ctx.blocks) {
      for (const decl of block.declarations) {
        if (decl.initialValue) this.walk(decl.initialValue, ctx, unit);
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
    for (const root of roots) this.walk(root, ctx, unit);
    extra?.(unit);
    return unit;
  }

  private runMethod(
    unit: Unit,
    fb: FunctionBlockDeclaration,
    method: MethodDeclaration,
  ): void {
    this.run(unit, `m:${fb.name}.${method.name}`, () =>
      this.bodyUnit(method.body, {
        fb,
        blocks: method.varBlocks,
        result: method.name,
      }),
    );
  }

  private runFunction(unit: Unit, f: FunctionDeclaration): void {
    this.run(unit, `fn:${f.name}`, () =>
      this.bodyUnit(f.body, { blocks: f.varBlocks, result: f.name }),
    );
  }

  /** A call of an instance of `fb`: the body of each FB of its chain runs. */
  private runBody(unit: Unit, fb: FunctionBlockDeclaration): void {
    for (const owner of this.chain(fb)) {
      this.run(unit, `b:${owner.name}`, () =>
        this.bodyUnit(owner.body, { fb: owner, blocks: [] }),
      );
    }
  }

  /** Both accessors of a property: a read or a write runs one of them. */
  private runProperty(
    unit: Unit,
    fb: FunctionBlockDeclaration,
    prop: PropertyDeclaration,
  ): void {
    for (const [getter, body, blocks, method] of [
      [true, prop.getter, prop.getterVarBlocks, prop.getterMethod],
      [false, prop.setter, prop.setterVarBlocks, prop.setterMethod],
    ] as const) {
      const lowered =
        method === undefined ? undefined : this.findMethod(fb, method);
      if (lowered !== undefined) {
        this.runMethod(unit, fb, lowered);
      } else if (body !== undefined) {
        this.run(
          unit,
          `${getter ? "get" : "set"}:${fb.name}.${prop.name}`,
          () =>
            this.bodyUnit(body, {
              fb,
              blocks: blocks ?? [],
              result: prop.name,
            }),
        );
      }
    }
  }

  /** The units creating a value of `ty` runs: member initial values, FB_init. */
  private typeUnits(ty: Typed): string[] {
    if (ty === undefined || ty === UNKNOWN) return [];
    if ("array" in ty) return this.typeUnits(ty.array);
    if (ty.refs.length > 0) return [];
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
          for (const field of struct.fields) {
            if (field.initialValue) {
              this.walk(field.initialValue, { blocks: [] }, unit);
            }
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

  private instanceUnit(fb: FunctionBlockDeclaration): Unit {
    const unit = this.newUnit();
    const ctx: Context = { fb, blocks: [] };
    for (const block of fb.varBlocks) {
      if (
        block.blockType === "VAR_EXTERNAL" ||
        block.blockType === "VAR_IN_OUT"
      ) {
        continue;
      }
      for (const decl of block.declarations) {
        if (decl.initialValue) this.walk(decl.initialValue, ctx, unit);
        for (const a of decl.fbInitArguments ?? [])
          this.walk(a.value, ctx, unit);
        for (const key of this.typeUnits(this.tyOf(decl.type))) {
          unit.runs.add(key);
        }
      }
    }
    const base = this.fbs.get((fb.extends ?? "").toUpperCase());
    if (base !== undefined) {
      for (const key of this.typeUnits({
        name: base.name.toUpperCase(),
        refs: [],
      })) {
        unit.runs.add(key);
      }
    }
    const init = this.findMethod(fb, "FB_INIT");
    if (init !== undefined) this.runMethod(unit, fb, init);
    return unit;
  }

  private walk(root: ASTNode, ctx: Context, unit: Unit): void {
    walkAST(root, (node) => {
      if (node.kind === "VariableExpression") {
        this.typeOfVariable(node as VariableExpression, ctx, unit);
      } else if (node.kind === "FunctionCallExpression") {
        this.call(node as FunctionCallExpression, ctx, unit);
      } else if (node.kind === "MethodCallExpression") {
        this.methodCall(node as MethodCallExpression, ctx, unit);
      }
    });
  }

  private unresolved(unit: Unit, node: ASTNode, reason: string): void {
    unit.unresolved ??= { node, reason };
  }

  /** The type of a variable access, running the accessors it reaches. */
  private typeOfVariable(
    v: VariableExpression,
    ctx: Context,
    unit: Unit,
  ): { ty: Typed; dynamic: boolean } {
    const upper = v.name.toUpperCase();
    let ty: Typed;
    let dynamic = false;
    if (upper === "THIS" && ctx.fb) {
      ty = { name: ctx.fb.name.toUpperCase(), refs: [] };
      dynamic = true;
    } else if (upper === "SUPER" && ctx.fb) {
      ty =
        ctx.fb.extends === undefined
          ? undefined
          : { name: ctx.fb.extends.toUpperCase(), refs: [] };
    } else {
      const resolved = this.resolve(upper, ctx);
      if (resolved?.global !== undefined) unit.reads.add(resolved.global);
      if (resolved !== undefined) {
        ty = this.tyOf(resolved.type);
      } else {
        // A property of the function block, read or written bare
        const prop = ctx.fb && this.findProperty(ctx.fb, upper);
        if (prop === undefined) return { ty: undefined, dynamic };
        this.runProperty(unit, prop.fb, prop.prop);
        ty = this.tyOf(prop.prop.type);
      }
    }
    for (const step of stepsOf(v)) {
      if (ty === undefined || ty === UNKNOWN) break;
      if (step.kind === "subscript") {
        const base = "array" in ty ? ty : this.deAlias(ty);
        // A character of a STRING, or an element of a library array
        ty =
          base !== undefined && base !== UNKNOWN && "array" in base
            ? base.array
            : undefined;
      } else if (step.kind === "dereference") {
        const base = this.deAlias(ty);
        if (base === UNKNOWN || base === undefined || "array" in base) {
          ty = UNKNOWN;
        } else if (base.refs.length === 0) {
          ty = UNKNOWN;
        } else {
          ty = { name: base.name, refs: base.refs.slice(1) };
          dynamic = true;
        }
      } else {
        const r = this.field(ty, step.name, v, unit);
        ty = r.ty;
        dynamic ||= r.dynamic;
      }
    }
    return { ty, dynamic };
  }

  /** The type of member `name` of a value of `ty`, running a property's accessors. */
  private field(
    ty: Ty,
    name: string,
    node: ASTNode,
    unit: Unit,
  ): { ty: Typed; dynamic: boolean } {
    const base = this.deAlias(ty);
    if (base === undefined || base === UNKNOWN || "array" in base) {
      return { ty: base === undefined ? undefined : UNKNOWN, dynamic: false };
    }
    let dynamic = false;
    let refs = base.refs;
    if (refs[0] === "reference_to") {
      refs = refs.slice(1);
      dynamic = true;
    }
    if (refs.length > 0) return { ty: UNKNOWN, dynamic };
    const upper = name.toUpperCase();
    if (this.interfaces.has(base.name)) {
      this.unresolved(unit, node, "a property used through an interface");
      return { ty: UNKNOWN, dynamic };
    }
    const fb = this.fbs.get(base.name);
    if (fb !== undefined) {
      const member = this.findMember(fb, upper);
      if (member !== undefined) return { ty: this.tyOf(member.type), dynamic };
      const prop = this.findProperty(fb, upper);
      if (prop !== undefined) {
        this.runProperty(unit, prop.fb, prop.prop);
        return { ty: this.tyOf(prop.prop.type), dynamic };
      }
      return { ty: undefined, dynamic }; // a member of a library base
    }
    const struct = this.structs.get(base.name);
    if (struct !== undefined) {
      const f = struct.fields.find((d) =>
        d.names.some((n) => n.toUpperCase() === upper),
      );
      return { ty: f === undefined ? UNKNOWN : this.tyOf(f.type), dynamic };
    }
    return { ty: undefined, dynamic };
  }

  private call(c: FunctionCallExpression, ctx: Context, unit: Unit): void {
    const parts = c.functionName.split(".").map((p) => p.toUpperCase());
    if (c.instance !== undefined) {
      // `units[0]()`: the element's FB body runs
      const ty =
        c.instance.kind === "VariableExpression"
          ? this.typeOfVariable(c.instance, ctx, unit).ty
          : UNKNOWN;
      return this.callInstance(ty, c, unit);
    }
    if (parts.length === 1) {
      const name = parts[0]!;
      if (ctx.fb && this.findMethodInChain(ctx.fb, name)) {
        return this.memberCall(
          { name: ctx.fb.name.toUpperCase(), refs: [] },
          name,
          true,
          c,
          unit,
        );
      }
      const resolved = this.resolve(name, ctx);
      if (resolved !== undefined) {
        if (resolved.global !== undefined) unit.reads.add(resolved.global);
        return this.callInstance(this.tyOf(resolved.type), c, unit);
      }
      const f = this.functions.get(name);
      if (f !== undefined) this.runFunction(unit, f);
      return;
    }
    const head = parts[0]!;
    let ty: Typed;
    let dynamic = false;
    if ((head === "THIS" || head === "SUPER") && ctx.fb) {
      const fb =
        head === "THIS"
          ? ctx.fb
          : this.fbs.get((ctx.fb.extends ?? "").toUpperCase());
      if (fb === undefined) return;
      ty = { name: fb.name.toUpperCase(), refs: [] };
      dynamic = head === "THIS";
    } else {
      const resolved = this.resolve(head, ctx);
      if (resolved === undefined) return; // a namespace or library call
      if (resolved.global !== undefined) unit.reads.add(resolved.global);
      ty = this.tyOf(resolved.type);
    }
    for (const name of parts.slice(1, -1)) {
      if (ty === undefined || ty === UNKNOWN || "array" in ty) {
        ty = ty === undefined ? undefined : UNKNOWN;
        break;
      }
      const r = this.field(ty, name, c, unit);
      ty = r.ty;
      dynamic ||= r.dynamic;
    }
    this.memberCall(ty, parts[parts.length - 1]!, dynamic, c, unit);
  }

  private methodCall(c: MethodCallExpression, ctx: Context, unit: Unit): void {
    let object: Expression = c.object;
    while (object.kind === "ParenthesizedExpression")
      object = object.expression;
    if (object.kind !== "VariableExpression") {
      return this.unresolved(unit, c, "a method called on a call result");
    }
    const { ty, dynamic } = this.typeOfVariable(object, ctx, unit);
    this.memberCall(ty, c.methodName.toUpperCase(), dynamic, c, unit);
  }

  /** A call of the instance `ty` itself: its FB bodies run. */
  private callInstance(ty: Typed, node: ASTNode, unit: Unit): void {
    if (ty === UNKNOWN) {
      return this.unresolved(
        unit,
        node,
        "a call whose instance cannot be followed",
      );
    }
    const base = ty === undefined ? undefined : this.deAlias(ty);
    if (base === undefined || base === UNKNOWN || "array" in base) return;
    if (this.interfaces.has(base.name)) {
      return this.unresolved(unit, node, "a call through an interface");
    }
    const fb = this.fbs.get(base.name);
    if (fb !== undefined && base.refs.every((r) => r === "reference_to")) {
      this.runBody(unit, fb);
    }
  }

  /** `a.M()` with `ty` the type of `a`; `dynamic` when `a` may be a derived instance. */
  private memberCall(
    ty: Typed,
    name: string,
    dynamic: boolean,
    node: ASTNode,
    unit: Unit,
  ): void {
    if (ty === UNKNOWN) {
      return this.unresolved(
        unit,
        node,
        "a call whose receiver cannot be followed",
      );
    }
    const base = ty === undefined ? undefined : this.deAlias(ty);
    if (base === undefined || base === UNKNOWN || "array" in base) return;
    let refs = base.refs;
    if (refs[0] === "reference_to") {
      refs = refs.slice(1);
      dynamic = true;
    }
    if (refs.length > 0) return;
    if (this.interfaces.has(base.name)) {
      return this.unresolved(unit, node, "a call through an interface");
    }
    const fb = this.fbs.get(base.name);
    if (fb === undefined) return; // a library function block
    const found = this.findMethodInChain(fb, name);
    if (found !== undefined) {
      this.runMethod(unit, found.fb, found.method);
      // An instance reached through a pointer, reference or THIS may be derived
      if (dynamic) {
        for (const derived of this.descendants.get(fb.name.toUpperCase()) ??
          []) {
          const override = this.findMethod(derived, name);
          if (override !== undefined) this.runMethod(unit, derived, override);
        }
      }
      return;
    }
    // `a.b()`: a function block member b of a, called
    const member = this.findMember(fb, name);
    if (member !== undefined)
      this.callInstance(this.tyOf(member.type), node, unit);
  }

  /** A name of a body: a local, a member, or a global (by VAR_EXTERNAL too). */
  private resolve(
    upper: string,
    ctx: Context,
  ): { type: TypeReference | undefined; global?: string } | undefined {
    if (ctx.result?.toUpperCase() === upper) return { type: undefined };
    const blocks = [
      ...ctx.blocks,
      ...(ctx.fb ? this.chain(ctx.fb).flatMap((f) => f.varBlocks) : []),
    ];
    for (const block of blocks) {
      for (const decl of block.declarations) {
        if (!decl.names.some((n) => n.toUpperCase() === upper)) continue;
        const global =
          block.blockType === "VAR_EXTERNAL"
            ? this.owner.get(upper)
            : undefined;
        return global === undefined
          ? { type: decl.type }
          : { type: decl.type, global };
      }
    }
    if (ctx.fb && this.findProperty(ctx.fb, upper)) return undefined;
    const global = this.owner.get(upper);
    return global === undefined
      ? undefined
      : { type: this.globalTypes.get(global), global };
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

function refsOf(type: TypeReference): string[] {
  if (type.referenceChain !== undefined) return [...type.referenceChain];
  const kind = type.referenceKind ?? "none";
  return kind === "none" ? [] : [kind];
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
