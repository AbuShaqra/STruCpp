// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * STRUCT inheritance: `TYPE ST_B EXTENDS ST_A : STRUCT ... END_STRUCT END_TYPE`
 * (feature struct_extends).
 *
 * A derived STRUCT is flattened in the AST before the symbol tables are
 * built: its `fields` become a copy of the base chain's fields followed by its
 * own, and `inheritedDeclarations` counts the copies. Every later pass and the
 * code generator then see an ordinary STRUCT, and the C++ struct is the same as
 * one written out in full. The copies keep the base declaration's source spans.
 */

import type {
  CompilationUnit,
  StructDefinition,
  TypeDeclaration,
  VarDeclaration,
} from "../frontend/ast.js";
import type { SourceSpan } from "../types.js";

/** Reports one diagnostic at `span`. */
export type StructExtendsReporter = (message: string, span: SourceSpan) => void;

/**
 * Describes a base name that no TYPE of the compilation unit declares:
 * `"a FUNCTION_BLOCK"`, `"a STRUCT from a library"`, ...; undefined when the
 * name is not known at all.
 */
export type ExternalTypeDescriber = (upperName: string) => string | undefined;

/** How a library STRUCT base is described by an {@link ExternalTypeDescriber}. */
export const LIBRARY_STRUCT = "a STRUCT from a library";

/** Deep copy of a plain AST value (objects, arrays and primitives only). */
function cloneAst<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item: unknown) => cloneAst(item)) as T;
  }
  if (typeof value === "object" && value !== null) {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) copy[key] = cloneAst(item);
    return copy as T;
  }
  return value;
}

/** `"an enumeration"`, `"an alias"`, ... for a TYPE that is not a STRUCT. */
function describeDefinition(decl: TypeDeclaration): string {
  switch (decl.definition.kind) {
    case "StructDefinition":
      return decl.definition.isUnion ? "a UNION" : "a STRUCT";
    case "EnumDefinition":
      return "an enumeration";
    case "ArrayDefinition":
      return "an ARRAY type";
    case "SubrangeDefinition":
      return "a subrange type";
    case "TypeReference":
      return decl.definition.arrayDimensions ? "an ARRAY type" : "an alias";
  }
}

/** The fields a STRUCT declares itself, without the copies inherited through EXTENDS. */
export function ownFields(def: StructDefinition): VarDeclaration[] {
  return def.fields.slice(def.inheritedDeclarations ?? 0);
}

/** Undo an earlier flattening of the same AST, so a re-analysis starts from the source. */
function restoreOwnFields(ast: CompilationUnit): void {
  for (const decl of ast.types) {
    const def = decl.definition;
    if (def.kind !== "StructDefinition") continue;
    if (def.inheritedDeclarations === undefined) continue;
    def.fields = ownFields(def);
    delete def.inheritedDeclarations;
  }
}

/**
 * Flatten every derived STRUCT of `ast` (see the file header) and report a
 * base that is undefined, not a STRUCT of this unit, part of a cycle, or a
 * field that repeats an inherited name. A STRUCT whose chain fails keeps only
 * its own fields. Idempotent: a second call recomputes from the own fields.
 */
export function flattenStructExtends(
  ast: CompilationUnit,
  describeExternal: ExternalTypeDescriber,
  report: StructExtendsReporter,
): void {
  restoreOwnFields(ast);
  if (!ast.types.some((t) => t.extends !== undefined)) return;

  const byName = new Map<string, TypeDeclaration>();
  for (const decl of ast.types) {
    const upper = decl.name.toUpperCase();
    if (!byName.has(upper)) byName.set(upper, decl);
  }

  /** Upper field name -> name of the STRUCT that declares it, per resolved STRUCT. */
  const origins = new Map<TypeDeclaration, Map<string, string>>();
  const failed = new Set<TypeDeclaration>();
  const resolving: TypeDeclaration[] = [];

  const ownOrigins = (decl: TypeDeclaration, def: StructDefinition): void => {
    const names = new Map<string, string>();
    for (const field of def.fields) {
      for (const n of field.names) names.set(n.toUpperCase(), decl.name);
    }
    origins.set(decl, names);
  };

  const resolve = (decl: TypeDeclaration): boolean => {
    if (origins.has(decl)) return true;
    if (failed.has(decl)) return false;
    const def = decl.definition;
    if (def.kind !== "StructDefinition") return false;
    const base = decl.extends;
    if (!base) {
      ownOrigins(decl, def);
      return true;
    }

    const at = resolving.indexOf(decl);
    if (at >= 0) {
      const cycle = resolving.slice(at);
      const inSourceOrder = [...cycle].sort(
        (x, y) => ast.types.indexOf(x) - ast.types.indexOf(y),
      );
      for (const member of inSourceOrder) {
        const i = cycle.indexOf(member);
        const path = [...cycle.slice(i), ...cycle.slice(0, i), member];
        report(
          `Circular EXTENDS in STRUCT '${member.name}': ${path.map((d) => d.name).join(" EXTENDS ")}`,
          member.extends?.sourceSpan ?? member.sourceSpan,
        );
        failed.add(member);
      }
      return false;
    }

    const baseDecl = byName.get(base.name.toUpperCase());
    if (!baseDecl) {
      const kind = describeExternal(base.name.toUpperCase());
      report(
        kind === undefined
          ? `Undefined type '${base.name}' in EXTENDS clause of STRUCT '${decl.name}'`
          : kind === LIBRARY_STRUCT
            ? `STRUCT '${decl.name}' cannot extend '${base.name}', ${kind}: the base must be declared in the compiled sources`
            : `STRUCT '${decl.name}' cannot extend '${base.name}', ${kind}: the base must be a STRUCT`,
        base.sourceSpan,
      );
      failed.add(decl);
      return false;
    }
    if (
      baseDecl.definition.kind !== "StructDefinition" ||
      baseDecl.definition.isUnion
    ) {
      report(
        `STRUCT '${decl.name}' cannot extend '${base.name}', ${describeDefinition(baseDecl)}: the base must be a STRUCT`,
        base.sourceSpan,
      );
      failed.add(decl);
      return false;
    }

    resolving.push(decl);
    const baseOk = resolve(baseDecl);
    resolving.pop();
    // A cycle through this STRUCT has already been reported for it.
    if (!baseOk || failed.has(decl)) {
      failed.add(decl);
      return false;
    }

    const baseDef = baseDecl.definition;
    const inherited = new Map(origins.get(baseDecl));
    for (const field of def.fields) {
      for (const n of field.names) {
        const from = inherited.get(n.toUpperCase());
        if (from !== undefined) {
          report(
            `Field '${n}' of STRUCT '${decl.name}' is already inherited from '${from}'`,
            field.sourceSpan,
          );
        }
      }
    }
    const copies: VarDeclaration[] = baseDef.fields.map((f) => cloneAst(f));
    for (const field of def.fields) {
      for (const n of field.names) {
        const upper = n.toUpperCase();
        if (!inherited.has(upper)) inherited.set(upper, decl.name);
      }
    }
    def.fields = [...copies, ...def.fields];
    def.inheritedDeclarations = copies.length;
    origins.set(decl, inherited);
    return true;
  };

  for (const decl of ast.types) {
    if (!decl.extends) continue;
    // EXTENDS on a UNION is refused in union.ts; the UNION keeps its members.
    if (
      decl.definition.kind === "StructDefinition" &&
      decl.definition.isUnion
    ) {
      continue;
    }
    if (decl.definition.kind !== "StructDefinition") {
      report(
        `EXTENDS on TYPE '${decl.name}' needs a STRUCT definition`,
        decl.extendsKeywordSpan ?? decl.sourceSpan,
      );
      continue;
    }
    resolve(decl);
  }
}

/**
 * True when STRUCT `derived` extends STRUCT `base`, directly or through a
 * chain of TYPE declarations of `ast`. Stops at an unknown name or a cycle.
 */
export function structExtends(
  ast: CompilationUnit,
  derived: string,
  base: string,
): boolean {
  const target = base.toUpperCase();
  const seen = new Set<string>();
  let current = derived.toUpperCase();
  for (;;) {
    if (seen.has(current)) return false;
    seen.add(current);
    const upper = current;
    const decl = ast.types.find((t) => t.name.toUpperCase() === upper);
    if (decl?.definition.kind !== "StructDefinition" || !decl.extends) {
      return false;
    }
    current = decl.extends.name.toUpperCase();
    if (current === target) return true;
  }
}
