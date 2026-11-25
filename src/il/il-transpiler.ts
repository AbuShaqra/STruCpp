// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * STruC++ IL Transpiler — Public API
 *
 * Detects IL bodies in a source file, parses them, converts to ST,
 * and reassembles the source with IL bodies replaced by ST equivalents.
 */

import type { ILTranspileResult, POURegion } from "./il-types.js";
import { extractPOURegions } from "./il-detector.js";
import { parseILBody } from "./il-parser.js";
import {
  convertILToST,
  ORIGIN_END,
  ORIGIN_LINE_END,
  ORIGIN_START,
  stripOrigins,
} from "./il-to-st.js";

/**
 * Transpile any IL bodies in the source to ST.
 *
 * Scans the source for POU regions, detects which have IL bodies,
 * and replaces those bodies with equivalent ST code. Non-IL POUs
 * and text outside POUs are left untouched.
 *
 * @param source - The full source text (may contain mixed IL and ST POUs)
 * @param fileName - Optional file name for error reporting
 * @returns Transpilation result with the ST source and any errors
 */
export function transpileILSource(
  source: string,
  fileName?: string,
): ILTranspileResult {
  const { regions, errors: detectionErrors } = extractPOURegions(source);

  // Detection errors (e.g. malformed POUs without VAR blocks) are reported
  // even if no IL bodies are present, so structural problems surface in
  // straight-ST programs too.
  const errors: ILTranspileResult["errors"] = detectionErrors.map((e) => {
    const entry: ILTranspileResult["errors"][number] = {
      message: e.message,
      line: e.line,
      column: e.column,
      severity: "error",
    };
    if (fileName) entry.file = fileName;
    return entry;
  });

  const ilRegions = regions.filter((r) => r.isIL);

  if (ilRegions.length === 0) {
    // Even when there's no IL, propagate any detection errors so callers
    // see them. hasIL stays false because no rewrite happened.
    return { hasIL: false, stSource: source, errors };
  }

  // Rebuild the source, replacing IL bodies with ST equivalents.
  // Process regions in reverse order so offsets remain valid.
  let result = source;
  const operandOrigins: NonNullable<ILTranspileResult["operandOrigins"]> = [];
  const ilLabels: NonNullable<ILTranspileResult["ilLabels"]> = [];

  for (let i = ilRegions.length - 1; i >= 0; i--) {
    const region = ilRegions[i]!;

    // Parse IL body
    const parseResult = parseILBody(region.bodyText, region.bodyStartLine);
    ilLabels.unshift(...parseResult.labels);
    for (const err of parseResult.errors) {
      const entry: ILTranspileResult["errors"][number] = {
        message: err.message,
        line: err.line,
        column: err.column,
        severity: "error",
      };
      if (fileName) entry.file = fileName;
      errors.push(entry);
    }

    if (parseResult.instructions.length === 0) continue;

    // Convert to ST
    const convertResult = convertILToST(
      parseResult.instructions,
      parseResult.hasControlFlow,
    );
    for (const err of convertResult.errors) {
      const entry: ILTranspileResult["errors"][number] = {
        message: err.message,
        line: err.line,
        column: err.column,
        severity: "error",
      };
      if (fileName) entry.file = fileName;
      errors.push(entry);
    }

    // Reconstruct the POU: header + extra vars (if needed) + ST body + closing.
    // Each ST line goes on the line of the IL instruction it comes from, so a
    // diagnostic in the body names the IL line; the POU keeps its line count.
    const pieces: Array<{ text: string; at: number }> = [];
    if (convertResult.extraVars) {
      // The state machine's variables, in a VAR block before the body
      pieces.push({ text: "  VAR", at: 0 });
      for (const line of convertResult.extraVars.split("\n")) {
        pieces.push({ text: line, at: 0 });
      }
      pieces.push({ text: "  END_VAR", at: 0 });
    }
    (convertResult.markedBody ?? convertResult.stBody)
      .split("\n")
      .forEach((text, i) => {
        pieces.push({ text, at: convertResult.lineSources?.[i] ?? 0 });
      });
    const bodyOffset = region.startOffset + region.headerText.length;
    const body = takeOrigins(
      layOutOnSourceLines(
        pieces,
        region.bodyStartLine,
        lineBreaks(region.bodyText),
      ),
      region.bodyStartLine,
      bodyOffset - (source.lastIndexOf("\n", bodyOffset - 1) + 1),
      source,
      operandOrigins,
    );
    const newPOU = region.headerText + body + region.closingText;

    // Replace the original POU text in the source
    result =
      result.substring(0, region.startOffset) +
      newPOU +
      result.substring(region.endOffset);
  }

  return {
    hasIL: true,
    stSource: result,
    errors,
    ilBodies: ilRegions.map((r) => ilBodyStart(source, r)),
    ilLabels,
    operandOrigins,
  };
}

/** The number of line breaks in `text`. */
function lineBreaks(text: string): number {
  let n = 0;
  for (const ch of text) if (ch === "\n") n++;
  return n;
}

/**
 * ST `pieces` laid out over `breaks + 1` lines, the first being source line
 * `firstLine`: each piece on the line of its IL instruction (`at`), or after
 * the piece before it when that line is not later (`at` 0, or out of order),
 * joined by spaces (generated ST holds no line comment).
 */
function layOutOnSourceLines(
  pieces: ReadonlyArray<{ text: string; at: number }>,
  firstLine: number,
  breaks: number,
): string {
  const lines: string[][] = Array.from({ length: breaks + 1 }, () => []);
  let cursor = 0;
  for (const piece of pieces) {
    const target = piece.at - firstLine;
    if (piece.at > 0 && target > cursor) cursor = Math.min(target, breaks);
    if (piece.text.trim() !== "") lines[cursor]!.push(piece.text.trim());
  }
  return lines.map((parts) => parts.join(" ")).join("\n");
}

/**
 * `body` without the operand marks of the generated ST (il-to-st.ts
 * markOrigin), each marked operand recorded in `out` with its position in the
 * output (line from `firstLine`; the first line starts at column
 * `firstColumnOffset` + 1) and the IL line and column naming it in `source`.
 */
function takeOrigins(
  body: string,
  firstLine: number,
  firstColumnOffset: number,
  source: string,
  out: NonNullable<ILTranspileResult["operandOrigins"]>,
): string {
  const sourceLines = source.split("\n");
  return body
    .split("\n")
    .map((line, i) => {
      let text = "";
      for (let k = 0; k < line.length; k++) {
        if (line[k] !== ORIGIN_START) {
          if (line[k] !== ORIGIN_END) text += line[k];
          continue;
        }
        const close = line.indexOf(ORIGIN_LINE_END, k);
        const end = line.indexOf(ORIGIN_END, close);
        const ilLine = Number(line.slice(k + 1, close));
        const operand = stripOrigins(line.slice(close + 1, end));
        const at =
          sourceLines[ilLine - 1]
            ?.toUpperCase()
            .indexOf(operand.toUpperCase()) ?? -1;
        out.push({
          line: firstLine + i,
          column: text.length + 1 + (i === 0 ? firstColumnOffset : 0),
          length: operand.length,
          ilLine,
          ilColumn: at >= 0 ? at + 1 : 1,
        });
        text += operand;
        k = end;
      }
      return text;
    })
    .join("\n");
}

/** The first non-blank character of an IL body, and the POU's name from its header. */
function ilBodyStart(
  source: string,
  region: POURegion,
): { pou: string; line: number; column: number } {
  // Modifiers such as FINAL or ABSTRACT come before the name.
  const pou =
    /^\s*(?:PROGRAM|FUNCTION_BLOCK|FUNCTION)\s+(?:(?:ABSTRACT|FINAL|PUBLIC|PRIVATE|PROTECTED|INTERNAL)\s+)*([A-Za-z_][A-Za-z0-9_]*)/i.exec(
      region.headerText,
    )?.[1] ?? "";
  const bodyOffset = region.startOffset + region.headerText.length;
  const lead = /^\s*/.exec(region.bodyText)?.[0].length ?? 0;
  const before = source.substring(0, bodyOffset + lead);
  const line = before.split("\n").length;
  return { pou, line, column: before.length - before.lastIndexOf("\n") };
}
