// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * STruC++ Test File Parser
 *
 * Parses test ST files into TestFile models. Uses the test lexer (which
 * recognizes TEST/END_TEST/ASSERT_* tokens) and the shared parser's
 * testFile entry point.
 */

import { parseTestSource } from "../frontend/parser.js";
import { toCompileErrors } from "../frontend/parse-errors.js";
import { buildTestAST } from "../frontend/ast-builder.js";
import { lowerTestInlineTypes } from "../frontend/lower-inline-types.js";
import type { TestFile } from "./test-model.js";
import type { CompileError, CompileOptions } from "../types.js";
import { tokenizeTest } from "../frontend/lexer.js";
import { DialectError, resolveDialect } from "../dialect.js";
import {
  applyConditionalPragmas,
  conditionalPragmaHint,
  sourcePrepFor,
  withPragmaHint,
} from "../frontend/conditional-pragmas.js";

/** Compile options a test file is parsed under. */
export type TestFileParseOptions = Pick<
  CompileOptions,
  | "dialect"
  | "dialectFiles"
  | "dialectPath"
  | "features"
  | "dialectIO"
  | "pragmaDefines"
>;

/**
 * Parse a test file source string into a TestFile model.
 *
 * @param source - The test file source code
 * @param fileName - The test file name (for error reporting and output)
 * @param options - Dialect and pragma defines. Without them conditional
 *   pragmas are refused; with them they are resolved when the dialect has
 *   the feature conditional_pragmas.
 * @returns The parsed TestFile and any errors
 */
export function parseTestFile(
  source: string,
  fileName: string,
  options?: TestFileParseOptions,
): { testFile?: TestFile; errors: CompileError[] } {
  const errors: CompileError[] = [];

  let text = source;
  let pragmaHint = "";
  if (options !== undefined) {
    let dialect;
    try {
      dialect = resolveDialect(
        {
          ...(options.dialect !== undefined
            ? { dialect: options.dialect }
            : {}),
          ...(options.dialectFiles
            ? { dialectFiles: options.dialectFiles }
            : {}),
          ...(options.dialectPath ? { dialectPath: options.dialectPath } : {}),
          ...(options.features ? { features: options.features } : {}),
        },
        options.dialectIO?.readFile,
        options.dialectIO?.listDir,
      );
    } catch (e) {
      if (!(e instanceof DialectError)) throw e;
      errors.push({
        message: e.message,
        line: 0,
        column: 0,
        severity: "error",
        file: fileName,
      });
      return { errors };
    }
    const prep = sourcePrepFor(dialect, options.pragmaDefines);
    if (prep.enabled) {
      const pragmaResult = applyConditionalPragmas(
        source,
        prep.defines,
        tokenizeTest,
      );
      if (pragmaResult.errors.length > 0) {
        errors.push(...toCompileErrors(pragmaResult.errors, fileName));
        return { errors };
      }
      text = pragmaResult.text;
    } else {
      pragmaHint = conditionalPragmaHint(dialect);
    }
  }

  // Parse with the test lexer/parser
  const parseResult = parseTestSource(text);

  if (parseResult.errors.length > 0) {
    errors.push(
      ...withPragmaHint(
        toCompileErrors(parseResult.errors, fileName),
        pragmaHint,
      ),
    );
    return { errors };
  }

  if (!parseResult.cst) {
    errors.push({
      message: "Parse failed: no CST produced",
      line: 0,
      column: 0,
      severity: "error",
      file: fileName,
    });
    return { errors };
  }

  // Build TestFile AST from CST
  try {
    const testFile = buildTestAST(parseResult.cst, fileName);
    errors.push(...lowerTestInlineTypes(testFile));
    return { testFile, errors };
  } catch (e) {
    errors.push({
      message: `Test file AST building failed: ${e instanceof Error ? e.message : String(e)}`,
      line: 0,
      column: 0,
      severity: "error",
      file: fileName,
    });
    return { errors };
  }
}
