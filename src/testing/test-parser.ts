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
import { lowerTestPlatformTypes } from "../semantic/platform-types.js";
import type { TestFile } from "./test-model.js";
import type { CompileError, CompileOptions } from "../types.js";
import { tokenizeTest } from "../frontend/lexer.js";
import {
  DialectError,
  profilesWithFeature,
  resolveDialect,
  type ResolvedDialect,
} from "../dialect.js";
import type { IfStatement } from "../frontend/ast.js";
import {
  applyConditionalPragmas,
  conditionalPragmaHint,
  sourcePrepFor,
  validatePragmaDefines,
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
 * @param options - Dialect and pragma defines (default dialect when
 *   omitted). Conditional pragmas are resolved when the dialect has the
 *   feature conditional_pragmas and refused otherwise.
 * @throws TypeError when `options.pragmaDefines` is not a name → string map
 * @returns The parsed TestFile and any errors
 */
export function parseTestFile(
  source: string,
  fileName: string,
  options?: TestFileParseOptions,
): { testFile?: TestFile; errors: CompileError[] } {
  const errors: CompileError[] = [];

  const opts: TestFileParseOptions = options ?? {};
  validatePragmaDefines(opts.pragmaDefines);
  let text = source;
  let pragmaHint = "";
  let dialect;
  try {
    dialect = resolveDialect(
      {
        ...(opts.dialect !== undefined ? { dialect: opts.dialect } : {}),
        ...(opts.dialectFiles ? { dialectFiles: opts.dialectFiles } : {}),
        ...(opts.dialectPath ? { dialectPath: opts.dialectPath } : {}),
        ...(opts.features ? { features: opts.features } : {}),
      },
      opts.dialectIO?.readFile,
      opts.dialectIO?.listDir,
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
  const prep = sourcePrepFor(dialect, opts.pragmaDefines);
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
    errors.push(...conditionalReturnErrors(testFile, dialect, fileName));
    if (dialect.features.has("platform_types")) {
      lowerTestPlatformTypes(testFile);
    }
    testFile.dialect = dialect;
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

/** `RETURN (cond);` in a test file needs the feature conditional_return, as in a source. */
function conditionalReturnErrors(
  testFile: TestFile,
  dialect: ResolvedDialect,
  fileName: string,
): CompileError[] {
  if (dialect.features.has("conditional_return")) return [];
  const profiles = profilesWithFeature(dialect, "conditional_return");
  const hint = profiles.length > 0 ? ` (profiles: ${profiles.join(", ")})` : "";
  const errors: CompileError[] = [];
  const seen = new Set<object>();
  const visit = (node: unknown): void => {
    if (typeof node !== "object" || node === null || seen.has(node)) return;
    seen.add(node);
    const stmt = node as Partial<IfStatement>;
    if (stmt.kind === "IfStatement" && stmt.conditionalReturn) {
      errors.push({
        message: `RETURN (condition) needs the feature conditional_return${hint}`,
        line: stmt.conditionalReturn.startLine,
        column: stmt.conditionalReturn.startCol,
        severity: "error",
        file: fileName,
      });
    }
    for (const value of Object.values(node)) visit(value);
  };
  visit(testFile);
  return errors;
}
