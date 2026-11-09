/**
 * Method calls through a member chain end to end through g++: FB in FB, FB in
 * a STRUCT field, FB in an ARRAY, through THIS and SUPER,
 * and through a global, with positional, named and output arguments. Also pins
 * the single-dot `inst.M()` C++ so the chain path does not change it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const TYPES = `FUNCTION_BLOCK FB_Counter
VAR n : INT; END_VAR
METHOD Add : INT
VAR_INPUT k : INT; END_VAR
  n := n + k;
  Add := n;
END_METHOD
METHOD AddTwice : INT
VAR_INPUT k : INT; END_VAR
VAR_OUTPUT twice : INT; END_VAR
  n := n + k;
  twice := n * 2;
  AddTwice := n;
END_METHOD
METHOD Reset
  n := 0;
END_METHOD
END_FUNCTION_BLOCK

FUNCTION_BLOCK FB_Tens EXTENDS FB_Counter
METHOD OVERRIDE Add : INT
VAR_INPUT k : INT; END_VAR
  n := n + 10 * k;
  Add := n;
END_METHOD
END_FUNCTION_BLOCK

TYPE ST_Slot : STRUCT
  c : FB_Counter;
  bank : ARRAY[0..1] OF FB_Counter;
END_STRUCT; END_TYPE

FUNCTION_BLOCK FB_Cell
VAR
  c : FB_Counter;
  t : FB_Tens;
  slot : ST_Slot;
  row : ARRAY[1..3] OF FB_Counter;
END_VAR
METHOD Bump : INT
  THIS.slot.c.Add(1);
  Bump := THIS.slot.c.Add(k := 1);
END_METHOD
END_FUNCTION_BLOCK

FUNCTION_BLOCK FB_CellX EXTENDS FB_Cell
METHOD BaseBump : INT
  BaseBump := SUPER.c.Add(5);
END_METHOD
END_FUNCTION_BLOCK

FUNCTION_BLOCK FB_Line
VAR cell : FB_CellX; END_VAR
END_FUNCTION_BLOCK

VAR_GLOBAL
  gLine : FB_Line;
END_VAR
`;

const MAIN = `PROGRAM MAIN
VAR_EXTERNAL gLine : FB_Line; END_VAR
VAR
  line : FB_Line;
  slot : ST_Slot;
  cells : ARRAY[1..2] OF FB_Cell;
  i : INT := 2;
  a : INT; b : INT; tw : INT; c : INT; d : INT; e : INT; f : INT; g : INT; h : INT;
END_VAR
  line.cell.c.Add(3);
  a := line.cell.c.Add(4);
  b := line.cell.t.Add(k := 2) + line.cell.row[1].AddTwice(k := 3, twice => tw);
  slot.c.Add(7);
  c := slot.c.Add(1) + slot.bank[1].Add(9);
  cells[i].row[3].Add(6);
  d := cells[2].row[3].Add(1);
  e := line.cell.Bump();
  f := line.cell.BaseBump();
  gLine.cell.slot.bank[0].Add(11);
  g := gLine.cell.slot.bank[0].Add(k := 1);
  line.cell.c.Reset();
  h := line.cell.c.Add(2);
END_PROGRAM
`;

describeIfGpp("member-chain method calls end to end", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-memberchain-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function run(
    source: string,
    mainBody: string,
    name: string,
    options: Parameters<typeof compile>[1] = {},
  ): string {
    const result = compile(source, {
      headerFileName: "generated.hpp",
      ...options,
    });
    expect(result.errors.map((e) => `${e.line}: ${e.message}`)).toEqual([]);
    return compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: name,
      mainCode: `#include <iostream>\nint main() {\n using namespace strucpp;\n${mainBody}\n return 0;\n}\n`,
    });
  }

  const FIELDS = ["A", "B", "TW", "C", "D", "E", "F", "G", "H"];
  const PRINT = ` Program_MAIN p;\n p.run();\n std::cout << ${FIELDS.map((v) => `p.${v}.get()`).join(' << " " << ')} << std::endl;`;
  // a: 3+4; b: 10*2 + 3 (twice 6); c: 7+1 + 9; d: 6+1; e: THIS.slot.c twice
  // -> 2; f: SUPER.c after line.cell.c reached 7 -> 12; g: 11+1; h: reset, +2.
  const EXPECTED = "7 23 6 17 7 2 12 12 2";

  it("runs under iec-3", () => {
    expect(
      run(TYPES + MAIN, PRINT, "memberchain_iec", { dialect: "iec-3" }),
    ).toBe(EXPECTED);
  });

  it("runs with no dialect flag", () => {
    expect(run(TYPES + MAIN, PRINT, "memberchain_default")).toBe(EXPECTED);
  });

  it("single-dot inst.M() C++ is unchanged by the chain path", () => {
    const counter = TYPES.slice(0, TYPES.indexOf("FUNCTION_BLOCK FB_Tens"));
    const src = `${counter}PROGRAM MAIN
VAR c : FB_Counter; x : INT; tw : INT; END_VAR
  c.Add(2);
  x := c.AddTwice(k := 3, twice => tw);
  c.Reset();
END_PROGRAM
`;
    const cpp = compile(src, { headerFileName: "generated.hpp" }).cppCode;
    expect(cpp).toContain(
      "    C.ADD(2);\n    X = C.ADDTWICE(3, TW);\n    C.RESET();\n",
    );
    expect(
      run(
        src,
        ' Program_MAIN p;\n p.run();\n std::cout << p.X.get() << " " << p.TW.get() << std::endl;',
        "memberchain_single",
      ),
    ).toBe("5 10");
  });
});
