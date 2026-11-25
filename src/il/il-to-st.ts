// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * STruC++ IL to ST Converter
 *
 * Converts parsed IL instructions into Structured Text source code.
 * Uses expression threading for straight-line IL (no accumulator variable)
 * and a CASE state machine for IL with labels/jumps.
 */

import type { ILElement, ILInstruction } from "./il-types.js";

/** Map from IL binary operators to ST operator text. */
const BINARY_OP_MAP: Record<string, string> = {
  AND: "AND",
  ANDN: "AND NOT",
  OR: "OR",
  ORN: "OR NOT",
  XOR: "XOR",
  XORN: "XOR NOT",
  ADD: "+",
  SUB: "-",
  MUL: "*",
  DIV: "/",
  MOD: "MOD",
  EQ: "=",
  NE: "<>",
  GT: ">",
  GE: ">=",
  LT: "<",
  LE: "<=",
};

/** Conversion error. */
export interface ILConvertError {
  message: string;
  line: number;
  column: number;
}

/** Result of IL→ST conversion. */
export interface ILConvertResult {
  /** Generated ST body text */
  stBody: string;
  /** Conversion errors */
  errors: ILConvertError[];
  /** Whether extra VAR declarations are needed (for state machine) */
  extraVars?: string;
  /** For each line of `stBody`, the IL source line it comes from (0: none). */
  lineSources?: number[];
  /** `stBody` with each operand marked by the IL line naming it (see markOrigin). */
  markedBody?: string;
}

/** Marks around an operand in generated ST: start, IL line, end of the line number, end. */
export const ORIGIN_START = "\u0001";
export const ORIGIN_LINE_END = "\u0002";
export const ORIGIN_END = "\u0003";

/**
 * `operand` marked with the IL line that names it, so a diagnostic at it can
 * be moved there (see il-transpiler.ts); the marks are removed from the ST.
 */
function markOrigin(operand: string, line: number): string {
  return `${ORIGIN_START}${line}${ORIGIN_LINE_END}${operand}${ORIGIN_END}`;
}

/** `text` without the origin marks of {@link markOrigin}. */
export function stripOrigins(text: string): string {
  return text.replace(
    new RegExp(`${ORIGIN_START}\\d+${ORIGIN_LINE_END}|${ORIGIN_END}`, "g"),
    "",
  );
}

/** Generated ST lines, each with the IL source line (`at` when pushed; 0: none). */
class SourcedLines {
  readonly text: string[] = [];
  readonly from: number[] = [];
  at = 0;
  push(...lines: string[]): void {
    for (const line of lines) {
      this.text.push(line);
      this.from.push(this.at);
    }
  }
}

/**
 * Convert parsed IL instructions to ST body text.
 *
 * For straight-line IL (no jumps/labels), uses expression threading
 * which produces clean ST without accumulator variables.
 *
 * For IL with jumps/labels, generates a CASE-based state machine.
 */
export function convertILToST(
  elements: ILElement[],
  hasControlFlow: boolean,
): ILConvertResult {
  if (hasControlFlow) {
    return convertWithStateMachine(elements);
  }
  return convertStraightLine(elements);
}

// =============================================================================
// Straight-line conversion (expression threading)
// =============================================================================

function convertStraightLine(elements: ILElement[]): ILConvertResult {
  const lines = new SourcedLines();
  const errors: ILConvertError[] = [];
  let expr = ""; // current accumulator expression

  // Expression stack for parenthesized expressions: (saved_expr, operator)
  const exprStack: Array<{ expr: string; op: string }> = [];

  for (const elem of elements) {
    if ("kind" in elem && elem.kind === "closeParen") {
      // Pop from expression stack and combine
      if (exprStack.length === 0) {
        errors.push({
          message: "Unexpected closing parenthesis",
          line: elem.sourceLine,
          column: 1,
        });
        continue;
      }
      const saved = exprStack.pop()!;
      expr = `(${saved.expr} ${saved.op} (${expr}))`;
      continue;
    }

    const instr = elem as ILInstruction;
    const op = instr.operator;
    const operand = instr.operand;
    const marked =
      operand !== undefined ? markOrigin(operand, instr.sourceLine) : undefined;
    lines.at = instr.sourceLine;

    switch (op) {
      case "LD":
        expr = marked ?? "";
        break;

      case "LDN":
        expr = `NOT ${marked ?? ""}`;
        break;

      case "ST":
        if (operand) {
          lines.push(`  ${marked} := ${expr};`);
        }
        break;

      case "STN":
        if (operand) {
          lines.push(`  ${marked} := NOT (${expr});`);
        }
        break;

      case "NOT":
        expr = `NOT (${expr})`;
        break;

      case "S":
        if (operand) {
          lines.push(`  IF ${expr} THEN ${marked} := TRUE; END_IF;`);
        }
        break;

      case "R":
        if (operand) {
          lines.push(`  IF ${expr} THEN ${marked} := FALSE; END_IF;`);
        }
        break;

      // Implicit FB invocation: assign accumulator to named input, then call FB
      // e.g., IN CMD_TMR → CMD_TMR.IN := expr; CMD_TMR();
      case "S1":
      case "R1":
      case "CLK":
      case "CU":
      case "CD":
      case "PV":
      case "IN":
      case "PT":
        if (operand) {
          lines.push(`  ${marked}.${op} := ${expr};`);
          lines.push(`  ${marked}();`);
        }
        break;

      case "CAL":
      case "CALC":
      case "CALCN": {
        const callST = generateCAL(instr);
        if (op === "CALC") {
          lines.push(`  IF ${expr} THEN`);
          lines.push(`    ${callST}`);
          lines.push(`  END_IF;`);
        } else if (op === "CALCN") {
          lines.push(`  IF NOT (${expr}) THEN`);
          lines.push(`    ${callST}`);
          lines.push(`  END_IF;`);
        } else {
          lines.push(`  ${callST}`);
        }
        break;
      }

      case "RET":
        lines.push("  RETURN;");
        break;

      case "RETC":
        lines.push(`  IF ${expr} THEN RETURN; END_IF;`);
        break;

      case "RETCN":
        lines.push(`  IF NOT (${expr}) THEN RETURN; END_IF;`);
        break;

      case "FUNC_CALL":
        // Inline function call: applies function to accumulator
        // e.g., BCD_TO_INT → expr = BCD_TO_INT(expr)
        if (instr.functionName) {
          expr = `${markOrigin(instr.functionName, instr.sourceLine)}(${expr})`;
        }
        break;

      default: {
        // Binary operators: AND, OR, XOR, ADD, SUB, etc.
        const stOp = BINARY_OP_MAP[op];
        if (stOp && operand) {
          if (instr.openParen) {
            // Push current expression and operator to stack
            exprStack.push({ expr, op: stOp });
            expr = marked ?? "";
          } else {
            expr = `(${expr} ${stOp} ${marked ?? ""})`;
          }
        } else if (!stOp) {
          errors.push({
            message: `Unsupported IL operator in straight-line mode: ${op}`,
            line: instr.sourceLine,
            column: 1,
          });
        }
        break;
      }
    }
  }

  return {
    stBody: stripOrigins(lines.text.join("\n")),
    markedBody: lines.text.join("\n"),
    errors,
    lineSources: lines.from,
  };
}

// =============================================================================
// Control flow conversion (CASE state machine)
// =============================================================================

interface BasicBlock {
  id: number;
  label?: string;
  instructions: ILInstruction[];
  /** How this block exits */
  exit:
    | { kind: "fallthrough"; nextId: number }
    | { kind: "jump"; target: string }
    | {
        kind: "conditional";
        target: string;
        negated: boolean;
        fallthroughId: number;
      }
    | { kind: "return" }
    | { kind: "conditionalReturn"; negated: boolean; fallthroughId: number }
    | { kind: "end" };
}

function convertWithStateMachine(elements: ILElement[]): ILConvertResult {
  const errors: ILConvertError[] = [];

  // Reject parenthesized expressions when control flow is also present.
  // The straight-line converter handles parens via an expression stack, but
  // that stack does not survive a basic-block boundary — propagating it
  // through the state machine is non-trivial and a separate enhancement.
  // Detect the combination here and surface a clear error rather than
  // silently producing wrong ST.
  for (const elem of elements) {
    if ("kind" in elem && elem.kind === "closeParen") {
      errors.push({
        message:
          "Parenthesized expressions are not supported in IL bodies that " +
          "also use control flow (JMP/JMPC/RET/CAL/...). Rewrite the " +
          "expression without parentheses or split the POU.",
        line: elem.sourceLine,
        column: 1,
      });
      return { stBody: "", errors };
    }
    if (!("kind" in elem) && elem.openParen) {
      errors.push({
        message:
          "Parenthesized expressions are not supported in IL bodies that " +
          "also use control flow (JMP/JMPC/RET/CAL/...). Rewrite the " +
          "expression without parentheses or split the POU.",
        line: elem.sourceLine,
        column: 1,
      });
      return { stBody: "", errors };
    }
  }

  // Filter to instructions only (handle close parens inline during block building)
  const instructions = elements.filter(
    (e): e is ILInstruction => !("kind" in e),
  );

  // Build basic blocks: split at labels and jump/ret instructions
  const blocks: BasicBlock[] = [];
  let currentBlock: BasicBlock = {
    id: 0,
    instructions: [],
    exit: { kind: "end" },
  };
  let nextId = 1;

  for (const instr of instructions) {
    // Start new block at labels
    if (instr.label && currentBlock.instructions.length > 0) {
      currentBlock.exit = { kind: "fallthrough", nextId };
      blocks.push(currentBlock);
      currentBlock = {
        id: nextId++,
        label: instr.label,
        instructions: [],
        exit: { kind: "end" },
      };
    } else if (instr.label) {
      currentBlock.label = instr.label;
    }

    // Check for control flow instructions
    if (instr.operator === "JMP" && instr.operand) {
      currentBlock.instructions.push(instr);
      currentBlock.exit = { kind: "jump", target: instr.operand };
      blocks.push(currentBlock);
      currentBlock = { id: nextId++, instructions: [], exit: { kind: "end" } };
      continue;
    }

    if (
      (instr.operator === "JMPC" || instr.operator === "JMPCN") &&
      instr.operand
    ) {
      currentBlock.instructions.push(instr);
      const fallthroughId = nextId;
      currentBlock.exit = {
        kind: "conditional",
        target: instr.operand,
        negated: instr.operator === "JMPCN",
        fallthroughId,
      };
      blocks.push(currentBlock);
      currentBlock = { id: nextId++, instructions: [], exit: { kind: "end" } };
      continue;
    }

    if (instr.operator === "RET") {
      currentBlock.instructions.push(instr);
      currentBlock.exit = { kind: "return" };
      blocks.push(currentBlock);
      currentBlock = { id: nextId++, instructions: [], exit: { kind: "end" } };
      continue;
    }

    if (instr.operator === "RETC" || instr.operator === "RETCN") {
      currentBlock.instructions.push(instr);
      const fallthroughId = nextId;
      currentBlock.exit = {
        kind: "conditionalReturn",
        negated: instr.operator === "RETCN",
        fallthroughId,
      };
      blocks.push(currentBlock);
      currentBlock = { id: nextId++, instructions: [], exit: { kind: "end" } };
      continue;
    }

    currentBlock.instructions.push(instr);
  }

  // Push the last block
  if (currentBlock.instructions.length > 0 || currentBlock.label) {
    blocks.push(currentBlock);
  }

  // Build label → block ID map
  const labelMap = new Map<string, number>();
  for (const block of blocks) {
    if (block.label) {
      labelMap.set(block.label.toUpperCase(), block.id);
    }
  }

  // Add an exit block
  const exitId = nextId;

  // Generate CASE statement.
  //
  // __IL_STATE is declared as a VAR (persistent class member) because IEC ST
  // doesn't support stack-local declarations inside a body. We must reset it
  // to 0 at the top of each invocation; otherwise the second call sees the
  // exit state from the first call and skips the entire state machine.
  const lines = new SourcedLines();
  lines.push("  __IL_STATE := 0;");
  lines.push("  REPEAT");
  lines.push("    CASE __IL_STATE OF");

  for (const block of blocks) {
    lines.at = 0;
    lines.push(`      ${block.id}:`);

    // Generate ST for non-control-flow instructions in this block
    const blockResult = convertBlockInstructions(block.instructions);
    for (const err of blockResult.errors) errors.push(err);
    blockResult.lines.text.forEach((line, i) => {
      lines.at = blockResult.lines.from[i] ?? 0;
      lines.push(`        ${line}`);
    });
    // The transition at the block's last instruction (its jump or return)
    lines.at =
      block.instructions[block.instructions.length - 1]?.sourceLine ?? 0;

    // Generate exit transition
    switch (block.exit.kind) {
      case "fallthrough":
        lines.push(`        __IL_STATE := ${block.exit.nextId};`);
        break;
      case "jump": {
        const targetId =
          labelMap.get(block.exit.target.toUpperCase()) ?? exitId;
        lines.push(`        __IL_STATE := ${targetId};`);
        break;
      }
      case "conditional": {
        const targetId =
          labelMap.get(block.exit.target.toUpperCase()) ?? exitId;
        const cond = block.exit.negated ? `NOT __IL_ACC_BOOL` : `__IL_ACC_BOOL`;
        lines.push(`        IF ${cond} THEN __IL_STATE := ${targetId};`);
        lines.push(
          `        ELSE __IL_STATE := ${block.exit.fallthroughId}; END_IF;`,
        );
        break;
      }
      case "return":
        lines.push("        RETURN;");
        break;
      case "conditionalReturn": {
        const cond = block.exit.negated ? `NOT __IL_ACC_BOOL` : `__IL_ACC_BOOL`;
        lines.push(`        IF ${cond} THEN RETURN; END_IF;`);
        lines.push(`        __IL_STATE := ${block.exit.fallthroughId};`);
        break;
      }
      case "end":
        lines.push(`        __IL_STATE := ${exitId};`);
        break;
    }
  }

  // Exit state
  lines.at = 0;
  lines.push(`      ${exitId}: EXIT;`);
  lines.push("    END_CASE;");
  lines.push("  UNTIL FALSE END_REPEAT;");

  const extraVars = "    __IL_STATE : INT := 0;\n    __IL_ACC_BOOL : BOOL;";

  return {
    stBody: stripOrigins(lines.text.join("\n")),
    markedBody: lines.text.join("\n"),
    errors,
    extraVars,
    lineSources: lines.from,
  };
}

/**
 * Convert the non-control-flow instructions within a basic block to ST lines.
 * Uses expression threading (same as straight-line), but stores to
 * __IL_ACC_BOOL when a comparison occurs (needed for JMPC transitions).
 */
function convertBlockInstructions(instructions: ILInstruction[]): {
  lines: SourcedLines;
  errors: ILConvertError[];
} {
  const lines = new SourcedLines();
  const errors: ILConvertError[] = [];
  let expr = "__IL_ACC_BOOL"; // default expression is the accumulator

  for (const instr of instructions) {
    const op = instr.operator;
    const operand = instr.operand;
    const marked =
      operand !== undefined ? markOrigin(operand, instr.sourceLine) : undefined;
    lines.at = instr.sourceLine;

    // Skip control flow instructions (handled by block exit logic)
    if (
      op === "JMP" ||
      op === "JMPC" ||
      op === "JMPCN" ||
      op === "RET" ||
      op === "RETC" ||
      op === "RETCN"
    ) {
      // Before a conditional jump, store the expression to __IL_ACC_BOOL
      if (op === "JMPC" || op === "JMPCN" || op === "RETC" || op === "RETCN") {
        lines.push(`__IL_ACC_BOOL := ${expr};`);
      }
      continue;
    }

    switch (op) {
      case "LD":
        expr = marked ?? "";
        break;
      case "LDN":
        expr = `NOT ${marked ?? ""}`;
        break;
      case "ST":
        if (operand) lines.push(`${marked} := ${expr};`);
        break;
      case "STN":
        if (operand) lines.push(`${marked} := NOT (${expr});`);
        break;
      case "NOT":
        expr = `NOT (${expr})`;
        break;
      case "S":
        if (operand) lines.push(`IF ${expr} THEN ${marked} := TRUE; END_IF;`);
        break;
      case "R":
        if (operand) lines.push(`IF ${expr} THEN ${marked} := FALSE; END_IF;`);
        break;
      case "S1":
      case "R1":
      case "CLK":
      case "CU":
      case "CD":
      case "PV":
      case "IN":
      case "PT":
        if (operand) {
          lines.push(`${marked}.${op} := ${expr};`);
          lines.push(`${marked}();`);
        }
        break;
      case "CAL":
      case "CALC":
      case "CALCN": {
        const callST = generateCAL(instr);
        if (op === "CALC") {
          lines.push(`IF ${expr} THEN ${callST} END_IF;`);
        } else if (op === "CALCN") {
          lines.push(`IF NOT (${expr}) THEN ${callST} END_IF;`);
        } else {
          lines.push(callST);
        }
        break;
      }
      case "FUNC_CALL":
        if (instr.functionName) {
          expr = `${markOrigin(instr.functionName, instr.sourceLine)}(${expr})`;
        }
        break;
      default: {
        const stOp = BINARY_OP_MAP[op];
        if (stOp && operand) {
          expr = `(${expr} ${stOp} ${marked ?? ""})`;
        } else if (!stOp) {
          errors.push({
            message: `Unsupported IL operator: ${op}`,
            line: instr.sourceLine,
            column: 1,
          });
        }
        break;
      }
    }
  }

  return { lines, errors };
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Generate ST for a CAL instruction.
 */
function generateCAL(instr: ILInstruction): string {
  const fbName = instr.operand ?? "";
  if (!instr.callParams || instr.callParams.length === 0) {
    return `${markOrigin(fbName, instr.sourceLine)}();`;
  }

  const params = instr.callParams.map((p) => {
    const assign = p.isOutput ? "=>" : ":=";
    return `${p.name} ${assign} ${markOrigin(p.value, instr.sourceLine)}`;
  });

  return `${markOrigin(fbName, instr.sourceLine)}(${params.join(", ")});`;
}
