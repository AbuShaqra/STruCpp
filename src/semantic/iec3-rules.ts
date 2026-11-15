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
  MethodDeclaration,
  ProgramDeclaration,
  ProgramInstance,
  PropertyDeclaration,
  TypeDeclaration,
  VarBlock,
  VarDeclaration,
} from "../frontend/ast.js";
import { walkAST } from "../ast-utils.js";
import type { CompileError, SourceSpan } from "../types.js";

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
 * A locator over the source texts by file: the first whole-word occurrence
 * of the name inside its span, with its spelling as written. A name not
 * found there is reported at the span's start, as the AST holds it.
 */
export function sourceNameLocator(
  sources: ReadonlyMap<string, string>,
): NameLocator {
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
    const m = re.exec(text);
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

/** Ed. 3 spelling errors for the names test-file VAR blocks declare. */
export function iec3VarBlockIdentifierErrors(
  blocks: readonly VarBlock[],
  inlineTypes: readonly TypeDeclaration[] = [],
): CompileError[] {
  const names: DeclaredName[] = [];
  varBlockNames(blocks, names);
  for (const t of inlineTypes) {
    if (t.definition.kind === "EnumDefinition") enumNames(t.definition, names);
  }
  return identifierErrors(names);
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

/** The key of a call's position, which a copy of the call shares. */
function callKey(call: FunctionCallExpression): string {
  const s = call.sourceSpan;
  return `${s.file ?? ""}:${s.startLine}:${s.startCol}`;
}

/**
 * The untyped `TRUNC(...)` calls of `ast` that name a user TRUNC: a FUNCTION
 * TRUNC anywhere, or a METHOD or ACTION TRUNC of the enclosing PROGRAM or
 * FUNCTION_BLOCK or of a FUNCTION_BLOCK it extends.
 */
export function userTruncCalls(
  ast: CompilationUnit,
): (call: FunctionCallExpression) => boolean {
  if (ast.functions.some((f) => f.name.toUpperCase() === "TRUNC")) {
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
    outerActions(pou.name).some(isTrunc);
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
      cur = base !== undefined ? fbs.get(base.toUpperCase()) : undefined;
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
    if (!inScope(pou)) continue;
    collect(pou);
    for (const a of outerActions(pou.name)) collect(a);
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
        for (const stmt of loop.body) {
          walkAST(stmt, (inner) => {
            if (
              inner.kind === "AssignmentStatement" &&
              storesTo(inner as AssignmentStatement, control)
            ) {
              warn(
                `IEC 61131-3 Ed. 3 does not allow the FOR control variable '${loop.controlVariable}' to be changed in the loop body; use a WHILE or REPEAT loop to step it yourself`,
                inner.sourceSpan,
              );
            }
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
