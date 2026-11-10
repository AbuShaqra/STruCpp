// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * Method declarations of a library function block, rebuilt from its manifest
 * entry so a consumer binds `inst.M(...)` arguments as for a local block.
 */

import type { LibraryFBEntry, LibraryVarType } from "./library-manifest.js";
import type { MethodDeclaration } from "../frontend/ast.js";
import { parse } from "../frontend/parser.js";
import { buildAST } from "../frontend/ast-builder.js";

const REFERENCE_SPELLING = {
  pointer_to: "POINTER TO ",
  ref_to: "REF_TO ",
  reference_to: "REFERENCE TO ",
} as const;

/** The ST spelling of a manifest variable type. */
function typeText(v: LibraryVarType): string {
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
