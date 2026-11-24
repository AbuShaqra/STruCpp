// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * The file-level globals an initial value reads, through the calls it makes.
 *
 * `x : INT := f.M()` runs M when x is created, so x must be created after f
 * and after every global M reads, also through the methods, functions,
 * function block bodies and property getters M calls in turn. A call whose
 * reads cannot be followed (through an interface, a pointer or reference, or
 * a longer member chain) is reported, since no order can be shown right.
 * Library code cannot read the project's globals, so it is not followed.
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
  Statement,
  TypeReference,
  VarBlock,
  VariableExpression,
} from "../frontend/ast.js";
import { walkAST } from "../ast-utils.js";

/** What an initial value or body reads. */
export interface CallReads {
  /** The globals read, as `owner` maps them (upper-case). */
  globals: Set<string>;
  /** The first call whose reads cannot be followed, and why. */
  unresolved?: { node: ASTNode; reason: string };
}

/** The variables a body sees besides the globals. */
interface Context {
  /** The function block whose members and methods are in scope. */
  fb?: FunctionBlockDeclaration;
  /** The blocks of the method or function itself. */
  blocks: readonly VarBlock[];
  /** The method, function or getter name, which holds its result. */
  result?: string;
}

type Resolved =
  | { scope: "local"; type: TypeReference | undefined }
  | { scope: "global"; name: string; type: TypeReference | undefined };

/** Follows the reads of initial values through the POUs of `ast`. */
export class CallReadTracer {
  private readonly fbs = new Map<string, FunctionBlockDeclaration>();
  private readonly functions = new Map<string, FunctionDeclaration>();
  private readonly interfaces = new Set<string>();
  /** The project's own TYPE names (upper-case). */
  private readonly types = new Set<string>();
  private readonly aliases = new Map<string, TypeReference>();
  /** Reads of a POU body by key; an entry in progress reads nothing more. */
  private readonly memo = new Map<string, CallReads>();

  constructor(
    ast: CompilationUnit,
    /** Every name a global is reached by → the global (upper-case). */
    private readonly owner: ReadonlyMap<string, string>,
    /** Each global's declared type (upper-case keys). */
    private readonly globalTypes: ReadonlyMap<string, TypeReference>,
  ) {
    for (const fb of ast.functionBlocks)
      this.fbs.set(fb.name.toUpperCase(), fb);
    for (const f of ast.functions) {
      this.functions.set(f.name.toUpperCase(), f);
    }
    for (const i of ast.interfaces) this.interfaces.add(i.name.toUpperCase());
    for (const t of ast.types) {
      this.types.add(t.name.toUpperCase());
      if (t.definition.kind === "TypeReference") {
        this.aliases.set(t.name.toUpperCase(), t.definition);
      }
    }
  }

  /** The globals `value`, a global's initial value, reads. */
  initialValueReads(value: Expression): CallReads {
    const out: CallReads = { globals: new Set() };
    this.walk(value, { blocks: [] }, out);
    return out;
  }

  private walk(root: ASTNode, ctx: Context, out: CallReads): void {
    walkAST(root, (node) => {
      if (node.kind === "VariableExpression") {
        this.variable(node as VariableExpression, ctx, out);
      } else if (node.kind === "FunctionCallExpression") {
        this.call(node as FunctionCallExpression, ctx, out);
      } else if (node.kind === "MethodCallExpression") {
        this.methodCall(node as MethodCallExpression, ctx, out);
      }
    });
  }

  private variable(v: VariableExpression, ctx: Context, out: CallReads): void {
    const resolved = this.resolve(v.name, ctx);
    if (resolved?.scope === "global") out.globals.add(resolved.name);
    // `f.P` of a property runs its getter
    const first = v.accessChain?.[0];
    const fb =
      first?.kind === "field" && resolved !== undefined
        ? this.fbOf(resolved.type)
        : undefined;
    if (fb === undefined || first?.kind !== "field") return;
    const upper = first.name.toUpperCase();
    for (const owner of this.chain(fb)) {
      const prop = owner.properties.find((p) => p.name.toUpperCase() === upper);
      if (prop === undefined) continue;
      const method =
        prop.getterMethod === undefined
          ? undefined
          : this.findMethod(owner, prop.getterMethod);
      if (method !== undefined) {
        this.merge(this.methodReads(owner, method), out);
      } else {
        this.merge(
          this.bodyReads(`get:${owner.name}.${prop.name}`, prop.getter ?? [], {
            fb: owner,
            blocks: prop.getterVarBlocks ?? [],
            result: prop.name,
          }),
          out,
        );
      }
      return;
    }
  }

  private call(c: FunctionCallExpression, ctx: Context, out: CallReads): void {
    const parts = c.functionName.split(".");
    const head = parts[0]!.toUpperCase();
    if (parts.length === 1) {
      const own = ctx.fb && this.findMethodInChain(ctx.fb, head);
      if (own) return this.merge(this.methodReads(own.fb, own.method), out);
      const resolved = this.resolve(head, ctx);
      if (resolved !== undefined) {
        if (resolved.scope === "global") out.globals.add(resolved.name);
        const target = this.fbOf(resolved.type, c.instance !== undefined);
        if (target) this.merge(this.fbBodyReads(target), out);
        return;
      }
      const f = this.functions.get(head);
      if (f) {
        this.merge(
          this.bodyReads(`fn:${f.name}`, [...f.body], {
            blocks: f.varBlocks,
            result: f.name,
          }),
          out,
        );
      }
      return;
    }
    if ((head === "THIS" || head === "SUPER") && ctx.fb && parts.length === 2) {
      const start =
        head === "SUPER"
          ? this.fbs.get((ctx.fb.extends ?? "").toUpperCase())
          : ctx.fb;
      const found = start && this.findMethodInChain(start, parts[1]!);
      if (found) this.merge(this.methodReads(found.fb, found.method), out);
      return;
    }
    const resolved = this.resolve(head, ctx);
    if (resolved === undefined) return; // a namespace or library call
    if (resolved.scope === "global") out.globals.add(resolved.name);
    this.memberCall(resolved.type, parts.slice(1), c, out);
  }

  private methodCall(
    c: MethodCallExpression,
    ctx: Context,
    out: CallReads,
  ): void {
    const object = c.object;
    if (object.kind !== "VariableExpression") {
      return this.unresolved(c, "a method called on a call result", out);
    }
    const v = object;
    const resolved = this.resolve(v.name, ctx);
    if (resolved === undefined) return;
    const steps = v.accessChain ?? [];
    const fields = steps.flatMap((s) => (s.kind === "field" ? [s.name] : []));
    if (steps.some((s) => s.kind === "dereference")) {
      return this.unresolved(c, "a call through a pointer or reference", out);
    }
    this.memberCall(
      resolved.type,
      [...fields, c.methodName],
      c,
      out,
      steps.some((s) => s.kind === "subscript"),
    );
  }

  /** `a.M()` (or `a.b()`), with `type` the type of `a`. */
  private memberCall(
    type: TypeReference | undefined,
    rest: readonly string[],
    node: ASTNode,
    out: CallReads,
    element = false,
  ): void {
    if (type === undefined) return;
    if (
      (type.referenceKind ?? "none") !== "none" ||
      type.referenceChain !== undefined ||
      (type.elementReferenceChain ?? []).length > 0
    ) {
      return this.unresolved(
        node,
        "a call through a pointer or reference",
        out,
      );
    }
    const name = (
      element || type.arrayDimensions !== undefined
        ? (type.elementTypeName ?? type.name)
        : type.name
    ).toUpperCase();
    if (this.interfaces.has(this.aliasTarget(name))) {
      return this.unresolved(node, "a call through an interface", out);
    }
    const fb = this.fbs.get(this.aliasTarget(name));
    if (fb === undefined && !this.types.has(this.aliasTarget(name))) return;
    if (fb === undefined || rest.length > 1) {
      return this.unresolved(node, "a call through a member chain", out);
    }
    const found = this.findMethodInChain(fb, rest[0]!);
    if (found) return this.merge(this.methodReads(found.fb, found.method), out);
    // `a.b()`: a function block member b of a, called
    for (const owner of this.chain(fb)) {
      for (const block of owner.varBlocks) {
        for (const decl of block.declarations) {
          if (
            !decl.names.some((n) => n.toUpperCase() === rest[0]!.toUpperCase())
          ) {
            continue;
          }
          const member = this.fbOf(decl.type);
          if (member) this.merge(this.fbBodyReads(member), out);
          return;
        }
      }
    }
  }

  private unresolved(node: ASTNode, reason: string, out: CallReads): void {
    out.unresolved ??= { node, reason };
  }

  private merge(from: CallReads, into: CallReads): void {
    for (const g of from.globals) into.globals.add(g);
    if (from.unresolved) into.unresolved ??= from.unresolved;
  }

  private methodReads(
    fb: FunctionBlockDeclaration,
    method: MethodDeclaration,
  ): CallReads {
    return this.bodyReads(`m:${fb.name}.${method.name}`, method.body, {
      fb,
      blocks: method.varBlocks,
      result: method.name,
    });
  }

  private fbBodyReads(fb: FunctionBlockDeclaration): CallReads {
    // The body of each FB of the chain runs on a call
    const out: CallReads = { globals: new Set() };
    for (const owner of this.chain(fb)) {
      this.merge(
        this.bodyReads(`fb:${owner.name}`, owner.body, {
          fb: owner,
          blocks: [],
        }),
        out,
      );
    }
    return out;
  }

  private bodyReads(
    key: string,
    body: readonly Statement[],
    ctx: Context,
  ): CallReads {
    const upper = key.toUpperCase();
    const known = this.memo.get(upper);
    if (known) return known;
    const out: CallReads = { globals: new Set() };
    this.memo.set(upper, out);
    for (const block of ctx.blocks) {
      for (const decl of block.declarations) {
        if (decl.initialValue) this.walk(decl.initialValue, ctx, out);
      }
    }
    for (const statement of body) this.walk(statement, ctx, out);
    return out;
  }

  /** A name of a body: a local, a member, or a global (by VAR_EXTERNAL too). */
  private resolve(name: string, ctx: Context): Resolved | undefined {
    const upper = name.toUpperCase();
    if (ctx.result?.toUpperCase() === upper) {
      return { scope: "local", type: undefined };
    }
    const blocks = [
      ...ctx.blocks,
      ...(ctx.fb ? this.chain(ctx.fb).flatMap((f) => f.varBlocks) : []),
    ];
    for (const block of blocks) {
      for (const decl of block.declarations) {
        if (!decl.names.some((n) => n.toUpperCase() === upper)) continue;
        if (block.blockType !== "VAR_EXTERNAL") {
          return { scope: "local", type: decl.type };
        }
        const global = this.owner.get(upper);
        return global === undefined
          ? { scope: "local", type: decl.type }
          : { scope: "global", name: global, type: decl.type };
      }
    }
    const global = this.owner.get(upper);
    return global === undefined
      ? undefined
      : { scope: "global", name: global, type: this.globalTypes.get(global) };
  }

  /** The project function block `type` is an instance (or array element) of. */
  private fbOf(
    type: TypeReference | undefined,
    element = false,
  ): FunctionBlockDeclaration | undefined {
    if (
      type === undefined ||
      (type.referenceKind ?? "none") !== "none" ||
      type.referenceChain !== undefined
    ) {
      return undefined;
    }
    const name =
      element || type.arrayDimensions !== undefined
        ? (type.elementTypeName ?? type.name)
        : type.name;
    return this.fbs.get(this.aliasTarget(name.toUpperCase()));
  }

  private aliasTarget(upper: string): string {
    let name = upper;
    const seen = new Set<string>();
    for (;;) {
      const target = this.aliases.get(name);
      if (
        target === undefined ||
        seen.has(name) ||
        (target.referenceKind ?? "none") !== "none"
      ) {
        return name;
      }
      seen.add(name);
      name = target.name.toUpperCase();
    }
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
