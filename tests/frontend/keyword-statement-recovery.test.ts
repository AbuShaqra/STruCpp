/**
 * A statement keyword written as an assignment target (`IF := 1;`) leaves
 * parts the parser cannot recover: the analysis reports the parse error and
 * does not crash.
 */
import { describe, it, expect } from "vitest";
import { analyze, compile } from "../../src/index.js";

const wrap = (stmt: string): string =>
  `PROGRAM P\nVAR x : INT; END_VAR\n${stmt}\nEND_PROGRAM\n`;
const messages = (src: string): string[] =>
  analyze(src).errors.map((e) => `${e.line}:${e.column}: ${e.message}`);

describe("a keyword written as an assignment target", () => {
  it("reports the parse error without crashing", () => {
    expect(messages(wrap("IF := 1;"))).toEqual([
      "3:4: Unexpected `:=` after `IF` while parsing an expression.",
    ]);
    expect(messages(wrap("WHILE := 1;"))).toEqual([
      "3:7: Unexpected `:=` after `WHILE` while parsing an expression.",
    ]);
    expect(messages(wrap("CASE := 1;"))).toEqual([
      "3:6: Unexpected `:=` after `CASE` while parsing an expression.",
    ]);
    expect(compile(wrap("IF := 1;")).errors.map((e) => e.message)).toEqual([
      "Unexpected `:=` after `IF` while parsing an expression.",
    ]);
  });

  it("names no empty variable after a FOR it could not read", () => {
    expect(messages(wrap("FOR := 1;"))).toEqual([
      "3:5: Expected `Identifier`, found `:=`.",
      "3:9: Expected `TO`, found `;`.",
    ]);
  });
});
