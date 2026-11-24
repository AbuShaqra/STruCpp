// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * Rules of the built-in profile `iec-3` that no feature controls: they apply
 * when `--dialect iec-3` itself is selected, not under a profile that extends
 * it and not with no dialect (the same key as the type checker's iec-3 rules).
 *
 * - Identifier spelling (IEC 61131-3 Ed. 3, 6.1.2): a declared name may not
 *   hold two consecutive underscores or end with one. Errors, at the
 *   declaration only.
 * - Forms Ed. 3 deprecates or leaves implementer-defined: warnings, one per
 *   occurrence (`{external}`, a real literal with an exponent and no decimal
 *   point, a store to a FOR control variable in its loop, `8#` literals,
 *   untyped `TRUNC`). IL bodies are warned where IL is transpiled (index.ts).
 *
 * Also here, though keyed on `--dialect iec-3` or `--strict` (as the type
 * checker's ANY_BIT refusals are): an underscore in a numeric literal must
 * stand between two digits (Ed. 3 Table 5; Table 8 for durations).
 */

import type {
  ASTNode,
  ActionDeclaration,
  AssignmentStatement,
  CompilationUnit,
  EnumDefinition,
  ForStatement,
  FunctionBlockDeclaration,
  FunctionCallExpression,
  LiteralExpression,
  MethodCallExpression,
  MethodDeclaration,
  ProgramDeclaration,
  ProgramInstance,
  PropertyDeclaration,
  RefAssignStatement,
  RefExpression,
  TypeDeclaration,
  TypeReference,
  VarBlock,
  VarDeclaration,
  VariableExpression,
} from "../frontend/ast.js";
import { walkAST } from "../ast-utils.js";
import type { CompileError, SourceSpan } from "../types.js";
import type { IToken } from "chevrotain";

/**
 * Names the compiler reserves or generates before analysis, exempt from the
 * spelling rule: its own `__` operators and types, and the prefixes of the
 * names the AST builder and the IL transpiler create.
 */
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  "__NEW",
  "__DELETE",
  "__XWORD",
  "__XINT",
  "__UXINT",
  "__ISVALIDREF",
  "__POUNAME",
  "__POSITION",
]);
const RESERVED_PREFIXES = ["__INLINE_", "__VLA_", "__IL_"];

/** Why Ed. 3 refuses identifier `name`, or undefined when it is allowed. */
export function iec3IdentifierProblem(name: string): string | undefined {
  const upper = name.toUpperCase();
  if (
    RESERVED_NAMES.has(upper) ||
    RESERVED_PREFIXES.some((p) => upper.startsWith(p))
  ) {
    return undefined;
  }
  if (name.includes("__")) return "contain two consecutive underscores";
  if (name.endsWith("_")) return "end with an underscore";
  return undefined;
}

/** Locates a declared name and gives its spelling as written, when the source is known. */
export type NameLocator = (
  name: string,
  span: SourceSpan,
) => { line: number; column: number; spelling: string };

/**
 * The offset ranges `[start, end)` of `text` that hold no name: comments,
 * pragmas and string literals, in order.
 */
function nonCodeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let i = 0;
  const until = (close: string, from: number): number => {
    const at = text.indexOf(close, from);
    return at < 0 ? text.length : at + close.length;
  };
  while (i < text.length) {
    const two = text.slice(i, i + 2);
    let end = -1;
    if (two === "(*") end = until("*)", i + 2);
    else if (two === "/*") end = until("*/", i + 2);
    else if (two === "//") end = until("\n", i + 2);
    else if (text[i] === "{") end = until("}", i + 1);
    else if (text[i] === "'" || text[i] === '"') {
      const q = text[i]!;
      let j = i + 1;
      while (j < text.length && text[j] !== q && text[j] !== "\n") {
        j += text[j] === "$" ? 2 : 1;
      }
      end = Math.min(j + 1, text.length);
    }
    if (end < 0) {
      i++;
      continue;
    }
    ranges.push([i, end]);
    i = end;
  }
  return ranges;
}

/**
 * A locator over the source texts by file: the first whole-word occurrence
 * of the name inside its span outside comments, pragmas and strings, with its
 * spelling as written. A name not found there is reported at the span's
 * start, as the AST holds it.
 */
export function sourceNameLocator(
  sources: ReadonlyMap<string, string>,
): NameLocator {
  const skipped = new Map<string, Array<[number, number]>>();
  const inSkipped = (file: string, text: string, at: number): boolean => {
    let ranges = skipped.get(file);
    if (ranges === undefined) {
      ranges = nonCodeRanges(text);
      skipped.set(file, ranges);
    }
    let lo = 0;
    let hi = ranges.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const [start, end] = ranges[mid]!;
      if (at < start) hi = mid - 1;
      else if (at >= end) lo = mid + 1;
      else return true;
    }
    return false;
  };
  const lineStarts = new Map<string, number[]>();
  const startsOf = (file: string, text: string): number[] => {
    let starts = lineStarts.get(file);
    if (starts === undefined) {
      starts = [0];
      for (let i = 0; i < text.length; i++) {
        if (text[i] === "\n") starts.push(i + 1);
      }
      lineStarts.set(file, starts);
    }
    return starts;
  };
  return (name, span) => {
    const fallback = {
      line: span.startLine,
      column: span.startCol,
      spelling: name,
    };
    const text = sources.get(span.file);
    if (text === undefined || !/^[A-Za-z0-9_]+$/.test(name)) return fallback;
    const starts = startsOf(span.file, text);
    const from = (starts[span.startLine - 1] ?? 0) + span.startCol - 1;
    const to = (starts[span.endLine - 1] ?? text.length) + span.endCol;
    const re = new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`, "gi");
    re.lastIndex = from;
    let m = re.exec(text);
    while (m !== null && m.index < to && inSkipped(span.file, text, m.index)) {
      m = re.exec(text);
    }
    if (m === null || m.index >= to) return fallback;
    let line = span.startLine;
    while ((starts[line] ?? Infinity) <= m.index) line++;
    return {
      line,
      column: m.index - (starts[line - 1] ?? 0) + 1,
      spelling: m[0],
    };
  };
}

/** One declared name and where it is declared. */
interface DeclaredName {
  name: string;
  span: SourceSpan;
}

/** Each name a VAR block declares, inline enumeration members included. */
function varBlockNames(blocks: readonly VarBlock[], out: DeclaredName[]): void {
  for (const block of blocks) {
    for (const decl of block.declarations) varDeclNames(decl, out);
  }
}

function varDeclNames(decl: VarDeclaration, out: DeclaredName[]): void {
  decl.names.forEach((name, i) => {
    const own = decl.nameSpans?.[i];
    out.push(
      own !== undefined
        ? { name, span: { ...own, file: decl.sourceSpan.file } }
        : { name, span: decl.sourceSpan },
    );
  });
  const inline = decl.type.inlineDefinition;
  if (inline?.kind === "EnumDefinition") enumNames(inline, out);
}

function enumNames(def: EnumDefinition, out: DeclaredName[]): void {
  for (const m of def.members) {
    out.push({ name: m.name, span: m.sourceSpan });
  }
}

/** Every name a compilation unit declares, as written by the user (before lowering). */
function unitDeclaredNames(unit: CompilationUnit): DeclaredName[] {
  const out: DeclaredName[] = [];
  const pou = (n: { name: string; sourceSpan: SourceSpan }): void => {
    out.push({ name: n.name, span: n.sourceSpan });
  };
  const method = (m: MethodDeclaration): void => {
    out.push(
      m.nameSpan !== undefined
        ? { name: m.name, span: m.nameSpan }
        : { name: m.name, span: m.sourceSpan },
    );
  };
  const property = (p: PropertyDeclaration): void => {
    pou(p);
    varBlockNames(p.getterVarBlocks ?? [], out);
    varBlockNames(p.setterVarBlocks ?? [], out);
  };
  for (const a of unit.actions) pou(a);
  for (const owner of [...unit.programs, ...unit.functionBlocks]) {
    for (const a of owner.actions) pou(a);
  }
  walkAST(unit, (node: ASTNode) => {
    switch (node.kind) {
      case "ProgramDeclaration":
      case "FunctionDeclaration":
      case "FunctionBlockDeclaration":
      case "InterfaceDeclaration":
      case "ConfigurationDeclaration":
      case "ResourceDeclaration":
      case "TaskDeclaration":
        pou(node as ASTNode & { name: string });
        break;
      case "TypeDeclaration":
        pou(node as TypeDeclaration);
        break;
      case "MethodDeclaration":
        method(node as MethodDeclaration);
        break;
      case "PropertyDeclaration":
        property(node as PropertyDeclaration);
        break;
      case "ProgramInstance": {
        const inst = node as ProgramInstance;
        pou({ name: inst.instanceName, sourceSpan: inst.sourceSpan });
        break;
      }
      case "VarDeclaration":
        varDeclNames(node as VarDeclaration, out);
        break;
      case "EnumMember": {
        const m = node as ASTNode & { name: string };
        out.push({ name: m.name, span: m.sourceSpan });
        break;
      }
      default:
        break;
    }
  });
  return out;
}

/** The errors for names Ed. 3 refuses, one per declaration site. */
function identifierErrors(
  names: readonly DeclaredName[],
  locate?: NameLocator,
): CompileError[] {
  const errors: CompileError[] = [];
  const seen = new Set<string>();
  for (const d of names) {
    const problem = iec3IdentifierProblem(d.name);
    if (problem === undefined) continue;
    const at = locate?.(d.name, d.span) ?? {
      line: d.span.startLine,
      column: d.span.startCol,
      spelling: d.name,
    };
    const key = `${d.span.file}:${at.line}:${at.column}:${d.name.toUpperCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    errors.push({
      message: `Identifier '${at.spelling}' is not allowed in IEC 61131-3 Ed. 3: an identifier may not ${problem}; rename it`,
      line: at.line,
      column: at.column,
      severity: "error",
      ...(d.span.file ? { file: d.span.file } : {}),
    });
  }
  return errors;
}

/** Ed. 3 spelling errors for every name a unit declares; run before lowering. */
export function iec3IdentifierErrors(
  unit: CompilationUnit,
  locate?: NameLocator,
): CompileError[] {
  const names = unitDeclaredNames(unit).sort(
    (a, b) =>
      a.span.file.localeCompare(b.span.file) ||
      a.span.startLine - b.span.startLine ||
      a.span.startCol - b.span.startCol,
  );
  return identifierErrors(names, locate);
}

/** Ed. 3 spelling errors for the labels of IL bodies, at each label as written. */
export function iec3IlLabelErrors(
  labels: ReadonlyArray<{ name: string; line: number; column: number }>,
  file?: string,
): CompileError[] {
  return identifierErrors(
    labels.map((l) => ({
      name: l.name,
      span: {
        file: file ?? "",
        startLine: l.line,
        startCol: l.column,
        endLine: l.line,
        endCol: l.column + l.name.length,
      },
    })),
  );
}

/** Ed. 3 spelling errors for the names test-file VAR blocks declare. */
export function iec3VarBlockIdentifierErrors(
  blocks: readonly VarBlock[],
  inlineTypes: readonly TypeDeclaration[] = [],
  locate?: NameLocator,
): CompileError[] {
  const names: DeclaredName[] = [];
  varBlockNames(blocks, names);
  for (const t of inlineTypes) {
    if (t.definition.kind === "EnumDefinition") enumNames(t.definition, names);
  }
  return identifierErrors(names, locate);
}

/** The digits of a literal after its type prefix (`REAL#1E-4` → `1E-4`). */
function literalBody(raw: string): { prefix: string; body: string } {
  const m = /^([A-Za-z_][A-Za-z0-9_]*#)?(.*)$/s.exec(raw);
  return { prefix: m?.[1] ?? "", body: m?.[2] ?? raw };
}

/** The warning for a literal Ed. 3 deprecates or does not spell so, if any. */
function literalWarning(lit: LiteralExpression): string | undefined {
  const { prefix, body } = literalBody(lit.rawValue);
  if (body.startsWith("8#")) {
    const hex =
      typeof lit.value === "number" && Number.isInteger(lit.value)
        ? ` or ${prefix}16#${lit.value.toString(16).toUpperCase()}`
        : "";
    return `Octal literal '${lit.rawValue}' is deprecated in IEC 61131-3 Ed. 3; write it in decimal${hex}`;
  }
  if (
    lit.literalType === "REAL" &&
    /^[+-]?[0-9_]+[eE]/.test(body) &&
    !body.includes(".")
  ) {
    const fixed = body.replace(/^([+-]?[0-9_]+)([eE])/, "$1.0$2");
    return `Real literal '${lit.rawValue}' has no decimal point, which IEC 61131-3 Ed. 3 requires before the exponent; write ${prefix}${fixed}`;
  }
  return undefined;
}

/** A store to the plain variable `upperName` (no member, index or dereference). */
function storesTo(stmt: AssignmentStatement, upperName: string): boolean {
  const t = stmt.target;
  return (
    t.kind === "VariableExpression" &&
    t.name.toUpperCase() === upperName &&
    t.fieldAccess.length === 0 &&
    t.subscripts.length === 0 &&
    !t.isDereference &&
    (t.accessChain === undefined || t.accessChain.length === 0)
  );
}

/** The name of a plain variable access (no member, index or dereference). */
function plainName(e: ASTNode): string | undefined {
  if (e.kind !== "VariableExpression") return undefined;
  const v = e as VariableExpression;
  return v.fieldAccess.length === 0 &&
    v.subscripts.length === 0 &&
    !v.isDereference &&
    (v.accessChain === undefined || v.accessChain.length === 0)
    ? v.name
    : undefined;
}

/** A POU whose body holds a FOR loop: what its calls and references resolve against. */
interface PouContext {
  /** The POU's statements: where a reference to the control variable is taken. */
  body: readonly ASTNode[];
  /** The variables in scope, own before owner's before global, by upper-cased name. */
  vars: Map<string, TypeReference>;
  unit: CompilationUnit;
}

/** Map each FOR loop of `unit` to the POU it is written in. */
function mapLoopPous(
  unit: CompilationUnit,
  out: Map<ForStatement, PouContext>,
): void {
  const globals = [
    ...unit.globalVarBlocks,
    ...unit.configurations.flatMap((c) => c.varBlocks),
  ];
  const add = (
    body: readonly ASTNode[],
    blocks: ReadonlyArray<readonly VarBlock[]>,
  ): void => {
    const vars = new Map<string, TypeReference>();
    for (const list of [globals, ...[...blocks].reverse()]) {
      for (const b of list) {
        for (const d of b.declarations) {
          for (const n of d.names) vars.set(n.toUpperCase(), d.type);
        }
      }
    }
    const ctx: PouContext = { body, vars, unit };
    for (const stmt of body) {
      walkAST(stmt, (n) => {
        if (n.kind === "ForStatement") out.set(n as ForStatement, ctx);
      });
    }
  };
  for (const pou of [...unit.programs, ...unit.functionBlocks]) {
    add(pou.body, [pou.varBlocks]);
    for (const m of pou.methods) add(m.body, [m.varBlocks, pou.varBlocks]);
    for (const a of pou.actions) add(a.body, [pou.varBlocks]);
  }
  for (const f of unit.functions) add(f.body, [f.varBlocks]);
}

/**
 * The plain variables of `pou` that are given a reference to `control`
 * (`r := REF(i)`, `p := ADR(i)`, `r REF= i`), by upper-cased name.
 */
function aliasesOf(pou: PouContext, control: string): Set<string> {
  const out = new Set<string>();
  const isRefTo = (e: ASTNode): boolean => {
    if (e.kind === "RefExpression") {
      return plainName((e as RefExpression).operand)?.toUpperCase() === control;
    }
    if (e.kind !== "FunctionCallExpression") return false;
    const call = e as FunctionCallExpression;
    const fn = call.functionName.toUpperCase();
    if ((fn !== "REF" && fn !== "ADR") || call.arguments.length !== 1) {
      return false;
    }
    return plainName(call.arguments[0]!.value)?.toUpperCase() === control;
  };
  for (const stmt of pou.body) {
    walkAST(stmt, (n) => {
      if (n.kind === "AssignmentStatement") {
        const a = n as AssignmentStatement;
        const target = plainName(a.target);
        if (target !== undefined && isRefTo(a.value)) {
          out.add(target.toUpperCase());
        }
      } else if (n.kind === "RefAssignStatement") {
        const a = n as RefAssignStatement;
        const target = plainName(a.target);
        if (
          target !== undefined &&
          plainName(a.source)?.toUpperCase() === control
        ) {
          out.add(target.toUpperCase());
        }
      }
    });
  }
  out.delete(control);
  return out;
}

/**
 * A store through one of `aliases`: `r^ := v` for a REF_TO or POINTER TO,
 * `r := v` for a REFERENCE TO.
 */
function storesThrough(
  stmt: AssignmentStatement,
  aliases: ReadonlySet<string>,
  pou: PouContext,
): boolean {
  const t = stmt.target;
  if (t.kind === "DrefExpression") {
    const name = plainName(t.operand);
    return name !== undefined && aliases.has(name.toUpperCase());
  }
  if (t.kind !== "VariableExpression") return false;
  const v = t;
  const upper = v.name.toUpperCase();
  if (!aliases.has(upper)) return false;
  if (v.fieldAccess.length > 0 || v.subscripts.length > 0) return false;
  const chain = v.accessChain ?? [];
  const derefOnce = chain.length === 1 && chain[0]!.kind === "dereference";
  if (v.isDereference || derefOnce) {
    return chain.length <= 1;
  }
  return (
    chain.length === 0 && pou.vars.get(upper)?.referenceKind === "reference_to"
  );
}

/** What a parameter of a call does with the variable it is bound to. */
type ParamUse = "input" | "output" | "inout";

/**
 * How the arguments of `call` bind, when the callee is a FUNCTION or a
 * FUNCTION_BLOCK instance of the unit (no EXTENDS): the VAR_IN_OUT names, and
 * each position's parameter (VAR_INPUT, VAR_OUTPUT and VAR_IN_OUT in
 * declaration order, as codegen maps them).
 */
function paramSlots(
  call: FunctionCallExpression,
  pou: PouContext,
): { inouts: Set<string>; positional?: ParamUse[] } | undefined {
  if (call.instance !== undefined) return undefined;
  const upper = call.functionName.toUpperCase();
  let blocks: readonly VarBlock[] | undefined;
  const local = pou.vars.get(upper);
  if (local !== undefined) {
    const fb = pou.unit.functionBlocks.find(
      (f) => f.name.toUpperCase() === local.name.toUpperCase(),
    );
    if (fb === undefined || fb.extends !== undefined) return undefined;
    blocks = fb.varBlocks;
  } else {
    blocks = pou.unit.functions.find(
      (f) => f.name.toUpperCase() === upper,
    )?.varBlocks;
  }
  if (blocks === undefined) return undefined;
  const uses: Partial<Record<string, ParamUse>> = {
    VAR_INPUT: "input",
    VAR_OUTPUT: "output",
    VAR_IN_OUT: "inout",
  };
  const inouts = new Set<string>();
  const positional: ParamUse[] = [];
  for (const b of blocks) {
    const use = uses[b.blockType];
    if (use === undefined) continue;
    for (const d of b.declarations) {
      for (const n of d.names) {
        positional.push(use);
        if (use === "inout") inouts.add(n.toUpperCase());
      }
    }
  }
  // Positions are certain only when no argument is named
  return call.arguments.some((a) => a.name !== undefined)
    ? { inouts }
    : { inouts, positional };
}

/** The key of a call's position, which a copy of the call shares. */
function callKey(call: FunctionCallExpression): string {
  const s = call.sourceSpan;
  return `${s.file ?? ""}:${s.startLine}:${s.startCol}`;
}

/** True when `blocks` declare a variable named TRUNC (an FB instance called as `TRUNC(...)`). */
function declaresTruncVar(blocks: readonly VarBlock[]): boolean {
  return blocks.some((b) =>
    b.declarations.some((d) =>
      d.names.some((n) => n.toUpperCase() === "TRUNC"),
    ),
  );
}

/**
 * The untyped `TRUNC(...)` calls of `ast` that name a user TRUNC: a FUNCTION
 * or global variable TRUNC anywhere, a METHOD, ACTION or variable TRUNC of
 * the enclosing PROGRAM or FUNCTION_BLOCK or of a FUNCTION_BLOCK it extends,
 * or a local TRUNC of the enclosing FUNCTION or METHOD. `libraryBaseDeclares`
 * tells whether a base FUNCTION_BLOCK not in `ast` (a library's) may declare one.
 */
export function userTruncCalls(
  ast: CompilationUnit,
  libraryBaseDeclares: (base: string) => boolean = () => false,
): (call: FunctionCallExpression) => boolean {
  if (
    ast.functions.some((f) => f.name.toUpperCase() === "TRUNC") ||
    declaresTruncVar(ast.globalVarBlocks) ||
    ast.configurations.some((c) => declaresTruncVar(c.varBlocks))
  ) {
    return () => true;
  }
  const isTrunc = (d: { name: string }): boolean =>
    d.name.toUpperCase() === "TRUNC";
  const fbs = new Map(
    ast.functionBlocks.map((fb) => [fb.name.toUpperCase(), fb]),
  );
  // Out-of-POU `ACTION Owner.TRUNC`, while not yet lowered into its owner.
  const outerActions = (owner: string): ActionDeclaration[] =>
    ast.actions.filter((a) => a.owner?.toUpperCase() === owner.toUpperCase());
  const declares = (
    pou: ProgramDeclaration | FunctionBlockDeclaration,
  ): boolean =>
    pou.methods.some(isTrunc) ||
    pou.actions.some(isTrunc) ||
    outerActions(pou.name).some(isTrunc) ||
    declaresTruncVar(pou.varBlocks);
  const inScope = (
    pou: ProgramDeclaration | FunctionBlockDeclaration,
  ): boolean => {
    const seen = new Set<string>();
    let cur: ProgramDeclaration | FunctionBlockDeclaration | undefined = pou;
    while (cur !== undefined && !seen.has(cur.name.toUpperCase())) {
      if (declares(cur)) return true;
      seen.add(cur.name.toUpperCase());
      const base: string | undefined =
        cur.kind === "FunctionBlockDeclaration" ? cur.extends : undefined;
      if (base === undefined) return false;
      cur = fbs.get(base.toUpperCase());
      if (cur === undefined) return libraryBaseDeclares(base);
    }
    return false;
  };
  const keys = new Set<string>();
  const collect = (node: ASTNode): void =>
    walkAST(node, (inner) => {
      if (inner.kind !== "FunctionCallExpression") return;
      const call = inner as FunctionCallExpression;
      if (call.functionName.toUpperCase() === "TRUNC") keys.add(callKey(call));
    });
  for (const pou of [...ast.programs, ...ast.functionBlocks]) {
    if (inScope(pou)) {
      collect(pou);
      for (const a of outerActions(pou.name)) collect(a);
      continue;
    }
    for (const m of pou.methods) {
      if (declaresTruncVar(m.varBlocks)) collect(m);
    }
  }
  for (const f of ast.functions) {
    if (declaresTruncVar(f.varBlocks)) collect(f);
  }
  return (call) => keys.has(callKey(call));
}

/**
 * Ed. 3 warnings for the nodes under `roots`, one per occurrence: a node
 * reached twice (a copy at the same place) warns once. `userTrunc` tells an
 * untyped TRUNC call that names a user declaration, not the standard one.
 */
export function iec3Warnings(
  roots: readonly ASTNode[],
  userTrunc: (call: FunctionCallExpression) => boolean = () => false,
  /** Spells a name as written; without it a name shows as the AST holds it. */
  locate?: NameLocator,
): CompileError[] {
  const warnings: CompileError[] = [];
  const seen = new Set<string>();
  const warn = (message: string, span: SourceSpan): void => {
    const key = `${span.file}:${span.startLine}:${span.startCol}:${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    warnings.push({
      message,
      line: span.startLine,
      column: span.startCol,
      severity: "warning",
      ...(span.file ? { file: span.file } : {}),
    });
  };
  // The POU around each FOR loop of a compilation unit among `roots`
  const loopPou = new Map<ForStatement, PouContext>();
  for (const root of roots) {
    if (root.kind === "CompilationUnit") {
      mapLoopPous(root as CompilationUnit, loopPou);
    }
  }
  const visit = (node: ASTNode): void => {
    switch (node.kind) {
      case "ExternalCodePragma":
        warn(
          "{external} inline C++ is not IEC 61131-3 Ed. 3: a pragma's contents are implementer-defined, so the code is not portable; write it in ST",
          node.sourceSpan,
        );
        break;
      case "LiteralExpression": {
        const message = literalWarning(node as LiteralExpression);
        if (message !== undefined) warn(message, node.sourceSpan);
        break;
      }
      case "FunctionCallExpression": {
        const call = node as FunctionCallExpression;
        if (
          call.instance === undefined &&
          call.functionName.toUpperCase() === "TRUNC" &&
          !userTrunc(call)
        ) {
          warn(
            "TRUNC with no result type is deprecated in IEC 61131-3 Ed. 3; write the typed form TRUNC_<type>, such as TRUNC_DINT",
            call.sourceSpan,
          );
        }
        break;
      }
      case "ForStatement": {
        const loop = node as ForStatement;
        const control = loop.controlVariable.toUpperCase();
        const pou = loopPou.get(loop);
        const aliases =
          pou === undefined ? new Set<string>() : aliasesOf(pou, control);
        // The AST holds names upper-cased: spell it as the FOR statement does
        const spelling =
          locate?.(loop.controlVariable, loop.sourceSpan).spelling ??
          loop.controlVariable;
        const changed = (span: SourceSpan, how = ""): void =>
          warn(
            `IEC 61131-3 Ed. 3 does not allow the FOR control variable '${spelling}' to be changed in the loop body${how}; use a WHILE or REPEAT loop to step it yourself`,
            span,
          );
        for (const stmt of loop.body) {
          walkAST(stmt, (inner) => {
            if (inner.kind === "AssignmentStatement") {
              const a = inner as AssignmentStatement;
              if (storesTo(a, control)) {
                changed(a.sourceSpan);
              } else if (pou !== undefined && storesThrough(a, aliases, pou)) {
                changed(a.sourceSpan, " (here through a reference to it)");
              }
              return;
            }
            if (
              inner.kind !== "FunctionCallExpression" &&
              inner.kind !== "MethodCallExpression"
            ) {
              return;
            }
            const call = inner as FunctionCallExpression | MethodCallExpression;
            const slots =
              pou !== undefined && inner.kind === "FunctionCallExpression"
                ? paramSlots(inner as FunctionCallExpression, pou)
                : undefined;
            call.arguments.forEach((arg, i) => {
              if (plainName(arg.value)?.toUpperCase() !== control) return;
              const use: ParamUse | undefined = arg.isOutput
                ? "output"
                : arg.name === undefined
                  ? slots?.positional?.[i]
                  : slots?.inouts.has(arg.name.toUpperCase()) === true
                    ? "inout"
                    : undefined;
              if (use === "output") {
                changed(arg.value.sourceSpan, " (here by an output)");
              } else if (use === "inout") {
                changed(
                  arg.value.sourceSpan,
                  " (here as a VAR_IN_OUT argument)",
                );
              }
            });
          });
        }
        break;
      }
      default:
        break;
    }
  };
  for (const root of roots) walkAST(root, visit);
  return warnings;
}

/** The Ed. 3 warning for an Instruction List body of POU `pou`. */
export function iec3IlWarningMessage(pou: string): string {
  return `Instruction List (IL) is deprecated in IEC 61131-3 Ed. 3; write the body of '${pou}' in ST`;
}

/** The lexer tokens whose image is a numeric literal that may hold underscores. */
const NUMERIC_LITERAL_TOKENS: ReadonlySet<string> = new Set([
  "IntegerLiteral",
  "RealLiteral",
  "TypedLiteral",
  "CharLiteral",
  "TimeLiteral",
]);

/**
 * True when a numeric literal, as written, has an underscore Ed. 3 refuses:
 * one not between two digits of its base (leading, trailing, doubled, or
 * next to `#`, `.`, a sign or a unit). A duration may also put one between a
 * unit and the next number (`T#1d_2h`, Table 8). Quoted CHAR literals have none.
 */
export function literalUnderscoreRefused(image: string): boolean {
  if (!image.includes("_") || /['"]/.test(image)) return false;
  const time = /^(?:LTIME|LT|TIME|T)#(.*)$/is.exec(image);
  if (time !== null) {
    const body = time[1] ?? "";
    for (let i = 0; i < body.length; i++) {
      if (body[i] !== "_") continue;
      const prev = body[i - 1] ?? "";
      const next = body[i + 1] ?? "";
      if (!/[0-9]/.test(next) || !/[0-9A-Za-z]/.test(prev)) return true;
    }
    return false;
  }
  const hash = image.lastIndexOf("#");
  const payload = image.slice(hash + 1);
  const digit = /16#[^#]*$/.test(image) ? /[0-9A-Fa-f]/ : /[0-9]/;
  for (let i = 0; i < payload.length; i++) {
    if (payload[i] !== "_") continue;
    if (
      !digit.test(payload[i - 1] ?? "") ||
      !digit.test(payload[i + 1] ?? "")
    ) {
      return true;
    }
  }
  return false;
}

/** The error message for numeric literal `spelling` (see literalUnderscoreRefused). */
export function literalUnderscoreMessage(spelling: string): string {
  return `An underscore in a numeric literal must stand between two digits (IEC 61131-3 Ed. 3): '${spelling}'`;
}

/**
 * Errors for the numeric literals of one source whose underscores Ed. 3
 * refuses, at each literal, spelled as written. `tokens` are the lexer's
 * tokens of `text` (whose offsets the upper-casing lexer keeps).
 */
export function literalUnderscoreErrors(
  text: string,
  tokens: readonly IToken[],
  file?: string,
): CompileError[] {
  const errors: CompileError[] = [];
  for (const token of tokens) {
    if (!NUMERIC_LITERAL_TOKENS.has(token.tokenType.name)) continue;
    const spelling = text.slice(token.startOffset, (token.endOffset ?? 0) + 1);
    if (!literalUnderscoreRefused(spelling)) continue;
    errors.push({
      message: literalUnderscoreMessage(spelling),
      line: token.startLine ?? 0,
      column: token.startColumn ?? 0,
      severity: "error",
      ...(file !== undefined ? { file } : {}),
    });
  }
  return errors;
}
