// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * UNION types: `TYPE U_A : UNION f : REAL; d : DWORD; END_UNION END_TYPE`
 * (feature union).
 *
 * A UNION is a {@link StructDefinition} with `isUnion` set, so member access,
 * the symbol tables and the type checker treat it like a STRUCT. This module
 * holds the rules only a UNION has: its members share one storage, so each
 * must be data (no function block, interface or program instance, no
 * variable-length array), names are unique, there is no EXTENDS, and initial
 * values are not supported yet.
 */

import type {
  CompilationUnit,
  Expression,
  StructDefinition,
  StructInitializerExpression,
  TypeDeclaration,
  TypeReference,
  VarDeclaration,
} from "../frontend/ast.js";
import { walkAST } from "../ast-utils.js";
import type { SourceSpan } from "../types.js";

/** Reports one diagnostic at `span`. */
export type UnionReporter = (message: string, span: SourceSpan) => void;

/**
 * What a name that no TYPE or POU of the compilation unit declares is: an
 * instance kind (`"FUNCTION_BLOCK"`), the exported fields of a library STRUCT,
 * or undefined (elementary, another library type, or unknown).
 */
export type UnionExternalLookup = (
  upperName: string,
) => { instance: string } | { fields: VarDeclaration[] } | undefined;

/** True when `def` is a UNION. */
export function isUnionDefinition(
  def: TypeDeclaration["definition"],
): def is StructDefinition & { isUnion: true } {
  return def.kind === "StructDefinition" && def.isUnion === true;
}

/** The TYPEs and POUs of a compilation unit by upper-case name. */
class UnitIndex {
  readonly types = new Map<string, TypeDeclaration>();
  readonly instances = new Map<string, string>();
  readonly fbInputs = new Map<string, VarDeclaration[]>();

  constructor(ast: CompilationUnit) {
    for (const t of ast.types) {
      const upper = t.name.toUpperCase();
      if (!this.types.has(upper)) this.types.set(upper, t);
    }
    for (const fb of ast.functionBlocks) {
      this.instances.set(fb.name.toUpperCase(), "FUNCTION_BLOCK");
      this.fbInputs.set(
        fb.name.toUpperCase(),
        fb.varBlocks
          .filter((b) => b.blockType === "VAR_INPUT")
          .flatMap((b) => b.declarations),
      );
    }
    for (const i of ast.interfaces) {
      this.instances.set(i.name.toUpperCase(), "INTERFACE");
    }
    for (const p of ast.programs) {
      this.instances.set(p.name.toUpperCase(), "PROGRAM");
    }
  }

  /** The TYPE an alias chain starting at `name` ends on, or undefined. */
  resolve(name: string): TypeDeclaration | undefined {
    const seen = new Set<string>();
    let upper = name.toUpperCase();
    for (;;) {
      if (seen.has(upper)) return undefined;
      seen.add(upper);
      const decl = this.types.get(upper);
      const def = decl?.definition;
      if (def?.kind !== "TypeReference" || def.arrayDimensions) return decl;
      if ((def.referenceKind ?? "none") !== "none") return decl;
      upper = def.name.toUpperCase();
    }
  }
}

/** Why a member type cannot share storage: the offending type and what it is. */
interface NotData {
  /** The type named in the member's declaration, or a type it holds. */
  name: string;
  /** `"FUNCTION_BLOCK"`, `"INTERFACE"`, `"PROGRAM"` or `"ARRAY[*]"`. */
  kind: string;
}

/**
 * The first part of type `ref` that is not data (an instance or a
 * variable-length array), looking through arrays, aliases and STRUCT/UNION
 * fields; undefined when it is all data. Pointers and references are data.
 */
function findNotData(
  ref: TypeReference,
  index: UnitIndex,
  external: UnionExternalLookup,
  seen: Set<string>,
): NotData | undefined {
  if ((ref.referenceKind ?? "none") !== "none") return undefined;
  if (ref.name.toUpperCase().startsWith("__VLA_")) {
    return { name: ref.name, kind: "ARRAY[*]" };
  }
  if (ref.arrayDimensions && ref.elementTypeName !== undefined) {
    if ((ref.elementReferenceChain ?? []).length > 0) return undefined;
    return findNotDataByName(ref.elementTypeName, index, external, seen);
  }
  return findNotDataByName(ref.name, index, external, seen);
}

/** {@link findNotData} for a type given by name. */
function findNotDataByName(
  name: string,
  index: UnitIndex,
  external: UnionExternalLookup,
  seen: Set<string>,
): NotData | undefined {
  const upper = name.toUpperCase();
  if (seen.has(upper)) return undefined;
  seen.add(upper);
  const instance = index.instances.get(upper);
  if (instance !== undefined) return { name, kind: instance };
  const decl = index.types.get(upper);
  if (!decl) {
    const ext = external(upper);
    if (ext === undefined) return undefined;
    if ("instance" in ext) return { name, kind: ext.instance };
    for (const field of ext.fields) {
      const found = findNotData(field.type, index, external, seen);
      if (found) return found;
    }
    return undefined;
  }
  const def = decl.definition;
  switch (def.kind) {
    case "StructDefinition":
      for (const field of def.fields) {
        const found = findNotData(field.type, index, external, seen);
        if (found) return found;
      }
      return undefined;
    case "ArrayDefinition":
      if (def.dimensions.some((d) => d.isVariableLength)) {
        return { name: decl.name, kind: "ARRAY[*]" };
      }
      return findNotData(def.elementType, index, external, seen);
    case "TypeReference":
      return findNotData(def, index, external, seen);
    case "EnumDefinition":
    case "SubrangeDefinition":
      return undefined;
  }
}

/** The member-type error for `field` of UNION `union`, or undefined. */
function memberTypeError(
  field: VarDeclaration,
  member: string,
  union: string,
  index: UnitIndex,
  external: UnionExternalLookup,
): string | undefined {
  const found = findNotData(
    field.type,
    index,
    external,
    new Set([union.toUpperCase()]),
  );
  if (!found) return undefined;
  const head = `Member '${member}' of UNION '${union}'`;
  if (found.kind === "ARRAY[*]") {
    return `${head} is a variable-length ARRAY[*]: the members of a UNION share one storage, so each must have a fixed size`;
  }
  const declared = field.type.elementTypeName ?? field.type.name;
  const what =
    declared.toUpperCase() === found.name.toUpperCase()
      ? `is of ${found.kind} type '${found.name}'`
      : `is of type '${declared}', which holds ${found.kind} type '${found.name}'`;
  return `${head} ${what}: a UNION member must be data, not a function block, interface or program instance`;
}

/**
 * Check every UNION of `ast`: at least one member, unique member names
 * (case-insensitive), no member initial value, no EXTENDS, and member types
 * that are data (see {@link findNotData}).
 */
export function validateUnionTypes(
  ast: CompilationUnit,
  external: UnionExternalLookup,
  report: UnionReporter,
): void {
  const unions = ast.types.filter((t) => isUnionDefinition(t.definition));
  if (unions.length === 0) return;
  const index = new UnitIndex(ast);
  for (const decl of unions) {
    const def = decl.definition as StructDefinition;
    if (decl.extends) {
      report(
        `UNION '${decl.name}' cannot use EXTENDS: only a STRUCT may extend another type`,
        decl.extendsKeywordSpan ?? decl.sourceSpan,
      );
    }
    if (def.fields.length === 0) {
      report(
        `UNION '${decl.name}' declares no members: a UNION needs at least one`,
        def.sourceSpan,
      );
      continue;
    }
    const names = new Set<string>();
    for (const field of def.fields) {
      for (const name of field.names) {
        const upper = name.toUpperCase();
        if (names.has(upper)) {
          report(
            `Duplicate member '${name}' in UNION '${decl.name}'`,
            field.sourceSpan,
          );
        }
        names.add(upper);
      }
      const member = field.names[0] ?? "";
      if (field.initialValue) {
        report(
          `Member '${member}' of UNION '${decl.name}' has an initial value: initial values in a UNION are not supported yet`,
          field.initialValue.sourceSpan,
        );
      }
      const typeError = memberTypeError(
        field,
        member,
        decl.name,
        index,
        external,
      );
      if (typeError !== undefined) report(typeError, field.type.sourceSpan);
    }
  }
}

/** The structure initializers directly inside `expr` (not nested in another one). */
function structInitializersIn(expr: Expression): StructInitializerExpression[] {
  const found: StructInitializerExpression[] = [];
  walkAST(expr, (node) => {
    if (node.kind !== "StructInitializerExpression") return;
    found.push(node as StructInitializerExpression);
    return false;
  });
  return found;
}

/**
 * The UNION an initial value `value` of type `ref` would set, looking through
 * aliases, arrays and the elements of structure initializers; else undefined.
 */
function unionInitialized(
  ref: TypeReference,
  value: Expression,
  index: UnitIndex,
  depth: number,
): string | undefined {
  if (depth > 32) return undefined;
  if ((ref.referenceKind ?? "none") !== "none") return undefined;
  if (ref.arrayDimensions && ref.elementTypeName !== undefined) {
    if ((ref.elementReferenceChain ?? []).length > 0) return undefined;
    return unionInitializedByName(ref.elementTypeName, value, index, depth);
  }
  return unionInitializedByName(ref.name, value, index, depth);
}

/** {@link unionInitialized} for a type given by name. */
function unionInitializedByName(
  name: string,
  value: Expression,
  index: UnitIndex,
  depth: number,
): string | undefined {
  const decl = index.resolve(name);
  const def = decl?.definition;
  if (decl && def && isUnionDefinition(def)) return decl.name;
  if (def?.kind === "ArrayDefinition") {
    return unionInitialized(def.elementType, value, index, depth + 1);
  }
  if (def?.kind === "TypeReference") {
    return unionInitialized(def, value, index, depth + 1);
  }
  const fields =
    def?.kind === "StructDefinition"
      ? def.fields
      : index.fbInputs.get(name.toUpperCase());
  if (!fields) return undefined;
  for (const init of structInitializersIn(value)) {
    for (const element of init.elements) {
      const upper = element.name.toUpperCase();
      const field = fields.find((f) =>
        f.names.some((n) => n.toUpperCase() === upper),
      );
      if (!field) continue;
      const hit = unionInitialized(field.type, element.value, index, depth + 1);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

/**
 * Refuse an initial value that sets a UNION: a variable's, a STRUCT field's, a
 * TYPE's default, also nested in a structure initializer or an array literal.
 * Members of a UNION are left to {@link validateUnionTypes}. A default shared
 * by several declarations (Annex B.1.3.3) is reported once.
 */
export function validateUnionInitializers(
  ast: CompilationUnit,
  report: UnionReporter,
): void {
  if (!ast.types.some((t) => isUnionDefinition(t.definition))) return;
  const index = new UnitIndex(ast);
  const reported = new Set<Expression>();
  const check = (ref: TypeReference, value: Expression): void => {
    if (reported.has(value)) return;
    const union = unionInitialized(ref, value, index, 0);
    if (union === undefined) return;
    reported.add(value);
    report(
      `An initial value for UNION '${union}' is not supported yet`,
      value.sourceSpan,
    );
  };
  walkAST(ast, (node) => {
    if (node.kind === "TypeDeclaration") {
      const decl = node as TypeDeclaration;
      if (decl.defaultValue) {
        const self: TypeReference = {
          kind: "TypeReference",
          sourceSpan: decl.sourceSpan,
          name: decl.name,
          isReference: false,
          referenceKind: "none",
        };
        check(self, decl.defaultValue);
      }
      // Members of a UNION are reported by validateUnionTypes.
      return !isUnionDefinition(decl.definition);
    }
    if (node.kind !== "VarDeclaration") return;
    const decl = node as VarDeclaration;
    if (decl.initialValue) check(decl.type, decl.initialValue);
    return false;
  });
}
