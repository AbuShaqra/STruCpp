// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * Method declarations of a library function block, and declarations of a
 * library function, rebuilt from their manifest entries so a consumer binds
 * `inst.M(...)` and `F(...)` arguments as for local ones.
 */

import type {
  LibraryFBEntry,
  LibraryFunctionEntry,
  LibraryVarType,
} from "./library-manifest.js";
import type {
  FunctionDeclaration,
  MethodDeclaration,
} from "../frontend/ast.js";
import { parse } from "../frontend/parser.js";
import { buildAST } from "../frontend/ast-builder.js";

const REFERENCE_SPELLING = {
  pointer_to: "POINTER TO ",
  ref_to: "REF_TO ",
  reference_to: "REFERENCE TO ",
} as const;

/** The ST spelling of a manifest variable type. */
function typeText(v: LibraryVarType & { maxLength?: number | string }): string {
  if (v.maxLength !== undefined) return `${v.type}(${String(v.maxLength)})`;
  const levels = v.referenceChain ?? (v.referenceKind ? [v.referenceKind] : []);
  const prefix = levels
    .map((k) => (k === "none" ? "" : REFERENCE_SPELLING[k]))
    .join("");
  if (v.arrayDimensions && v.arrayDimensions.length > 0) {
    const dims = v.arrayDimensions.map((d) => `${d.start}..${d.end}`);
    const elemPrefix = (v.elementReferenceChain ?? [])
      .map((k) => (k === "none" ? "" : REFERENCE_SPELLING[k]))
      .join("");
    return `${prefix}ARRAY[${dims.join(", ")}] OF ${elemPrefix}${v.elementTypeName ?? v.type}`;
  }
  return `${prefix}${v.type}`;
}

/**
 * The methods `fb` lists, as declarations without bodies; undefined when the
 * archive predates method lists or the signatures do not parse.
 */
export function libraryMethodDeclarations(
  fb: LibraryFBEntry,
): MethodDeclaration[] | undefined {
  if (fb.methods === undefined) return undefined;
  if (fb.methods.length === 0) return [];
  const blockOf = {
    input: "VAR_INPUT",
    output: "VAR_OUTPUT",
    inout: "VAR_IN_OUT",
  };
  const methods = fb.methods.map((m) => {
    const ret = m.returnType ? ` : ${typeText(m.returnType)}` : "";
    const params = m.parameters.map(
      (p) =>
        `${blockOf[p.direction]} ${p.name} : ${typeText(p)}` +
        `${p.initialValue !== undefined ? ` := ${p.initialValue}` : ""}; END_VAR`,
    );
    return [
      `METHOD ${m.visibility ?? ""} ${m.name}${ret}`,
      ...params,
      "END_METHOD",
    ].join("\n");
  });
  const source = `FUNCTION_BLOCK ${fb.name}\n${methods.join("\n")}\nEND_FUNCTION_BLOCK\n`;
  try {
    const parsed = parse(source);
    if (parsed.errors.length > 0 || parsed.cst === null) return undefined;
    return buildAST(parsed.cst).functionBlocks[0]?.methods;
  } catch {
    return undefined;
  }
}

/**
 * `fn` as a declaration without a body, its parameters in manifest order (the
 * order of its C++ parameter list); undefined when the signature does not parse.
 */
export function libraryFunctionDeclaration(
  fn: LibraryFunctionEntry,
): FunctionDeclaration | undefined {
  const blockOf = {
    input: "VAR_INPUT",
    output: "VAR_OUTPUT",
    inout: "VAR_IN_OUT",
  };
  const params = fn.parameters.map(
    (p) =>
      `${blockOf[p.direction]} ${p.name} : ${p.referenceKind === "reference_to" ? "REFERENCE TO " : ""}${p.type}${p.maxLength !== undefined ? `(${String(p.maxLength)})` : ""}` +
      `${p.initialValue !== undefined ? ` := ${p.initialValue}` : ""}; END_VAR`,
  );
  const source = [
    `FUNCTION ${fn.name} : ${fn.returnType}`,
    ...params,
    "END_FUNCTION",
  ].join("\n");
  try {
    const parsed = parse(source);
    if (parsed.errors.length > 0 || parsed.cst === null) return undefined;
    return buildAST(parsed.cst).functions[0];
  } catch {
    return undefined;
  }
}
