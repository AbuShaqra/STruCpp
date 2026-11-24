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
  TypeReference,
} from "../frontend/ast.js";
import { parse } from "../frontend/parser.js";
import { buildAST } from "../frontend/ast-builder.js";
import { lowerDefaultStringLength } from "../semantic/string-default-length.js";

const REFERENCE_SPELLING = {
  pointer_to: "POINTER TO ",
  ref_to: "REF_TO ",
  reference_to: "REFERENCE TO ",
} as const;

/** `name` with a STRING / WSTRING length, when there is one. */
function withLength(name: string, length: number | string | undefined): string {
  return length === undefined ? name : `${name}(${String(length)})`;
}

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
    return `${prefix}ARRAY[${dims.join(", ")}] OF ${elemPrefix}${withLength(v.elementTypeName ?? v.type, v.elementMaxLength)}`;
  }
  return `${prefix}${withLength(v.type, v.maxLength)}`;
}

/**
 * An ARRAY[*] parameter's element length, which its spelled type name
 * (`__VLA_1D_STRING`) cannot carry, onto the parsed declarations.
 */
function applyElementLengths(
  blocks: ReadonlyArray<{
    declarations: ReadonlyArray<{ names: string[]; type: TypeReference }>;
  }>,
  params: ReadonlyArray<{ name: string; elementMaxLength?: number | string }>,
): void {
  for (const block of blocks) {
    for (const decl of block.declarations) {
      const upper = decl.names[0]?.toUpperCase();
      const length = params.find(
        (p) => p.name.toUpperCase() === upper,
      )?.elementMaxLength;
      if (length !== undefined && /^__VLA_/i.test(decl.type.name)) {
        decl.type.elementMaxLength = length;
      }
    }
  }
}

/**
 * The methods `fb` lists, as declarations without bodies; undefined when the
 * archive predates method lists or the signatures do not parse. A STRING
 * written without a length gets `stringDefaultLength`, the library's own.
 */
export function libraryMethodDeclarations(
  fb: LibraryFBEntry,
  stringDefaultLength?: number,
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
    const declared = buildAST(parsed.cst).functionBlocks[0]?.methods;
    declared?.forEach((method, i) =>
      applyElementLengths(method.varBlocks, fb.methods?.[i]?.parameters ?? []),
    );
    if (declared !== undefined && stringDefaultLength !== undefined) {
      lowerDefaultStringLength(declared, stringDefaultLength);
    }
    return declared;
  } catch {
    return undefined;
  }
}

/**
 * `fn` as a declaration without a body, its parameters in manifest order (the
 * order of its C++ parameter list); undefined when the signature does not parse.
 * A STRING written without a length gets `stringDefaultLength`, the library's own.
 */
export function libraryFunctionDeclaration(
  fn: LibraryFunctionEntry,
  stringDefaultLength?: number,
): FunctionDeclaration | undefined {
  const blockOf = {
    input: "VAR_INPUT",
    output: "VAR_OUTPUT",
    inout: "VAR_IN_OUT",
  };
  // Every recorded level and ARRAY shape is spelled (older archives record
  // only REFERENCE TO), so a POINTER TO STRING(n) is not read as a STRING.
  const params = fn.parameters.map(
    (p) =>
      `${blockOf[p.direction]} ${p.name} : ${typeText(p)}` +
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
    const declared = buildAST(parsed.cst).functions[0];
    if (declared !== undefined) {
      applyElementLengths(declared.varBlocks, fn.parameters);
    }
    if (declared !== undefined && stringDefaultLength !== undefined) {
      lowerDefaultStringLength(declared, stringDefaultLength);
    }
    return declared;
  } catch {
    return undefined;
  }
}
