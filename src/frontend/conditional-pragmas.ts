// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * Conditional-compilation pragmas (`{IF}`, `{ELSIF}`, `{ELSE}`, `{END_IF}`,
 * `{define}`, `{undefine}`), a vendor-toolchain extension enabled by the dialect feature
 * `conditional_pragmas`. Not IEC 61131-3.
 *
 * {@link applyConditionalPragmas} blanks every directive and every inactive
 * branch with spaces, keeping line breaks, so the result has the same length
 * and every active character keeps its offset, line and column. The rest of
 * the pipeline then compiles the active text as usual.
 *
 * Pure: no Node APIs.
 */

import type { ILexingResult } from "chevrotain";
import {
  PRAGMA_GROUP,
  hasConditionalPragma,
  isConditionalPragma,
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
  /** 1-based lines that held text and are blank after the pass. */
  blankedLines: number[];
}

/** A define name: an IEC identifier. The one rule every entry point applies. */
const PRAGMA_DEFINE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * True if `name` is a valid conditional-pragma define name (an identifier).
 *
 * @param name - The candidate define name
 */
export function isPragmaDefineName(name: string): boolean {
  return PRAGMA_DEFINE_NAME_RE.test(name);
}

/**
 * Throw a TypeError unless `defines` is undefined or maps identifiers to strings.
 *
 * @param defines - A `pragmaDefines` value from a caller
 */
export function validatePragmaDefines(defines: unknown): void {
  if (defines === undefined) return;
  if (
    typeof defines !== "object" ||
    defines === null ||
    Array.isArray(defines)
  ) {
    throw new TypeError("pragmaDefines must be an object of name → string");
  }
  for (const [name, value] of Object.entries(defines)) {
    if (!isPragmaDefineName(name)) {
      throw new TypeError(
        `pragmaDefines key ${JSON.stringify(name)} is not an identifier`,
      );
    }
    if (typeof value !== "string") {
      throw new TypeError(
        `pragmaDefines[${JSON.stringify(name)}] must be a string`,
      );
    }
  }
}

/** Whether the pass runs, and the defines it evaluates against. */
export interface SourcePrep {
  enabled: boolean;
  /** Project define names (case-sensitive) → value (`''` for a bare name). */
  defines: Map<string, string>;
}

/**
 * The conditional-pragma settings of one compile.
 *
 * @param dialect - The resolved dialect; the pass runs when it has `conditional_pragmas`
 * @param pragmaDefines - Project define names and values; names are case-sensitive
 */
export function sourcePrepFor(
  dialect: ResolvedDialect,
  pragmaDefines?: Record<string, string>,
): SourcePrep {
  return {
    enabled: dialect.features.has("conditional_pragmas"),
    defines: new Map(Object.entries(pragmaDefines ?? {})),
  };
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
  | { kind: "defined"; name: string; projectOnly: boolean }
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
      return { kind: "defined", name, projectOnly: false };
    }
    if (upper === "PROJECT_DEFINED") {
      const name = this.expectName();
      this.expectPunct(")");
      return { kind: "defined", name, projectOnly: true };
    }
    if (upper === "HASVALUE") {
      const name = this.expectName();
      this.expectPunct(",");
      const v = this.peek();
      if (v.kind !== "string") throw this.unexpected(v, "a quoted value");
      this.next();
      this.expectPunct(")");
      return { kind: "hasvalue", name, value: v.text };
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

/** Defines in effect at one point of a file. */
interface DefineScope {
  /** Project defines (`-D`, `pragmaDefines`); never changed by the source. */
  project: ReadonlyMap<string, string>;
  /** Defines given for this file only (`--file-define`, a source's `pragmaDefines`). */
  file: ReadonlyMap<string, string>;
  /** `{define}`s of this file seen so far and not undefined. */
  source: ReadonlyMap<string, string>;
}

/**
 * Value of `name`: a source define shadows a file define, which shadows a
 * project define of the same name.
 */
function defineValue(scope: DefineScope, name: string): string | undefined {
  return (
    scope.source.get(name) ?? scope.file.get(name) ?? scope.project.get(name)
  );
}

function evaluate(node: CondNode, scope: DefineScope): boolean {
  switch (node.kind) {
    case "and":
      return evaluate(node.left, scope) && evaluate(node.right, scope);
    case "or":
      return evaluate(node.left, scope) || evaluate(node.right, scope);
    case "not":
      return !evaluate(node.operand, scope);
    case "defined":
      return (
        scope.project.has(node.name) ||
        (!node.projectOnly &&
          (scope.file.has(node.name) || scope.source.has(node.name)))
      );
    case "hasvalue":
      return defineValue(scope, node.name) === node.value;
    case "false":
      return false;
  }
}

/** A parsed `{define NAME ['value']}` or `{undefine NAME}`. */
interface DefineAction {
  name: string;
  /** The value of a `{define}`; undefined for `{undefine}`. */
  value?: string;
}

/**
 * Parse the text after `define` / `undefine`: a name, then for `{define}` an
 * optional single-quoted value. Throws {@link ConditionSyntaxError}.
 */
function parseDefineAction(
  keyword: "DEFINE" | "UNDEFINE",
  rest: string,
  restOffset: number,
  closeOffset: number,
): DefineAction {
  const what = `Malformed {${keyword.toLowerCase()}}`;
  const toks = lexCondition(rest, restOffset);
  const at = (t: CondToken): number =>
    t.kind === "end" ? closeOffset : t.offset;
  const first = toks[0]!;
  if (first.kind !== "name") {
    throw new ConditionSyntaxError(`${what}: expected a name`, at(first));
  }
  let i = 1;
  let value: string | undefined;
  if (keyword === "DEFINE") {
    value = "";
    const v = toks[i]!;
    if (v.kind === "string") {
      value = v.text;
      i++;
    } else if (v.kind === "bad" && v.text === "unterminated string") {
      throw new ConditionSyntaxError(`${what}: unterminated string`, v.offset);
    } else if (v.kind !== "end") {
      throw new ConditionSyntaxError(
        `${what}: expected a quoted value or '}'`,
        v.offset,
      );
    }
  }
  const extra = toks[i]!;
  if (extra.kind !== "end") {
    throw new ConditionSyntaxError(`${what}: expected '}'`, extra.offset);
  }
  return value === undefined
    ? { name: first.text }
    : { name: first.text, value };
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
  /** Parsed `{define}` / `{undefine}`; undefined when it failed to parse. */
  action?: DefineAction;
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
 * A copy of `source` with the same length in UTF-16 units whose upper-case
 * form also keeps that length, so the lexer's offsets line up with `source`.
 * Characters that change length when upper-cased (`ß`, `ﬁ`) become `_`.
 */
function lengthStableCopy(source: string): string {
  return source.replace(/[^\p{ASCII}]/gu, (c) =>
    c.toUpperCase().length === c.length ? c : "_".repeat(c.length),
  );
}

/** A line that starts with a conditional directive (inside a string it is an error). */
const DIRECTIVE_LINE =
  /^[ \t]*\{\s*(?:IF|ELSIF|ELSE|END_IF|DEFINE|UNDEFINE)\b/i;

/**
 * Resolve the conditional-compilation directives of `source` against the
 * project `defines` and the file's own `{define}`s, in textual order. Problems
 * in the text come back as positioned errors; only an internal bug propagates
 * as an exception.
 *
 * @param source - The source text
 * @param defines - Project define names (case-sensitive) → value
 * @param lex - The lexer for this kind of file; its pragma group and string tokens are read
 * @param fileDefines - Defines given for this file only: seen by `defined()` and
 *   `hasvalue()` (over a project define of the same name), not by `project_defined()`
 * @returns The text with directives and inactive branches blanked, and the errors
 */
export function applyConditionalPragmas(
  source: string,
  defines: ReadonlyMap<string, string>,
  lex: (s: string) => ILexingResult,
  fileDefines: ReadonlyMap<string, string> = new Map(),
): ConditionalPragmaResult {
  if (!hasConditionalPragma(source)) {
    return { text: source, errors: [], blankedLines: [] };
  }
  let lexed: ILexingResult;
  try {
    lexed = lex(lengthStableCopy(source));
  } catch {
    return { text: source, errors: [], blankedLines: [] };
  }
  const pragmas = lexed.groups[PRAGMA_GROUP] ?? [];
  const starts = lineStarts(source);
  const errors: PragmaDirectiveError[] = [];
  const report = (message: string, offset: number, length: number): void => {
    errors.push({ message, ...lineColAt(starts, offset), length, offset });
  };

  // A string literal with a raw line break can swallow directives of a dead
  // branch (an unbalanced quote); refuse instead of silently dropping them.
  for (const tok of lexed.tokens) {
    if (!/[\r\n]/.test(tok.image)) continue;
    const text = source.substring(
      tok.startOffset,
      tok.startOffset + tok.image.length,
    );
    const lineBreak = /\r\n?|\n/g;
    let m: RegExpExecArray | null;
    while ((m = lineBreak.exec(text)) !== null) {
      const lineStart = m.index + m[0].length;
      const rest = text.substring(lineStart);
      const hit = DIRECTIVE_LINE.exec(rest);
      if (hit) {
        const brace = tok.startOffset + lineStart + hit[0].indexOf("{");
        report(
          "Conditional pragma directive inside a string literal that spans lines",
          brace,
          1,
        );
      }
    }
  }

  const directives: Directive[] = [];
  for (const tok of [...pragmas].sort(
    (a, b) => a.startOffset - b.startOffset,
  )) {
    const image = source.substring(
      tok.startOffset,
      tok.startOffset + tok.image.length,
    );
    if (!isConditionalPragma(image)) {
      if (isConditionalPragma(tok.image)) {
        report(
          "Internal error: conditional pragma offsets do not match the source",
          tok.startOffset,
          1,
        );
      }
      continue;
    }
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
      try {
        d.action = parseDefineAction(keyword, d.rest, d.restOffset, d.end - 1);
      } catch (e) {
        if (!(e instanceof ConditionSyntaxError)) throw e;
        report(e.message, e.offset, 1);
      }
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
  if (directives.length === 0) {
    errors.sort((a, b) => a.offset - b.offset);
    return { text: source, errors, blankedLines: [] };
  }

  const stack: Frame[] = [];
  const isActive = (): boolean =>
    stack.length === 0 || stack[stack.length - 1]!.active;
  const sourceDefines = new Map<string, string>();
  const scope: DefineScope = {
    project: defines,
    file: fileDefines,
    source: sourceDefines,
  };
  const choose = (d: Directive): boolean =>
    d.condition !== undefined && evaluate(d.condition, scope);

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
      case "DEFINE":
        if (d.action && isActive()) {
          sourceDefines.set(d.action.name, d.action.value ?? "");
        }
        break;
      case "UNDEFINE":
        if (d.action && isActive()) sourceDefines.delete(d.action.name);
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
  const text = parts.join("");
  return { text, errors, blankedLines: newlyBlankLines(source, text, starts) };
}

/** Lines (1-based) with non-blank text in `before` and only blanks in `after`. */
function newlyBlankLines(
  before: string,
  after: string,
  starts: readonly number[],
): number[] {
  const out: number[] = [];
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i]!;
    const to = i + 1 < starts.length ? starts[i + 1]! : before.length;
    if (
      /\S/.test(before.substring(from, to)) &&
      !/\S/.test(after.substring(from, to))
    ) {
      out.push(i + 1);
    }
  }
  return out;
}
