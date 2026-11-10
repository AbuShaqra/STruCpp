// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * The C++ names of user POUs and types named like a runtime function.
 *
 * A FUNCTION_BLOCK, INTERFACE or TYPE named like a function the runtime
 * declares at namespace scope (`SUB`, `MID`, `LIMIT`) is hidden by that
 * function in C++, so `SUB inst;` does not name a type. A FUNCTION of such a
 * name overloads the runtime one, and the runtime template can win the call.
 * Each of them is emitted as `NAME_`, the rule {@link globalCppName} applies
 * to globals.
 *
 * The renaming is applied to the analysed AST, right before code generation:
 * diagnostics and the analysis results keep the ST name. Variable names are
 * never touched, so the debug table and the REPL show the names as written.
 */

import type {
  ASTNode,
  CompilationUnit,
  FunctionCallExpression,
  IECType,
  StructDefinition,
  TestFile,
  TypeReference,
  VariableExpression,
} from "../frontend/ast.js";
import { walkAST } from "../ast-utils.js";
import type { SymbolTables } from "../semantic/symbol-table.js";
import type {
  ProjectModel,
  ProjectVarDeclaration,
  VarExternalDeclaration,
} from "../project-model.js";
import { RUNTIME_NAMESPACE_NAMES } from "./global-naming.js";

/** The C++ name of a renamed POU or type. */
function renamed(name: string): string {
  return `${name}_`;
}

/** Synthesised type names that embed an element type: inline and open arrays. */
const EMBEDDED_TYPE_NAME = /^(__INLINE_ARRAY_|__VLA_\d+D_)(.+)$/i;

/** The renamed declarations of one compilation unit and how to rewrite references to them. */
class PouRenamer {
  private readonly renamedTypes = new WeakSet<IECType>();

  constructor(
    /** Upper-cased FUNCTION_BLOCK, INTERFACE and TYPE names to rename. */
    readonly types: ReadonlySet<string>,
    /** Upper-cased FUNCTION names to rename. */
    readonly functions: ReadonlySet<string>,
    /** The enumeration types among {@link types}. */
    private readonly enumTypes: ReadonlySet<string>,
  ) {}

  /** `name`, or its C++ name when it names a renamed type. */
  typeName(name: string): string {
    if (this.types.has(name.toUpperCase())) return renamed(name);
    const m = EMBEDDED_TYPE_NAME.exec(name);
    return m !== null && this.types.has(m[2]!.toUpperCase())
      ? `${m[1]}${renamed(m[2]!)}`
      : name;
  }

  /**
   * Rewrite every reference under `node`. `ownFunction` is the upper-cased
   * name of the FUNCTION whose body this is: its result variable.
   */
  visit(node: ASTNode, ownFunction?: string): void {
    walkAST(node, (n) => {
      this.renameType((n as ASTNode & { resolvedType?: IECType }).resolvedType);
      switch (n.kind) {
        case "TypeReference":
          this.renameTypeRef(n as TypeReference);
          break;
        case "StructDefinition":
          // Fields inherited through EXTENDS are not walked: rename them here.
          for (const field of (n as StructDefinition).fields) {
            this.renameTypeRef(field.type);
          }
          break;
        case "FunctionCallExpression":
        case "MockFunctionStatement": {
          const call = n as FunctionCallExpression;
          if (this.functions.has(call.functionName.toUpperCase())) {
            call.functionName = renamed(call.functionName);
          }
          break;
        }
        case "VariableExpression": {
          const v = n as VariableExpression;
          if (v.enumType !== undefined) v.enumType = this.typeName(v.enumType);
          // `E#A` and `E.A` name an enumeration type.
          const upper = v.name.toUpperCase();
          if (
            (this.enumTypes.has(upper) &&
              (v.typedLiteral === true || v.fieldAccess.length > 0)) ||
            (upper === ownFunction && this.functions.has(upper))
          ) {
            v.name = renamed(v.name);
          }
          break;
        }
        case "LiteralExpression": {
          const lit = n as ASTNode & { typePrefix?: string };
          if (lit.typePrefix !== undefined) {
            lit.typePrefix = this.typeName(lit.typePrefix);
          }
          break;
        }
        case "AssertCall": {
          const args = (n as ASTNode & { args: ASTNode[] }).args;
          for (const arg of args) this.visit(arg, ownFunction);
          break;
        }
      }
    });
  }

  private renameTypeRef(tr: TypeReference): void {
    tr.name = this.typeName(tr.name);
    if (tr.elementTypeName !== undefined) {
      tr.elementTypeName = this.typeName(tr.elementTypeName);
    }
  }

  /** Rename an analysed type, shared or not, once. */
  private renameType(t: IECType | undefined): void {
    if (t === undefined || this.renamedTypes.has(t)) return;
    this.renamedTypes.add(t);
    const named = t as IECType & { name?: unknown };
    if (typeof named.name === "string") {
      (named as { name: string }).name = this.typeName(named.name);
    }
    if (t.typeKind === "array") {
      this.renameType((t as IECType & { elementType: IECType }).elementType);
    } else if (t.typeKind === "reference") {
      this.renameType(
        (t as IECType & { referencedType: IECType }).referencedType,
      );
    } else if (t.typeKind === "struct") {
      const fields = (t as IECType & { fields: Map<string, IECType> }).fields;
      for (const f of fields.values()) this.renameType(f);
    }
  }
}

/** The renaming applied to each compilation unit, for code generated beside it. */
const renamersByUnit = new WeakMap<CompilationUnit, PouRenamer>();

/**
 * Rename, in place, every user FUNCTION, FUNCTION_BLOCK, INTERFACE and TYPE
 * whose name the runtime declares at namespace scope, with all references to
 * it, and register each new name in the global scope beside the old one.
 * Returns the upper-cased new name → declared name, empty when nothing
 * collides.
 */
export function renameRuntimeCollidingPous(
  ast: CompilationUnit,
  symbolTables: SymbolTables | undefined,
  projectModel?: ProjectModel,
): Map<string, string> {
  const collides = (name: string): boolean =>
    RUNTIME_NAMESPACE_NAMES.has(name.toUpperCase());
  const typeDecls = [...ast.functionBlocks, ...ast.interfaces, ...ast.types];
  const types = new Set(
    typeDecls.filter((d) => collides(d.name)).map((d) => d.name.toUpperCase()),
  );
  const functions = new Set(
    ast.functions
      .filter((f) => collides(f.name))
      .map((f) => f.name.toUpperCase()),
  );
  const display = new Map<string, string>();
  if (types.size === 0 && functions.size === 0) return display;
  const enumTypes = new Set(
    ast.types
      .filter(
        (t) =>
          t.definition.kind === "EnumDefinition" &&
          types.has(t.name.toUpperCase()),
      )
      .map((t) => t.name.toUpperCase()),
  );
  const renamer = new PouRenamer(types, functions, enumTypes);
  renamersByUnit.set(ast, renamer);

  // Symbols stay reachable under the declared name, and gain the new one.
  if (symbolTables) {
    for (const upper of [...types, ...functions]) {
      const sym = symbolTables.globalScope.lookupLocal(upper);
      if (sym) {
        symbolTables.globalScope.defineOrReplace({
          ...sym,
          name: renamed(sym.name),
        });
      }
    }
  }
  if (projectModel) renameInProjectModel(projectModel, renamer);

  for (const fb of ast.functionBlocks) {
    if (fb.extends !== undefined) fb.extends = renamer.typeName(fb.extends);
    if (fb.implements) {
      fb.implements = fb.implements.map((n) => renamer.typeName(n));
    }
  }
  for (const itf of ast.interfaces) {
    if (itf.extends) itf.extends = itf.extends.map((n) => renamer.typeName(n));
  }
  for (const action of ast.actions) {
    if (action.owner !== undefined) {
      action.owner = renamer.typeName(action.owner);
    }
  }
  // Bodies before declarations, so a function's result variable is matched.
  for (const fn of ast.functions) renamer.visit(fn, fn.name.toUpperCase());
  for (const list of [
    ast.programs,
    ast.functionBlocks,
    ast.interfaces,
    ast.types,
    ast.configurations,
    ast.globalVarBlocks,
    ast.actions,
  ] as ASTNode[][]) {
    for (const node of list) renamer.visit(node);
  }

  for (const d of [...typeDecls, ...ast.functions]) {
    const upper = d.name.toUpperCase();
    if (types.has(upper) || functions.has(upper)) {
      display.set(renamed(d.name).toUpperCase(), d.name);
      d.name = renamed(d.name);
    }
  }
  return display;
}

/**
 * Apply the renaming {@link renameRuntimeCollidingPous} made to `ast` to test
 * files compiled against it. A no-op when nothing was renamed.
 */
export function renamePouReferencesInTests(
  ast: CompilationUnit,
  testFiles: readonly TestFile[],
): void {
  const renamer = renamersByUnit.get(ast);
  if (!renamer) return;
  for (const tf of testFiles) {
    const nodes: ASTNode[] = [
      ...(tf.inlineTypes ?? []),
      ...(tf.setup?.varBlocks ?? []),
      ...(tf.setup?.body ?? []),
      ...(tf.teardown?.body ?? []),
      ...tf.testCases.flatMap((tc) => [...tc.varBlocks, ...tc.body]),
    ];
    for (const node of nodes) renamer.visit(node);
  }
}

/** The type names a project model records, renamed; renamed POUs are keyed under both names. */
function renameInProjectModel(model: ProjectModel, renamer: PouRenamer): void {
  const vars = (
    list: readonly (ProjectVarDeclaration | VarExternalDeclaration)[],
  ): void => {
    for (const v of list) {
      v.typeName = renamer.typeName(v.typeName);
      if (v.elementTypeName !== undefined) {
        v.elementTypeName = renamer.typeName(v.elementTypeName);
      }
    }
  };
  for (const c of model.configurations) vars(c.globalVars);
  for (const p of model.programs.values()) {
    vars(p.varDeclarations);
    vars(p.varExternal);
  }
  for (const fb of [...model.functionBlocks.values()]) {
    vars([...fb.inputs, ...fb.outputs, ...fb.inouts, ...fb.locals]);
    vars(fb.varExternal);
    const name = renamer.typeName(fb.name);
    if (name !== fb.name) {
      fb.name = name;
      model.functionBlocks.set(name.toUpperCase(), fb);
    }
  }
  for (const fn of [...model.functions.values()]) {
    vars(fn.parameters);
    fn.returnType = renamer.typeName(fn.returnType);
    if (renamer.functions.has(fn.name.toUpperCase())) {
      fn.name = renamed(fn.name);
      model.functions.set(fn.name.toUpperCase(), fn);
    }
  }
}
