/**
 * A STRUCT field, an ARRAY element or a file-level VAR_GLOBAL whose type is a
 * function block (D3). The C++ needs the FB class complete before the struct or
 * the global that holds it by value, so such "late" types and globals follow
 * the FB classes (and the library FB classes) in the header. A CONFIGURATION
 * VAR_GLOBAL that would hold an FB is refused at its line instead. Ends in g++
 * so the result is the proof.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { compile } from "../../src/index.js";
import { loadStlibFromFile } from "../../src/node/library-loader.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const IEC_STDLIB_PATH = path.resolve(
  __dirname,
  "../../libs/iec-standard-fb.stlib",
);
const iecStdlib = fs.existsSync(IEC_STDLIB_PATH)
  ? loadStlibFromFile(IEC_STDLIB_PATH)
  : undefined;

const describeIfGpp = hasGpp ? describe : describe.skip;

const FB_BELT = `FUNCTION_BLOCK FB_Belt
VAR_OUTPUT speed : INT := 1; END_VAR
speed := speed + 7;
END_FUNCTION_BLOCK
`;

const PRINT_OUT =
  "    Program_MAIN p;\n    p.run();\n    std::cout << p.OUT.get() << std::endl;";

describeIfGpp(
  "function blocks inside types and globals — generated C++",
  () => {
    let tempDir: string;
    let pchPath: string;

    beforeAll(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-fbtyped-"));
      pchPath = createPCH(tempDir);
    });

    afterAll(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    function run(
      source: string,
      mainBody: string,
      testName: string,
      options: Parameters<typeof compile>[1] = {},
    ): string {
      const result = compile(source, {
        headerFileName: "generated.hpp",
        ...options,
      });
      expect(result.errors.map((e) => `${e.line}: ${e.message}`)).toEqual([]);
      expect(result.success).toBe(true);
      return compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName,
        mainCode: `#include <iostream>\n\nint main() {\n    using namespace strucpp;\n${mainBody}\n    return 0;\n}\n`,
      });
    }

    const STRUCT_LINE =
      "TYPE ST_Line : STRUCT belt : FB_Belt; END_STRUCT END_TYPE\n";
    const MAIN_LINE = `PROGRAM Main
VAR Out : INT; line : ST_Line; END_VAR
line.belt();
line.belt();
Out := line.belt.speed;
END_PROGRAM
`;

    it("STRUCT with an FB field, FB declared after", () => {
      expect(
        run(STRUCT_LINE + FB_BELT + MAIN_LINE, PRINT_OUT, "fbt_after"),
      ).toBe("15");
    });

    it("STRUCT with an FB field, FB declared before", () => {
      expect(
        run(FB_BELT + STRUCT_LINE + MAIN_LINE, PRINT_OUT, "fbt_before"),
      ).toBe("15");
    });

    // Invoking an FB through more than one selector (`o.inner.belt()`,
    // `a.b[1]()`) is not supported, so the deeper cases read the instance: its
    // initial value proves the FB was constructed in place.
    it("a struct holding a struct holding an FB, used as an FB member", () => {
      const source = `FUNCTION_BLOCK FB_Cell
VAR o : ST_Outer; END_VAR
VAR_OUTPUT v : INT; END_VAR
v := o.inner.belt.speed + o.n;
END_FUNCTION_BLOCK
TYPE
  ST_Outer : STRUCT inner : ST_Inner; n : INT := 100; END_STRUCT;
  ST_Inner : STRUCT belt : FB_Belt; END_STRUCT;
END_TYPE
${FB_BELT}
PROGRAM Main
VAR Out : INT; cell : FB_Cell; END_VAR
cell();
Out := cell.v;
END_PROGRAM
`;
      expect(run(source, PRINT_OUT, "fbt_nested")).toBe("101");
    });

    it("ARRAY OF FB inside a struct", () => {
      const source = `TYPE ST_Bank : STRUCT belts : ARRAY[0..1] OF FB_Belt; END_STRUCT END_TYPE
${FB_BELT}
PROGRAM Main
VAR Out : INT; bank : ST_Bank; END_VAR
Out := bank.belts[1].speed * 10 + bank.belts[0].speed;
END_PROGRAM
`;
      expect(run(source, PRINT_OUT, "fbt_array_in_struct")).toBe("11");
    });

    it("a TYPE array of FB held by a struct", () => {
      const source = `TYPE
  ST_Bank : STRUCT belts : BeltPair; END_STRUCT;
  BeltPair : ARRAY[0..1] OF FB_Belt;
END_TYPE
${FB_BELT}
PROGRAM Main
VAR Out : INT; bank : ST_Bank; END_VAR
Out := bank.belts[0].speed;
END_PROGRAM
`;
      expect(run(source, PRINT_OUT, "fbt_type_array")).toBe("1");
    });

    it.skipIf(!iecStdlib)(
      "a STRUCT with a TON field, the timer called through the field",
      () => {
        // Inputs are set on the field and the call has no arguments: a call with
        // arguments through a selector (`d.tmr(IN := TRUE)`) is emitted as a
        // method call today, for any FB, held in a STRUCT or not.
        const source = `TYPE ST_Delay : STRUCT tmr : TON; n : INT; END_STRUCT END_TYPE
PROGRAM Main
VAR Out : INT; d : ST_Delay; END_VAR
d.tmr.IN := TRUE;
d.tmr.PT := T#0s;
d.tmr();
d.tmr();
IF d.tmr.Q THEN
  Out := 1;
END_IF;
END_PROGRAM
`;
        expect(
          run(source, PRINT_OUT, "fbt_ton_field", {
            libraries: iecStdlib ? [iecStdlib] : [],
          }),
        ).toBe("1");
      },
    );

    const GVL_BELT = "VAR_GLOBAL\n  gBelt : FB_Belt;\nEND_VAR\n";
    const MAIN_GVL = `PROGRAM Main
VAR Out : INT; END_VAR
VAR_EXTERNAL gBelt : FB_Belt; END_VAR
gBelt();
gBelt();
Out := gBelt.speed;
END_PROGRAM
`;

    it("a file-level VAR_GLOBAL of FB type, declared before the FB, called", () => {
      expect(
        run(GVL_BELT + FB_BELT + MAIN_GVL, PRINT_OUT, "fbt_gvl_before"),
      ).toBe("15");
    });

    it("a file-level VAR_GLOBAL of FB type, declared after the FB, called", () => {
      expect(
        run(FB_BELT + GVL_BELT + MAIN_GVL, PRINT_OUT, "fbt_gvl_after"),
      ).toBe("15");
    });

    it("a file-level VAR_GLOBAL of a late struct type", () => {
      const source = `VAR_GLOBAL
  gLine : ST_Line;
  gCount : INT := 3;
END_VAR
${STRUCT_LINE}${FB_BELT}
PROGRAM Main
VAR Out : INT; END_VAR
VAR_EXTERNAL gLine : ST_Line; gCount : INT; END_VAR
gLine.belt();
Out := gLine.belt.speed + gCount;
END_PROGRAM
`;
      expect(run(source, PRINT_OUT, "fbt_gvl_late_struct")).toBe("11");
    });

    it("a late struct with an enum field initialised by a bare member", () => {
      const source = `TYPE
  E_Mode : (Idle, Fast, Slow);
  ST_Axis : STRUCT belt : FB_Belt; mode : E_Mode := Slow; END_STRUCT;
END_TYPE
${FB_BELT}
PROGRAM Main
VAR Out : INT; ax : ST_Axis; END_VAR
IF ax.mode = E_Mode#Slow THEN
  Out := 2;
END_IF;
END_PROGRAM
`;
      expect(run(source, PRINT_OUT, "fbt_late_enum_init")).toBe("2");
    });

    it("a late struct named in an interface method before its definition", () => {
      const source = `INTERFACE I_Line
METHOD Speed : INT
VAR_IN_OUT l : ST_Line; END_VAR
END_METHOD
END_INTERFACE
${STRUCT_LINE}${FB_BELT}
FUNCTION_BLOCK FB_User IMPLEMENTS I_Line
METHOD Speed : INT
VAR_IN_OUT l : ST_Line; END_VAR
l.belt();
Speed := l.belt.speed;
END_METHOD
END_FUNCTION_BLOCK
PROGRAM Main
VAR Out : INT; u : FB_User; ln : ST_Line; END_VAR
Out := u.Speed(l := ln);
END_PROGRAM
`;
      expect(run(source, PRINT_OUT, "fbt_late_in_interface")).toBe("8");
    });

    // A TYPE ARRAY or alias holding an FB is a `using`: it stays with the
    // other types, ahead of the interfaces and FB classes whose method
    // signatures name it.
    it("a TYPE array of FBs taken by VAR_IN_OUT in an FB method and an interface method", () => {
      const source = `TYPE BeltPair : ARRAY[0..1] OF FB_Belt; END_TYPE
INTERFACE I_Sum
METHOD Sum : INT
VAR_IN_OUT p : BeltPair; END_VAR
END_METHOD
END_INTERFACE
FUNCTION_BLOCK FB_User IMPLEMENTS I_Sum
METHOD Sum : INT
VAR_IN_OUT p : BeltPair; END_VAR
p[0]();
Sum := p[0].speed + p[1].speed;
END_METHOD
END_FUNCTION_BLOCK
${FB_BELT}
PROGRAM Main
VAR Out : INT; u : FB_User; pair : BeltPair; END_VAR
Out := u.Sum(p := pair);
END_PROGRAM
`;
      expect(run(source, PRINT_OUT, "fbt_type_array_in_method")).toBe("9");
    });

    it("an alias of a late struct in a method, and a TYPE array of FBs as an FB member declared first", () => {
      const source = `TYPE
  LineAlias : ST_Line;
  BeltPair : ARRAY[0..1] OF FB_Belt;
END_TYPE
FUNCTION_BLOCK FB_User
VAR pair : BeltPair; END_VAR
METHOD Speed : INT
VAR_IN_OUT l : LineAlias; END_VAR
l.belt();
Speed := l.belt.speed + pair[1].speed * 10;
END_METHOD
END_FUNCTION_BLOCK
${STRUCT_LINE}${FB_BELT}
PROGRAM Main
VAR Out : INT; u : FB_User; ln : LineAlias; END_VAR
Out := u.Speed(l := ln);
END_PROGRAM
`;
      expect(run(source, PRINT_OUT, "fbt_late_alias_in_method")).toBe("18");
    });

    it("a CONFIGURATION VAR_GLOBAL of a plain struct still compiles", () => {
      const source = `TYPE ST_Scale : STRUCT lo : INT := 4; hi : INT := 22; END_STRUCT END_TYPE
PROGRAM Main
VAR_EXTERNAL s : ST_Scale; END_VAR
s.lo := s.hi;
END_PROGRAM
CONFIGURATION Cfg
  VAR_GLOBAL
    s : ST_Scale;
  END_VAR
  RESOURCE Res ON PLC
    TASK T(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM P WITH T : Main;
  END_RESOURCE
END_CONFIGURATION
`;
      expect(
        run(
          source,
          "    std::cout << S.value.HI.get() << std::endl;",
          "fbt_config_plain_struct",
        ),
      ).toBe("22");
    });
  },
);

describe("a CONFIGURATION VAR_GLOBAL that would hold a function block", () => {
  function configWith(globalDecl: string, body: string): string {
    return `${FB_BELT}TYPE ST_Line : STRUCT belt : FB_Belt; END_STRUCT END_TYPE
PROGRAM Main
VAR Out : INT; END_VAR
${body}
END_PROGRAM
CONFIGURATION Cfg
  VAR_GLOBAL
    ${globalDecl}
  END_VAR
  RESOURCE Res ON PLC
    TASK T(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM P WITH T : Main;
  END_RESOURCE
END_CONFIGURATION
`;
  }
  // FB_BELT is 4 lines, then TYPE (5), PROGRAM..VAR (6-7), body (8),
  // END_PROGRAM (9), CONFIGURATION (10), VAR_GLOBAL (11), the declaration (12).
  const DECL_LINE = 12;

  // The AST keeps identifiers upper-cased, so the message shows them so.
  function errorsOf(source: string): string[] {
    const result = compile(source, { headerFileName: "generated.hpp" });
    expect(result.success).toBe(false);
    return result.errors.map((e) => `${e.line}: ${e.message}`);
  }

  it("of FB type is refused at its line, not called", () => {
    expect(errorsOf(configWith("gBelt : FB_Belt;", "Out := 1;"))).toEqual([
      `${DECL_LINE}: VAR_GLOBAL GBELT in a CONFIGURATION cannot hold a FUNCTION_BLOCK (FB_BELT); declare it in a global variable list or in a PROGRAM`,
    ]);
  });

  it("of FB type is refused at its line, called", () => {
    // The body takes two lines here, so the declaration moves down by one.
    expect(
      errorsOf(
        configWith(
          "gBelt : FB_Belt;",
          "VAR_EXTERNAL gBelt : FB_Belt; END_VAR\ngBelt();",
        ),
      ),
    ).toEqual([
      `${DECL_LINE + 1}: VAR_GLOBAL GBELT in a CONFIGURATION cannot hold a FUNCTION_BLOCK (FB_BELT); declare it in a global variable list or in a PROGRAM`,
    ]);
  });

  it("of a struct holding an FB is refused at its line", () => {
    expect(errorsOf(configWith("gLine : ST_Line;", "Out := 1;"))).toEqual([
      `${DECL_LINE}: VAR_GLOBAL GLINE in a CONFIGURATION cannot hold a FUNCTION_BLOCK (ST_LINE); declare it in a global variable list or in a PROGRAM`,
    ]);
  });

  it.skipIf(!iecStdlib)(
    "of a library FB type (TON) is refused at its line",
    () => {
      const result = compile(
        `PROGRAM Main
VAR Out : INT; END_VAR
Out := 1;
END_PROGRAM
CONFIGURATION Cfg
  VAR_GLOBAL
    gT : TON;
  END_VAR
  RESOURCE Res ON PLC
    TASK T(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM P WITH T : Main;
  END_RESOURCE
END_CONFIGURATION
`,
        {
          headerFileName: "generated.hpp",
          libraries: iecStdlib ? [iecStdlib] : [],
        },
      );
      expect(result.errors.map((e) => `${e.line}: ${e.message}`)).toEqual([
        "7: VAR_GLOBAL GT in a CONFIGURATION cannot hold a FUNCTION_BLOCK (TON); declare it in a global variable list or in a PROGRAM",
      ]);
    },
  );
});
