// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * The feature bit_type: `BIT` as the type of a STRUCT member. A BIT member
 * holds a BOOL value in one bit. A run of consecutive BIT members fills bytes
 * from the least significant bit, 8 per byte; a member of another type ends
 * the run. BIT is accepted nowhere else. A TYPE or POU named BIT (in the
 * sources or a library) wins in every dialect. See docs/DIALECTS.md.
 */

import type {
  CompilationUnit,
  StructDefinition,
  TypeReference,
} from "../frontend/ast.js";
import type { CompileError } from "../types.js";

function isBitName(name: string | undefined): boolean {
  return name?.toUpperCase() === "BIT";
}

/** A plain `BIT`: no array, reference or pointer level. */
function isPlainBit(ref: TypeReference): boolean {
  return (
    isBitName(ref.name) &&
    ref.arrayDimensions === undefined &&
    ref.elementTypeName === undefined &&
    (ref.referenceKind ?? "none") === "none" &&
    ref.referenceChain === undefined
  );
}

function error(ref: TypeReference, message: string): CompileError {
  const span = ref.sourceSpan;
  return {
    message,
    line: span.startLine,
    column: span.startCol,
    severity: "error",
    ...(span.file ? { file: span.file } : {}),
  };
}

/** The STRUCT (not UNION) definitions of the unit. */
function structs(ast: CompilationUnit): StructDefinition[] {
  const out: StructDefinition[] = [];
  for (const t of ast.types) {
    const def = t.definition;
    if (def.kind === "StructDefinition" && def.isUnion !== true) out.push(def);
  }
  return out;
}

/**
 * Mark each STRUCT member of type BIT and give it the type BOOL. With the
 * feature off such a member is refused (and still marked, so its uses add no
 * error); with it on, BIT written anywhere else is refused.
 */
export function lowerBitType(
  ast: CompilationUnit,
  enabled: boolean,
  declaredElsewhere: (nameUpper: string) => boolean,
  profiles: readonly string[] = [],
): CompileError[] {
  const hint = profiles.length > 0 ? ` (profiles: ${profiles.join(", ")})` : "";
  const declared = [
    ...ast.types,
    ...ast.functionBlocks,
    ...ast.programs,
    ...ast.interfaces,
  ].some((d) => isBitName(d.name));
  if (declared || declaredElsewhere("BIT")) return [];
  const errors: CompileError[] = [];
  const members = new Set<TypeReference>();
  for (const def of structs(ast)) {
    for (const field of def.fields) {
      if (!isPlainBit(field.type) || members.has(field.type)) continue;
      members.add(field.type);
      if (!enabled) {
        errors.push(
          error(
            field.type,
            `BIT as a STRUCT member needs the feature bit_type${hint}`,
          ),
        );
      }
      field.type.name = "BOOL";
      field.type.bit = true;
    }
  }
  if (!enabled) return errors;
  const seen = new Set<object>();
  const visit = (node: unknown): void => {
    if (typeof node !== "object" || node === null || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const ref = node as TypeReference;
    if (
      ref.kind === "TypeReference" &&
      !members.has(ref) &&
      (isBitName(ref.name) || isBitName(ref.elementTypeName))
    ) {
      errors.push(
        error(ref, "BIT is allowed only as the type of a STRUCT member"),
      );
      if (isBitName(ref.name)) ref.name = "BOOL";
      if (isBitName(ref.elementTypeName)) ref.elementTypeName = "BOOL";
    }
    for (const value of Object.values(node)) visit(value);
  };
  visit(ast);
  return errors;
}
