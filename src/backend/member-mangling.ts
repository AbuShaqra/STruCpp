// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * The one rule for renaming a C++ member whose ST name would not survive
 * translation.
 *
 * Two collisions force a trailing underscore:
 *
 *   1. **The member's name matches its own type's name.** CODESYS allows
 *      `RunningLights : RunningLights` and real projects use it, but GCC rejects
 *      a member that changes the meaning of its type name within the class
 *      (`-Wchanges-meaning`), so it is emitted as `RUNNINGLIGHTS_`.
 *
 *      The same holds for a member named like another user-defined type that
 *      a declaration of the same scope uses (`s3 : STRING(3)` next to
 *      `a : S3`): see {@link typeShadowingMemberNames}.
 *
 *   2. **The member's name matches an interface method the owning FB
 *      implements.** `VAR Start : BOOL` inside a `FUNCTION_BLOCK ... IMPLEMENTS
 *      IMotor` that declares `METHOD Start` would otherwise redeclare the method
 *      as a data member.
 *
 * Every emitter that writes or addresses a member has to agree, because they all
 * name the same C++ entity: the class definition (`codegen` / `type-codegen`),
 * body expressions (`codegen` / `test-codegen`), and the debugger's pointer
 * table (`debug-table-gen`). The rule previously existed as five copies with
 * three different conditions; the debug table drifting from the class definition
 * broke the build of any project using the pattern, and only in a full firmware
 * build, since `strucpp file.st` emits no debug table.
 *
 * Callers differ in what they can resolve, so both inputs arrive through
 * {@link MemberManglingContext} rather than being computed here.
 */

import type {
  CompilationUnit,
  MethodDeclaration,
  TypeReference,
  VarBlock,
  VarDeclaration,
} from "../frontend/ast.js";

/**
 * Upper-cased names of every user-defined type in a compilation unit — function
 * blocks, interfaces, TYPE declarations, and programs, matching what
 * `CodeGenerator.isUserDefinedType` recognises.
 *
 * For emitters that have only the AST. It cannot see library-declared types, so
 * anything holding symbol tables should consult those as well; no elementary
 * name can appear here, since redeclaring one is an error.
 */
export function userDefinedTypeNames(ast: CompilationUnit): Set<string> {
  const names = new Set<string>();
  for (const fb of ast.functionBlocks) names.add(fb.name.toUpperCase());
  for (const iface of ast.interfaces) names.add(iface.name.toUpperCase());
  for (const type of ast.types) names.add(type.name.toUpperCase());
  for (const prog of ast.programs) names.add(prog.name.toUpperCase());
  return names;
}

/**
 * What the rule needs to know, supplied by each emitter from whatever it has:
 * codegen from its `known*Types` sets, the debug table from the symbol tables
 * and AST.
 */
export interface MemberManglingContext {
  /**
   * True when `typeName` is a user-defined type — function block, interface,
   * STRUCT/UDT, or program.
   *
   * Must be false for elementary types. `Time : TIME` is an ordinary
   * declaration that codegen emits unmangled, so mangling it would name a
   * `TIME_` member that does not exist.
   */
  isUserDefinedType(typeName: string): boolean;

  /**
   * Upper-cased method names of every interface implemented by the type that
   * *declares* the member — not the member's own type. Omitted where the caller
   * has no owner in hand, which skips that check rather than guessing.
   */
  interfaceMethods?: ReadonlySet<string> | undefined;

  /**
   * Upper-cased member names that hide a user type their scope uses
   * ({@link typeShadowingMemberNames}). Omitted where unknown.
   */
  shadowingNames?: ReadonlySet<string> | undefined;
}

/** The declarations of one scope: each type used, with the name it declares. */
type ScopeDeclarations = Array<{ name?: string; type: string }>;

/**
 * Upper-cased names that a scope (a PROGRAM, FUNCTION_BLOCK with its methods
 * and properties, FUNCTION or STRUCT) gives a variable while another of its
 * declarations is of the user type of that name: the C++ name would hide the
 * type. A variable named like its own type alone is rule 1, not this.
 */
export function typeShadowingMemberNames(ast: CompilationUnit): Set<string> {
  const userTypes = userDefinedTypeNames(ast);
  const result = new Set<string>();
  const scopes: ScopeDeclarations[] = [];
  const add = (scope: ScopeDeclarations, blocks: readonly VarBlock[]): void => {
    for (const block of blocks) {
      for (const decl of block.declarations) addDecl(scope, decl);
    }
  };
  const addDecl = (scope: ScopeDeclarations, decl: VarDeclaration): void => {
    for (const name of decl.names) {
      scope.push({ name: name.toUpperCase(), type: typeNameOf(decl.type) });
    }
  };
  const typeNameOf = (type: TypeReference): string =>
    (type.arrayDimensions !== undefined && type.elementTypeName !== undefined
      ? type.elementTypeName
      : type.name
    ).toUpperCase();
  const withMethods = (
    blocks: readonly VarBlock[],
    methods: readonly MethodDeclaration[],
    extraTypes: readonly TypeReference[],
  ): ScopeDeclarations => {
    const scope: ScopeDeclarations = [];
    add(scope, blocks);
    for (const m of methods) {
      add(scope, m.varBlocks);
      if (m.returnType) scope.push({ type: typeNameOf(m.returnType) });
    }
    for (const t of extraTypes) scope.push({ type: typeNameOf(t) });
    return scope;
  };
  for (const fb of ast.functionBlocks) {
    scopes.push(
      withMethods(
        fb.varBlocks,
        fb.methods,
        fb.properties.map((p) => p.type),
      ),
    );
  }
  for (const prog of ast.programs) {
    scopes.push(withMethods(prog.varBlocks, prog.methods, []));
  }
  for (const fn of ast.functions) {
    scopes.push(withMethods(fn.varBlocks, [], [fn.returnType]));
  }
  for (const type of ast.types) {
    if (type.definition.kind !== "StructDefinition") continue;
    const scope: ScopeDeclarations = [];
    for (const decl of type.definition.fields) addDecl(scope, decl);
    scopes.push(scope);
  }
  for (const scope of scopes) {
    for (const entry of scope) {
      const name = entry.name;
      if (name === undefined || !userTypes.has(name)) continue;
      if (scope.some((other) => other !== entry && other.type === name)) {
        result.add(name);
      }
    }
  }
  return result;
}

/**
 * Whether a member needs the trailing underscore. See the module comment for the
 * two collisions.
 *
 * `memberTypeName` is the member's declared ST type; undefined where the caller
 * cannot resolve it, which skips the type-collision check.
 */
export function needsMemberMangling(
  memberName: string,
  memberTypeName: string | undefined,
  ctx: MemberManglingContext,
): boolean {
  const upperMember = memberName.toUpperCase();

  if (
    memberTypeName !== undefined &&
    memberTypeName !== "" &&
    upperMember === memberTypeName.toUpperCase() &&
    ctx.isUserDefinedType(memberTypeName)
  ) {
    return true;
  }

  // Named like a user type that the same declaring scope uses for another
  // declaration: the member would hide the type there.
  if (ctx.shadowingNames?.has(upperMember) === true) return true;

  return ctx.interfaceMethods?.has(upperMember) === true;
}

/** The member's C++ name: {@link needsMemberMangling} applied. */
export function mangledMemberName(
  memberName: string,
  memberTypeName: string | undefined,
  ctx: MemberManglingContext,
): string {
  return needsMemberMangling(memberName, memberTypeName, ctx)
    ? `${memberName}_`
    : memberName;
}
