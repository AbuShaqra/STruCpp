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

/** The spellings of each compilation unit, set where it is parsed (a function does not clone with it). */
const byUnit = new WeakMap<CompilationUnit, LazySpellings>();

/** The spellings `declaredSpellings` gave for `unit`, if any. */
export function spellingsOf(unit: CompilationUnit): LazySpellings | undefined {
  return byUnit.get(unit);
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
  isLibraryName?: (upper: string) => boolean,
): LazySpellings {
  const names = unitDeclaredNames(unit);
  const lazy = once(() => {
    const out = new Map<string, string | null>();
    addSpellings(names, sources, out, isLibraryName);
    return out;
  });
  byUnit.set(unit, lazy);
  return lazy;
}

/** The spellings of the names a test file declares, over those of `base`. */
export function testFileSpellings(
  testFile: TestFile,
  base: LazySpellings | undefined,
): LazySpellings {
  const names: DeclaredName[] = [];
  varBlockNames(testFile.setup?.varBlocks ?? [], names);
  for (const tc of testFile.testCases) varBlockNames(tc.varBlocks, names);
  const source = testFile.source;
  return once(() => {
    const out = new Map(base?.() ?? []);
    if (source !== undefined) {
      addSpellings(names, new Map([[testFile.fileName, source]]), out);
    }
    return out;
  });
}

/** A quoted name: dotted and indexed paths (`'A.B'`, `'A[1].B'`). */
const QUOTED_NAME =
  /'([A-Za-z_][A-Za-z0-9_]*(?:(?:\.[A-Za-z_][A-Za-z0-9_]*)|\[[^\]'\n]*\])*)'|(identifier `)([A-Za-z_][A-Za-z0-9_]*)`/g;

/** `message` with each quoted declared name in its declared spelling. */
export function withDeclaredSpelling(
  message: string,
  spellings: Pick<DeclaredSpellings, "get">,
): string {
  const respell = (word: string): string =>
    word === word.toUpperCase() ? (spellings.get(word) ?? word) : word;
  return message.replace(
    QUOTED_NAME,
    (_whole: string, path?: string, lead?: string, ident?: string) => {
      if (path !== undefined) {
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
      }
      return `${lead ?? ""}${respell(ident ?? "")}\``;
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
];

/**
 * The spelling of `upper` as written on `line` of `text`, if it is there:
 * the first occurrence from `column` on, else the first on the line.
 */
function writtenOnLine(
  upper: string,
  text: string | undefined,
  line: number,
  column: number,
): string | undefined {
  if (text === undefined || line < 1) return undefined;
  let start = 0;
  for (let n = 1; n < line && start >= 0; n++) {
    start = text.indexOf("\n", start);
    if (start >= 0) start++;
  }
  if (start < 0) return undefined;
  const end = text.indexOf("\n", start);
  const lineText = text.slice(start, end < 0 ? undefined : end);
  const re = new RegExp(`(?<![A-Za-z0-9_])${upper}(?![A-Za-z0-9_])`, "gi");
  let first: string | undefined;
  for (const m of lineText.matchAll(re)) {
    first ??= m[0];
    if (m.index + 1 >= column) return m[0];
  }
  return first;
}

/**
 * Each diagnostic's message with declared spellings, in place; with
 * `sources`, an undeclared name in a message of {@link NAMED_AT_POSITION}
 * as written at the diagnostic.
 */
export function respellDiagnostics(
  diagnostics: CompileError[],
  lazy: LazySpellings | undefined,
  sources?: ReadonlyMap<string, string>,
): void {
  for (const d of diagnostics) {
    // Only a message quoting a name with a capital reads the spellings
    if (!/'[^'\n]*[A-Z][^'\n]*'|identifier `/.test(d.message)) continue;
    const spellings = lazy?.();
    let local: Pick<DeclaredSpellings, "get"> | undefined = spellings;
    if (
      sources !== undefined &&
      d.file !== undefined &&
      NAMED_AT_POSITION.some((re) => re.test(d.message))
    ) {
      const extra = new Map<string, string | null>();
      for (const m of d.message.matchAll(/'([A-Za-z_][A-Za-z0-9_]*)'/g)) {
        const upper = m[1]!;
        if (upper !== upper.toUpperCase()) continue;
        const written = writtenOnLine(
          upper,
          sources.get(d.file),
          d.line,
          d.column,
        );
        if (written !== undefined) extra.set(upper, written);
      }
      local = {
        get: (upper: string): string | null | undefined =>
          extra.has(upper) ? extra.get(upper) : spellings?.get(upper),
      };
    }
    if (local === undefined) continue;
    d.message = withDeclaredSpelling(d.message, local);
  }
}
