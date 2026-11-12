// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * The operators `__POUNAME()`, `__POSITION()` and `BITADR(x)` of the feature
 * vendor_operators. Each call is a constant, so with the feature on it is
 * replaced by a literal before semantic analysis:
 *
 * - `__POUNAME()`: STRING, the name of the enclosing POU as declared;
 *   `FB.Method` in a method, `FB.Property` in a property accessor,
 *   `POU.Action` in an action, the TYPE in a STRUCT or UNION member's initial
 *   value, the list in a global variable list, the CONFIGURATION in its globals.
 * - `__POSITION()`: STRING, `'Line N, Column C (Impl)'` in a body and
 *   `'Line N (Decl)'` in a declaration, N and C counted from 1 in the file.
 * - `BITADR(x)`: DWORD, for a located variable `x`: the area in the top
 *   nibble (16#4 M, 16#8 I, 16#C Q), then the bit address, byte × 8 + bit,
 *   taking the address's number as a byte offset for every size.
 *
 * A FUNCTION, POU, method, TYPE or variable of the operator's name, in the
 * sources or a library, wins: the operator is then not lowered. See
 * docs/DIALECTS.md.
 */

import type {
  CompilationUnit,
  FunctionCallExpression,
  LiteralExpression,
  TestFile,
  VarBlock,
  VarDeclaration,
} from "../frontend/ast.js";
import type { CompileError, SourceSpan } from "../types.js";

/** The operators lowered here. */
export const POU_OPERATORS: ReadonlySet<string> = new Set([
  "__POUNAME",
  "__POSITION",
  "BITADR",
]);

/** The DWORD area flag of each located area. */
const AREA_FLAGS: Readonly<Record<string, number>> = {
  M: 0x4,
  I: 0x8,
  Q: 0xc,
};

/** Largest bit address below the area nibble. */
const MAX_BIT_ADDRESS = 0x0fffffff;

interface Context {
  /** The value of `__POUNAME()` here, or undefined where there is none. */
  pouName: string | undefined;
  section: "Decl" | "Impl";
  /** Variables in scope, by upper-case name, innermost first. */
  variables: ReadonlyMap<string, VarDeclaration>;
}

export interface PouOperatorOptions {
  /** Source text by file name, to give a name the spelling it was declared with. */
  sources: ReadonlyMap<string, string>;
  /** Whether a library declares a FUNCTION, FB or TYPE of the upper-case name. */
  declaredByLibrary: (nameUpper: string) => boolean;
}

/** Every name the unit declares (POUs, TYPEs, methods, variables), upper-case. */
function declaredNames(ast: CompilationUnit): Set<string> {
  const names = new Set<string>();
  const seen = new Set<object>();
  const visit = (node: unknown): void => {
    if (typeof node !== "object" || node === null || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const n = node as { kind?: unknown; name?: unknown; names?: unknown };
    if (
      (n.kind === "VarDeclaration" && Array.isArray(n.names)) ||
      (typeof n.kind === "string" &&
        n.kind.endsWith("Declaration") &&
        typeof n.name === "string")
    ) {
      const list = Array.isArray(n.names) ? n.names : [n.name];
      for (const name of list) {
        if (typeof name === "string") names.add(name.toUpperCase());
      }
    }
    for (const value of Object.values(node)) visit(value);
  };
  visit(ast);
  return names;
}

/** The spelling of `nameUpper` as first written at or after `span` in its file. */
function spelled(
  nameUpper: string,
  span: SourceSpan,
  sources: ReadonlyMap<string, string>,
): string {
  const text = sources.get(span.file);
  if (text === undefined) return nameUpper;
  const lines = text.split(/\r\n|\r|\n/);
  const from = [
    (lines[span.startLine - 1] ?? "").slice(Math.max(span.startCol - 1, 0)),
    ...lines.slice(span.startLine),
  ].join("\n");
  const escaped = nameUpper.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`,
    "i",
  ).exec(from);
  return match ? match[0] : nameUpper;
}

function varMap(
  blocks: ReadonlyArray<readonly VarBlock[]>,
): Map<string, VarDeclaration> {
  const map = new Map<string, VarDeclaration>();
  for (const list of blocks) {
    for (const block of list) {
      for (const decl of block.declarations) {
        for (const name of decl.names) {
          const upper = name.toUpperCase();
          if (!map.has(upper)) map.set(upper, decl);
        }
      }
    }
  }
  return map;
}

function stringLiteral(text: string, span: SourceSpan): LiteralExpression {
  const raw = `'${text.replace(/\$/g, "$$$$").replace(/'/g, "$$'")}'`;
  return {
    kind: "LiteralExpression",
    sourceSpan: span,
    literalType: "STRING",
    value: raw,
    rawValue: raw,
  };
}

function dwordLiteral(value: number, span: SourceSpan): LiteralExpression {
  const hex = value.toString(16).toUpperCase();
  return {
    kind: "LiteralExpression",
    sourceSpan: span,
    literalType: "INT",
    value,
    rawValue: `DWORD#16#${hex}`,
    typePrefix: "DWORD",
  };
}

/** The BITADR value of a `%` address, or an error message. */
export function bitAddressOf(address: string): number | string {
  const match = /^%([IQM])([XBWDL]?)(\d+)(?:\.(\d+))?$/i.exec(address);
  if (!match) {
    return `BITADR needs a complete address of the form %IX2.3, %QB4 or %MW8, not ${address}`;
  }
  const area = AREA_FLAGS[match[1]!.toUpperCase()]!;
  const size = (match[2] ?? "").toUpperCase() || "X";
  const byte = Number(match[3]);
  const bit = match[4] === undefined ? 0 : Number(match[4]);
  if (size !== "X" && match[4] !== undefined) {
    return `BITADR needs a complete address of the form %IX2.3, %QB4 or %MW8, not ${address}`;
  }
  if (bit > 7) return `BITADR: bit ${bit} of ${address} is not in 0..7`;
  const bitAddress = byte * 8 + bit;
  if (bitAddress > MAX_BIT_ADDRESS) {
    return `BITADR: ${address} is beyond the bit addresses a DWORD holds`;
  }
  return area * 0x10000000 + bitAddress;
}

/**
 * Replace each call of `__POUNAME`, `__POSITION` and `BITADR` that no
 * declaration shadows with its literal value. Calls in a place the operator
 * has no value for stay, and the analyzer refuses them.
 */
export function lowerPouOperators(
  ast: CompilationUnit,
  opts: PouOperatorOptions,
): CompileError[] {
  const errors: CompileError[] = [];
  const shadowed = declaredNames(ast);
  const active = new Set(
    [...POU_OPERATORS].filter(
      (op) => !shadowed.has(op) && !opts.declaredByLibrary(op),
    ),
  );
  if (active.size === 0) return errors;

  const globals = varMap([
    ast.globalVarBlocks,
    ...ast.configurations.map((c) => c.varBlocks),
  ]);
  const scope = (
    ...blocks: ReadonlyArray<readonly VarBlock[]>
  ): Map<string, VarDeclaration> => {
    const map = varMap(blocks);
    for (const [name, decl] of map) {
      const external =
        blocks.some((list) =>
          list.some(
            (b) =>
              b.blockType === "VAR_EXTERNAL" && b.declarations.includes(decl),
          ),
        ) && globals.get(name);
      if (external) map.set(name, external);
    }
    for (const [name, decl] of globals) if (!map.has(name)) map.set(name, decl);
    return map;
  };
  const name = (upper: string, span: SourceSpan): string =>
    spelled(upper, span, opts.sources);

  const fail = (message: string, span: SourceSpan): void => {
    errors.push({
      message,
      line: span.startLine,
      column: span.startCol,
      severity: "error",
      ...(span.file ? { file: span.file } : {}),
    });
  };

  const lowerCall = (
    call: FunctionCallExpression,
    ctx: Context,
  ): LiteralExpression | undefined => {
    const op = call.functionName.toUpperCase();
    const span = call.sourceSpan;
    if (op === "BITADR") {
      const arg = call.arguments[0];
      if (call.arguments.length !== 1 || arg!.name !== undefined) {
        fail(`BITADR takes one argument, got ${call.arguments.length}`, span);
        return dwordLiteral(0, span);
      }
      const value = arg!.value;
      const decl =
        value.kind === "VariableExpression" &&
        value.fieldAccess.length === 0 &&
        value.subscripts.length === 0 &&
        !value.isDereference &&
        (value.accessChain?.length ?? 0) === 0
          ? ctx.variables.get(value.name.toUpperCase())
          : undefined;
      if (!decl?.address || decl.addressKind === "alias") {
        const byName =
          value.kind === "VariableExpression" &&
          value.fieldAccess.length === 0 &&
          value.subscripts.length === 0;
        const what = byName
          ? `'${value.name.toUpperCase()}' is not one`
          : "write it by name";
        fail(
          `BITADR needs a located variable (declared AT %I, %Q or %M); ${what}`,
          value.sourceSpan,
        );
        return dwordLiteral(0, span);
      }
      const bitAddress = bitAddressOf(decl.address);
      if (typeof bitAddress === "string") {
        fail(bitAddress, value.sourceSpan);
        return dwordLiteral(0, span);
      }
      return dwordLiteral(bitAddress, span);
    }
    if (call.arguments.length > 0) {
      fail(`${op} takes no argument`, span);
    }
    if (op === "__POSITION") {
      const text =
        ctx.section === "Impl"
          ? `Line ${span.startLine}, Column ${span.startCol} (Impl)`
          : `Line ${span.startLine} (Decl)`;
      return stringLiteral(text, span);
    }
    if (ctx.pouName === undefined) return undefined;
    return stringLiteral(ctx.pouName, span);
  };

  const rewrite = (node: unknown, ctx: Context): void => {
    if (typeof node !== "object" || node === null) return;
    if (Array.isArray(node)) {
      for (const item of node) rewrite(item, ctx);
      return;
    }
    const call = node as FunctionCallExpression;
    if (
      call.kind === "FunctionCallExpression" &&
      call.instance === undefined &&
      active.has(call.functionName.toUpperCase())
    ) {
      const literal = lowerCall(call, ctx);
      if (literal) {
        const target = node as Record<string, unknown>;
        for (const key of Object.keys(target)) delete target[key];
        Object.assign(target, literal);
        return;
      }
    }
    for (const value of Object.values(node)) rewrite(value, ctx);
  };

  const pou = (
    pouName: string | undefined,
    variables: ReadonlyMap<string, VarDeclaration>,
    decls: unknown,
    body: unknown,
  ): void => {
    rewrite(decls, { pouName, section: "Decl", variables });
    rewrite(body, { pouName, section: "Impl", variables });
  };

  const owners = [...ast.programs, ...ast.functionBlocks];
  for (const fn of ast.functions) {
    pou(name(fn.name, fn.sourceSpan), scope(fn.varBlocks), fn.varBlocks, [
      fn.body,
    ]);
  }
  for (const owner of owners) {
    const ownerName = name(owner.name, owner.sourceSpan);
    const ownerScope = scope(owner.varBlocks);
    pou(ownerName, ownerScope, owner.varBlocks, owner.body);
    for (const m of owner.methods) {
      pou(
        `${ownerName}.${name(m.name, m.nameSpan ?? m.sourceSpan)}`,
        scope(m.varBlocks, owner.varBlocks),
        [m.varBlocks, m.returnType],
        m.body,
      );
    }
    for (const a of owner.actions) {
      pou(`${ownerName}.${name(a.name, a.sourceSpan)}`, ownerScope, [], a.body);
    }
    if (owner.kind === "FunctionBlockDeclaration") {
      for (const p of owner.properties) {
        const blocks = [
          ...(p.getterVarBlocks ?? []),
          ...(p.setterVarBlocks ?? []),
        ];
        pou(
          `${ownerName}.${name(p.name, p.sourceSpan)}`,
          scope(blocks, owner.varBlocks),
          blocks,
          [p.getter, p.setter],
        );
      }
    }
  }
  for (const a of ast.actions) {
    const owner = owners.find(
      (o) => o.name.toUpperCase() === a.owner?.toUpperCase(),
    );
    const ownerName = owner ? name(owner.name, owner.sourceSpan) : a.owner;
    pou(
      ownerName === undefined
        ? undefined
        : `${ownerName}.${name(a.name, a.sourceSpan)}`,
      owner ? scope(owner.varBlocks) : globals,
      [],
      a.body,
    );
  }
  for (const t of ast.types) {
    pou(
      name(t.name, t.sourceSpan),
      globals,
      [t.definition, t.defaultValue],
      [],
    );
  }
  for (const block of ast.globalVarBlocks) {
    pou(block.globalListName, globals, [block], []);
  }
  for (const c of ast.configurations) {
    pou(name(c.name, c.sourceSpan), globals, c.varBlocks, []);
  }
  return errors;
}

/**
 * The operators in a test file whose dialect has vendor_operators:
 * `__POSITION()` is lowered as in a source; `__POUNAME()` and `BITADR` have
 * no value there and are refused.
 */
export function lowerTestPouOperators(
  testFile: TestFile,
  fileName: string,
): CompileError[] {
  const errors: CompileError[] = [];
  const rewrite = (node: unknown, section: "Decl" | "Impl"): void => {
    if (typeof node !== "object" || node === null) return;
    if (Array.isArray(node)) {
      for (const item of node) rewrite(item, section);
      return;
    }
    const call = node as FunctionCallExpression;
    const op =
      call.kind === "FunctionCallExpression" && call.instance === undefined
        ? call.functionName.toUpperCase()
        : undefined;
    if (op !== undefined && POU_OPERATORS.has(op)) {
      const span = call.sourceSpan;
      if (op !== "__POSITION") {
        errors.push({
          message: `${op} is not supported in a test file`,
          line: span.startLine,
          column: span.startCol,
          severity: "error",
          file: fileName,
        });
        return;
      }
      const text =
        section === "Impl"
          ? `Line ${span.startLine}, Column ${span.startCol} (Impl)`
          : `Line ${span.startLine} (Decl)`;
      const target = node as Record<string, unknown>;
      for (const key of Object.keys(target)) delete target[key];
      Object.assign(target, stringLiteral(text, span));
      return;
    }
    for (const value of Object.values(node)) rewrite(value, section);
  };
  for (const block of [
    testFile.setup,
    testFile.teardown,
    ...testFile.testCases,
  ]) {
    if (!block) continue;
    if ("varBlocks" in block) rewrite(block.varBlocks, "Decl");
    rewrite(block.body, "Impl");
  }
  return errors;
}
