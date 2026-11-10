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
 * variable-length array), names are unique, there is no EXTENDS, a member
 * has no initial value, and an initial value of the UNION names one member.
 */

import type {
  CompilationUnit,
  Expression,
  FunctionCallExpression,
  RefAssignStatement,
  RefExpression,
  StructDefinition,
  StructInitializerExpression,
  TypeDeclaration,
  TypeReference,
  VarBlock,
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
 * One problem with an initial value that sets a UNION: `value` is the
 * expression to report at, `message` the diagnostic.
 */
interface UnionInitProblem {
  value: Expression;
  message: string;
}

/**
 * Collect the problems of initial value `value` of type `ref` where it sets a
 * UNION, looking through aliases, arrays, STRUCT elements and FB inputs. A
 * UNION takes a structure initializer naming exactly one member; that
 * member's value is checked in turn. Any other value for a UNION is refused.
 */
function collectUnionInitProblems(
  ref: TypeReference,
  value: Expression,
  index: UnitIndex,
  depth: number,
  out: UnionInitProblem[],
): void {
  if (depth > 32) return;
  if ((ref.referenceKind ?? "none") !== "none") return;
  if (ref.arrayDimensions && ref.elementTypeName !== undefined) {
    if ((ref.elementReferenceChain ?? []).length > 0) return;
    const elementName = ref.elementTypeName;
    forEachArrayElement(value, (element) =>
      collectNamedProblems(elementName, element, index, depth + 1, out),
    );
    return;
  }
  collectNamedProblems(ref.name, value, index, depth, out);
}

/** Calls `fn` for each element of an array initial value, through nested array literals. */
function forEachArrayElement(
  value: Expression,
  fn: (element: Expression) => void,
): void {
  if (value.kind !== "ArrayLiteralExpression") {
    fn(value);
    return;
  }
  for (const element of value.elements) forEachArrayElement(element, fn);
}

/** {@link collectUnionInitProblems} for a type given by name. */
function collectNamedProblems(
  name: string,
  value: Expression,
  index: UnitIndex,
  depth: number,
  out: UnionInitProblem[],
): void {
  const decl = index.resolve(name);
  const def = decl?.definition;
  if (decl && def && isUnionDefinition(def)) {
    if (value.kind !== "StructInitializerExpression") {
      out.push({
        value,
        message: `An initial value for UNION '${decl.name}' is not supported yet: name one member, as in (${def.fields[0]?.names[0] ?? "member"} := value)`,
      });
      return;
    }
    if (value.elements.length !== 1) {
      out.push({
        value,
        message: `The initial value for UNION '${decl.name}' names ${value.elements.length} members: a UNION initial value sets one member`,
      });
      return;
    }
    const named = value.elements[0]!.name;
    const upper = named.toUpperCase();
    if (
      !def.fields.some((f) => f.names.some((n) => n.toUpperCase() === upper))
    ) {
      out.push({
        value,
        message: `UNION '${decl.name}' has no member '${named}'`,
      });
      return;
    }
    collectFieldProblems(def.fields, value, index, depth, out);
    return;
  }
  if (def?.kind === "ArrayDefinition") {
    const elementType = def.elementType;
    forEachArrayElement(value, (element) =>
      collectUnionInitProblems(elementType, element, index, depth + 1, out),
    );
    return;
  }
  if (def?.kind === "TypeReference") {
    collectUnionInitProblems(def, value, index, depth + 1, out);
    return;
  }
  const fields =
    def?.kind === "StructDefinition"
      ? def.fields
      : index.fbInputs.get(name.toUpperCase());
  if (!fields) return;
  for (const init of structInitializersIn(value)) {
    collectFieldProblems(fields, init, index, depth, out);
  }
}

/** The problems in the element values of `init`, by each element's field type. */
function collectFieldProblems(
  fields: readonly VarDeclaration[],
  init: StructInitializerExpression,
  index: UnitIndex,
  depth: number,
  out: UnionInitProblem[],
): void {
  for (const element of init.elements) {
    const upper = element.name.toUpperCase();
    const field = fields.find((f) =>
      f.names.some((n) => n.toUpperCase() === upper),
    );
    if (!field) continue;
    collectUnionInitProblems(field.type, element.value, index, depth + 1, out);
  }
}

/**
 * Check an initial value that sets a UNION: a variable's, a STRUCT field's, a
 * TYPE's default, also nested in a structure initializer or an array literal.
 * It must be a structure initializer naming exactly one member, `(f := 1.0)`,
 * which writes that member into the zero-initialised storage. Members of a
 * UNION are left to {@link validateUnionTypes}. A default shared by several
 * declarations (Annex B.1.3.3) is reported once.
 */
export function validateUnionInitializers(
  ast: CompilationUnit,
  report: UnionReporter,
): void {
  if (!ast.types.some((t) => isUnionDefinition(t.definition))) return;
  const index = new UnitIndex(ast);
  const reported = new Set<Expression>();
  const check = (ref: TypeReference, value: Expression): void => {
    const problems: UnionInitProblem[] = [];
    collectUnionInitProblems(ref, value, index, 0, problems);
    for (const problem of problems) {
      if (reported.has(problem.value)) continue;
      reported.add(problem.value);
      report(problem.message, problem.value.sourceSpan);
    }
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

/** What a name not declared in the unit is, for {@link unionLoweringErrors}. */
export type UnionTypeLookup = (
  upperName: string,
) => TypeDeclaration["definition"] | undefined;

/** The type name a reference stores in place (an array's element), or undefined for a pointer. */
function storedName(ref: TypeReference): string | undefined {
  if ((ref.referenceKind ?? "none") !== "none") return undefined;
  if (ref.arrayDimensions) {
    if ((ref.elementReferenceChain ?? []).length > 0) return undefined;
    return ref.elementTypeName;
  }
  return ref.name;
}

/** True for a REFERENCE TO, written directly or as the element of an array. */
function isReferenceTo(ref: TypeReference): boolean {
  const chain = ref.arrayDimensions
    ? ref.elementReferenceChain
    : (ref.referenceChain ?? [ref.referenceKind ?? "none"]);
  return chain?.[0] === "reference_to";
}

/**
 * What compile cannot lower yet although analysis accepts it (feature union),
 * one message per place: a REF(), REF_LINK() or REF= of a UNION member, a
 * REFERENCE TO or library STRUCT stored in a UNION, and a RETAIN or
 * PERSISTENT variable that is or holds a UNION.
 */
export function unionLoweringErrors(
  ast: CompilationUnit,
  lookup: UnionTypeLookup,
  report: UnionReporter,
): void {
  const index = new UnitIndex(ast);
  const isUnionName = (name: string): string | undefined => {
    const decl = index.resolve(name);
    if (decl) {
      return isUnionDefinition(decl.definition) ? decl.name : undefined;
    }
    const def = lookup(name.toUpperCase());
    return def !== undefined && isUnionDefinition(def) ? name : undefined;
  };

  // Members of UNIONs and the STRUCT fields stored in them.
  const checkStored = (
    unionName: string,
    fields: VarDeclaration[],
    seen: Set<string>,
  ): void => {
    for (const field of fields) {
      const member = field.names[0] ?? "";
      if (isReferenceTo(field.type)) {
        report(
          `Member '${member}' stored in UNION '${unionName}' is a REFERENCE TO: a REFERENCE TO in a UNION is not supported yet`,
          field.type.sourceSpan,
        );
        continue;
      }
      const name = storedName(field.type);
      if (name === undefined) continue;
      const upper = name.toUpperCase();
      if (seen.has(upper)) continue;
      seen.add(upper);
      const decl = index.resolve(name);
      const def = decl?.definition;
      if (def === undefined) {
        const ext = lookup(upper);
        if (ext?.kind === "StructDefinition" && ext.isUnion !== true) {
          report(
            `Member '${member}' stored in UNION '${unionName}' is of library STRUCT type '${name}': a library STRUCT in a UNION is not supported yet`,
            field.type.sourceSpan,
          );
        }
        continue;
      }
      if (def.kind === "StructDefinition") {
        checkStored(unionName, def.fields, seen);
      } else if (def.kind === "ArrayDefinition") {
        checkStored(unionName, [{ ...field, type: def.elementType }], seen);
      }
    }
  };
  for (const t of ast.types) {
    if (!isUnionDefinition(t.definition)) continue;
    checkStored(t.name, t.definition.fields, new Set([t.name.toUpperCase()]));
  }

  // The UNION a type is or holds (arrays, aliases, STRUCT fields, FB members).
  const heldUnion = (
    ref: TypeReference,
    seen: Set<string>,
  ): string | undefined => {
    const name = storedName(ref);
    if (name === undefined) return undefined;
    const upper = name.toUpperCase();
    if (seen.has(upper)) return undefined;
    seen.add(upper);
    const union = isUnionName(name);
    if (union !== undefined) return union;
    const decl = index.resolve(name);
    const def = decl?.definition ?? lookup(upper);
    let fields: VarDeclaration[] = [];
    if (def?.kind === "StructDefinition") fields = def.fields;
    else if (def?.kind === "ArrayDefinition") {
      return heldUnion(def.elementType, seen);
    } else if (def?.kind === "TypeReference" && decl !== undefined) {
      return heldUnion(def, seen);
    } else {
      const fb = ast.functionBlocks.find((f) => f.name.toUpperCase() === upper);
      if (fb) {
        fields = fb.varBlocks
          .filter(
            (b) =>
              b.blockType !== "VAR_IN_OUT" &&
              b.blockType !== "VAR_EXTERNAL" &&
              b.blockType !== "VAR_TEMP",
          )
          .flatMap((b) => b.declarations);
      }
    }
    for (const f of fields) {
      const hit = heldUnion(f.type, seen);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };

  walkAST(ast, (node) => {
    if (node.kind === "VarBlock") {
      const block = node as VarBlock;
      if (!block.isRetain) return;
      for (const decl of block.declarations) {
        const union = heldUnion(decl.type, new Set());
        if (union === undefined) continue;
        report(
          `RETAIN of a UNION is not supported yet: '${decl.names[0] ?? ""}' is or holds UNION '${union}'`,
          decl.sourceSpan,
        );
      }
      return;
    }
    if (node.kind === "RefExpression") {
      const operand = (node as RefExpression).operand;
      if (isUnionMemberAccess(operand)) {
        report(
          "REF of a UNION member is not supported yet",
          operand.sourceSpan,
        );
      }
      return;
    }
    if (node.kind === "FunctionCallExpression") {
      const call = node as FunctionCallExpression;
      const arg = call.arguments[0]?.value;
      if (
        call.functionName.toUpperCase() === "REF_LINK" &&
        arg !== undefined &&
        isUnionMemberAccess(arg)
      ) {
        report("REF of a UNION member is not supported yet", arg.sourceSpan);
      }
      return;
    }
    if (node.kind === "RefAssignStatement") {
      const stmt = node as RefAssignStatement;
      for (const side of [stmt.target, stmt.source]) {
        if (isUnionMemberAccess(side)) {
          report(
            "REF= on a UNION member is not supported yet",
            side.sourceSpan,
          );
        }
      }
    }
    return;
  });
}

/** A variable access the type checker found inside a UNION's storage. */
function isUnionMemberAccess(expr: Expression): boolean {
  return expr.kind === "VariableExpression" && expr.unionMember === true;
}
