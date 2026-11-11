// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * A library FUNCTION named like a standard function (OSCAT's `ROUND(IN, N)`)
 * is called instead of the standard one when the call's arguments fit only the
 * library's signature. A call that fits the standard function keeps it.
 */
import type { FunctionCallExpression } from "../frontend/ast.js";
import { stripEnEno } from "../ast-utils.js";
import { STD_FUNCTIONS_LIBRARY } from "../library/library-manifest.js";
import type { FunctionSymbol, SymbolTables } from "./symbol-table.js";
import type { StdFunctionRegistry } from "./std-function-registry.js";

/** Whether `names` and `positional` arguments bind to these parameters. */
function fits(
  paramNames: readonly string[],
  required: number,
  positional: number,
  names: readonly string[],
): boolean {
  const known = new Set(paramNames.map((n) => n.toUpperCase()));
  if (names.some((n) => !known.has(n))) return false;
  const total = positional + names.length;
  return total <= paramNames.length && total >= required;
}

/**
 * The library FUNCTION a call of a standard function's name resolves to, or
 * undefined when the standard function is called (or no library one exists).
 * The caller has already ruled out a variable, an FB instance, a method and a
 * user FUNCTION of the name.
 */
export function libraryOverloadFor(
  expr: FunctionCallExpression,
  symbolTables: SymbolTables,
  stdRegistry: StdFunctionRegistry | undefined,
): FunctionSymbol | undefined {
  if (!stdRegistry || expr.instance || expr.functionName.includes(".")) {
    return undefined;
  }
  const upper = expr.functionName.toUpperCase();
  const desc = stdRegistry.lookup(upper);
  if (!desc) return undefined;
  // A user FUNCTION of the name replaces every library one.
  if (
    symbolTables.lookupFunction(upper) !== undefined &&
    !symbolTables.globalScope.definedByLibrary(upper)
  ) {
    return undefined;
  }
  const candidates = symbolTables
    .libraryFunctionsNamed(upper)
    .filter((fn) => fn.libraryName !== STD_FUNCTIONS_LIBRARY);
  if (candidates.length === 0) return undefined;

  const args = stripEnEno(expr.arguments);
  const names = args
    .filter((a) => a.name !== undefined)
    .map((a) => a.name!.toUpperCase());
  const positional = args.length - names.length;

  const stdNames = desc.params.map((p) => p.name.toUpperCase());
  const stdFits = desc.isVariadic
    ? args.length >= (desc.minArgs ?? desc.params.length) &&
      names.every((n) => /^IN\d+$/.test(n) || stdNames.includes(n))
    : fits(stdNames, stdNames.length, positional, names);
  if (stdFits) return undefined;

  return candidates.find((fn) => {
    const required = fn.parameters.filter(
      (p) => p.isInOut || (p.isInput && p.initialValue === undefined),
    ).length;
    return fits(
      fn.parameters.map((p) => p.name),
      required,
      positional,
      names,
    );
  });
}
