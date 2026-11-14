// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * STruC++ Lexer
 *
 * Tokenizes IEC 61131-3 Structured Text source code using Chevrotain.
 * This module defines all tokens used by the ST grammar.
 */

import {
  createToken,
  Lexer,
  type ILexingError,
  type ILexingResult,
  type IToken,
} from "chevrotain";

// =============================================================================
// Token Categories
// =============================================================================

/**
 * Whitespace tokens (skipped during parsing)
 */
export const WhiteSpace = createToken({
  name: "WhiteSpace",
  pattern: /\s+/,
  group: Lexer.SKIPPED,
});

// =============================================================================
// Custom Pattern Helpers
// =============================================================================

/**
 * Helper to create a RegExpExecArray-compatible result for custom patterns.
 */
function createMatchResult(
  match: string,
  offset: number,
): RegExpExecArray | null {
  if (match.length === 0) return null;
  const result = [match] as unknown as RegExpExecArray;
  result.index = offset;
  result.input = "";
  return result;
}

// =============================================================================
// Pragma Support
// =============================================================================

/**
 * Custom pattern matcher for {external ...} pragma.
 * Handles nested braces in C++ code correctly.
 * Content inside is passed through AS-IS to generated code.
 *
 * @param text - The full source text
 * @param startOffset - The current position in the text
 * @returns A RegExpExecArray-compatible result or null if no match
 */
function matchExternalPragma(
  text: string,
  startOffset: number,
): RegExpExecArray | null {
  // Must start with {external (case insensitive)
  if (text.charAt(startOffset) !== "{") return null;

  // Check for "external" keyword (case insensitive)
  const keywordStart = startOffset + 1;
  let keywordEnd = keywordStart;

  // Skip whitespace after {
  while (keywordEnd < text.length && /\s/.test(text.charAt(keywordEnd))) {
    keywordEnd++;
  }

  // Check for "external" keyword
  const potentialKeyword = text.substring(keywordEnd, keywordEnd + 8);
  if (potentialKeyword.toLowerCase() !== "external") {
    return null;
  }

  // Find the matching closing brace, counting nested braces
  let depth = 1;
  let i = keywordEnd + 8; // After "external"

  while (i < text.length && depth > 0) {
    const char = text.charAt(i);

    // Handle string literals (don't count braces inside strings)
    if (char === '"' || char === "'") {
      const quote = char;
      i++;
      while (i < text.length && text.charAt(i) !== quote) {
        if (text.charAt(i) === "\\") i++; // Skip escape sequences
        i++;
      }
      i++; // Skip closing quote
      continue;
    }

    // Handle C++ comments inside external code
    if (char === "/" && text.charAt(i + 1) === "/") {
      // Single-line comment - skip to end of line
      while (i < text.length && text.charAt(i) !== "\n") {
        i++;
      }
      continue;
    }
    if (char === "/" && text.charAt(i + 1) === "*") {
      // Block comment - skip to */
      i += 2;
      while (i < text.length - 1) {
        if (text.charAt(i) === "*" && text.charAt(i + 1) === "/") {
          i += 2;
          break;
        }
        i++;
      }
      continue;
    }

    if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;
    }
    i++;
  }

  if (depth === 0) {
    return createMatchResult(text.substring(startOffset, i), startOffset);
  }

  return null; // Unclosed pragma
}

/**
 * External code pragma token: {external ... }
 * Content is passed through AS-IS to generated C++ code.
 */
export const ExternalPragma = createToken({
  name: "ExternalPragma",
  pattern: matchExternalPragma,
  line_breaks: true, // Content can span multiple lines
});

/** True if `{` at `startOffset` opens an `{external ...}` pragma. */
function opensExternalPragma(text: string, startOffset: number): boolean {
  let i = startOffset + 1;
  while (i < text.length && /\s/.test(text.charAt(i))) i++;
  return text.substring(i, i + 8).toLowerCase() === "external";
}

/**
 * Custom pattern matcher for a general pragma `{ ... }` (IEC 61131-3 Ed.3,
 * 6.2): everything up to the first `}`. Pragmas do not nest. `{external ...}`
 * is left to {@link ExternalPragma}; an unclosed `{` does not match.
 *
 * @param text - The full source text
 * @param startOffset - The current position in the text
 * @returns A RegExpExecArray-compatible result or null if no match
 */
function matchPragma(
  text: string,
  startOffset: number,
): RegExpExecArray | null {
  if (text.charAt(startOffset) !== "{") return null;
  if (opensExternalPragma(text, startOffset)) return null;
  const close = text.indexOf("}", startOffset + 1);
  if (close < 0) return null;
  return createMatchResult(text.substring(startOffset, close + 1), startOffset);
}

/** Lexer group that collects pragma tokens; see {@link Pragma}. */
export const PRAGMA_GROUP = "pragmas";

/**
 * General pragma `{ ... }`. Kept out of the token stream (trivia) and
 * collected in `groups.pragmas`, so the parser never sees it and the
 * compiler can warn that it was ignored.
 */
export const Pragma = createToken({
  name: "Pragma",
  pattern: matchPragma,
  line_breaks: true,
  start_chars_hint: ["{"],
  group: PRAGMA_GROUP,
});

/** Conditional-compilation pragma keywords, matched case-insensitively. */
const CONDITIONAL_PRAGMA = /^\{\s*(IF|ELSIF|ELSE|END_IF|DEFINE|UNDEFINE)\b/i;

/**
 * True if a pragma's text is a conditional-compilation directive
 * (`{IF ...}`, `{ELSIF ...}`, `{ELSE}`, `{END_IF}`, `{define ...}`,
 * `{undefine ...}`).
 *
 * @param image - The pragma text, braces included
 */
export function isConditionalPragma(image: string): boolean {
  return CONDITIONAL_PRAGMA.test(image);
}

/** {@link CONDITIONAL_PRAGMA} without its start anchor, to search a whole text. */
const CONDITIONAL_PRAGMA_ANYWHERE = new RegExp(
  CONDITIONAL_PRAGMA.source.replace(/^\^/, ""),
  CONDITIONAL_PRAGMA.flags,
);

/**
 * True if `text` holds something that looks like a conditional-compilation
 * directive anywhere (comments and strings included). A cheap pre-check:
 * a hit still has to be confirmed by lexing.
 *
 * @param text - Source text to search
 */
export function hasConditionalPragma(text: string): boolean {
  return CONDITIONAL_PRAGMA_ANYWHERE.test(text);
}

// =============================================================================
// Nested Comment Support
// =============================================================================

/**
 * Custom pattern for comments with nested block comment support.
 * Handles both // single-line and (* *) block comments.
 * Block comments can be nested to arbitrary depth per IEC 61131-3 Ed.3.
 *
 * @param text - The full source text
 * @param startOffset - The current position in the text
 * @returns A RegExpExecArray-compatible result or null if no match
 */
function matchComment(
  text: string,
  startOffset: number,
): RegExpExecArray | null {
  // Try single-line comment first: // ...
  if (
    text.charAt(startOffset) === "/" &&
    text.charAt(startOffset + 1) === "/"
  ) {
    let end = startOffset + 2;
    while (
      end < text.length &&
      text.charAt(end) !== "\n" &&
      text.charAt(end) !== "\r"
    ) {
      end++;
    }
    return createMatchResult(text.substring(startOffset, end), startOffset);
  }

  // Try block comment: (* ... *) with nesting support
  if (
    text.charAt(startOffset) === "(" &&
    text.charAt(startOffset + 1) === "*"
  ) {
    let depth = 1;
    let i = startOffset + 2;

    while (i < text.length && depth > 0) {
      if (text.charAt(i) === "(" && text.charAt(i + 1) === "*") {
        depth++;
        i += 2;
      } else if (text.charAt(i) === "*" && text.charAt(i + 1) === ")") {
        depth--;
        i += 2;
      } else {
        i++;
      }
    }

    if (depth === 0) {
      return createMatchResult(text.substring(startOffset, i), startOffset);
    }

    // Unclosed comment - return null, lexer will report error
    return null;
  }

  return null;
}

/**
 * Comment token with support for nested block comments.
 * - Single-line: // ... (to end of line)
 * - Block: (* ... *) with arbitrary nesting depth
 */
export const Comment = createToken({
  name: "Comment",
  pattern: matchComment,
  line_breaks: true, // Essential for multi-line block comments
  group: Lexer.SKIPPED,
});

// =============================================================================
// Keywords
// =============================================================================

// Program Organization Units
export const PROGRAM = createToken({ name: "PROGRAM", pattern: /PROGRAM/i });
export const END_PROGRAM = createToken({
  name: "END_PROGRAM",
  pattern: /END_PROGRAM/i,
});
export const FUNCTION = createToken({ name: "FUNCTION", pattern: /FUNCTION/i });
export const END_FUNCTION = createToken({
  name: "END_FUNCTION",
  pattern: /END_FUNCTION/i,
});
export const FUNCTION_BLOCK = createToken({
  name: "FUNCTION_BLOCK",
  pattern: /FUNCTION_BLOCK/i,
});
export const END_FUNCTION_BLOCK = createToken({
  name: "END_FUNCTION_BLOCK",
  pattern: /END_FUNCTION_BLOCK/i,
});

// Variable declarations
export const VAR = createToken({ name: "VAR", pattern: /VAR/i });
export const END_VAR = createToken({ name: "END_VAR", pattern: /END_VAR/i });
export const VAR_INPUT = createToken({
  name: "VAR_INPUT",
  pattern: /VAR_INPUT/i,
});
export const VAR_OUTPUT = createToken({
  name: "VAR_OUTPUT",
  pattern: /VAR_OUTPUT/i,
});
export const VAR_IN_OUT = createToken({
  name: "VAR_IN_OUT",
  pattern: /VAR_IN_OUT/i,
});
export const VAR_EXTERNAL = createToken({
  name: "VAR_EXTERNAL",
  pattern: /VAR_EXTERNAL/i,
});
export const VAR_GLOBAL = createToken({
  name: "VAR_GLOBAL",
  pattern: /VAR_GLOBAL/i,
});
export const VAR_TEMP = createToken({ name: "VAR_TEMP", pattern: /VAR_TEMP/i });
export const CONSTANT = createToken({ name: "CONSTANT", pattern: /CONSTANT/i });
export const RETAIN = createToken({ name: "RETAIN", pattern: /RETAIN/i });
// NON_RETAIN is IEC's explicit spelling of the DEFAULT — a variable that does
// not survive a power cycle. Lexed so a CODESYS import parses rather than
// failing on the next line: without a token, `NON_RETAIN` matched Identifier
// and the parser then demanded a colon, reporting a syntax error one line
// below the qualifier that caused it.
export const NON_RETAIN = createToken({
  name: "NON_RETAIN",
  pattern: /NON_RETAIN/i,
});
// PERSISTENT folds into RETAIN. CODESYS distinguishes them (PERSISTENT also
// survives a download), and this toolchain does not yet — so it is accepted
// and treated as RETAIN rather than rejected, which is what lets a converted
// project compile. Revisit if download-surviving retention is implemented.
export const PERSISTENT = createToken({
  name: "PERSISTENT",
  pattern: /PERSISTENT/i,
});
export const AT = createToken({ name: "AT", pattern: /AT/i });

// Type declarations
export const TYPE = createToken({ name: "TYPE", pattern: /TYPE/i });
export const END_TYPE = createToken({ name: "END_TYPE", pattern: /END_TYPE/i });
export const STRUCT = createToken({ name: "STRUCT", pattern: /STRUCT/i });
export const END_STRUCT = createToken({
  name: "END_STRUCT",
  pattern: /END_STRUCT/i,
});
export const ARRAY = createToken({ name: "ARRAY", pattern: /ARRAY/i });
export const OF = createToken({ name: "OF", pattern: /OF/i });

// Configuration
export const CONFIGURATION = createToken({
  name: "CONFIGURATION",
  pattern: /CONFIGURATION/i,
});
export const END_CONFIGURATION = createToken({
  name: "END_CONFIGURATION",
  pattern: /END_CONFIGURATION/i,
});
export const RESOURCE = createToken({ name: "RESOURCE", pattern: /RESOURCE/i });
export const END_RESOURCE = createToken({
  name: "END_RESOURCE",
  pattern: /END_RESOURCE/i,
});
export const TASK = createToken({ name: "TASK", pattern: /TASK/i });
export const WITH = createToken({ name: "WITH", pattern: /WITH/i });
export const ON = createToken({ name: "ON", pattern: /ON/i });

// Control flow
export const IF = createToken({ name: "IF", pattern: /IF/i });
export const THEN = createToken({ name: "THEN", pattern: /THEN/i });
export const ELSIF = createToken({ name: "ELSIF", pattern: /ELSIF/i });
export const ELSE = createToken({ name: "ELSE", pattern: /ELSE/i });
export const END_IF = createToken({ name: "END_IF", pattern: /END_IF/i });
export const CASE = createToken({ name: "CASE", pattern: /CASE/i });
export const END_CASE = createToken({ name: "END_CASE", pattern: /END_CASE/i });
export const FOR = createToken({ name: "FOR", pattern: /FOR/i });
export const TO = createToken({ name: "TO", pattern: /TO/i });
export const BY = createToken({ name: "BY", pattern: /BY/i });
export const DO = createToken({ name: "DO", pattern: /DO/i });
export const END_FOR = createToken({ name: "END_FOR", pattern: /END_FOR/i });
export const WHILE = createToken({ name: "WHILE", pattern: /WHILE/i });
export const END_WHILE = createToken({
  name: "END_WHILE",
  pattern: /END_WHILE/i,
});
export const REPEAT = createToken({ name: "REPEAT", pattern: /REPEAT/i });
export const UNTIL = createToken({ name: "UNTIL", pattern: /UNTIL/i });
export const END_REPEAT = createToken({
  name: "END_REPEAT",
  pattern: /END_REPEAT/i,
});
export const EXIT = createToken({ name: "EXIT", pattern: /EXIT/i });
export const CONTINUE = createToken({
  name: "CONTINUE",
  pattern: /CONTINUE/i,
});
export const RETURN = createToken({ name: "RETURN", pattern: /RETURN/i });

// Boolean literals
export const TRUE = createToken({ name: "TRUE", pattern: /TRUE/i });
export const FALSE = createToken({ name: "FALSE", pattern: /FALSE/i });

// Logical operators
export const AND = createToken({ name: "AND", pattern: /AND/i });
export const OR = createToken({ name: "OR", pattern: /OR/i });
export const XOR = createToken({ name: "XOR", pattern: /XOR/i });
export const NOT = createToken({ name: "NOT", pattern: /NOT/i });
export const MOD = createToken({ name: "MOD", pattern: /MOD/i });

// Reference types (IEC v3 and CODESYS compatibility)
// IEC 61131-3 / CODESYS spell this as two words ("REFERENCE TO"); the
// underscore form is also accepted for backward compatibility. The
// whitespace between the words is consumed by this token, not skipped.
export const REFERENCE_TO = createToken({
  name: "REFERENCE_TO",
  pattern: /REFERENCE(?:_|\s+)TO/i,
});
export const REF_TO = createToken({ name: "REF_TO", pattern: /REF_TO/i });
export const DREF = createToken({ name: "DREF", pattern: /DREF/i });
export const REF = createToken({ name: "REF", pattern: /REF/i });
export const NULL = createToken({ name: "NULL", pattern: /NULL/i });

// Pointer type (CODESYS compatibility)
export const POINTER = createToken({ name: "POINTER", pattern: /POINTER/i });

// Dynamic memory (extension keywords)
export const __NEW = createToken({ name: "__NEW", pattern: /__NEW/i });
export const __DELETE = createToken({ name: "__DELETE", pattern: /__DELETE/i });

// Test framework keywords (only active in test file lexing)
export const TEST = createToken({ name: "TEST", pattern: /TEST/i });
export const END_TEST = createToken({
  name: "END_TEST",
  pattern: /END_TEST/i,
});

// Test framework assert built-in functions
export const ASSERT_EQ = createToken({
  name: "ASSERT_EQ",
  pattern: /ASSERT_EQ/i,
});
export const ASSERT_TRUE = createToken({
  name: "ASSERT_TRUE",
  pattern: /ASSERT_TRUE/i,
});
export const ASSERT_FALSE = createToken({
  name: "ASSERT_FALSE",
  pattern: /ASSERT_FALSE/i,
});
export const ASSERT_NEQ = createToken({
  name: "ASSERT_NEQ",
  pattern: /ASSERT_NEQ/i,
});
export const ASSERT_GT = createToken({
  name: "ASSERT_GT",
  pattern: /ASSERT_GT/i,
});
export const ASSERT_LT = createToken({
  name: "ASSERT_LT",
  pattern: /ASSERT_LT/i,
});
export const ASSERT_GE = createToken({
  name: "ASSERT_GE",
  pattern: /ASSERT_GE/i,
});
export const ASSERT_LE = createToken({
  name: "ASSERT_LE",
  pattern: /ASSERT_LE/i,
});
export const ASSERT_NEAR = createToken({
  name: "ASSERT_NEAR",
  pattern: /ASSERT_NEAR/i,
});

// ADVANCE_TIME for test time simulation
export const ADVANCE_TIME = createToken({
  name: "ADVANCE_TIME",
  pattern: /ADVANCE_TIME/i,
});

// SETUP/TEARDOWN for test organization
export const SETUP = createToken({ name: "SETUP", pattern: /SETUP/i });
export const END_SETUP = createToken({
  name: "END_SETUP",
  pattern: /END_SETUP/i,
});
export const TEARDOWN = createToken({
  name: "TEARDOWN",
  pattern: /TEARDOWN/i,
});
export const END_TEARDOWN = createToken({
  name: "END_TEARDOWN",
  pattern: /END_TEARDOWN/i,
});

// Mocking framework keywords (test file only)
export const MOCK_VERIFY_CALL_COUNT = createToken({
  name: "MOCK_VERIFY_CALL_COUNT",
  pattern: /MOCK_VERIFY_CALL_COUNT/i,
});
export const MOCK_VERIFY_CALLED = createToken({
  name: "MOCK_VERIFY_CALLED",
  pattern: /MOCK_VERIFY_CALLED/i,
});
export const MOCK_FUNCTION = createToken({
  name: "MOCK_FUNCTION",
  pattern: /MOCK_FUNCTION/i,
});
export const MOCK = createToken({ name: "MOCK", pattern: /MOCK/i });
export const RETURNS = createToken({ name: "RETURNS", pattern: /RETURNS/i });

// OOP extensions (IEC 61131-3 Edition 3)
export const METHOD = createToken({ name: "METHOD", pattern: /METHOD/i });
export const END_METHOD = createToken({
  name: "END_METHOD",
  pattern: /END_METHOD/i,
});
// ACTION ... END_ACTION (IEC 61131-3 ed. 2 SFC-style actions, also used with ST).
// ACTION is contextual (see isActionDeclarationAhead in the parser).
export const ACTION = createToken({ name: "ACTION", pattern: /ACTION/i });
export const END_ACTION = createToken({
  name: "END_ACTION",
  pattern: /END_ACTION/i,
});
export const INTERFACE = createToken({
  name: "INTERFACE",
  pattern: /INTERFACE/i,
});
export const END_INTERFACE = createToken({
  name: "END_INTERFACE",
  pattern: /END_INTERFACE/i,
});
export const EXTENDS = createToken({ name: "EXTENDS", pattern: /EXTENDS/i });
export const IMPLEMENTS = createToken({
  name: "IMPLEMENTS",
  pattern: /IMPLEMENTS/i,
});
export const THIS = createToken({ name: "THIS", pattern: /THIS/i });
export const SUPER = createToken({ name: "SUPER", pattern: /SUPER/i });
export const PROPERTY = createToken({ name: "PROPERTY", pattern: /PROPERTY/i });
export const END_PROPERTY = createToken({
  name: "END_PROPERTY",
  pattern: /END_PROPERTY/i,
});
// GET and SET are not tokens: they lex as Identifier and are accessor keywords
// only inside a PROPERTY (see STParser.propertyGetter), names everywhere else.
export const END_GET = createToken({ name: "END_GET", pattern: /END_GET/i });
export const END_SET = createToken({ name: "END_SET", pattern: /END_SET/i });
export const ABSTRACT = createToken({ name: "ABSTRACT", pattern: /ABSTRACT/i });
export const FINAL = createToken({ name: "FINAL", pattern: /FINAL/i });
export const OVERRIDE = createToken({ name: "OVERRIDE", pattern: /OVERRIDE/i });
export const PUBLIC = createToken({ name: "PUBLIC", pattern: /PUBLIC/i });
export const PRIVATE = createToken({ name: "PRIVATE", pattern: /PRIVATE/i });
export const PROTECTED = createToken({
  name: "PROTECTED",
  pattern: /PROTECTED/i,
});
export const VAR_INST = createToken({
  name: "VAR_INST",
  pattern: /VAR_INST/i,
});

// =============================================================================
// Literals
// =============================================================================

// Time literal: T#1s, T#100ms, TIME#1h2m3s, T#-14ms (signed: Ed. 3 Table 8);
// LTIME#1d_2h, LT#5ns are the 64-bit duration (LTIME)
// Note: Each numeric component must have a unit suffix (ms, us, ns, d, h, m, s)
// Longer suffixes (ms, us, ns) must come before shorter ones (m, s) in the alternation
export const TimeLiteral = createToken({
  name: "TimeLiteral",
  pattern:
    /(?:LTIME|LT|TIME|T)#[+-]?(?:[0-9_]+(?:\.[0-9_]+)?(?:ms|us|ns|d|h|m|s))+/i,
});

// Date literal: D#2024-01-15, D#1970-9-1 (IEC allows 1- or 2-digit month/day);
// LDATE# / LD# give LDATE
export const DateLiteral = createToken({
  name: "DateLiteral",
  pattern: /(?:LDATE|LD|DATE|D)#[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}/i,
});

// Time of day literal: TOD#12:30:00, TOD#1:2:3 (1- or 2-digit fields; seconds optional);
// LTOD# / LTIME_OF_DAY# give LTOD
export const TimeOfDayLiteral = createToken({
  name: "TimeOfDayLiteral",
  pattern:
    /(?:LTIME_OF_DAY|LTOD|TIME_OF_DAY|TOD)#[0-9]{1,2}:[0-9]{1,2}(?::[0-9]{1,2}(?:\.[0-9]+)?)?/i,
});

// Date and time literal: DT#2024-01-15-12:30:00, DT#1970-1-1-00:00:00 (LDT# and
// LDATE_AND_TIME# give LDT)
// (1- or 2-digit month/day/time fields; seconds optional)
export const DateTimeLiteral = createToken({
  name: "DateTimeLiteral",
  pattern:
    /(?:LDATE_AND_TIME|LDT|DATE_AND_TIME|DT)#[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}-[0-9]{1,2}:[0-9]{1,2}(?::[0-9]{1,2}(?:\.[0-9]+)?)?/i,
});

// Typed character literal: CHAR#'A', CHAR#'$41', WCHAR#"B", WCHAR#"$20AC",
// WCHAR#'X' (Table 6) and a code, CHAR#16#41 / WCHAR#8364 (Table 5)
export const CharLiteral = createToken({
  name: "CharLiteral",
  pattern:
    /W?CHAR#(?:16#[0-9A-Fa-f_]+|8#[0-7_]+|2#[01_]+|[0-9][0-9_]*)|CHAR#'(?:[^'$]|\$\$|\$'|\$[LNPRTlnprt]|\$[0-9A-Fa-f]{2}|'')*'|WCHAR#'(?:[^'$]|\$\$|\$'|\$[LNPRTlnprt]|\$[0-9A-Fa-f]{4}|'')*'|WCHAR#"(?:[^"$]|\$\$|\$"|\$[LNPRTlnprt]|\$[0-9A-Fa-f]{4})*"/i,
});

// Typed literal: BYTE#255, DWORD#16#FF, INT#0, BOOL#1, REAL#1.5E10, INT#-123, etc.
// Must be before keyword tokens and RealLiteral/IntegerLiteral so that BYTE#255 isn't split.
// A sign is taken only by a decimal integer or real payload (Ed. 3 Annex A
// Int_Literal/Real_Literal); bit-string, BOOL and based payloads stay unsigned.
export const TypedLiteral = createToken({
  name: "TypedLiteral",
  pattern:
    /(?:BYTE|WORD|DWORD|LWORD|BOOL)#(?:16#[0-9A-Fa-f_]+|8#[0-7_]+|2#[01_]+|[0-9][0-9_]*(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)|(?:SINT|INT|DINT|LINT|USINT|UINT|UDINT|ULINT|REAL|LREAL)#(?:16#[0-9A-Fa-f_]+|8#[0-7_]+|2#[01_]+|[+-]?[0-9][0-9_]*(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/i,
});

// Typed enumeration literal: E_State#Idle (IEC 61131-3 type-qualified enum
// value). After TypedLiteral, so BYTE#255 and the other numeric forms keep
// their token; also takes BOOL#TRUE / BOOL#FALSE, which the builder reads as
// boolean literals.
export const EnumLiteral = createToken({
  name: "EnumLiteral",
  pattern: /[A-Za-z_][A-Za-z0-9_]*#[A-Za-z_][A-Za-z0-9_]*/,
});

// Real number literal: 3.14, 1.0e-10
export const RealLiteral = createToken({
  name: "RealLiteral",
  pattern: /[0-9]+\.[0-9]+(?:[eE][+-]?[0-9]+)?|[0-9]+[eE][+-]?[0-9]+/,
});

// Integer literal: 123, 16#FF, 2#1010, 8#77
export const IntegerLiteral = createToken({
  name: "IntegerLiteral",
  pattern: /(?:16#[0-9A-Fa-f_]+|8#[0-7_]+|2#[01_]+|[0-9][0-9_]*)/,
});

// String literal: 'hello world'
export const StringLiteral = createToken({
  name: "StringLiteral",
  pattern: /'(?:[^'$]|\$\$|\$'|\$[LNPRTlnprt]|\$[0-9A-Fa-f]{2}|'')*'/,
});

// Wide string literal: "hello world"
export const WideStringLiteral = createToken({
  name: "WideStringLiteral",
  pattern: /"(?:[^"$]|\$\$|\$"|\$[LNPRTlnprt]|\$[0-9A-Fa-f]{4})*"/,
});

// =============================================================================
// Operators and Punctuation
// =============================================================================

export const RefAssign = createToken({ name: "RefAssign", pattern: /REF=/i });
export const Assign = createToken({ name: "Assign", pattern: /:=/ });
export const OutputAssign = createToken({
  name: "OutputAssign",
  pattern: /=>/,
});
export const Colon = createToken({ name: "Colon", pattern: /:/ });
export const Semicolon = createToken({ name: "Semicolon", pattern: /;/ });
export const Comma = createToken({ name: "Comma", pattern: /,/ });
export const Dot = createToken({ name: "Dot", pattern: /\./ });
export const DoubleDot = createToken({ name: "DoubleDot", pattern: /\.\./ });
export const LParen = createToken({ name: "LParen", pattern: /\(/ });
export const RParen = createToken({ name: "RParen", pattern: /\)/ });
export const LBracket = createToken({ name: "LBracket", pattern: /\[/ });
export const RBracket = createToken({ name: "RBracket", pattern: /\]/ });

// Comparison operators
export const Equal = createToken({ name: "Equal", pattern: /=/ });
export const NotEqual = createToken({ name: "NotEqual", pattern: /<>/ });
export const LessEqual = createToken({ name: "LessEqual", pattern: /<=/ });
export const GreaterEqual = createToken({
  name: "GreaterEqual",
  pattern: />=/,
});
export const Less = createToken({ name: "Less", pattern: /</ });
export const Greater = createToken({ name: "Greater", pattern: />/ });

// Arithmetic operators
export const Plus = createToken({ name: "Plus", pattern: /\+/ });
export const Minus = createToken({ name: "Minus", pattern: /-/ });
export const Star = createToken({ name: "Star", pattern: /\*/ });
export const Slash = createToken({ name: "Slash", pattern: /\// });
export const Power = createToken({ name: "Power", pattern: /\*\*/ });

// Reference operators (IEC v3)
export const Caret = createToken({ name: "Caret", pattern: /\^/ });
export const Ampersand = createToken({ name: "Ampersand", pattern: /&/ });

// Located variable prefix
export const DirectAddress = createToken({
  name: "DirectAddress",
  pattern: /%[IQM][XBWDL]?[0-9]+(?:\.[0-9]+)*/i,
});

// =============================================================================
// Identifier (must be last to avoid matching keywords)
// =============================================================================

/**
 * A name's characters: A–Z, a–z, digits and _, and any non-ASCII character
 * but whitespace, so a word holding one lexes as one Identifier and each such
 * character is then refused by name (see collectRefused).
 */
/** Control characters a character class names as range ends (not written literally). */
const TAB = String.fromCharCode(0x09);
const CR = String.fromCharCode(0x0d);

/**
 * A name's characters: A–Z, a–z, digits and _, and any other character but
 * whitespace and ASCII punctuation (non-ASCII, and control characters), so a
 * word holding one lexes as one Identifier and each such character is then
 * refused (see collectRefused).
 */
export const Identifier = createToken({
  name: "Identifier",
  pattern: new RegExp(
    `[^${TAB}-${CR}\\x20-\\x40\\x5B-\\x5E\\x60\\x7B-\\x7E\\s][^${TAB}-${CR}\\x20-\\x2F\\x3A-\\x40\\x5B-\\x5E\\x60\\x7B-\\x7E\\s]*`,
  ),
});

// =============================================================================
// Keyword Configuration
// =============================================================================

// Test-specific keyword tokens (separate from normal keywords)
const testKeywordTokens = [
  END_TEST,
  TEST,
  END_SETUP,
  SETUP,
  END_TEARDOWN,
  TEARDOWN,
  ADVANCE_TIME,
  ASSERT_EQ,
  ASSERT_NEQ,
  ASSERT_TRUE,
  ASSERT_FALSE,
  ASSERT_GT,
  ASSERT_LT,
  ASSERT_GE,
  ASSERT_LE,
  ASSERT_NEAR,
  MOCK_VERIFY_CALL_COUNT,
  MOCK_VERIFY_CALLED,
  MOCK_FUNCTION,
  MOCK,
  RETURNS,
];

// Set longer_alt for test keywords
testKeywordTokens.forEach((token) => {
  token.LONGER_ALT = Identifier;
});

// Configure all keywords to use Identifier as longer_alt
// This ensures that 'var123' is tokenized as Identifier, not VAR + 123
const keywordTokens = [
  PROGRAM,
  END_PROGRAM,
  FUNCTION,
  END_FUNCTION,
  FUNCTION_BLOCK,
  END_FUNCTION_BLOCK,
  VAR,
  END_VAR,
  VAR_INPUT,
  VAR_OUTPUT,
  VAR_IN_OUT,
  VAR_EXTERNAL,
  VAR_GLOBAL,
  VAR_TEMP,
  CONSTANT,
  RETAIN,
  NON_RETAIN,
  PERSISTENT,
  AT,
  TYPE,
  END_TYPE,
  STRUCT,
  END_STRUCT,
  ARRAY,
  OF,
  CONFIGURATION,
  END_CONFIGURATION,
  RESOURCE,
  END_RESOURCE,
  TASK,
  WITH,
  ON,
  IF,
  THEN,
  ELSIF,
  ELSE,
  END_IF,
  CASE,
  END_CASE,
  FOR,
  TO,
  BY,
  DO,
  END_FOR,
  WHILE,
  END_WHILE,
  REPEAT,
  UNTIL,
  END_REPEAT,
  EXIT,
  CONTINUE,
  RETURN,
  TRUE,
  FALSE,
  AND,
  OR,
  XOR,
  NOT,
  MOD,
  REFERENCE_TO,
  REF_TO,
  POINTER,
  DREF,
  REF,
  NULL,
  __NEW,
  __DELETE,
  METHOD,
  END_METHOD,
  ACTION,
  END_ACTION,
  INTERFACE,
  END_INTERFACE,
  EXTENDS,
  IMPLEMENTS,
  THIS,
  SUPER,
  PROPERTY,
  END_PROPERTY,
  END_GET,
  END_SET,
  ABSTRACT,
  FINAL,
  OVERRIDE,
  PUBLIC,
  PRIVATE,
  PROTECTED,
  VAR_INST,
];

// Set longer_alt for all keywords
keywordTokens.forEach((token) => {
  token.LONGER_ALT = Identifier;
});

// =============================================================================
// Token List (order matters for matching priority)
// =============================================================================

/**
 * All tokens in order of matching priority.
 * Keywords must come before Identifier to be matched correctly.
 */
export const allTokens = [
  // Whitespace and comments (skipped)
  WhiteSpace,
  Comment,

  // External code pragma, then any other pragma (trivia)
  ExternalPragma,
  Pragma,

  // Multi-character operators (before single-character)
  DoubleDot,
  Power,
  RefAssign,
  Assign,
  OutputAssign,
  NotEqual,
  LessEqual,
  GreaterEqual,

  // Typed and time/date literals (before keywords — BYTE#255, TOD#12:00 must not split)
  TimeLiteral,
  DateTimeLiteral,
  DateLiteral,
  TimeOfDayLiteral,
  CharLiteral,
  TypedLiteral,
  EnumLiteral,

  // Keywords (before Identifier)
  END_PROGRAM,
  END_FUNCTION_BLOCK,
  END_FUNCTION,
  END_CONFIGURATION,
  END_RESOURCE,
  END_STRUCT,
  END_TYPE,
  END_VAR,
  END_IF,
  END_CASE,
  END_FOR,
  END_WHILE,
  END_REPEAT,
  FUNCTION_BLOCK,
  FUNCTION,
  PROGRAM,
  CONFIGURATION,
  RESOURCE,
  VAR_INPUT,
  VAR_OUTPUT,
  VAR_IN_OUT,
  VAR_EXTERNAL,
  VAR_GLOBAL,
  VAR_TEMP,
  VAR_INST,
  VAR,
  CONSTANT,
  RETAIN,
  NON_RETAIN,
  PERSISTENT,
  TYPE,
  STRUCT,
  ARRAY,
  OF,
  AT,
  TASK,
  WITH,
  ON,
  IF,
  THEN,
  ELSIF,
  ELSE,
  CASE,
  FOR,
  TO,
  BY,
  DO,
  WHILE,
  REPEAT,
  UNTIL,
  EXIT,
  CONTINUE,
  RETURN,
  TRUE,
  FALSE,
  AND,
  OR,
  XOR,
  NOT,
  MOD,
  REFERENCE_TO,
  REF_TO,
  POINTER,
  DREF,
  REF,
  NULL,
  __NEW,
  __DELETE,
  END_METHOD,
  ACTION,
  END_ACTION,
  END_INTERFACE,
  END_PROPERTY,
  END_GET,
  END_SET,
  METHOD,
  INTERFACE,
  EXTENDS,
  IMPLEMENTS,
  THIS,
  SUPER,
  PROPERTY,
  ABSTRACT,
  FINAL,
  OVERRIDE,
  PUBLIC,
  PRIVATE,
  PROTECTED,

  // Literals
  RealLiteral,
  IntegerLiteral,
  StringLiteral,
  WideStringLiteral,
  DirectAddress,

  // Single-character operators and punctuation
  Colon,
  Semicolon,
  Comma,
  Dot,
  LParen,
  RParen,
  LBracket,
  RBracket,
  Equal,
  Less,
  Greater,
  Plus,
  Minus,
  Star,
  Slash,
  Caret,
  Ampersand,

  // Identifier (last)
  Identifier,
];

/**
 * The STruC++ lexer instance.
 */
export const STLexer = new Lexer(allTokens);

/**
 * Token list for test files. Built programmatically from allTokens by
 * inserting test-specific keywords (TEST, END_TEST, ASSERT_*, MOCK*, etc.)
 * before the normal keywords section.
 *
 * Test keywords must NOT be in allTokens to avoid conflicting with user
 * identifiers named TEST in normal ST programs.
 */
export const allTestTokens = (() => {
  // Find where normal keywords start (first keyword is END_PROGRAM)
  const keywordIndex = allTokens.indexOf(END_PROGRAM);
  return [
    ...allTokens.slice(0, keywordIndex),
    // Test-specific keywords (higher priority than normal keywords)
    ...testKeywordTokens,
    ...allTokens.slice(keywordIndex),
  ];
})();

/**
 * The STruC++ test file lexer instance.
 * Uses allTestTokens which includes TEST/END_TEST/ASSERT_* tokens.
 */
export const TestLexer = new Lexer(allTestTokens);

/**
 * Check for unclosed block comments in source code.
 * Returns error info if an unclosed comment is found.
 */
function findUnclosedBlockComment(
  source: string,
): { line: number; column: number; offset: number } | null {
  let i = 0;
  let depth = 0;
  let commentStartOffset = -1;
  let commentStartLine = 1;
  let commentStartColumn = 1;
  let line = 1;
  let column = 1;

  while (i < source.length) {
    const char = source.charAt(i);
    const nextChar = source.charAt(i + 1);

    // Skip single-line comments (only outside block comments)
    if (char === "/" && nextChar === "/" && depth === 0) {
      while (i < source.length && source.charAt(i) !== "\n") {
        i++;
        column++;
      }
      // Don't advance past the newline - let the main loop handle it
      continue;
    }

    // Skip string literals, for the same reason single-line comments are
    // skipped: their contents are not code. `s : STRING := '(*';` is a valid
    // IEC declaration, and without this the `(*` inside the literal opened a
    // comment that never closed, so the whole compilation unit was rejected
    // with "Unclosed block comment" pointing at a line with no comment on it.
    // A doubled quote is IEC's escape for a literal quote and does not end the
    // string; neither does one written `$'`, which is the form `StringLiteral`
    // itself accepts. Missing that ended the string early, and from there every
    // quote in the file paired the wrong way: `'It$'s (*';` was reported as an
    // unclosed block comment, and a genuinely unclosed `(*` further down could
    // land inside a phantom string and lose its diagnostic altogether.
    if ((char === "'" || char === '"') && depth === 0) {
      const quote = char;
      i++;
      column++;
      while (i < source.length) {
        if (source.charAt(i) === "$") {
          // `$` escapes whatever follows it — `$'`, `$$`, `$R`, `$0D`. Only the
          // one character after it matters here: a hex escape's digits are
          // ordinary characters that end nothing.
          const escaped = source.charAt(i + 1);
          if (escaped === "\n") {
            line++;
            column = 1;
          } else {
            column += 2;
          }
          i += 2;
          continue;
        }
        if (source.charAt(i) === quote) {
          if (source.charAt(i + 1) === quote) {
            i += 2;
            column += 2;
            continue;
          }
          i++;
          column++;
          break;
        }
        if (source.charAt(i) === "\n") {
          line++;
          column = 1;
        } else {
          column++;
        }
        i++;
      }
      continue;
    }

    // Check for block comment start
    if (char === "(" && nextChar === "*") {
      if (depth === 0) {
        commentStartOffset = i;
        commentStartLine = line;
        commentStartColumn = column;
      }
      depth++;
      i += 2;
      column += 2;
      continue;
    }

    // Check for block comment end
    if (char === "*" && nextChar === ")") {
      if (depth > 0) {
        depth--;
      }
      i += 2;
      column += 2;
      continue;
    }

    // Handle newlines
    if (char === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }
    i++;
  }

  if (depth > 0) {
    return {
      line: commentStartLine,
      column: commentStartColumn,
      offset: commentStartOffset,
    };
  }

  return null;
}

/**
 * Uppercase ST source while preserving case inside string literals,
 * wide string literals, block comments, and line comments.
 * IEC 61131-3 is case-insensitive, so this normalizes identifiers/keywords.
 * The result has the source's length: a character whose upper case is longer
 * is kept as written.
 */
export function uppercaseSource(source: string): string {
  const len = source.length;
  const out: string[] = new Array<string>(len);
  let i = 0;

  // Helper to get char at position (always valid when i < len)
  const at = (pos: number): string => source.charAt(pos);

  while (i < len) {
    const ch = at(i);

    // Single-quoted string literal: preserve case
    if (ch === "'") {
      out[i] = ch;
      i++;
      while (i < len) {
        const sc = at(i);
        if (sc === "$" && i + 1 < len) {
          out[i] = sc;
          out[i + 1] = at(i + 1);
          i += 2;
          continue;
        }
        if (sc === "'" && i + 1 < len && at(i + 1) === "'") {
          out[i] = sc;
          out[i + 1] = "'";
          i += 2;
          continue;
        }
        out[i] = sc;
        if (sc === "'") {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // Double-quoted wide string literal: preserve case
    if (ch === '"') {
      out[i] = ch;
      i++;
      while (i < len) {
        const sc = at(i);
        if (sc === "$" && i + 1 < len) {
          out[i] = sc;
          out[i + 1] = at(i + 1);
          i += 2;
          continue;
        }
        out[i] = sc;
        if (sc === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // Block comment (* ... *): preserve case, nesting supported
    if (ch === "(" && i + 1 < len && at(i + 1) === "*") {
      let depth = 1;
      out[i] = ch;
      out[i + 1] = "*";
      i += 2;
      while (i < len && depth > 0) {
        const c = at(i);
        if (c === "(" && i + 1 < len && at(i + 1) === "*") {
          out[i] = c;
          out[i + 1] = "*";
          i += 2;
          depth++;
        } else if (c === "*" && i + 1 < len && at(i + 1) === ")") {
          out[i] = c;
          out[i + 1] = ")";
          i += 2;
          depth--;
        } else {
          out[i] = c;
          i++;
        }
      }
      continue;
    }

    // Line comment // ... : preserve case
    if (ch === "/" && i + 1 < len && at(i + 1) === "/") {
      while (i < len && at(i) !== "\n") {
        out[i] = at(i);
        i++;
      }
      continue;
    }

    // External code pragma {external ...}: uppercase the tag, preserve body
    if (ch === "{") {
      // Skip whitespace after {
      let probe = i + 1;
      while (probe < len && /\s/.test(at(probe))) probe++;
      const keyword = source.substring(probe, probe + 8);
      if (keyword.toLowerCase() === "external") {
        // Found {external ...} — preserve body as-is except uppercase the opening keyword
        out[i] = "{";
        i++;
        // Copy whitespace
        while (i < probe) {
          out[i] = at(i);
          i++;
        }
        // Uppercase "external"
        for (let k = 0; k < 8 && i < len; k++, i++) {
          out[i] = at(i).toUpperCase();
        }
        // Now preserve everything else until matching }, counting nested braces
        let depth = 1;
        while (i < len && depth > 0) {
          const pc = at(i);
          // Handle string literals inside external code
          if (pc === '"' || pc === "'") {
            out[i] = pc;
            i++;
            while (i < len && at(i) !== pc) {
              if (at(i) === "\\") {
                out[i] = at(i);
                i++;
              }
              if (i < len) {
                out[i] = at(i);
                i++;
              }
            }
            if (i < len) {
              out[i] = at(i);
              i++;
            }
            continue;
          }
          // Handle C++ line comments inside external code
          if (pc === "/" && i + 1 < len && at(i + 1) === "/") {
            while (i < len && at(i) !== "\n") {
              out[i] = at(i);
              i++;
            }
            continue;
          }
          // Handle C++ block comments inside external code
          if (pc === "/" && i + 1 < len && at(i + 1) === "*") {
            out[i] = at(i);
            out[i + 1] = at(i + 1);
            i += 2;
            while (i < len - 1) {
              if (at(i) === "*" && at(i + 1) === "/") {
                out[i] = at(i);
                out[i + 1] = at(i + 1);
                i += 2;
                break;
              }
              out[i] = at(i);
              i++;
            }
            continue;
          }
          if (pc === "{") depth++;
          else if (pc === "}") depth--;
          out[i] = at(i);
          i++;
        }
        continue;
      }
    }

    // Everything else: uppercase, unless that lengthens the character
    // ('ß' gives 'SS'), so offsets and columns stay those of the source.
    // A non-ASCII character never becomes ASCII ('ı' is not I).
    const upper = ch.toUpperCase();
    out[i] =
      upper.length === ch.length && (ch < "\u0080" || upper >= "\u0080")
        ? upper
        : ch;
    i++;
  }

  return out.join("");
}

/**
 * Pragma diagnostics on a lexer result, in place: a conditional-compilation
 * pragma is an error (ignoring it would compile every branch), and the
 * generic error at an unclosed `{` or a stray `}` gets a clear message.
 * Errors end up sorted by offset.
 *
 * @param result - The Chevrotain lexer result to amend
 * @param source - The original source, quoted in messages
 * @param lexed - The text that was lexed (`source` with keywords uppercased)
 */
function checkPragmas(
  result: ILexingResult,
  source: string,
  lexed: string,
): void {
  for (const err of result.errors) {
    const ch = lexed.charAt(err.offset);
    if (ch === "{" && err.message.startsWith("unexpected character")) {
      err.message = "Unterminated pragma: '{' has no closing '}'";
    } else if (ch === "}" && err.message.startsWith("unexpected character")) {
      err.message =
        "Unexpected '}' outside a pragma (pragmas do not nest; the first '}' ends one)";
    }
  }
  for (const tok of result.groups[PRAGMA_GROUP] ?? []) {
    const image = pragmaSourceText(tok, source);
    if (!isConditionalPragma(image)) continue;
    result.errors.push({
      offset: tok.startOffset,
      line: tok.startLine,
      column: tok.startColumn,
      length: image.length,
      message: `Conditional compilation pragmas are not supported: ${shortPragmaText(image)}`,
    });
  }
  result.errors.sort((a, b) => a.offset - b.offset);
}

/**
 * A pragma token's text as written in `source` (the lexer sees uppercased
 * text). Falls back to the token image if the offsets do not line up.
 *
 * @param tok - A {@link Pragma} token
 * @param source - The original source the token was lexed from
 */
export function pragmaSourceText(tok: IToken, source: string): string {
  const slice = source.substring(
    tok.startOffset,
    tok.startOffset + tok.image.length,
  );
  return slice.toUpperCase() === tok.image.toUpperCase() ? slice : tok.image;
}

/** Longest pragma text quoted in a diagnostic before it is shortened. */
const PRAGMA_TEXT_MAX = 60;

/**
 * A pragma's text for a diagnostic: whitespace runs collapsed, and cut to
 * {@link PRAGMA_TEXT_MAX} characters with `...` when longer.
 *
 * @param image - The pragma text, braces included
 */
export function shortPragmaText(image: string): string {
  const flat = image.replace(/\s+/g, " ");
  return flat.length <= PRAGMA_TEXT_MAX
    ? flat
    : `${flat.substring(0, PRAGMA_TEXT_MAX - 4)}...}`;
}

/**
 * The refusal of a character in a name, its code points listed. It is quoted
 * too when it shows (not only format, control, separator or mark characters).
 */
function nameLetterMessage(cluster: string): string {
  const chars = [...cluster];
  const points = chars
    .map(
      (c) =>
        `U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`,
    )
    .join(" ");
  const visible = chars.some(
    (c) => !/^[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{M}]$/u.test(c),
  );
  const shown = visible ? `'${cluster}' (${points})` : points;
  return `${shown} is not allowed in a name: identifiers use A–Z, digits and _`;
}

/** A combining mark or a zero-width joiner, kept with the character before it. */
const JOINS = /^[\p{M}\u200C\u200D]$/u;

/** Grapheme segmentation where the runtime has it. */
const GRAPHEMES =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : undefined;

/**
 * The characters of `text` from `start` to `end` grouped into user-perceived
 * characters (grapheme clusters): each cluster's offset and text.
 */
function clusters(
  text: string,
  start: number,
  end: number,
): Array<{ offset: number; text: string }> {
  if (GRAPHEMES !== undefined) {
    return [...GRAPHEMES.segment(text.slice(start, end))].map((g) => ({
      offset: start + g.index,
      text: g.segment,
    }));
  }
  const out: Array<{ offset: number; text: string }> = [];
  for (let k = start; k < end; ) {
    const ch = String.fromCodePoint(text.codePointAt(k) ?? 0);
    const last = out[out.length - 1];
    if (last !== undefined && JOINS.test(ch)) last.text += ch;
    else out.push({ offset: k, text: ch });
    k += ch.length;
  }
  return out;
}

/** A character a name refuses: non-ASCII, or a control character. */
function refused(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return code >= 0x7f || code < 0x20;
}

/** The refusals of one lexing pass, and the code-unit ranges they remove. */
interface Refusals {
  errors: ILexingError[];
  ranges: Array<[number, number]>;
}

/**
 * A name allows A–Z, digits and _ only. Every grapheme cluster of an
 * Identifier holding another character (non-ASCII, or a control) is refused
 * once, at its first character, quoted with its base (a mark glued to the
 * token before takes that token's last character); a character the lexer
 * skipped is refused the same way. Returns the refusals and the ranges of
 * the refused characters, which the second pass lexes without.
 */
function collectRefused(
  result: { tokens: IToken[]; errors: ILexingError[] },
  source: string,
): Refusals {
  const errors: ILexingError[] = [];
  const ranges: Array<[number, number]> = [];
  const refuseRange = (from: number, to: number): void => {
    for (let k = from; k < to; ) {
      const ch = String.fromCodePoint(source.codePointAt(k) ?? 0);
      if (refused(ch)) ranges.push([k, k + ch.length]);
      k += ch.length;
    }
  };
  for (const error of result.errors) {
    const ch = String.fromCodePoint(source.codePointAt(error.offset) ?? 0);
    if (error.offset < source.length && refused(ch) && !/^\s$/.test(ch)) {
      const cluster = clusters(source, error.offset, error.offset + ch.length);
      errors.push({
        ...error,
        message: nameLetterMessage(cluster[0]?.text ?? ch),
      });
      ranges.push([error.offset, error.offset + ch.length]);
    }
  }
  for (const token of result.tokens) {
    if (token.tokenType !== Identifier || /^\w*$/.test(token.image)) {
      continue;
    }
    const start = token.startOffset;
    const end = start + token.image.length;
    const startCol = token.startColumn ?? 0;
    // A mark at the start combines with the previous token's last character.
    const first = String.fromCodePoint(source.codePointAt(start) ?? 0);
    const before = start > 0 ? source.charAt(start - 1) : "";
    const back =
      JOINS.test(first) && before !== "" && !/\s/.test(before)
        ? before >= "\udc00" && before <= "\udfff" && start > 1
          ? 2
          : 1
        : 0;
    for (const c of clusters(source, start - back, end)) {
      if (![...c.text].some(refused)) continue;
      errors.push({
        offset: c.offset,
        line: token.startLine,
        column: startCol + (c.offset - start),
        length: c.text.length,
        message: nameLetterMessage(c.text),
      });
    }
    refuseRange(start, end);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  return { errors, ranges };
}

/**
 * Lexes `source` as if its refused characters were not there: a first pass
 * finds and refuses them, a second lexes the text without them, its tokens
 * and errors mapped back to the source's offsets, lines and columns.
 */
function lexWithoutRefused<R extends ILexingResult>(
  source: string,
  lexOnce: (text: string) => R,
): R {
  const first = lexOnce(source);
  const refusals = collectRefused(first, source);
  if (refusals.ranges.length === 0) return first;
  // The text without the refused characters; at[i] is the source offset of
  // its i-th code unit (at[length] the end).
  let text = "";
  const at: number[] = [];
  let k = 0;
  for (const [from, to] of refusals.ranges) {
    if (from < k) continue;
    text += source.slice(k, from);
    for (let i = k; i < from; i++) at.push(i);
    k = to;
  }
  text += source.slice(k);
  for (let i = k; i < source.length; i++) at.push(i);
  at.push(source.length);
  const lineStart: number[] = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 0x0a) lineStart.push(i + 1);
  }
  const column = (offset: number, line: number | undefined): number =>
    offset - (lineStart[(line ?? 1) - 1] ?? 0) + 1;
  const second = lexOnce(text);
  const move = (t: IToken): void => {
    const end = t.endOffset;
    t.startOffset = at[t.startOffset] ?? t.startOffset;
    t.startColumn = column(t.startOffset, t.startLine);
    if (end !== undefined) {
      t.endOffset = at[end] ?? end;
      t.endColumn = column(t.endOffset, t.endLine);
    }
  };
  for (const t of second.tokens) move(t);
  for (const group of Object.values(second.groups)) {
    for (const t of group) move(t);
  }
  for (const e of second.errors) {
    e.offset = at[e.offset] ?? e.offset;
    if (e.line !== undefined) e.column = column(e.offset, e.line);
  }
  second.errors.push(...refusals.errors);
  second.errors.sort((a, b) => a.offset - b.offset);
  return second;
}

/**
 * Tokenize ST source code.
 *
 * @param source - The ST source code to tokenize
 * @returns Lexer result with tokens and any lexing errors
 */
export function tokenize(source: string): ReturnType<typeof STLexer.tokenize> {
  return lexWithoutRefused(source, (text) => lexOnce(text, STLexer));
}

/** One lexing pass: upper-cased copy, unclosed comments, pragma checks. */
function lexOnce(
  source: string,
  lexer: typeof STLexer,
): ReturnType<typeof STLexer.tokenize> {
  // Normalize to uppercase for case-insensitive matching (preserves string/comment contents)
  const upperSource = uppercaseSource(source);

  // Check for unclosed block comments first
  const unclosedComment = findUnclosedBlockComment(upperSource);

  const result = lexer.tokenize(upperSource);

  if (unclosedComment) {
    result.errors.push({
      offset: unclosedComment.offset,
      line: unclosedComment.line,
      column: unclosedComment.column,
      length: 2,
      message: "Unclosed block comment",
    });
  }

  checkPragmas(result, source, upperSource);
  return result;
}

/**
 * Tokenize test file source code using the test lexer.
 * Identical to tokenize() but uses TestLexer (which recognizes TEST/ASSERT_* tokens).
 *
 * @param source - The test file source code to tokenize
 * @returns Lexer result with tokens and any lexing errors
 */
export function tokenizeTest(
  source: string,
): ReturnType<typeof TestLexer.tokenize> {
  return lexWithoutRefused(source, (text) => lexOnce(text, TestLexer));
}
