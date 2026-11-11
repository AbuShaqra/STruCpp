/**
 * Defines of one file: `defined()` and `hasvalue()` see them (a file define
 * over a project define of the same name, a `{define}` in the file over
 * both); `project_defined()` does not. Through the API, as `filePragmaDefines`
 * (primary source) and `additionalSources[].pragmaDefines`.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import { applyConditionalPragmas } from "../../src/frontend/conditional-pragmas.js";
import { tokenize } from "../../src/frontend/lexer.js";

const text = (
  src: string,
  project: Record<string, string>,
  file: Record<string, string>,
): string =>
  applyConditionalPragmas(
    src,
    new Map(Object.entries(project)),
    tokenize,
    new Map(Object.entries(file)),
  )
    .text.replace(/\s+/g, " ")
    .trim();

describe("file defines in conditional pragmas", () => {
  it("defined() sees them, project_defined() does not", () => {
    const src =
      "{IF defined(F)} a {ELSE} b {END_IF} {IF project_defined(F)} c {ELSE} d {END_IF}";
    expect(text(src, {}, { F: "" })).toBe("a d");
    expect(text(src, { F: "" }, {})).toBe("a c");
  });

  it("hasvalue(): the file value wins over the project's, a {define} over both", () => {
    const src = "{IF hasvalue(V, '2')} two {ELSE} other {END_IF}";
    expect(text(src, { V: "1" }, { V: "2" })).toBe("two");
    expect(text(src, { V: "2" }, { V: "1" })).toBe("other");
    expect(text(`{define V '2'} ${src}`, { V: "1" }, { V: "1" })).toBe("two");
  });

  it("applies per source through the API", () => {
    const main =
      "PROGRAM Main VAR a : INT; END_VAR {IF defined(F)} a := 1; {ELSE} a := 2; {END_IF} END_PROGRAM\n";
    const other =
      "FUNCTION Other : INT {IF defined(F)} Other := 1; {ELSE} Other := 2; {END_IF} END_FUNCTION\n";
    const r = compile(main, {
      headerFileName: "generated.hpp",
      features: ["+conditional_pragmas"],
      filePragmaDefines: { F: "" },
      additionalSources: [{ source: other, fileName: "other.st" }],
    });
    expect(r.errors).toEqual([]);
    expect(r.cppCode).toContain("A = 1;");
    expect(r.cppCode).toContain("OTHER_result = 2;");
    const r2 = compile(main, {
      headerFileName: "generated.hpp",
      features: ["+conditional_pragmas"],
      additionalSources: [
        { source: other, fileName: "other.st", pragmaDefines: { F: "" } },
      ],
    });
    expect(r2.cppCode).toContain("A = 2;");
    expect(r2.cppCode).toContain("OTHER_result = 1;");
  });

  it("refuses a bad file define name", () => {
    expect(() =>
      compile("PROGRAM P END_PROGRAM", { filePragmaDefines: { "1x": "" } }),
    ).toThrow('pragmaDefines key "1x" is not an identifier');
  });
});
