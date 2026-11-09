// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * Convert the errors from `parse()` / `parseTestSource()` — Chevrotain
 * lexer errors and parser recognition exceptions, mixed — into
 * `CompileError`s with real 1-based positions.
 *
 * Every entry path (compile, analyze, the public `parse()`, library
 * compilation via compile, and the test-file parser) goes through
 * {@link toCompileErrors}, so a position bug is fixed once.
 */

import type { IToken } from "chevrotain";
import type { CompileError } from "../types.js";
import { suggestionForParseError } from "./parser-error-message-provider.js";

/** The fields of a Chevrotain lexer error or recognition exception we read. */
interface RawFrontendError {
  message?: unknown;
  /** Lexer error: 1-based line. */
  line?: unknown;
  /** Lexer error: 1-based column. */
  column?: unknown;
  /** Recognition exception: the offending token (EOF has NaN positions). */
  token?: Partial<IToken>;
  /** Recognition exception: the last token consumed before the failure. */
  previousToken?: Partial<IToken>;
  /** Recognition exception: rule stack at the failure point. */
  context?: { ruleStack?: unknown };
}

/** A positive finite number, or undefined. */
function pos(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

/**
 * Line and column of one error. Lexer errors carry `line`/`column`; parser
 * errors carry a token. A token at EOF has no position, so the error is
 * placed just after the last consumed token, or at 1:1 for an empty input.
 */
function positionOf(err: RawFrontendError): { line: number; column: number } {
  const lexLine = pos(err.line);
  if (lexLine !== undefined) {
    return { line: lexLine, column: pos(err.column) ?? 1 };
  }
  const tokLine = pos(err.token?.startLine);
  if (tokLine !== undefined) {
    return { line: tokLine, column: pos(err.token?.startColumn) ?? 1 };
  }
  const prevLine = pos(err.previousToken?.endLine);
  if (prevLine !== undefined) {
    const endCol = pos(err.previousToken?.endColumn);
    return { line: prevLine, column: endCol !== undefined ? endCol + 1 : 1 };
  }
  return { line: 1, column: 1 };
}

/**
 * Convert frontend errors to `CompileError`s.
 *
 * @param errors - Errors returned by `parse()` or `parseTestSource()`
 * @param file - Source file name to attach, when known
 * @returns One `CompileError` per input error, in order
 */
export function toCompileErrors(
  errors: ReadonlyArray<unknown>,
  file?: string,
): CompileError[] {
  return errors.map((raw) => {
    const err: RawFrontendError =
      typeof raw === "object" && raw !== null ? (raw as RawFrontendError) : {};
    const { line, column } = positionOf(err);
    const entry: CompileError = {
      message:
        typeof err.message === "string" && err.message.length > 0
          ? err.message
          : "Parse error",
      line,
      column,
      severity: "error",
    };
    if (file !== undefined) entry.file = file;
    if (err.token !== undefined) {
      const stack = Array.isArray(err.context?.ruleStack)
        ? (err.context.ruleStack as unknown[])
        : [];
      const rule = stack[stack.length - 1];
      const suggestion = suggestionForParseError(
        typeof rule === "string" ? rule : "",
        err.token as IToken,
      );
      if (suggestion !== undefined) entry.suggestion = suggestion;
    }
    return entry;
  });
}
