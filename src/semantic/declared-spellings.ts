// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * Names in diagnostics as the user declared them.
 *
 * The lexer upper-cases identifiers, so a message built from the AST names
 * `FB_MOTOR` for a block declared `Fb_Motor`. This pass re-spells a quoted
 * name in a message (`'FB_MOTOR'`, `'FB_MOTOR.NCNT'`, ``identifier `R2` ``)
 * with its declared spelling. Only names the sources declare are re-spelled;
 * elementary type names, keywords, library names and names declared twice
 * in different cases keep the message's spelling.
 */

import type { CompilationUnit, TestFile } from "../frontend/ast.js";
import { allTokens } from "../frontend/lexer.js";
import type { CompileError } from "../types.js";
import { ELEMENTARY_TYPES } from "./type-utils.js";
import { StdFunctionRegistry } from "./std-function-registry.js";
import {
  type DeclaredName,
  sourceNameLocator,
  unitDeclaredNames,
  varBlockNames,
} from "./iec3-rules.js";

/** Keyword token names: a quoted keyword in a message is not a declared name. */
let keywordNames: ReadonlySet<string> | undefined;
function isKeyword(upper: string): boolean {
  keywordNames ??= new Set(
    allTokens
      .map((t) => t.name)
      .filter((n) => /^[A-Z_][A-Z0-9_]*$/.test(n) && n !== n.toLowerCase()),
  );
  return keywordNames.has(upper);
}

/** Upper-cased name → declared spelling; `null` when declared in two spellings. */
export type DeclaredSpellings = ReadonlyMap<string, string | null>;

/** The spellings, located in the sources on first use (most runs report no name). */
export type LazySpellings = () => DeclaredSpellings;

/**
 * What the pass needs of a compilation: the spellings, and whether an
 * upper-cased name is a member or parameter of a library POU or standard
 * function (also upper-cased): in a message naming that POU it keeps its
 * spelling, the POU's and not a user declaration of that name.
 */
export interface SpellingContext {
  spellings: LazySpellings;
  isLibraryMember: (pou: string, member: string) => boolean;
}

/** The context of each compilation unit, set where it is parsed (a function does not clone with it). */
const byUnit = new WeakMap<CompilationUnit, SpellingContext>();

/** The context `declaredSpellings` gave for `unit`, if any. */
export function spellingsOf(
  unit: CompilationUnit,
): SpellingContext | undefined {
  return byUnit.get(unit);
}

let stdRegistry: StdFunctionRegistry | undefined;
/** `member` is a parameter of standard function `pou` (LEN's IN, MAX's IN1…). */
function isStandardParameter(pou: string, member: string): boolean {
  stdRegistry ??= new StdFunctionRegistry();
  if (!stdRegistry.isStandardFunction(pou)) return false;
  const params =
    stdRegistry.lookup(pou)?.params ??
    stdRegistry.resolveTypedTrunc(pou)?.params ??
    [];
  return (
    params.some((p) => p.name.toUpperCase() === member) ||
    /^IN\d*$/.test(member)
  );
}

/** `compute` run once, on the first call. */
function once(compute: () => DeclaredSpellings): LazySpellings {
  let value: DeclaredSpellings | undefined;
  return () => (value ??= compute());
}

/** Add each of `names`, located in `sources`, to `into`. */
function addSpellings(
  names: readonly DeclaredName[],
  sources: ReadonlyMap<string, string>,
  into: Map<string, string | null>,
  isLibraryName: (upper: string) => boolean = () => false,
): void {
  const locate = sourceNameLocator(sources);
  for (const d of names) {
    const upper = d.name.toUpperCase();
    if (
      ELEMENTARY_TYPES[upper] !== undefined ||
      isKeyword(upper) ||
      isLibraryName(upper)
    ) {
      continue;
    }
    const spelling = locate(d.name, d.span).spelling;
    if (spelling.toUpperCase() !== upper) continue;
    const known = into.get(upper);
    if (known === undefined) into.set(upper, spelling);
    else if (known !== null && known !== spelling) into.set(upper, null);
  }
}

/**
 * The spellings of every name `unit` declares in `sources`, but for the names
 * a library declares too; also kept for {@link spellingsOf}. Run before
 * lowering, which adds and renames names: the names are collected now, their
 * spellings read when first needed.
 */
export function declaredSpellings(
  unit: CompilationUnit,
  sources: ReadonlyMap<string, string>,
  isLibraryName: (upper: string) => boolean = () => false,
  /** Upper-cased library POU → the upper-cased names of its members and parameters. */
  libraryMembers: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): SpellingContext {
  const names = unitDeclaredNames(unit);
  const context: SpellingContext = {
    spellings: once(() => {
      const out = new Map<string, string | null>();
      addSpellings(names, sources, out, isLibraryName);
      return out;
    }),
    isLibraryMember: (pou, member) =>
      libraryMembers.get(pou)?.has(member) === true ||
      isStandardParameter(pou, member),
  };
  byUnit.set(unit, context);
  return context;
}

/** The spellings of the names a test file declares, over those of `base`. */
export function testFileSpellings(
  testFile: TestFile,
  base: SpellingContext | undefined,
): SpellingContext {
  const names: DeclaredName[] = [];
  varBlockNames(testFile.setup?.varBlocks ?? [], names);
  for (const tc of testFile.testCases) varBlockNames(tc.varBlocks, names);
  const source = testFile.source;
  return {
    spellings: once(() => {
      const out = new Map(base?.spellings() ?? []);
      if (source !== undefined) {
        addSpellings(names, new Map([[testFile.fileName, source]]), out);
      }
      return out;
    }),
    isLibraryMember: base?.isLibraryMember ?? isStandardParameter,
  };
}

/** A quoted name: dotted and indexed paths (`'A.B'`, `'A[1].B'`). */
const QUOTED_NAME =
  /'([A-Za-z_][A-Za-z0-9_]*(?:(?:\.[A-Za-z_][A-Za-z0-9_]*)|\[[^\]'\n]*\])*)'/g;

/** The first word of each quoted name of `message` that is not inside a literal. */
function quotedHeads(message: string): string[] {
  const heads: string[] = [];
  for (const m of message.matchAll(QUOTED_NAME)) {
    if (message[m.index - 1] === "#") continue;
    heads.push(/^[A-Za-z0-9_]+/.exec(m[1]!)![0]);
  }
  return heads;
}

/**
 * `message` with each quoted declared name in its declared spelling. A quoted
 * text that is the body of a typed literal (`CHAR#'MOTOR'`) is left as it is.
 */
export function withDeclaredSpelling(
  message: string,
  spellings: Pick<DeclaredSpellings, "get">,
): string {
  const respell = (word: string): string =>
    word === word.toUpperCase() ? (spellings.get(word) ?? word) : word;
  return message.replace(
    QUOTED_NAME,
    (whole: string, path: string, offset: number) => {
      if (message[offset - 1] === "#") return whole;
      // Index expressions inside `[...]` are left as written
      let out = "";
      let depth = 0;
      let word = "";
      const flush = (): void => {
        out += depth === 0 ? respell(word) : word;
        word = "";
      };
      for (const ch of path) {
        if (/[A-Za-z0-9_]/.test(ch)) {
          word += ch;
          continue;
        }
        flush();
        if (ch === "[") depth++;
        if (ch === "]") depth--;
        out += ch;
      }
      flush();
      return `'${out}'`;
    },
  );
}

/**
 * Messages that quote a name not declared as what they call it, read at the
 * diagnostic's position: a name written on that line keeps the spelling
 * written there, over a declaration of another kind with that name.
 */
const NAMED_AT_POSITION = [
  /^Undeclared variable '/,
  / has no member '/,
  /^Undefined type '/,
  /^Undeclared function '/,
];

/** A line of a source and the offsets of each word in it, upper-cased, read once. */
interface LineText {
  text: string;
  words: ReadonlyMap<string, readonly number[]>;
}

/** `text` with the offsets of its words (identifier-like runs), in order. */
function lineText(text: string): LineText {
  const words = new Map<string, number[]>();
  for (const m of text.matchAll(/[A-Za-z0-9_]+/g)) {
    const key = m[0].toUpperCase();
    const at = words.get(key);
    if (at === undefined) words.set(key, [m.index]);
    else at.push(m.index);
  }
  return { text, words };
}

/** The lines of each source, split and upper-cased once per line read. */
class SourceLines {
  private readonly starts = new Map<string, number[]>();
  private readonly read = new Map<string, LineText>();
  constructor(private readonly sources: ReadonlyMap<string, string>) {}

  /** Line `line` (1-based) of `file`, without its line break. */
  line(file: string, line: number): LineText | undefined {
    const key = `${line}\u0000${file}`;
    const known = this.read.get(key);
    if (known !== undefined) return known;
    const text = this.sources.get(file);
    if (text === undefined || line < 1) return undefined;
    let starts = this.starts.get(file);
    if (starts === undefined) {
      starts = [0];
      for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) {
        starts.push(i + 1);
      }
      this.starts.set(file, starts);
    }
    const start = starts[line - 1];
    if (start === undefined) return undefined;
    const end = starts[line];
    const result = lineText(
      text.slice(start, end === undefined ? undefined : end - 1),
    );
    this.read.set(key, result);
    return result;
  }
}

/**
 * The spelling of `upper` as written in `line`: the first occurrence from
 * `column` on, else the first on the line; with `exact`, only one at `column`.
 */
function writtenOnLine(
  upper: string,
  line: LineText | undefined,
  column: number,
  exact = false,
): string | undefined {
  const at = line?.words.get(upper);
  if (line === undefined || at === undefined) return undefined;
  const spelled = (i: number): string => line.text.slice(i, i + upper.length);
  if (exact) return at.includes(column - 1) ? spelled(column - 1) : undefined;
  return spelled(at.find((i) => i >= column - 1) ?? at[0]!);
}

/** The spelling of the last `upper` in `line` that ends before `column`, if any. */
function writtenBefore(
  upper: string,
  line: LineText | undefined,
  column: number,
): string | undefined {
  const at = line?.words.get(upper);
  if (line === undefined || at === undefined) return undefined;
  let found: number | undefined;
  for (const i of at) {
    if (i + upper.length > column - 1) break;
    found = i;
  }
  return found !== undefined
    ? line.text.slice(found, found + upper.length)
    : undefined;
}

/**
 * Each diagnostic's message with declared spellings, in place. With
 * `sources`, an undeclared name in a message of {@link NAMED_AT_POSITION} is
 * spelled as written at the diagnostic, and so is a parse error's echo of the
 * identifier at its position (``identifier `FOO` ``). A message that names a
 * library POU or a standard function keeps its other names: they are that
 * POU's members and parameters.
 */
export function respellDiagnostics(
  diagnostics: CompileError[],
  context: SpellingContext | undefined,
  sources?: ReadonlyMap<string, string>,
  /** The file of a diagnostic that names none. */
  defaultFile?: string,
): void {
  const lines = sources !== undefined ? new SourceLines(sources) : undefined;
  for (const d of diagnostics) {
    const file = d.file ?? defaultFile;
    if (/identifier `[A-Za-z_]/.test(d.message)) {
      // A parse error echoes tokens: the one at its position, and the one before it
      const at = file !== undefined ? lines?.line(file, d.line) : undefined;
      d.message = d.message.replace(
        /identifier `([A-Za-z_][A-Za-z0-9_]*)`/g,
        (whole: string, name: string) => {
          const written =
            writtenOnLine(name, at, d.column, true) ??
            writtenBefore(name, at, d.column);
          return written !== undefined ? `identifier \`${written}\`` : whole;
        },
      );
      continue;
    }
    // Only a message quoting a name with a capital reads the spellings
    if (!/'[^'\n]*[A-Z][^'\n]*'/.test(d.message)) continue;
    const heads = quotedHeads(d.message);
    const spellings = context?.spellings();
    const extra = new Map<string, string | null>();
    // A member or parameter of a library POU or standard function the message
    // names keeps that POU's spelling
    if (context !== undefined) {
      for (const pou of heads) {
        for (const member of heads) {
          if (member !== pou && context.isLibraryMember(pou, member)) {
            extra.set(member, member);
          }
        }
      }
    }
    if (
      lines !== undefined &&
      file !== undefined &&
      NAMED_AT_POSITION.some((re) => re.test(d.message))
    ) {
      const at = lines.line(file, d.line);
      for (const upper of heads) {
        if (upper !== upper.toUpperCase()) continue;
        const written = writtenOnLine(upper, at, d.column);
        if (written !== undefined) extra.set(upper, written);
      }
    }
    if (spellings === undefined && extra.size === 0) continue;
    d.message = withDeclaredSpelling(d.message, {
      get: (upper: string): string | null | undefined =>
        extra.has(upper) ? extra.get(upper) : spellings?.get(upper),
    });
  }
}
