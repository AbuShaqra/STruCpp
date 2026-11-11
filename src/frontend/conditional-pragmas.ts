// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * Conditional-compilation pragmas (`{IF}`, `{ELSIF}`, `{ELSE}`, `{END_IF}`),
 * a vendor-toolchain extension enabled by the dialect feature
 * `conditional_pragmas`. Not IEC 61131-3.
 *
 * {@link applyConditionalPragmas} blanks every directive and every inactive
 * branch with spaces, keeping line breaks, so the result has the same length
 * and every active character keeps its offset, line and column. The rest of
 * the pipeline then compiles the active text as usual.
 *
 * Pure: no Node APIs.
 */

import type { ILexingResult, IToken } from "chevrotain";
import {
  PRAGMA_GROUP,
  hasConditionalPragma,
  isConditionalPragma,
  pragmaSourceText,
} from "./lexer.js";
import { profilesWithFeature, type ResolvedDialect } from "../dialect.js";
import type { CompileError } from "../types.js";

/** One problem with a directive; the shape of a Chevrotain lexing error. */
export interface PragmaDirectiveError {
  message: string;
  /** 1-based line. */
  line: number;
  /** 1-based column (a tab counts as one). */
  column: number;
  length: number;
  offset: number;
}

/** Result of {@link applyConditionalPragmas}. */
export interface ConditionalPragmaResult {
  /** The source with directives and inactive branches blanked. */
  text: string;
  errors: PragmaDirectiveError[];
}

/** Whether the pass runs, and the defines it evaluates against. */
export interface SourcePrep {
  enabled: boolean;
  /** Define names in upper case → value (`''` for a bare name). */
  defines: Map<string, string>;
}

/**
 * The conditional-pragma settings of one compile.
 *
 * @param dialect - The resolved dialect; the pass runs when it has `conditional_pragmas`
 * @param pragmaDefines - Define names and values; names compare case-insensitively
 */
export function sourcePrepFor(
  dialect: ResolvedDialect,
  pragmaDefines?: Record<string, string>,
): SourcePrep {
  const defines = new Map<string, string>();
  for (const [name, value] of Object.entries(pragmaDefines ?? {})) {
    defines.set(name.toUpperCase(), value);
  }
  return { enabled: dialect.features.has("conditional_pragmas"), defines };
}

/** Prefix of the lexer error for a conditional pragma when the feature is off. */
const CONDITIONAL_PRAGMA_REFUSAL =
  "Conditional compilation pragmas are not supported";

/** Suffix naming the feature (and the loaded profiles that have it). */
export function conditionalPragmaHint(dialect: ResolvedDialect): string {
  const profiles = profilesWithFeature(dialect, "conditional_pragmas");
  return (
    "; they need the feature conditional_pragmas" +
    (profiles.length > 0 ? ` (profiles: ${profiles.join(", ")})` : "")
  );
}

/** Append `hint` to every conditional-pragma refusal in `errors`. */
export function withPragmaHint(
  errors: CompileError[],
  hint: string,
): CompileError[] {
  if (hint === "") return errors;
  for (const e of errors) {
    if (e.message.startsWith(CONDITIONAL_PRAGMA_REFUSAL)) e.message += hint;
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

/** Offsets where each line starts; terminators are `\r\n`, `\n` and `\r`. */
function lineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    const c = source.charCodeAt(i);
    if (c === 10) starts.push(i + 1);
    else if (c === 13) {
      if (source.charCodeAt(i + 1) === 10) i++;
      starts.push(i + 1);
    }
  }
  return starts;
}

/** 1-based line and column of `offset`, given {@link lineStarts}. */
function lineColAt(
  starts: readonly number[],
  offset: number,
): { line: number; column: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - starts[lo]! + 1 };
}

// ---------------------------------------------------------------------------
// Condition expressions
// ---------------------------------------------------------------------------

type CondToken =
  | { kind: "name"; text: string; offset: number }
  | { kind: "string"; text: string; offset: number; length: number }
  | { kind: "punct"; text: "(" | ")" | "," | ":"; offset: number }
  | { kind: "bad"; text: string; offset: number }
  | { kind: "end"; offset: number };

type CondNode =
  | { kind: "and" | "or"; left: CondNode; right: CondNode }
  | { kind: "not"; operand: CondNode }
  | { kind: "defined"; name: string }
  | { kind: "hasvalue"; name: string; value: string }
  | { kind: "false" };

/** Operators the vendor languages define whose answer needs symbol information. */
const REFUSED_OPERATORS = new Set([
  "HASATTRIBUTE",
  "HASTYPE",
  "HASCONSTANTVALUE",
  "HASCONSTANTTYPE",
]);

/** `defined(<kind>:x)` kinds the vendor languages define; all are refused here. */
const REFUSED_DEFINED_KINDS = new Set(["VARIABLE", "TYPE", "POU"]);

class ConditionSyntaxError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(message);
  }
}

/** Split condition text into tokens; offsets are absolute in the source. */
function lexCondition(text: string, base: number): CondToken[] {
  const out: CondToken[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text.charAt(i);
    if (/\s/.test(c)) {
      i++;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.substring(i))!;
      out.push({ kind: "name", text: m[0], offset: base + i });
      i += m[0].length;
    } else if (c === "(" || c === ")" || c === "," || c === ":") {
      out.push({ kind: "punct", text: c, offset: base + i });
      i++;
    } else if (c === "'") {
      const close = text.indexOf("'", i + 1);
      if (close < 0) {
        out.push({
          kind: "bad",
          text: "unterminated string",
          offset: base + i,
        });
        break;
      }
      out.push({
        kind: "string",
        text: text.substring(i + 1, close),
        offset: base + i,
        length: close + 1 - i,
      });
      i = close + 1;
    } else {
      out.push({ kind: "bad", text: c, offset: base + i });
      i++;
    }
  }
  out.push({ kind: "end", offset: base + text.length });
  return out;
}

/**
 * Recursive-descent parser for one condition. Refused and unknown operators
 * are recorded and parsing goes on; a syntax error stops it.
 */
class ConditionParser {
  private pos = 0;
  readonly problems: Array<{ message: string; offset: number }> = [];

  constructor(private readonly toks: CondToken[]) {}

  parse(): CondNode {
    const node = this.or();
    const t = this.peek();
    if (t.kind !== "end") throw this.unexpected(t, "end of condition");
    return node;
  }

  private peek(): CondToken {
    return this.toks[this.pos]!;
  }

  private next(): CondToken {
    const t = this.toks[this.pos]!;
    if (t.kind !== "end") this.pos++;
    return t;
  }

  private isWord(t: CondToken, word: string): boolean {
    return t.kind === "name" && t.text.toUpperCase() === word;
  }

  private isPunct(t: CondToken, p: string): boolean {
    return t.kind === "punct" && t.text === p;
  }

  private unexpected(t: CondToken, expected: string): ConditionSyntaxError {
    if (t.kind === "bad" && t.text === "unterminated string") {
      return new ConditionSyntaxError(
        "Malformed conditional pragma expression: unterminated string",
        t.offset,
      );
    }
    return new ConditionSyntaxError(
      `Malformed conditional pragma expression: expected ${expected}`,
      t.offset,
    );
  }

  private expectPunct(p: string): void {
    const t = this.peek();
    if (!this.isPunct(t, p)) throw this.unexpected(t, `'${p}'`);
    this.next();
  }

  private expectName(): string {
    const t = this.peek();
    if (t.kind !== "name") throw this.unexpected(t, "a name");
    this.next();
    return t.text;
  }

  private or(): CondNode {
    let left = this.and();
    while (this.isWord(this.peek(), "OR")) {
      this.next();
      left = { kind: "or", left, right: this.and() };
    }
    return left;
  }

  private and(): CondNode {
    let left = this.not();
    while (this.isWord(this.peek(), "AND")) {
      this.next();
      left = { kind: "and", left, right: this.not() };
    }
    return left;
  }

  private not(): CondNode {
    if (this.isWord(this.peek(), "NOT")) {
      this.next();
      return { kind: "not", operand: this.not() };
    }
    return this.primary();
  }

  private primary(): CondNode {
    const t = this.peek();
    if (this.isPunct(t, "(")) {
      this.next();
      const inner = this.or();
      this.expectPunct(")");
      return inner;
    }
    if (t.kind !== "name") throw this.unexpected(t, "a condition");
    this.next();
    return this.call(t.text, t.offset);
  }

  /** Skip a balanced argument list after `(` has been consumed. */
  private skipArguments(): void {
    let depth = 1;
    for (;;) {
      const t = this.peek();
      if (t.kind === "end") throw this.unexpected(t, "')'");
      if (t.kind === "bad" && t.text === "unterminated string") {
        throw this.unexpected(t, "')'");
      }
      this.next();
      if (this.isPunct(t, "(")) depth++;
      else if (this.isPunct(t, ")") && --depth === 0) return;
    }
  }

  private call(op: string, opOffset: number): CondNode {
    const upper = op.toUpperCase();
    this.expectPunct("(");
    if (upper === "DEFINED") {
      const name = this.expectName();
      if (this.isPunct(this.peek(), ":")) {
        this.next();
        this.expectName();
        this.expectPunct(")");
        const kind = name.toUpperCase();
        this.problems.push({
          message: REFUSED_DEFINED_KINDS.has(kind)
            ? `Conditional pragma operator 'defined(${name.toLowerCase()}:...)' is not supported`
            : `unknown operator 'defined(${name}:...)' in a conditional pragma`,
          offset: opOffset,
        });
        return { kind: "false" };
      }
      this.expectPunct(")");
      return { kind: "defined", name: name.toUpperCase() };
    }
    if (upper === "PROJECT_DEFINED") {
      const name = this.expectName();
      this.expectPunct(")");
      return { kind: "defined", name: name.toUpperCase() };
    }
    if (upper === "HASVALUE") {
      const name = this.expectName();
      this.expectPunct(",");
      const v = this.peek();
      if (v.kind !== "string") throw this.unexpected(v, "a quoted value");
      this.next();
      this.expectPunct(")");
      return { kind: "hasvalue", name: name.toUpperCase(), value: v.text };
    }
    this.problems.push({
      message: REFUSED_OPERATORS.has(upper)
        ? `Conditional pragma operator '${op.toLowerCase()}' is not supported`
        : `unknown operator '${op}' in a conditional pragma`,
      offset: opOffset,
    });
    this.skipArguments();
    return { kind: "false" };
  }
}

function evaluate(
  node: CondNode,
  defines: ReadonlyMap<string, string>,
): boolean {
  switch (node.kind) {
    case "and":
      return evaluate(node.left, defines) && evaluate(node.right, defines);
    case "or":
      return evaluate(node.left, defines) || evaluate(node.right, defines);
    case "not":
      return !evaluate(node.operand, defines);
    case "defined":
      return defines.has(node.name);
    case "hasvalue":
      return defines.get(node.name) === node.value;
    case "false":
      return false;
  }
}

// ---------------------------------------------------------------------------
// Directives
// ---------------------------------------------------------------------------

const DIRECTIVE = /^\{(\s*)(IF|ELSIF|ELSE|END_IF|DEFINE|UNDEFINE)\b/i;

interface Directive {
  keyword: "IF" | "ELSIF" | "ELSE" | "END_IF" | "DEFINE" | "UNDEFINE";
  start: number;
  /** Exclusive end offset of the whole pragma. */
  end: number;
  /** Text between the keyword and the closing `}`. */
  rest: string;
  restOffset: number;
  /** Parsed condition of an IF/ELSIF; undefined when it failed to parse. */
  condition?: CondNode;
}

interface Frame {
  ifTok: Directive;
  parentActive: boolean;
  taken: boolean;
  active: boolean;
  sawElse: boolean;
}

/** Replace every UTF-16 unit of `text[start, end)` except CR and LF with a space. */
function blank(text: string, start: number, end: number): string {
  return text.substring(start, end).replace(/[^\r\n]/g, " ");
}

/**
 * Resolve the conditional-compilation directives of `source` against
 * `defines`. Never throws.
 *
 * @param source - The source text
 * @param defines - Define names in upper case → value
 * @param lex - The lexer for this kind of file; only its pragma group is read
 * @returns The text with directives and inactive branches blanked, and the errors
 */
export function applyConditionalPragmas(
  source: string,
  defines: ReadonlyMap<string, string>,
  lex: (s: string) => ILexingResult,
): ConditionalPragmaResult {
  if (!hasConditionalPragma(source)) return { text: source, errors: [] };
  let pragmas: IToken[];
  try {
    pragmas = lex(source).groups[PRAGMA_GROUP] ?? [];
  } catch {
    return { text: source, errors: [] };
  }
  const starts = lineStarts(source);
  const errors: PragmaDirectiveError[] = [];
  const report = (message: string, offset: number, length: number): void => {
    errors.push({ message, ...lineColAt(starts, offset), length, offset });
  };

  const directives: Directive[] = [];
  for (const tok of [...pragmas].sort(
    (a, b) => a.startOffset - b.startOffset,
  )) {
    const image = pragmaSourceText(tok, source);
    if (!isConditionalPragma(image)) continue;
    const m = DIRECTIVE.exec(image)!;
    const keyword = m[2]!.toUpperCase() as Directive["keyword"];
    const restStart = 1 + m[1]!.length + m[2]!.length;
    const d: Directive = {
      keyword,
      start: tok.startOffset,
      end: tok.startOffset + image.length,
      rest: image.substring(restStart, image.length - 1),
      restOffset: tok.startOffset + restStart,
    };
    directives.push(d);
    if (keyword === "DEFINE" || keyword === "UNDEFINE") {
      report(
        `{${keyword.toLowerCase()}} is not supported; pass defines with -D`,
        d.start,
        image.length,
      );
    } else if (keyword === "IF" || keyword === "ELSIF") {
      if (d.rest.trim() === "") {
        report(
          "Malformed conditional pragma expression: expected a condition",
          d.end - 1,
          1,
        );
        continue;
      }
      const parser = new ConditionParser(lexCondition(d.rest, d.restOffset));
      try {
        d.condition = parser.parse();
      } catch (e) {
        if (!(e instanceof ConditionSyntaxError)) throw e;
        for (const p of parser.problems) report(p.message, p.offset, 1);
        report(e.message, e.offset, 1);
        continue;
      }
      for (const p of parser.problems) report(p.message, p.offset, 1);
    } else if (d.rest.trim() !== "") {
      const lead = d.rest.length - d.rest.trimStart().length;
      report(
        `Malformed conditional pragma: {${keyword}} takes no condition`,
        d.restOffset + lead,
        1,
      );
    }
  }
  if (directives.length === 0) return { text: source, errors: [] };

  const stack: Frame[] = [];
  const isActive = (): boolean =>
    stack.length === 0 || stack[stack.length - 1]!.active;
  const choose = (d: Directive): boolean =>
    d.condition !== undefined && evaluate(d.condition, defines);

  const parts: string[] = [];
  let cursor = 0;
  for (const d of directives) {
    const region = source.substring(cursor, d.start);
    parts.push(isActive() ? region : blank(source, cursor, d.start));
    parts.push(blank(source, d.start, d.end));
    cursor = d.end;
    const top = stack[stack.length - 1];
    const length = d.end - d.start;
    switch (d.keyword) {
      case "IF": {
        const parentActive = isActive();
        const active = parentActive && choose(d);
        stack.push({
          ifTok: d,
          parentActive,
          taken: active,
          active,
          sawElse: false,
        });
        break;
      }
      case "ELSIF":
        if (!top) {
          report("{ELSIF} without a matching {IF}", d.start, length);
        } else if (top.sawElse) {
          report("{ELSIF} after {ELSE}", d.start, length);
          top.active = false;
        } else {
          top.active = top.parentActive && !top.taken && choose(d);
          top.taken ||= top.active;
        }
        break;
      case "ELSE":
        if (!top) {
          report("{ELSE} without a matching {IF}", d.start, length);
        } else if (top.sawElse) {
          report("second {ELSE} in one {IF}", d.start, length);
          top.active = false;
        } else {
          top.sawElse = true;
          top.active = top.parentActive && !top.taken;
          top.taken ||= top.active;
        }
        break;
      case "END_IF":
        if (!top) report("{END_IF} without a matching {IF}", d.start, length);
        else stack.pop();
        break;
      default:
        break;
    }
  }
  parts.push(
    isActive()
      ? source.substring(cursor)
      : blank(source, cursor, source.length),
  );
  for (const frame of stack) {
    report(
      "{IF} has no matching {END_IF}",
      frame.ifTok.start,
      frame.ifTok.end - frame.ifTok.start,
    );
  }
  errors.sort((a, b) => a.offset - b.offset);
  return { text: parts.join(""), errors };
}
