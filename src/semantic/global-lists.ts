// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * Named global variable lists (feature `named_global_lists`).
 *
 * The top-level VAR_GLOBAL blocks of one source file form a global variable
 * list. Its name defaults to the file's stem and the caller may override it
 * per file. With the feature on, `LIST.var` (and any member, subscript or
 * dereference chain after it) reaches the global `var` of that list.
 *
 * The analyzer runs two steps:
 *
 * 1. {@link prepareGlobalLists}, before the symbol tables are built: collects
 *    the lists and, with the feature on, renames each global whose name is
 *    declared by two or more lists to its list name (`LIST__NAME`), so each
 *    keeps its own storage. Other globals keep their names.
 * 2. {@link GlobalListResolver.rewriteStatements}, per POU body before type
 *    checking: rewrites a qualified access in place to the unqualified form
 *    the parser builds for `var...`, with the name that reaches the global.
 *    That is the global's own name, its renamed name, or, when a local of
 *    the same name hides the global, an alias `LIST__NAME` the analyzer
 *    defines and code generation emits as a C++ reference to the global.
 *
 * So every later pass, code generation included, sees an ordinary access to
 * a global; source that uses none of this generates the same C++ as before.
 *
 * A list name is consulted last: when the name before the dot resolves to
 * anything else in the body (a variable, POU, type, enum value, function or
 * method name, THIS/SUPER), that wins and nothing is rewritten.
 */

import type {
  CompilationUnit,
  Expression,
  FunctionCallExpression,
  MethodCallExpression,
  Statement,
  VarBlock,
  VariableExpression,
} from "../frontend/ast.js";
import type { SourceSpan } from "../types.js";

/** An IEC 61131-3 identifier; a list name must be one to be usable. */
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** True when `name` can be written as a global variable list name. */
export function isGlobalListName(name: string): boolean {
  return IDENTIFIER_RE.test(name);
}

/**
 * The default list name for a source file: its base name without the last
 * extension (`dir/GVL_A.st` gives `GVL_A`).
 */
export function defaultGlobalListName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/** Record `listName` on every top-level VAR_GLOBAL block of one source file's unit. */
export function nameGlobalLists(unit: CompilationUnit, listName: string): void {
  for (const block of unit.globalVarBlocks) block.globalListName = listName;
}

/**
 * The name a global of list `list` gets when it must be told apart from a
 * same-named variable: `LIST__NAME`, upper-case. IEC identifiers cannot hold
 * `__`, so it collides with no user name.
 */
export function listQualifiedName(list: string, name: string): string {
  return `${list.toUpperCase()}__${name.toUpperCase()}`;
}

/** One global variable list: its name and the variables it declares. */
export interface GlobalList {
  /** The list name as given (file stem or override). */
  name: string;
  /** Upper-case declared name of each variable or constant → the name it is declared under now. */
  variables: Map<string, string>;
  /** File of its first block, when known. */
  file: string | undefined;
}

/**
 * A diagnostic produced while collecting lists or rewriting access: an error
 * `message`, or the refusal of `access` (`LIST.var`) while the feature is off.
 */
export type GlobalListDiagnostic =
  | { featureRefusal: false; message: string; span: SourceSpan }
  | { featureRefusal: true; access: string; span: SourceSpan };

/** The lists of a unit and the global names more than one list declares. */
export interface GlobalLists {
  /** Lists by upper-case name. */
  lists: Map<string, GlobalList>;
  /** Upper-case variable name → names of the lists declaring it (two or more). */
  ambiguous: Map<string, string[]>;
  /** Internal names of renamed globals that the program also declares. */
  clashing: Set<string>;
}

/** The blocks that form lists: top-level VAR_GLOBAL blocks with an identifier list name. */
function listBlocks(ast: CompilationUnit): Array<[VarBlock, string]> {
  const out: Array<[VarBlock, string]> = [];
  for (const block of ast.globalVarBlocks) {
    const name = block.globalListName;
    if (name !== undefined && isGlobalListName(name)) out.push([block, name]);
  }
  return out;
}

/** Upper-case names of the unit's POUs, types and top-level globals. */
function declaredNames(ast: CompilationUnit): Set<string> {
  const names = [
    ...ast.programs.map((p) => p.name),
    ...ast.functions.map((f) => f.name),
    ...ast.functionBlocks.map((f) => f.name),
    ...ast.interfaces.map((i) => i.name),
    ...ast.types.map((t) => t.name),
    ...ast.globalVarBlocks.flatMap((b) =>
      b.declarations.flatMap((d) => d.names),
    ),
  ];
  return new Set(names.map((n) => n.toUpperCase()));
}

/**
 * Collect the lists of a merged unit. With `enabled`, a list name used by two
 * files is reported at the second file's first block, and each global whose
 * name two or more lists declare is renamed to {@link listQualifiedName}.
 */
export function prepareGlobalLists(
  ast: CompilationUnit,
  enabled: boolean,
  report: (d: GlobalListDiagnostic) => void,
): GlobalLists {
  const lists = new Map<string, GlobalList>();
  const declaredBy = new Map<string, Set<string>>();
  const reported = new Set<string>();
  const blocks = listBlocks(ast);
  for (const [block, name] of blocks) {
    const key = name.toUpperCase();
    const file = block.sourceSpan.file || undefined;
    let list = lists.get(key);
    if (!list) {
      list = { name, variables: new Map(), file };
      lists.set(key, list);
    } else if (list.file !== file) {
      const dupKey = `${key}\u0000${file ?? ""}`;
      if (enabled && !reported.has(dupKey)) {
        reported.add(dupKey);
        report({
          message: `Global variable list '${name}' is declared in both '${list.file ?? "?"}' and '${file ?? "?"}'; give one of them another list name`,
          span: block.sourceSpan,
          featureRefusal: false,
        });
      }
    }
    for (const decl of block.declarations) {
      for (const varName of decl.names) {
        const upper = varName.toUpperCase();
        list.variables.set(upper, varName);
        const owners = declaredBy.get(upper) ?? new Set<string>();
        owners.add(list.name.toUpperCase());
        declaredBy.set(upper, owners);
      }
    }
  }

  const ambiguous = new Map<string, string[]>();
  const clashing = new Set<string>();
  if (!enabled) return { lists, ambiguous, clashing };
  for (const [upper, owners] of declaredBy) {
    if (owners.size < 2) continue;
    ambiguous.set(
      upper,
      [...owners].map((o) => lists.get(o)?.name ?? o),
    );
  }
  if (ambiguous.size === 0) return { lists, ambiguous, clashing };
  const taken = declaredNames(ast);
  for (const [block, name] of blocks) {
    const list = lists.get(name.toUpperCase());
    for (const decl of block.declarations) {
      decl.names = decl.names.map((varName) => {
        const upper = varName.toUpperCase();
        if (!ambiguous.has(upper)) return varName;
        const renamed = listQualifiedName(name, varName);
        if (taken.has(renamed)) {
          clashing.add(renamed);
          report({
            message: `'${name}.${upper}' is reached through the name '${renamed}', which this program also declares; rename that declaration`,
            span: decl.sourceSpan,
            featureRefusal: false,
          });
        }
        list?.variables.set(upper, renamed);
        return renamed;
      });
    }
  }
  return { lists, ambiguous, clashing };
}

/** Name resolution in the POU body being rewritten, supplied by the analyzer. */
export interface GlobalListScope {
  /** True when `name` resolves to anything in the body, a list excepted. */
  resolvesOtherwise(name: string): boolean;
  /**
   * True when an unqualified `name` in the body reaches something other than
   * the global of that name (a local, member, return value or THIS/SUPER).
   */
  hidesGlobal(name: string): boolean;
  /**
   * Make `alias` a second name of the global `name` for the rest of the
   * compile; false when another symbol already has that name.
   */
  defineAlias(name: string, alias: string): boolean;
}

/** Rewrites qualified global list access in statements, reporting what it refuses. */
export class GlobalListResolver {
  constructor(
    private readonly lists: GlobalLists,
    private readonly enabled: boolean,
    private readonly report: (d: GlobalListDiagnostic) => void,
  ) {}

  /** Rewrite every qualified access in `stmts` (recursively) in place. */
  rewriteStatements(stmts: Statement[], scope: GlobalListScope): void {
    if (this.lists.lists.size === 0) return;
    for (const stmt of stmts) this.rewriteStatement(stmt, scope);
  }

  /**
   * Rewrite every qualified access in the initial values and init argument
   * lists of `blocks` in place, as in a body.
   */
  rewriteDeclarations(
    blocks: readonly VarBlock[],
    scope: GlobalListScope,
  ): void {
    if (this.lists.lists.size === 0) return;
    for (const block of blocks) {
      for (const decl of block.declarations) {
        if (decl.initialValue) {
          decl.initialValue = this.rewriteExpression(decl.initialValue, scope);
        }
        for (const arg of decl.fbInitArguments ?? []) {
          arg.value = this.rewriteExpression(arg.value, scope);
        }
      }
    }
  }

  /**
   * Report a plain use of `name` (a variable, an FB call or a VAR_EXTERNAL)
   * when two or more lists declare it and nothing else in the body does.
   */
  checkUnqualified(
    name: string,
    span: SourceSpan,
    scope: GlobalListScope,
  ): void {
    const owners = this.lists.ambiguous.get(name.toUpperCase());
    if (!owners || scope.resolvesOtherwise(name)) return;
    this.report({
      message: `'${name}' is declared in lists ${owners.join(" and ")}; qualify it as ${owners.map((o) => `${o}.${name}`).join(" or ")}`,
      span,
      featureRefusal: false,
    });
  }

  /** Report a VAR_EXTERNAL of a name two or more lists declare. */
  checkExternal(name: string, span: SourceSpan): void {
    const owners = this.lists.ambiguous.get(name.toUpperCase());
    if (!owners) return;
    this.report({
      message: `VAR_EXTERNAL '${name}' is ambiguous: it is declared in lists ${owners.join(" and ")}; access it as ${owners.map((o) => `${o}.${name}`).join(" or ")} instead`,
      span,
      featureRefusal: false,
    });
  }

  private rewriteStatement(stmt: Statement, scope: GlobalListScope): void {
    const ex = (e: Expression): Expression => this.rewriteExpression(e, scope);
    switch (stmt.kind) {
      case "AssignmentStatement":
        stmt.target = ex(stmt.target);
        stmt.value = ex(stmt.value);
        break;
      case "RefAssignStatement":
        stmt.target = ex(stmt.target);
        stmt.source = ex(stmt.source);
        break;
      case "FunctionCallStatement": {
        const call = ex(stmt.call);
        if (
          call.kind === "FunctionCallExpression" ||
          call.kind === "MethodCallExpression"
        ) {
          stmt.call = call;
        }
        break;
      }
      case "DeleteStatement":
        stmt.pointer = ex(stmt.pointer);
        break;
      case "ForStatement":
        this.checkUnqualified(stmt.controlVariable, stmt.sourceSpan, scope);
        stmt.start = ex(stmt.start);
        stmt.end = ex(stmt.end);
        if (stmt.step) stmt.step = ex(stmt.step);
        this.rewriteStatements(stmt.body, scope);
        break;
      case "IfStatement":
        stmt.condition = ex(stmt.condition);
        this.rewriteStatements(stmt.thenStatements, scope);
        for (const clause of stmt.elsifClauses) {
          clause.condition = ex(clause.condition);
          this.rewriteStatements(clause.statements, scope);
        }
        this.rewriteStatements(stmt.elseStatements, scope);
        break;
      case "WhileStatement":
        stmt.condition = ex(stmt.condition);
        this.rewriteStatements(stmt.body, scope);
        break;
      case "RepeatStatement":
        this.rewriteStatements(stmt.body, scope);
        stmt.condition = ex(stmt.condition);
        break;
      case "CaseStatement":
        stmt.selector = ex(stmt.selector);
        for (const c of stmt.cases) {
          for (const label of c.labels) {
            label.start = ex(label.start);
            if (label.end) label.end = ex(label.end);
          }
          this.rewriteStatements(c.statements, scope);
        }
        this.rewriteStatements(stmt.elseStatements, scope);
        break;
      case "AssertCall":
        stmt.args = stmt.args.map(ex);
        break;
      default:
        break;
    }
  }

  /** Rewrite the children of `expr`, then `expr` itself; returns its replacement. */
  private rewriteExpression(
    expr: Expression,
    scope: GlobalListScope,
  ): Expression {
    const ex = (e: Expression): Expression => this.rewriteExpression(e, scope);
    switch (expr.kind) {
      case "VariableExpression": {
        // `subscripts` and the chain's subscript steps share index nodes.
        const done = new Map<Expression, Expression>();
        const once = (e: Expression): Expression => {
          const hit = done.get(e);
          if (hit) return hit;
          const out = ex(e);
          done.set(e, out);
          return out;
        };
        expr.subscripts = expr.subscripts.map(once);
        for (const step of expr.accessChain ?? []) {
          if (step.kind === "subscript") step.indices = step.indices.map(once);
        }
        this.rewriteVariable(expr, scope);
        return expr;
      }
      case "FunctionCallExpression":
        for (const arg of expr.arguments) arg.value = ex(arg.value);
        if (expr.instance) {
          expr.instance = ex(expr.instance);
          // `GVL_A.units[0](...)`: the call names the global the path now starts at.
          if (expr.instance.kind === "VariableExpression") {
            expr.functionName = expr.instance.name;
          }
        }
        this.rewriteCallee(expr, scope);
        return expr;
      case "MethodCallExpression":
        for (const arg of expr.arguments) arg.value = ex(arg.value);
        expr.object = ex(expr.object);
        return this.foldMethodCall(expr);
      case "BinaryExpression":
        expr.left = ex(expr.left);
        expr.right = ex(expr.right);
        return expr;
      case "UnaryExpression":
        expr.operand = ex(expr.operand);
        return expr;
      case "ParenthesizedExpression":
        expr.expression = ex(expr.expression);
        return expr;
      case "RefExpression":
      case "DrefExpression":
        expr.operand = ex(expr.operand);
        return expr;
      case "ArrayLiteralExpression":
        expr.elements = expr.elements.map(ex);
        return expr;
      case "NewExpression":
        if (expr.arraySize) expr.arraySize = ex(expr.arraySize);
        return expr;
      case "StructInitializerExpression":
        for (const el of expr.elements) el.value = ex(el.value);
        return expr;
      default:
        return expr;
    }
  }

  /**
   * The list `head` names in this body, or undefined when it names none or
   * resolves to something else.
   */
  private listFor(
    head: string,
    scope: GlobalListScope,
  ): GlobalList | undefined {
    const list = this.lists.lists.get(head.toUpperCase());
    if (!list || scope.resolvesOtherwise(head)) return undefined;
    return list;
  }

  /**
   * Resolve `list.member`: the name the access is rewritten to, or undefined
   * when it is refused. With the feature off the refusal is reported and the
   * plain name returned, so the passes after (which it does not gate) see the
   * unqualified form.
   */
  private target(
    list: GlobalList,
    member: string,
    span: SourceSpan,
    scope: GlobalListScope,
  ): string | undefined {
    if (!this.enabled) {
      this.report({
        access: `${list.name}.${member}`,
        span,
        featureRefusal: true,
      });
      return member;
    }
    const declared = list.variables.get(member.toUpperCase());
    if (declared === undefined) {
      this.report({
        message: `'${member}' is not a variable of global variable list '${list.name}'`,
        span,
        featureRefusal: false,
      });
      return undefined;
    }
    let name = declared;
    if (declared.toUpperCase() === member.toUpperCase()) {
      if (!scope.hidesGlobal(declared)) return declared;
      name = listQualifiedName(list.name, declared);
    }
    // A local, or another global, already named like the internal name.
    if (scope.hidesGlobal(name)) return this.taken(list, member, name, span);
    if (name !== declared && !scope.defineAlias(declared, name)) {
      return this.taken(list, member, name, span);
    }
    return name;
  }

  /** Report that the internal name of `list.member` is declared by the program. */
  private taken(
    list: GlobalList,
    member: string,
    name: string,
    span: SourceSpan,
  ): undefined {
    this.report({
      message: `'${list.name}.${member}' is reached through the name '${name}', which this program also declares; rename that declaration`,
      span,
      featureRefusal: false,
    });
    return undefined;
  }

  /** `LIST.var...` becomes `<name>...`, exactly as the parser builds `var...`. */
  private rewriteVariable(
    expr: VariableExpression,
    scope: GlobalListScope,
  ): void {
    if (expr.globalList !== undefined) return;
    const chain = expr.accessChain;
    const first = chain ? chain[0] : undefined;
    const member = chain
      ? first?.kind === "field"
        ? first.name
        : undefined
      : expr.fieldAccess[0];
    const list =
      member === undefined ? undefined : this.listFor(expr.name, scope);
    if (member === undefined || !list) {
      this.checkUnqualified(expr.name, expr.sourceSpan, scope);
      return;
    }
    const name = this.target(list, member, expr.sourceSpan, scope);
    if (name === undefined) return;
    expr.globalList = list.name;
    expr.name = name;
    expr.fieldAccess = expr.fieldAccess.slice(1);
    if (chain) {
      if (chain.length > 1) expr.accessChain = chain.slice(1);
      else delete expr.accessChain;
    }
  }

  /** `LIST.fb(...)` / `LIST.s.fb(...)`: replace the list segment and member of the callee. */
  private rewriteCallee(
    expr: FunctionCallExpression,
    scope: GlobalListScope,
  ): void {
    if (expr.globalList !== undefined) return;
    const parts = expr.functionName.split(".");
    const head = parts[0] ?? "";
    const member = parts[1];
    const list = member === undefined ? undefined : this.listFor(head, scope);
    if (member === undefined || !list) {
      this.checkUnqualified(head, expr.sourceSpan, scope);
      return;
    }
    const name = this.target(list, member, expr.sourceSpan, scope);
    if (name === undefined) return;
    expr.globalList = list.name;
    expr.functionName = [name, ...parts.slice(2)].join(".");
  }

  /**
   * `LIST.fb.M()` parses as a method call on `LIST.fb`; once rewritten its
   * object is a bare name, which the parser writes as the call `fb.M()`.
   */
  private foldMethodCall(expr: MethodCallExpression): Expression {
    const obj = expr.object;
    if (
      obj.kind !== "VariableExpression" ||
      obj.globalList === undefined ||
      obj.accessChain !== undefined ||
      obj.fieldAccess.length > 0 ||
      obj.subscripts.length > 0 ||
      obj.isDereference
    ) {
      return expr;
    }
    const call: FunctionCallExpression = {
      kind: "FunctionCallExpression",
      functionName: `${obj.name}.${expr.methodName}`,
      arguments: expr.arguments,
      sourceSpan: expr.sourceSpan,
      globalList: obj.globalList,
    };
    return call;
  }
}
