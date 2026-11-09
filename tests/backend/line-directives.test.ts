/**
 * STruC++ Phase 8.1 — #line Directive Emission Tests
 *
 * Verifies that `lineDirectives: true` emits `#line N "file.st"` directives
 * in the generated C++ code, and that `lineDirectives: false` does not.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { compile } from '../../src/index.js';
import {
  hasGpp,
  createPCH,
  compileAndRunStandalone,
} from '../integration/test-helpers.js';

/** Helper: compile with lineDirectives enabled */
function compileWithLineDirectives(source: string, fileName = 'test.st') {
  return compile(source, {
    debug: false,
    lineMapping: true,
    lineDirectives: true,
    optimizationLevel: 0,
    fileName,
  });
}

/** Helper: compile without lineDirectives */
function compileWithoutLineDirectives(source: string) {
  return compile(source, {
    debug: false,
    lineMapping: true,
    lineDirectives: false,
    optimizationLevel: 0,
  });
}

describe('Phase 8.1 — #line Directive Emission', () => {
  describe('basic emission', () => {
    it('should emit #line directives in cppCode when lineDirectives is true', () => {
      const source = `
PROGRAM Test
  VAR x : INT; END_VAR
  x := 42;
END_PROGRAM
      `;
      const result = compileWithLineDirectives(source);
      expect(result.success).toBe(true);
      expect(result.cppCode).toContain('#line');
      expect(result.cppCode).toContain('"test.st"');
    });

    it('should NOT emit #line directives when lineDirectives is false', () => {
      const source = `
PROGRAM Test
  VAR x : INT; END_VAR
  x := 42;
END_PROGRAM
      `;
      const result = compileWithoutLineDirectives(source);
      expect(result.success).toBe(true);
      expect(result.cppCode).not.toContain('#line');
    });

    it('should use the provided fileName in #line directives', () => {
      const source = `
PROGRAM Test
  VAR x : INT; END_VAR
  x := 42;
END_PROGRAM
      `;
      const result = compileWithLineDirectives(source, 'my_program.st');
      expect(result.success).toBe(true);
      expect(result.cppCode).toContain('"my_program.st"');
    });
  });

  describe('program statements', () => {
    it('should emit #line before assignment statements', () => {
      const source = `
PROGRAM Test
  VAR x : INT; END_VAR
  x := 42;
END_PROGRAM
      `;
      const result = compileWithLineDirectives(source);
      expect(result.success).toBe(true);

      const lines = result.cppCode.split('\n');
      // Find the assignment line
      const assignIdx = lines.findIndex(l => l.includes('X = 42;'));
      expect(assignIdx).toBeGreaterThan(0);

      // There should be a #line directive before it
      const precedingLines = lines.slice(Math.max(0, assignIdx - 3), assignIdx);
      const hasLineDirective = precedingLines.some(l => l.includes('#line'));
      expect(hasLineDirective).toBe(true);
    });

    it('should emit #line for IF/ELSIF/ELSE/END_IF', () => {
      const source = `
PROGRAM Test
  VAR x : INT; y : INT; END_VAR
  IF x > 0 THEN
    y := 1;
  ELSIF x < 0 THEN
    y := -1;
  ELSE
    y := 0;
  END_IF
END_PROGRAM
      `;
      const result = compileWithLineDirectives(source);
      expect(result.success).toBe(true);

      const lines = result.cppCode.split('\n');
      // Count #line directives — should have several (if, elsif, else, end_if, assignments, etc.)
      const lineDirectives = lines.filter(l => l.trim().startsWith('#line'));
      expect(lineDirectives.length).toBeGreaterThanOrEqual(4);
    });

    it('should emit #line for FOR/WHILE/REPEAT loops', () => {
      const source = `
PROGRAM Test
  VAR i : INT; sum : INT; END_VAR
  FOR i := 1 TO 10 DO
    sum := sum + i;
  END_FOR
  WHILE sum > 0 DO
    sum := sum - 1;
  END_WHILE
  REPEAT
    sum := sum + 1;
  UNTIL sum > 100
  END_REPEAT
END_PROGRAM
      `;
      const result = compileWithLineDirectives(source);
      expect(result.success).toBe(true);

      const lines = result.cppCode.split('\n');
      const lineDirectives = lines.filter(l => l.trim().startsWith('#line'));
      // Each loop has at least start + closing + body statements
      expect(lineDirectives.length).toBeGreaterThanOrEqual(6);
    });

    it('should emit #line for CASE statement', () => {
      const source = `
PROGRAM Test
  VAR x : INT; y : INT; END_VAR
  CASE x OF
    1: y := 10;
    2: y := 20;
  END_CASE
END_PROGRAM
      `;
      const result = compileWithLineDirectives(source);
      expect(result.success).toBe(true);

      const lines = result.cppCode.split('\n');
      const lineDirectives = lines.filter(l => l.trim().startsWith('#line'));
      expect(lineDirectives.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('header line directives', () => {
    it('should emit #line in header for PROGRAM class declaration', () => {
      const source = `
PROGRAM Test
  VAR x : INT; END_VAR
  x := 42;
END_PROGRAM
      `;
      const result = compileWithLineDirectives(source);
      expect(result.success).toBe(true);
      expect(result.headerCode).toContain('#line');
      expect(result.headerCode).toContain('"test.st"');
    });

    it('should NOT emit #line in header when lineDirectives is false', () => {
      const source = `
PROGRAM Test
  VAR x : INT; END_VAR
  x := 42;
END_PROGRAM
      `;
      const result = compileWithoutLineDirectives(source);
      expect(result.success).toBe(true);
      expect(result.headerCode).not.toContain('#line');
    });
  });

  describe('function block declarations', () => {
    it('should emit #line for FB class declaration in header', () => {
      const source = `
FUNCTION_BLOCK MyFB
  VAR_INPUT
    in1 : INT;
  END_VAR
  VAR_OUTPUT
    out1 : INT;
  END_VAR
  out1 := in1 * 2;
END_FUNCTION_BLOCK
PROGRAM Test
  VAR fb : MyFB; END_VAR
  fb();
END_PROGRAM
      `;
      const result = compileWithLineDirectives(source);
      expect(result.success).toBe(true);

      // Header should have #line for FB class declaration (not forward decl)
      const headerLines = result.headerCode.split('\n');
      const classIdx = headerLines.findIndex(l => l.includes('class MYFB') && l.includes('{'));
      expect(classIdx).toBeGreaterThan(0);
      const precedingHeader = headerLines.slice(Math.max(0, classIdx - 3), classIdx);
      expect(precedingHeader.some(l => l.includes('#line'))).toBe(true);

      // CPP should have #line for FB operator() implementation
      expect(result.cppCode).toContain('#line');
    });

    it('should emit #line for FB member variable declarations', () => {
      const source = `
FUNCTION_BLOCK MyFB
  VAR_INPUT
    in1 : INT;
  END_VAR
  in1 := 0;
END_FUNCTION_BLOCK
PROGRAM Test
  VAR fb : MyFB; END_VAR
  fb();
END_PROGRAM
      `;
      const result = compileWithLineDirectives(source);
      expect(result.success).toBe(true);

      // Header should have #line before member variable declarations
      const headerLines = result.headerCode.split('\n');
      const memberIdx = headerLines.findIndex(l => l.includes('IEC_INT IN1;'));
      expect(memberIdx).toBeGreaterThan(0);
      const precedingHeader = headerLines.slice(Math.max(0, memberIdx - 3), memberIdx);
      expect(precedingHeader.some(l => l.includes('#line'))).toBe(true);
    });
  });

  describe('function declarations', () => {
    it('should emit #line for function declaration in header', () => {
      const source = `
FUNCTION AddTwo : INT
  VAR_INPUT
    a : INT;
    b : INT;
  END_VAR
  AddTwo := a + b;
END_FUNCTION
PROGRAM Test
  VAR result : INT; END_VAR
  result := AddTwo(1, 2);
END_PROGRAM
      `;
      const result = compileWithLineDirectives(source);
      expect(result.success).toBe(true);

      // Header should contain #line before function declaration
      const headerLines = result.headerCode.split('\n');
      const funcDeclIdx = headerLines.findIndex(l => l.includes('ADDTWO('));
      expect(funcDeclIdx).toBeGreaterThan(0);
      const precedingHeader = headerLines.slice(Math.max(0, funcDeclIdx - 3), funcDeclIdx);
      expect(precedingHeader.some(l => l.includes('#line'))).toBe(true);

      // CPP should contain #line before function implementation
      const cppLines = result.cppCode.split('\n');
      const funcImplIdx = cppLines.findIndex(l => l.includes('ADDTWO(') && l.includes('{'));
      expect(funcImplIdx).toBeGreaterThan(0);
      const precedingCpp = cppLines.slice(Math.max(0, funcImplIdx - 3), funcImplIdx);
      expect(precedingCpp.some(l => l.includes('#line'))).toBe(true);
    });
  });

  describe('interface declarations', () => {
    it('should emit #line for interface declaration in header', () => {
      const source = `
INTERFACE IMovable
  METHOD Move : BOOL
    VAR_INPUT
      distance : INT;
    END_VAR
  END_METHOD
END_INTERFACE

FUNCTION_BLOCK Robot IMPLEMENTS IMovable
  VAR
    position : INT;
  END_VAR

  METHOD Move : BOOL
    VAR_INPUT
      distance : INT;
    END_VAR
    position := position + distance;
    Move := TRUE;
  END_METHOD
END_FUNCTION_BLOCK

PROGRAM Test
  VAR r : Robot; END_VAR
  r();
END_PROGRAM
      `;
      const result = compileWithLineDirectives(source);
      expect(result.success).toBe(true);

      // Header should have #line for interface class declaration (not forward decl)
      const headerLines = result.headerCode.split('\n');
      const ifaceIdx = headerLines.findIndex(l => l.includes('class IMOVABLE') && l.includes('{'));
      expect(ifaceIdx).toBeGreaterThan(0);
      const precedingHeader = headerLines.slice(Math.max(0, ifaceIdx - 3), ifaceIdx);
      expect(precedingHeader.some(l => l.includes('#line'))).toBe(true);
    });
  });

  describe('method implementations', () => {
    it('should emit #line for method implementation', () => {
      const source = `
FUNCTION_BLOCK Counter
  VAR
    count : INT;
  END_VAR

  METHOD Increment : INT
    count := count + 1;
    Increment := count;
  END_METHOD
END_FUNCTION_BLOCK

PROGRAM Test
  VAR c : Counter; END_VAR
  c();
END_PROGRAM
      `;
      const result = compileWithLineDirectives(source);
      expect(result.success).toBe(true);

      // CPP should have #line before method implementation
      const cppLines = result.cppCode.split('\n');
      const methodIdx = cppLines.findIndex(l => l.includes('COUNTER::INCREMENT('));
      expect(methodIdx).toBeGreaterThan(0);
      const precedingCpp = cppLines.slice(Math.max(0, methodIdx - 3), methodIdx);
      expect(precedingCpp.some(l => l.includes('#line'))).toBe(true);
    });
  });

  describe('line map population', () => {
    it('should populate lineMap even without lineDirectives', () => {
      const source = `
PROGRAM Test
  VAR x : INT; END_VAR
  x := 42;
END_PROGRAM
      `;
      const result = compile(source, {
        debug: false,
        lineMapping: true,
        lineDirectives: false,
        optimizationLevel: 0,
      });
      expect(result.success).toBe(true);
      expect(result.lineMap.size).toBeGreaterThan(0);
    });

    it('should populate lineMap and headerLineMap with lineDirectives', () => {
      const source = `
PROGRAM Test
  VAR x : INT; END_VAR
  x := 42;
END_PROGRAM
      `;
      const result = compileWithLineDirectives(source);
      expect(result.success).toBe(true);
      expect(result.lineMap.size).toBeGreaterThan(0);
      expect(result.headerLineMap.size).toBeGreaterThan(0);
    });

    it('should map FB declaration line to header line map', () => {
      const source = `
FUNCTION_BLOCK MyFB
  VAR_INPUT
    val : INT;
  END_VAR
  val := val + 1;
END_FUNCTION_BLOCK
PROGRAM Test
  VAR fb : MyFB; END_VAR
  fb();
END_PROGRAM
      `;
      const result = compileWithLineDirectives(source);
      expect(result.success).toBe(true);
      // FB declaration at line 2 should be in header line map
      expect(result.headerLineMap.has(2)).toBe(true);
    });
  });

  describe('#line directive format', () => {
    it('should use correct #line N "filename" format', () => {
      const source = `
PROGRAM Test
  VAR x : INT; END_VAR
  x := 42;
END_PROGRAM
      `;
      const result = compileWithLineDirectives(source, 'myfile.st');
      expect(result.success).toBe(true);

      const lines = result.cppCode.split('\n');
      // The resets to the generated file after each body are pinned in
      // '#line reset after each body' below.
      const lineDirectives = lines.filter(
        l => l.trim().startsWith('#line') && !l.includes('"generated.cpp"'),
      );
      expect(lineDirectives.length).toBeGreaterThan(0);

      // Each #line directive should match the format: #line N "filename"
      for (const directive of lineDirectives) {
        expect(directive.trim()).toMatch(/^#line \d+ "myfile\.st"$/);
      }
    });
  });
});

/**
 * After each generated body, a `#line <n> "<generated file>"` hands the lines
 * that follow back to the generated file, so generated code after a body (the
 * next POU's constructor, the configuration) is not attributed to the last ST
 * line. `<n>` is the physical line after the directive in the file as written.
 */
describe('#line reset after each body', () => {
  const FIXTURES = resolve(__dirname, '../fixtures/line-directives');
  const SAMPLE = readFileSync(join(FIXTURES, 'sample.st'), 'utf-8');
  const ST_OR_RESET = /^#line (\d+) "([^"]+)"$/;

  function compileSample(extra: Record<string, unknown> = {}) {
    const result = compile(SAMPLE, {
      debug: false,
      lineMapping: true,
      lineDirectives: true,
      optimizationLevel: 0,
      fileName: 'test.st',
      headerFileName: 'out.hpp',
      cppFileName: 'out.cpp',
      ...extra,
    });
    expect(result.errors.map((e) => e.message)).toEqual([]);
    return result;
  }

  /** Every `#line N "<file>"` in `code` with its 0-based index. */
  function resets(code: string, file: string): Array<{ index: number; n: number }> {
    const found: Array<{ index: number; n: number }> = [];
    code.split('\n').forEach((line, index) => {
      const m = ST_OR_RESET.exec(line);
      if (m && m[2] === file) found.push({ index, n: Number(m[1]) });
    });
    return found;
  }

  /** The file named by the nearest `#line` above the first line matching `re`. */
  function nearestDirectiveFile(code: string, re: RegExp): string | undefined {
    const lines = code.split('\n');
    const at = lines.findIndex((l) => re.test(l));
    expect(at).toBeGreaterThanOrEqual(0);
    for (let i = at - 1; i >= 0; i--) {
      const m = ST_OR_RESET.exec(lines[i]!);
      if (m) return m[2];
    }
    return undefined;
  }

  it('every reset directive in the cpp names out.cpp and its number equals its own physical line + 1', () => {
    const result = compileSample();
    const found = resets(result.cppCode, 'out.cpp');
    // run() of the program, the FB body, the FB method, the function
    expect(found.length).toBeGreaterThanOrEqual(4);
    for (const { index, n } of found) {
      // index is 0-based: the directive sits on physical line index + 1
      expect(n).toBe(index + 2);
    }
    // only the ST file and the generated file are named
    for (const line of result.cppCode.split('\n')) {
      const m = ST_OR_RESET.exec(line);
      if (m) expect(['test.st', 'out.cpp']).toContain(m[2]);
    }
  });

  it('every reset in each per-TU cppFiles entry names that entry and its own line + 1 there', () => {
    const result = compileSample();
    expect(result.cppFiles.length).toBeGreaterThan(1);
    let total = 0;
    for (const file of result.cppFiles) {
      file.content.split('\n').forEach((line, index) => {
        const m = ST_OR_RESET.exec(line);
        if (!m) return;
        // only the ST file and this entry are named
        expect(['test.st', file.name]).toContain(m[2]);
        if (m[2] === file.name) {
          expect(Number(m[1])).toBe(index + 2);
          total++;
        }
      });
      expect(file.content).not.toContain('\u0000');
    }
    // run() of the program, the FB body, the FB method, the function
    expect(total).toBe(resets(result.cppCode, 'out.cpp').length);
    expect(total).toBeGreaterThanOrEqual(4);
    // a per-TU file never names the concatenated file
    for (const file of result.cppFiles) {
      expect(file.content).not.toContain('"out.cpp"');
    }
  });

  it('a reset follows the closing brace of each body', () => {
    const lines = compileSample().cppCode.split('\n');
    for (const sig of [
      /^void Program_MAIN::run\(\) \{$/,
      /^void FB_X::operator\(\)\(\) \{$/,
      /^IEC_INT FB_X::BUMP\(\) \{$/,
      /^IEC_INT ADDONE\(/,
    ]) {
      const start = lines.findIndex((l) => sig.test(l));
      expect(start).toBeGreaterThanOrEqual(0);
      const close = lines.findIndex((l, i) => i > start && l === '}');
      expect(lines[close + 1]).toBe(`#line ${close + 3} "out.cpp"`);
    }
  });

  it('the FB constructor after a program carries no ST line', () => {
    const result = compileSample();
    expect(nearestDirectiveFile(result.cppCode, /^FB_X::FB_X\(\)/)).toBe(
      'out.cpp',
    );
    expect(
      nearestDirectiveFile(result.cppCode, /^void FB_X::operator\(\)\(\)/),
    ).toBe('test.st');
  });

  it('the same in the header for out.hpp', () => {
    const result = compileSample();
    const found = resets(result.headerCode, 'out.hpp');
    // FB_X, Program_MAIN, ADDONE's declaration
    expect(found.length).toBeGreaterThanOrEqual(3);
    for (const { index, n } of found) {
      expect(n).toBe(index + 2);
    }
    expect(
      nearestDirectiveFile(result.headerCode, /^class Configuration_CFG :/),
    ).toBe('out.hpp');
    expect(nearestDirectiveFile(result.headerCode, /^class Program_MAIN :/)).toBe(
      'test.st',
    );
    for (const line of result.headerCode.split('\n')) {
      const m = ST_OR_RESET.exec(line);
      if (m) expect(['test.st', 'out.hpp']).toContain(m[2]);
    }
  });

  it('names generated.cpp when no cppFileName is given', () => {
    const result = compileSample({ cppFileName: undefined });
    expect(resets(result.cppCode, 'generated.cpp').length).toBeGreaterThan(0);
    expect(resets(result.cppCode, 'out.cpp')).toEqual([]);
  });

  it('with directives off, nothing changes', () => {
    const result = compileSample({ lineDirectives: false });
    expect(result.cppCode).toBe(
      readFileSync(join(FIXTURES, 'sample.acc1af2.cpp.txt'), 'utf-8'),
    );
    expect(result.headerCode).toBe(
      readFileSync(join(FIXTURES, 'sample.acc1af2.hpp.txt'), 'utf-8'),
    );
  });

  it('CLI: -o program.cpp --line-directives resets to program.cpp and program.hpp', () => {
    const cli = resolve(__dirname, '../../dist/node/cli.js');
    const dir = mkdtempSync(join(tmpdir(), 'strucpp-line-reset-'));
    try {
      writeFileSync(join(dir, 'sample.st'), SAMPLE);
      execFileSync(
        'node',
        [cli, join(dir, 'sample.st'), '-o', join(dir, 'program.cpp'), '--line-directives'],
        { encoding: 'utf-8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const cpp = readFileSync(join(dir, 'program.cpp'), 'utf-8');
      const hpp = readFileSync(join(dir, 'program.hpp'), 'utf-8');
      const cppResets = resets(cpp, 'program.cpp');
      const hppResets = resets(hpp, 'program.hpp');
      expect(cppResets.length).toBeGreaterThanOrEqual(4);
      expect(hppResets.length).toBeGreaterThanOrEqual(3);
      for (const { index, n } of [...cppResets, ...hppResets]) {
        expect(n).toBe(index + 2);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  (hasGpp ? it : it.skip)('the generated code with resets builds and runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'strucpp-line-reset-gpp-'));
    try {
      const pch = createPCH(dir);
      const result = compileSample({ headerFileName: 'generated.hpp' });
      const out = compileAndRunStandalone({
        tempDir: dir,
        pchPath: pch,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: 'line_reset',
        mainCode:
          '#include <iostream>\nint main() {\n using namespace strucpp;\n Program_MAIN p;\n p.run();\n p.run();\n std::cout << p.X.get() << std::endl;\n return 0;\n}\n',
      });
      // run 1: fb() 0 -> 1, Bump 1 + 2 = 3; run 2: fb() 3 -> 4, Bump 4 + 2 = 6
      expect(out).toBe('6');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
