// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * `{attribute 'implicit-parameter' := '<value>'}` on a FUNCTION input: in
 * common vendor toolchains the compiler fills such an input at each call
 * (`pouname`, `position`, `instance-path`). This compiler skips the pragma, so
 * the input is an ordinary one; the "missing required input" error names the
 * attribute for an input that carries it.
 */

import type { IToken } from "chevrotain";
import type { CompilationUnit } from "../frontend/ast.js";
import { pragmaSourceText } from "../frontend/lexer.js";

/** An implicit-parameter attribute found in a source file. */
export interface ImplicitParameterPragma {
  file: string;
  /** Line of the pragma's `{` (1-indexed). */
  startLine: number;
  /** Column of the pragma's `{` (1-indexed). */
  startColumn: number;
  /** Line of the pragma's last character (1-indexed). */
  endLine: number;
  /** Column of the pragma's last character (1-indexed). */
  endColumn: number;
  /** The attribute value, `pouname`, `position` or `instance-path`. */
  value: string;
}

const ATTRIBUTE =
  /^\{\s*attribute\s+'implicit-parameter'\s*:=\s*'([^']*)'\s*\}$/i;

/** The implicit-parameter attributes among a file's pragma tokens. */
export function implicitParameterPragmas(
  pragmas: ReadonlyArray<IToken>,
  source: string,
  file: string,
): ImplicitParameterPragma[] {
  const out: ImplicitParameterPragma[] = [];
  for (const tok of pragmas) {
    const match = ATTRIBUTE.exec(pragmaSourceText(tok, source));
    if (!match) continue;
    out.push({
      file,
      startLine: tok.startLine ?? 1,
      startColumn: tok.startColumn ?? 1,
      endLine: tok.endLine ?? tok.startLine ?? 1,
      endColumn: tok.endColumn ?? tok.startColumn ?? 1,
      value: match[1]!,
    });
  }
  return out;
}

/** `a` is before `b`, comparing line then column. */
function before(
  a: { line: number; col: number },
  b: { line: number; col: number },
): boolean {
  return a.line < b.line || (a.line === b.line && a.col < b.col);
}

/**
 * Mark each FUNCTION input that an implicit-parameter attribute precedes
 * with the attribute's value. An attribute belongs to the first declaration
 * after it: one written between the previous declaration of the VAR_INPUT
 * block (or the block's start) and this one, other pragmas and comments
 * between them included.
 */
export function markImplicitParameters(
  ast: CompilationUnit,
  pragmas: readonly ImplicitParameterPragma[],
): void {
  if (pragmas.length === 0) return;
  for (const fn of ast.functions) {
    for (const block of fn.varBlocks) {
      if (block.blockType !== "VAR_INPUT") continue;
      let from = {
        line: block.sourceSpan.startLine,
        col: block.sourceSpan.startCol,
      };
      for (const decl of block.declarations) {
        const span = decl.sourceSpan;
        const start = { line: span.startLine, col: span.startCol };
        const pragma = pragmas.find(
          (p) =>
            p.file === span.file &&
            before(from, { line: p.startLine, col: p.startColumn }) &&
            before({ line: p.endLine, col: p.endColumn }, start),
        );
        if (pragma) decl.implicitParameter = pragma.value;
        from = { line: span.endLine, col: span.endCol };
      }
    }
  }
}

/** The hint the "missing required input" error adds for these inputs, or "". */
export function implicitParameterHint(names: readonly string[]): string {
  if (names.length === 0) return "";
  const them = names.length > 1 ? "them" : "it";
  return `; this compiler does not fill {attribute 'implicit-parameter'} inputs (${names.join(", ")}): pass ${them} or give ${them} an initial value`;
}
