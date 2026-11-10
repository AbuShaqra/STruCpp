// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * Binding of named arguments of standard function calls to the IEC
 * parameter order (MID(IN, L, P), LIMIT(MN, IN, MX), SEL(G, IN0, IN1)...).
 */

import type { Argument } from "../frontend/ast.js";
import { isEnEnoArgument } from "../ast-utils.js";
import type { StdFunctionParam } from "./std-function-registry.js";

/** A problem found while binding the arguments of one call. */
export interface StdArgumentIssue {
  severity: "error" | "warning";
  message: string;
  /** The argument it is about; undefined for a call-level issue. */
  argument?: Argument;
}

/** Result of {@link bindStdFunctionArguments}. */
export interface StdArgumentBinding {
  /**
   * The arguments in parameter order (EN/ENO last), or undefined when the
   * call has no named argument to bind or an error was found.
   */
  ordered?: Argument[];
  /** True when an error was found: the arguments match no parameter order. */
  failed: boolean;
  issues: StdArgumentIssue[];
}

const NUMBERED = /^(.*?)(\d+)$/;

/** Extensible functions whose numbered inputs are selected by number. */
const SELECTED_BY_NUMBER = new Set(["MUX"]);

/**
 * The parameter slot a named argument binds to: its declared parameter, or
 * for a variadic function an extra numbered input past the last one (IN3).
 */
function slotOf(
  upper: string,
  params: readonly StdFunctionParam[],
  variadic: boolean,
): number | undefined {
  const index = params.findIndex((p) => p.name.toUpperCase() === upper);
  if (index >= 0) return index;
  if (!variadic || params.length === 0) return undefined;
  const last = NUMBERED.exec(params[params.length - 1]!.name.toUpperCase());
  const arg = NUMBERED.exec(upper);
  if (!last || !arg || last[1] !== arg[1] || arg[2]!.startsWith("0")) {
    return undefined;
  }
  const n = Number(arg[2]);
  const lastN = Number(last[2]);
  return n > lastN ? params.length - 1 + (n - lastN) : undefined;
}

/** The name of the parameter at a slot (numbered past the last one). */
function slotName(slot: number, params: readonly StdFunctionParam[]): string {
  const param = params[slot];
  if (param) return param.name;
  const lastParam = params[params.length - 1]!;
  const last = NUMBERED.exec(lastParam.name)!;
  return `${last[1]}${Number(last[2]) + slot - (params.length - 1)}`;
}

/**
 * Bind the arguments of a standard function call by the IEC parameter
 * names: positional arguments fill the free slots in order, named ones
 * their parameter. Calls without a named argument (EN/ENO aside) are left
 * as written.
 */
export function bindStdFunctionArguments(
  functionName: string,
  params: readonly StdFunctionParam[],
  variadic: boolean,
  args: readonly Argument[],
): StdArgumentBinding {
  const issues: StdArgumentIssue[] = [];
  const user = args.filter((a) => !isEnEnoArgument(a));
  if (!user.some((a) => a.name !== undefined)) {
    return { issues, failed: false };
  }

  const slots = new Map<number, Argument>();
  let failed = false;
  for (const arg of user) {
    if (arg.name === undefined) continue;
    const slot = slotOf(arg.name.toUpperCase(), params, variadic);
    if (slot === undefined) {
      issues.push({
        severity: "error",
        message: `Function '${functionName}' has no parameter named '${arg.name}'`,
        argument: arg,
      });
      failed = true;
      continue;
    }
    if (slots.has(slot)) {
      issues.push({
        severity: "error",
        message: `Parameter '${slotName(slot, params)}' of '${functionName}' is given more than once`,
        argument: arg,
      });
      failed = true;
      continue;
    }
    if (arg.isOutput) {
      issues.push({
        severity: "warning",
        message: `Output argument '=>' used for input parameter '${slotName(slot, params).toLowerCase()}' — did you mean ':='?`,
        argument: arg,
      });
    }
    slots.set(slot, arg);
  }

  let next = 0;
  for (const arg of user) {
    if (arg.name !== undefined) continue;
    while (slots.has(next)) next++;
    slots.set(next, arg);
  }

  const count = slots.size === 0 ? 0 : Math.max(...slots.keys()) + 1;
  // An extensible input left out closes up (ADD(IN1, IN3) adds both), but
  // MUX selects its inputs by number, and a fixed signature needs them all.
  const closesUp = variadic && !SELECTED_BY_NUMBER.has(functionName);
  for (let i = 0; i < count; i++) {
    if (slots.has(i) || closesUp) continue;
    issues.push({
      severity: "error",
      message: `Function '${functionName}' is missing parameter '${slotName(i, params)}'`,
    });
    failed = true;
  }
  if (failed) return { issues, failed };

  const ordered: Argument[] = [];
  for (let i = 0; i < count; i++) {
    const arg = slots.get(i);
    if (arg) ordered.push(arg);
  }
  ordered.push(...args.filter((a) => isEnEnoArgument(a)));
  return { ordered, issues, failed };
}
