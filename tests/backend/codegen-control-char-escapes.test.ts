/**
 * Control characters and `$XX` escapes in string literals.
 *
 * A raw CR or LF copied into a C++ string literal is a line break to the C++
 * preprocessor: `\` + CR in the ST source spliced the next line onto the
 * literal and let the code after it escape the string. A `\x` escape is also
 * greedy (`'$41BC'` became one out-of-range char). `??/` is a trigraph for `\`
 * below C++17.
 *
 * `translateIECString` now writes every control character (below 0x20 and
 * 0x7F) and every `$XX` as a three-digit octal escape, a WSTRING code unit
 * above 0o777 as `\xHHHH` followed by a literal restart, `$"` in a WSTRING as
 * `\"`, and `?` as `\?`.
 */

import { describe, it, expect } from "vitest";
import { translateIECString } from "../../src/backend/codegen-utils.js";
import { compile } from "../../src/index.js";

describe("translateIECString: STRING", () => {
  it("escapes raw control characters as octal", () => {
    expect(translateIECString("a\rb")).toBe("a\\015b");
    expect(translateIECString("a\nb")).toBe("a\\012b");
    expect(translateIECString("a\tb")).toBe("a\\011b");
    expect(translateIECString("a\x7fb")).toBe("a\\177b");
    expect(translateIECString("a\x00b")).toBe("a\\000b");
  });

  it("never leaves a raw CR or LF in the output (backslash + CR splice)", () => {
    const out = translateIECString('a\\\r"; X := 1; //');
    expect(out).not.toMatch(/[\r\n]/);
    expect(out).toBe('a\\\\\\015\\"; X := 1; //');
  });

  it("writes $XX as a non-greedy octal escape", () => {
    expect(translateIECString("$41BC")).toBe("\\101BC");
    expect(translateIECString("$0D$0a7")).toBe("\\015\\0127");
    expect(translateIECString("$0022x")).toBe("\\00022x");
    expect(translateIECString("$4E2D1")).toBe("\\1162D1");
  });

  it("escapes ? so a ??/ trigraph cannot form", () => {
    expect(translateIECString("?")).toBe("\\?");
    expect(translateIECString("??/")).toBe("\\?\\?/");
    expect(translateIECString("a??/b")).toBe("a\\?\\?/b");
  });

  it("keeps the existing named escapes", () => {
    expect(translateIECString("$N$L$R$T$P$$$'")).toBe("\\n\\n\\r\\t\\f$'");
  });
});

describe("translateIECString: WSTRING", () => {
  it("escapes raw control characters as octal", () => {
    expect(translateIECString("a\rb", true)).toBe("a\\015b");
    expect(translateIECString("a\x7fb", true)).toBe("a\\177b");
  });

  it("writes $XXXX up to 0o777 as octal", () => {
    expect(translateIECString("$00e9", true)).toBe("\\351");
    expect(translateIECString("$0041BC", true)).toBe("\\101BC");
    expect(translateIECString("$0022x", true)).toBe("\\042x");
  });

  it("writes $XXXX above 0o777 as \\xHHHH and restarts the literal", () => {
    expect(translateIECString("$41BC", true)).toBe('\\x41bc" u"');
    expect(translateIECString("$4E2D1", true)).toBe('\\x4e2d" u"1');
    expect(translateIECString("$FFFFx", true)).toBe('\\xffff" u"x');
  });

  it("passes surrogate code units through as \\x escapes", () => {
    expect(translateIECString("$D800", true)).toBe('\\xd800" u"');
    expect(translateIECString("$DFFF", true)).toBe('\\xdfff" u"');
    expect(translateIECString("$D83D$DE00", true)).toBe(
      '\\xd83d" u"\\xde00" u"',
    );
  });

  it('turns $" into an escaped double quote', () => {
    expect(translateIECString('$"q', true)).toBe('\\"q');
  });

  it("escapes ?", () => {
    expect(translateIECString("??/", true)).toBe("\\?\\?/");
  });
});

describe("control-character escapes through compile()", () => {
  it("emits the escaped literals in the generated C++", () => {
    const result = compile(`
      PROGRAM Main
        VAR s : STRING := '$41BC'; w : WSTRING := "$D800a"; END_VAR
      END_PROGRAM
    `);
    expect(result.success).toBe(true);
    expect(result.cppCode).toContain('"\\101BC"');
    expect(result.cppCode).toContain('u"\\xd800" u"a"');
  });
});
