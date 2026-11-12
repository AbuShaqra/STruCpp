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
import type { CompilationUnit, VarDeclaration } from "../frontend/ast.js";
import { pragmaSourceText } from "../frontend/lexer.js";

/** An implicit-parameter attribute found in a source file. */
export interface ImplicitParameterPragma {
  file: string;
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
      endLine: tok.endLine ?? tok.startLine ?? 1,
      endColumn: tok.endColumn ?? tok.startColumn ?? 1,
      value: match[1]!,
    });
  }
  return out;
}

/** Every VAR_INPUT declaration of the unit's FUNCTIONs. */
function functionInputs(ast: CompilationUnit): VarDeclaration[] {
  const out: VarDeclaration[] = [];
  for (const fn of ast.functions) {
    for (const block of fn.varBlocks) {
      if (block.blockType === "VAR_INPUT") out.push(...block.declarations);
    }
  }
  return out;
}

/**
 * Mark each FUNCTION input written right after an implicit-parameter
 * attribute (on the same or the next line) with the attribute's value.
 */
export function markImplicitParameters(
  ast: CompilationUnit,
  pragmas: readonly ImplicitParameterPragma[],
): void {
  if (pragmas.length === 0) return;
  for (const decl of functionInputs(ast)) {
    const span = decl.sourceSpan;
    const pragma = pragmas.find(
      (p) =>
        p.file === span.file &&
        (p.endLine === span.startLine
          ? p.endColumn < span.startCol
          : p.endLine + 1 === span.startLine),
    );
    if (pragma) decl.implicitParameter = pragma.value;
  }
}

/** The hint the "missing required input" error adds for these inputs, or "". */
export function implicitParameterHint(names: readonly string[]): string {
  if (names.length === 0) return "";
  const them = names.length > 1 ? "them" : "it";
  return `; this compiler does not fill {attribute 'implicit-parameter'} inputs (${names.join(", ")}): pass ${them} or give ${them} an initial value`;
}
