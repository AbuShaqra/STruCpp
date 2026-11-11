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
  AssignmentStatement,
  CompilationUnit,
  FunctionCallExpression,
  MethodCallExpression,
  RefAssignStatement,
  FunctionBlockDeclaration,
  MethodDeclaration,
  PropertyDeclaration,
  Statement,
  VarBlock,
  VarBlockType,
} from "../frontend/ast.js";
import type { CompileError } from "../types.js";
import { walkAST } from "../ast-utils.js";

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
  // A point, so no diagnostic in the accessor is placed in this block.
  const head = {
    ...prop.sourceSpan,
    endLine: prop.sourceSpan.startLine,
    endCol: prop.sourceSpan.startCol,
  };
  // The property's own name: the value a GET returns, the value a SET receives.
  const value: VarBlock = {
    kind: "VarBlock",
    sourceSpan: head,
    blockType: accessor === "GET" ? "VAR_OUTPUT" : "VAR_INPUT",
    isConstant: false,
    isRetain: false,
    isNonRetain: false,
    declarations: [
      {
        kind: "VarDeclaration",
        sourceSpan: head,
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
      // A GET is a const C++ member: one that changes or calls the instance
      // runs as a method too, as one with locals does.
      if (
        prop.getterVarBlocks === undefined &&
        prop.getter !== undefined &&
        prop.getter.length > 0 &&
        getterChangesInstance(unit, fb, prop)
      ) {
        prop.getterVarBlocks = [];
      }
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

/**
 * Whether a GET body writes a member of its FB (a base's included), calls a
 * method of it, or invokes a member: what a const C++ getter cannot do.
 */
function getterChangesInstance(
  unit: CompilationUnit,
  fb: FunctionBlockDeclaration,
  prop: PropertyDeclaration,
): boolean {
  const members = new Set<string>();
  const methods = new Set<string>();
  const seen = new Set<string>();
  let current: FunctionBlockDeclaration | undefined = fb;
  while (current !== undefined && !seen.has(current.name.toUpperCase())) {
    seen.add(current.name.toUpperCase());
    for (const block of current.varBlocks) {
      for (const decl of block.declarations) {
        for (const n of decl.names) members.add(n.toUpperCase());
      }
    }
    for (const m of current.methods) methods.add(m.name.toUpperCase());
    // Writing another property calls its (non-const) setter.
    for (const p of current.properties) members.add(p.name.toUpperCase());
    const base: string | undefined = current.extends?.toUpperCase();
    current =
      base === undefined
        ? undefined
        : unit.functionBlocks.find((f) => f.name.toUpperCase() === base);
  }
  const self = prop.name.toUpperCase();
  const rootOf = (name: string): string => name.split(".")[0]!.toUpperCase();
  const isInstance = (root: string): boolean =>
    root === "THIS" || root === "SUPER" || members.has(root);
  let changes = false;
  for (const stmt of prop.getter ?? []) {
    walkAST(stmt, (node) => {
      if (changes) return false;
      if (
        node.kind === "AssignmentStatement" ||
        node.kind === "RefAssignStatement"
      ) {
        const target = (node as AssignmentStatement | RefAssignStatement)
          .target;
        if (target.kind === "VariableExpression") {
          const root = target.name.toUpperCase();
          if (root !== self && isInstance(root)) changes = true;
        }
      } else if (node.kind === "FunctionCallExpression") {
        const call = node as FunctionCallExpression;
        const root = rootOf(call.functionName);
        if (
          call.instance !== undefined ||
          isInstance(root) ||
          (!call.functionName.includes(".") && methods.has(root))
        ) {
          changes = true;
        }
      } else if (node.kind === "MethodCallExpression") {
        const object = (node as MethodCallExpression).object;
        if (
          object.kind === "VariableExpression" &&
          isInstance(object.name.toUpperCase())
        ) {
          changes = true;
        }
      }
      return undefined;
    });
    if (changes) return true;
  }
  return changes;
}
