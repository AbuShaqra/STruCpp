// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * Lower a property accessor that declares locals to a method of its
 * FUNCTION_BLOCK.
 *
 *   PROPERTY Value : INT
 *   GET  VAR t : INT; END_VAR  t := _v * 2; Value := t;  END_GET
 *   SET  VAR t : INT; END_VAR  t := Value;  _v := t;     END_SET
 *     →  METHOD PRIVATE __GET_FB_Value  VAR_OUTPUT Value : INT; END_VAR
 *                                       VAR t : INT; END_VAR ... END_METHOD
 *        METHOD PRIVATE __SET_FB_Value  VAR_INPUT Value : INT; END_VAR
 *                                       VAR t : INT; END_VAR ... END_METHOD
 *
 * The accessor keeps an empty body and names its method (`getterMethod`,
 * `setterMethod`); code generation calls it from the accessor. The locals
 * are then scoped, checked and generated as any method's locals are. The
 * method name carries the FB's name, so it never overrides a base accessor.
 * An accessor without declarations is left alone.
 */

import type {
  CompilationUnit,
  FunctionBlockDeclaration,
  MethodDeclaration,
  PropertyDeclaration,
  Statement,
  VarBlock,
  VarBlockType,
} from "../frontend/ast.js";
import type { CompileError } from "../types.js";

const ACCESSOR_BLOCKS: ReadonlySet<VarBlockType> = new Set<VarBlockType>([
  "VAR",
  "VAR_TEMP",
]);

/** The name of the method that holds an accessor's body. */
export function accessorMethodName(
  fbName: string,
  propertyName: string,
  accessor: "GET" | "SET",
): string {
  return `__${accessor}_${fbName}_${propertyName}`;
}

function lowerOne(
  fb: FunctionBlockDeclaration,
  prop: PropertyDeclaration,
  accessor: "GET" | "SET",
  blocks: VarBlock[],
  body: Statement[],
  errors: CompileError[],
): string | undefined {
  const refused = blocks.find((b) => !ACCESSOR_BLOCKS.has(b.blockType));
  if (refused) {
    errors.push({
      message: `A property accessor declares only VAR or VAR_TEMP variables, not ${refused.blockType} (${accessor} of '${prop.name}')`,
      line: refused.sourceSpan.startLine,
      column: refused.sourceSpan.startCol,
      severity: "error",
      ...(refused.sourceSpan.file !== undefined
        ? { file: refused.sourceSpan.file }
        : {}),
    });
    return undefined;
  }
  const name = accessorMethodName(fb.name, prop.name, accessor);
  // The property's own name: the value a GET returns, the value a SET receives.
  const value: VarBlock = {
    kind: "VarBlock",
    sourceSpan: prop.sourceSpan,
    blockType: accessor === "GET" ? "VAR_OUTPUT" : "VAR_INPUT",
    isConstant: false,
    isRetain: false,
    isNonRetain: false,
    declarations: [
      {
        kind: "VarDeclaration",
        sourceSpan: prop.sourceSpan,
        names: [prop.name],
        type: { ...prop.type },
      },
    ],
  };
  const method: MethodDeclaration = {
    kind: "MethodDeclaration",
    sourceSpan: prop.sourceSpan,
    name,
    visibility: "PRIVATE",
    isAbstract: false,
    isFinal: false,
    isOverride: false,
    varBlocks: [value, ...blocks],
    body,
    fromAccessor: true,
  };
  fb.methods.push(method);
  return name;
}

/**
 * Move every accessor body that declares locals into a method of its FB.
 * Mutates `unit`. Returns the errors found; a refused accessor keeps its
 * body and loses its declarations.
 */
export function lowerAccessorLocals(unit: CompilationUnit): CompileError[] {
  const errors: CompileError[] = [];
  for (const fb of unit.functionBlocks) {
    for (const prop of fb.properties) {
      if (prop.getterVarBlocks !== undefined && prop.getter !== undefined) {
        const name = lowerOne(
          fb,
          prop,
          "GET",
          prop.getterVarBlocks,
          prop.getter,
          errors,
        );
        if (name !== undefined) {
          prop.getter = [];
          prop.getterMethod = name;
        }
      }
      if (prop.setterVarBlocks !== undefined && prop.setter !== undefined) {
        const name = lowerOne(
          fb,
          prop,
          "SET",
          prop.setterVarBlocks,
          prop.setter,
          errors,
        );
        if (name !== undefined) {
          prop.setter = [];
          prop.setterMethod = name;
        }
      }
      delete prop.getterVarBlocks;
      delete prop.setterVarBlocks;
    }
  }
  return errors;
}
