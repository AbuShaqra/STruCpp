// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * Where a PROGRAM is reached by name from another POU (feature program_methods):
 *
 *   PRG_A.cnt            a member of the program, read or written
 *   PRG_A.Bump(k := 5)   a method or action of the program
 *   PRG_A(inp := 1);     the program body
 *
 * A PROGRAM has one instance. A program reached this way is emitted with one
 * shared C++ instance that tasks run and every POU reaches; a program nobody
 * reaches keeps today's code. The analyzer validates each reach and the code
 * generators ask which programs are reached, so both read the same answer.
 *
 * A name declared in the POU (a variable `PRG_A`) shadows the program and is
 * not a reach. Uses inside the program itself (its body, methods and actions)
 * are not reaches either.
 */

import type {
  Argument,
  CompilationUnit,
  Expression,
  FunctionCallExpression,
  MethodCallExpression,
  Statement,
  VarBlock,
  VariableExpression,
} from "../frontend/ast.js";
import type { SourceSpan } from "../types.js";
import { walkAST } from "../ast-utils.js";

/** One use of a program by name in another POU. */
export type ProgramReach =
  | {
      kind: "member";
      /** Upper-case program name. */
      program: string;
      /** The member named after the program (`cnt` in `PRG_A.cnt`). */
      member: string;
      /** Assigned, REF=-bound or captured with `=>`. */
      write: boolean;
      node: VariableExpression;
      span: SourceSpan;
    }
  | {
      kind: "method";
      program: string;
      method: string;
      span: SourceSpan;
    }
  | {
      kind: "call";
      program: string;
      /** False when the body call is written inside an expression. */
      statement: boolean;
      arguments: Argument[];
      span: SourceSpan;
    };

/** A POU's code: the program it belongs to (upper case), if any, its names and bodies. */
interface PouCode {
  ownProgram: string | undefined;
  blocks: readonly VarBlock[];
  bodies: readonly Statement[][];
}

/** Upper-case names declared in `blocks`. */
function declaredNames(blocks: readonly VarBlock[]): Set<string> {
  const names = new Set<string>();
  for (const block of blocks) {
    for (const decl of block.declarations) {
      for (const name of decl.names) names.add(name.toUpperCase());
    }
  }
  return names;
}

/** Every body in the unit, with the names it declares. */
function pouCode(ast: CompilationUnit): PouCode[] {
  const out: PouCode[] = [];
  for (const prog of ast.programs) {
    const own = prog.name.toUpperCase();
    out.push({ ownProgram: own, blocks: prog.varBlocks, bodies: [prog.body] });
    for (const method of prog.methods) {
      out.push({
        ownProgram: own,
        blocks: [...prog.varBlocks, ...method.varBlocks],
        bodies: [method.body],
      });
    }
  }
  for (const func of ast.functions) {
    out.push({
      ownProgram: undefined,
      blocks: func.varBlocks,
      bodies: [func.body],
    });
  }
  const fbs = new Map(
    ast.functionBlocks.map((fb) => [fb.name.toUpperCase(), fb]),
  );
  for (const fb of ast.functionBlocks) {
    // The members of the EXTENDS chain are in scope too.
    const chain: VarBlock[] = [];
    const seen = new Set<string>();
    for (
      let cur: string | undefined = fb.name.toUpperCase();
      cur !== undefined && !seen.has(cur);
      cur = fbs.get(cur)?.extends?.toUpperCase()
    ) {
      seen.add(cur);
      chain.push(...(fbs.get(cur)?.varBlocks ?? []));
    }
    out.push({ ownProgram: undefined, blocks: chain, bodies: [fb.body] });
    for (const method of fb.methods) {
      out.push({
        ownProgram: undefined,
        blocks: [...chain, ...method.varBlocks],
        bodies: [method.body],
      });
    }
    for (const prop of fb.properties) {
      const bodies = [prop.getter, prop.setter].filter(
        (b): b is Statement[] => b !== undefined,
      );
      out.push({ ownProgram: undefined, blocks: chain, bodies });
    }
  }
  return out;
}

/** The first member a variable expression names, when it starts with a field. */
function firstField(expr: VariableExpression): string | undefined {
  if (expr.accessChain !== undefined && expr.accessChain.length > 0) {
    const step = expr.accessChain[0]!;
    return step.kind === "field" ? step.name : undefined;
  }
  if (expr.subscripts.length > 0) return undefined;
  return expr.fieldAccess[0];
}

/** The expressions a body writes: assignment and REF= targets, `=>` outputs. */
function writtenExpressions(bodies: readonly Statement[][]): Set<Expression> {
  const written = new Set<Expression>();
  const outputs = (args: readonly Argument[]): void => {
    for (const arg of args) if (arg.isOutput) written.add(arg.value);
  };
  for (const body of bodies) {
    for (const stmt of body) {
      walkAST(stmt, (node) => {
        if (node.kind === "AssignmentStatement") {
          written.add((node as Statement & { target: Expression }).target);
        } else if (node.kind === "RefAssignStatement") {
          written.add((node as Statement & { target: Expression }).target);
        } else if (
          node.kind === "FunctionCallExpression" ||
          node.kind === "MethodCallExpression"
        ) {
          outputs(
            (node as FunctionCallExpression | MethodCallExpression).arguments,
          );
        }
      });
    }
  }
  return written;
}

/**
 * Every place a PROGRAM of this unit is reached by name from another POU, in
 * source order per POU.
 */
export function findProgramReaches(ast: CompilationUnit): ProgramReach[] {
  const programs = new Set(ast.programs.map((p) => p.name.toUpperCase()));
  if (programs.size === 0) return [];
  const reaches: ProgramReach[] = [];
  for (const pou of pouCode(ast)) {
    const shadowed = declaredNames(pou.blocks);
    const target = (name: string): string | undefined => {
      const upper = name.toUpperCase();
      if (!programs.has(upper) || shadowed.has(upper)) return undefined;
      return upper === pou.ownProgram ? undefined : upper;
    };
    const written = writtenExpressions(pou.bodies);
    const statementCalls = new Set<FunctionCallExpression>();
    for (const body of pou.bodies) {
      for (const stmt of body) {
        walkAST(stmt, (node) => {
          if (node.kind === "FunctionCallStatement") {
            const call = (
              node as Statement & {
                call: FunctionCallExpression | MethodCallExpression;
              }
            ).call;
            if (call.kind === "FunctionCallExpression")
              statementCalls.add(call);
          }
        });
      }
    }
    for (const body of pou.bodies) {
      for (const stmt of body) {
        walkAST(stmt, (node) => {
          if (node.kind === "VariableExpression") {
            const expr = node as VariableExpression;
            const program = target(expr.name);
            const member = program !== undefined ? firstField(expr) : undefined;
            if (program !== undefined && member !== undefined) {
              reaches.push({
                kind: "member",
                program,
                member,
                write: written.has(expr),
                node: expr,
                span: expr.sourceSpan,
              });
            }
          } else if (node.kind === "FunctionCallExpression") {
            const call = node as FunctionCallExpression;
            if (call.instance !== undefined) return;
            const parts = call.functionName.split(".");
            if (parts.length === 2) {
              const program = target(parts[0]!);
              if (program !== undefined) {
                reaches.push({
                  kind: "method",
                  program,
                  method: parts[1]!,
                  span: call.sourceSpan,
                });
              }
            } else if (parts.length === 1) {
              const program = target(call.functionName);
              if (program !== undefined) {
                reaches.push({
                  kind: "call",
                  program,
                  statement: statementCalls.has(call),
                  arguments: call.arguments,
                  span: call.sourceSpan,
                });
              }
            }
          } else if (node.kind === "MethodCallExpression") {
            const call = node as MethodCallExpression;
            const obj = call.object;
            if (
              obj.kind !== "VariableExpression" ||
              obj.fieldAccess.length > 0 ||
              obj.subscripts.length > 0 ||
              (obj.accessChain?.length ?? 0) > 0
            ) {
              return;
            }
            const program = target(obj.name);
            if (program !== undefined) {
              reaches.push({
                kind: "method",
                program,
                method: call.methodName,
                span: call.sourceSpan,
              });
            }
          }
        });
      }
    }
  }
  return reaches;
}

/** Calls of a PROGRAM's own body inside the program (`PRG_A();` in PRG_A). */
export function findProgramSelfCalls(
  ast: CompilationUnit,
): Array<{ program: string; span: SourceSpan }> {
  const found: Array<{ program: string; span: SourceSpan }> = [];
  for (const pou of pouCode(ast)) {
    const own = pou.ownProgram;
    if (own === undefined || declaredNames(pou.blocks).has(own)) continue;
    for (const body of pou.bodies) {
      for (const stmt of body) {
        walkAST(stmt, (node) => {
          if (node.kind !== "FunctionCallExpression") return;
          const call = node as FunctionCallExpression;
          if (
            call.instance === undefined &&
            call.functionName.toUpperCase() === own
          ) {
            found.push({ program: own, span: call.sourceSpan });
          }
        });
      }
    }
  }
  return found;
}

/**
 * `PRG_A.x` and `PRG_A.fb(...)` written inside PRG_A itself (its body, methods
 * and actions; feature program_methods) name the program's own member, so
 * they are rewritten in place to `x` and `fb(...)`. Not rewritten: a POU
 * declaring a name PRG_A, or a method declaring a local of the member's name.
 */
export function lowerProgramSelfMembers(ast: CompilationUnit): void {
  for (const prog of ast.programs) {
    const own = prog.name.toUpperCase();
    const members = declaredNames(prog.varBlocks);
    if (members.has(own)) continue;
    const units = [
      { body: prog.body, locals: new Set<string>() },
      ...prog.methods.map((m) => ({
        body: m.body,
        locals: declaredNames(m.varBlocks),
      })),
    ];
    for (const { body, locals } of units) {
      if (locals.has(own)) continue;
      const isMember = (name: string): boolean => {
        const upper = name.toUpperCase();
        return members.has(upper) && !locals.has(upper);
      };
      for (const stmt of body) {
        walkAST(stmt, (node) => {
          if (node.kind === "VariableExpression") {
            const expr = node as VariableExpression;
            const field = firstField(expr);
            if (
              expr.name.toUpperCase() !== own ||
              field === undefined ||
              !isMember(field)
            ) {
              return;
            }
            expr.name = field;
            expr.fieldAccess = expr.fieldAccess.slice(1);
            const rest = expr.accessChain?.slice(1) ?? [];
            if (rest.length > 0) expr.accessChain = rest;
            else delete expr.accessChain;
          } else if (node.kind === "FunctionCallExpression") {
            const call = node as FunctionCallExpression;
            if (call.instance !== undefined) return;
            const parts = call.functionName.split(".");
            if (
              parts.length === 2 &&
              parts[0]!.toUpperCase() === own &&
              isMember(parts[1]!)
            ) {
              call.functionName = parts[1]!;
            }
          }
        });
      }
    }
  }
}

/** Upper-case names of the PROGRAMs reached by name from another POU. */
export function programsReachedByName(ast: CompilationUnit): Set<string> {
  return new Set(findProgramReaches(ast).map((r) => r.program));
}
