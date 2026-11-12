// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * The platform types of the feature platform_types: integer types whose width
 * follows the target's address width. The compiler generates for a 64-bit
 * target, so each is lowered to its 64-bit type before semantic analysis:
 *
 *   __XINT, XINT    → LINT
 *   __UXINT, UXINT  → ULINT
 *   XWORD           → __XWORD (the address-width bit string; 64-bit here)
 *   PVOID           → __XWORD (an untyped address)
 *
 * A TYPE, FUNCTION_BLOCK, PROGRAM or INTERFACE of the same name (declared in
 * the sources or by a library) wins and is not lowered. See docs/DIALECTS.md.
 */

import type {
  CompilationUnit,
  TestFile,
  TypeReference,
} from "../frontend/ast.js";

const PLATFORM_TYPES: ReadonlyMap<string, string> = new Map([
  ["__XINT", "LINT"],
  ["XINT", "LINT"],
  ["__UXINT", "ULINT"],
  ["UXINT", "ULINT"],
  ["XWORD", "__XWORD"],
  ["PVOID", "__XWORD"],
]);

/** The type a platform type name (any case) stands for, or undefined. */
export function platformTypeTarget(name: string): string | undefined {
  return PLATFORM_TYPES.get(name.toUpperCase());
}

/** Upper-case names of the TYPEs and POUs a compilation unit declares. */
function declaredTypeNames(ast: CompilationUnit): Set<string> {
  const names = new Set<string>();
  for (const list of [
    ast.types,
    ast.functionBlocks,
    ast.programs,
    ast.interfaces,
  ]) {
    for (const decl of list) names.add(decl.name.toUpperCase());
  }
  return names;
}

function isTypeReference(node: object): node is TypeReference {
  return (node as { kind?: unknown }).kind === "TypeReference";
}

/** Visit every TypeReference under `root` once. */
function forEachTypeReference(
  root: object,
  fn: (ref: TypeReference) => void,
): void {
  const seen = new Set<object>();
  const visit = (node: unknown): void => {
    if (typeof node !== "object" || node === null || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (isTypeReference(node)) fn(node);
    for (const value of Object.values(node)) visit(value);
  };
  visit(root);
}

/**
 * Rewrite every type reference to a platform type to the type it stands for.
 * `declaredElsewhere` tells whether a library declares a type of the name.
 */
export function lowerPlatformTypes(
  ast: CompilationUnit,
  declaredElsewhere: (nameUpper: string) => boolean,
): void {
  const declared = declaredTypeNames(ast);
  const target = (name: string | undefined): string | undefined => {
    if (name === undefined) return undefined;
    const upper = name.toUpperCase();
    const to = PLATFORM_TYPES.get(upper);
    if (to === undefined || declared.has(upper) || declaredElsewhere(upper)) {
      return undefined;
    }
    return to;
  };
  forEachTypeReference(ast, (node) => {
    const name = target(node.name);
    if (name !== undefined) node.name = name;
    const element = target(node.elementTypeName);
    if (element !== undefined) node.elementTypeName = element;
  });
}

/**
 * Lower the platform types of a test file, which declares no TYPE of its
 * own, keeping each name written in `platformTypeName` so that
 * {@link restoreDeclaredPlatformTypes} can undo it for a declared type.
 */
export function lowerTestPlatformTypes(testFile: TestFile): void {
  forEachTypeReference(testFile, (node) => {
    const to = PLATFORM_TYPES.get(node.name.toUpperCase());
    if (to !== undefined) {
      node.platformTypeName = node.name;
      node.name = to;
    }
    const written = node.elementTypeName;
    const element =
      written === undefined
        ? undefined
        : PLATFORM_TYPES.get(written.toUpperCase());
    if (written !== undefined && element !== undefined) {
      node.platformElementTypeName = written;
      node.elementTypeName = element;
    }
  });
}

/** Give a test file's lowered references back the name the sources declare as a type. */
export function restoreDeclaredPlatformTypes(
  testFile: TestFile,
  isDeclaredType: (nameUpper: string) => boolean,
): void {
  forEachTypeReference(testFile, (node) => {
    if (
      node.platformTypeName !== undefined &&
      isDeclaredType(node.platformTypeName.toUpperCase())
    ) {
      node.name = node.platformTypeName;
    }
    if (
      node.platformElementTypeName !== undefined &&
      isDeclaredType(node.platformElementTypeName.toUpperCase())
    ) {
      node.elementTypeName = node.platformElementTypeName;
    }
  });
}
