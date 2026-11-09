/**
 * ACTION blocks after lowering to methods (`lowerActions`): the owner lookup,
 * the clash errors, scope and strict checks inside an action, calls by
 * `Name()` and `inst.Name()`, C12's refusal from another POU, and the rule
 * that an action is not part of the OOP surface (no override by a METHOD, no
 * INTERFACE method satisfied by an action).
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import { parse } from "../../src/frontend/parser.js";
import { buildAST } from "../../src/frontend/ast-builder.js";
import { lowerActions } from "../../src/semantic/lower-actions.js";

const lines = (r: ReturnType<typeof compile>): string[] =>
  r.errors.map((e) => `${e.line}:${e.column}: ${e.message}`);

const messages = (r: ReturnType<typeof compile>): string[] =>
  r.errors.map((e) => e.message);

describe("lowerActions", () => {
  it("appends a PUBLIC, parameterless, value-less method marked fromAction", () => {
    const parsed = parse(`PROGRAM MAIN
VAR n : INT; END_VAR
  Count();
  ACTION Count:
    n := n + 1;
  END_ACTION
END_PROGRAM
`);
    const ast = buildAST(parsed.cst!);
    expect(lowerActions(ast)).toEqual([]);
    const method = ast.programs[0]!.methods[0]!;
    expect(method.kind).toBe("MethodDeclaration");
    expect(method.name).toBe("COUNT");
    expect(method.visibility).toBe("PUBLIC");
    expect(method.returnType).toBeUndefined();
    expect(method.varBlocks).toEqual([]);
    expect(method.body).toHaveLength(1);
    expect(method.fromAction).toBe(true);
    expect(method.isAbstract || method.isFinal || method.isOverride).toBe(
      false,
    );
    expect(method.sourceSpan.startLine).toBe(4);
  });

  it("finds a top-level action's owner case-insensitively", () => {
    const parsed = parse(`FUNCTION_BLOCK Motor
VAR n : INT; END_VAR
END_FUNCTION_BLOCK
ACTION motor.Reset
  n := 0;
END_ACTION
`);
    const ast = buildAST(parsed.cst!);
    expect(lowerActions(ast)).toEqual([]);
    expect(ast.functionBlocks[0]!.methods.map((m) => m.name)).toEqual([
      "RESET",
    ]);
  });
});

describe("ACTION errors", () => {
  it("an owner that is not a PROGRAM or FUNCTION_BLOCK, at the ACTION line", () => {
    const src = `FUNCTION F : INT
  F := 1;
END_FUNCTION
ACTION F.Act
  ;
END_ACTION
ACTION Nowhere.Act
  ;
END_ACTION
`;
    expect(lines(compile(src))).toEqual([
      "4:1: ACTION F.ACT: F is not a PROGRAM or FUNCTION_BLOCK of this program",
      "7:1: ACTION NOWHERE.ACT: NOWHERE is not a PROGRAM or FUNCTION_BLOCK of this program",
    ]);
  });

  it("an action defined twice for its owner (both forms)", () => {
    const src = `PROGRAM MAIN
VAR n : INT; END_VAR
  n := 1;
  ACTION Count:
    n := n + 1;
  END_ACTION
END_PROGRAM
ACTION MAIN.Count
  n := n + 2;
END_ACTION
`;
    expect(lines(compile(src))).toEqual([
      "8:1: ACTION COUNT is defined twice for MAIN",
    ]);
  });

  it("an action with the name of a METHOD of its owner", () => {
    const src = `FUNCTION_BLOCK Fb
VAR n : INT; END_VAR
METHOD Reset
  n := 0;
END_METHOD
  n := 1;
  ACTION Reset:
    n := 2;
  END_ACTION
END_FUNCTION_BLOCK
`;
    expect(lines(compile(src))).toEqual([
      "7:3: ACTION RESET has the same name as a METHOD of FB",
    ]);
  });

  it("an action with the name of a variable of its owner", () => {
    const src = `PROGRAM MAIN
VAR_INPUT count : INT; END_VAR
END_PROGRAM
ACTION MAIN.Count
  ;
END_ACTION
`;
    expect(lines(compile(src))).toEqual([
      "4:1: ACTION COUNT has the same name as a variable of MAIN",
    ]);
  });

  it("a derived FB's METHOD named like a base action is refused", () => {
    const src = `FUNCTION_BLOCK Base
VAR n : INT; END_VAR
  ACTION Reset:
    n := 0;
  END_ACTION
END_FUNCTION_BLOCK
FUNCTION_BLOCK Derived EXTENDS Base
METHOD Reset
  n := 5;
END_METHOD
END_FUNCTION_BLOCK
`;
    expect(lines(compile(src))).toEqual([
      "8:1: ACTION RESET of BASE cannot be overridden by a METHOD of DERIVED",
    ]);
  });

  it("an action does not implement an INTERFACE method", () => {
    const src = `INTERFACE IReset
METHOD Reset
END_METHOD
END_INTERFACE
FUNCTION_BLOCK Fb IMPLEMENTS IReset
VAR n : INT; END_VAR
  n := 1;
  ACTION Reset:
    n := 0;
  END_ACTION
END_FUNCTION_BLOCK
`;
    expect(messages(compile(src))).toEqual([
      "FUNCTION_BLOCK 'FB' implements 'IRESET' but does not provide method 'RESET'.",
    ]);
  });

  it("an inherited action does not implement an INTERFACE method either", () => {
    const src = `INTERFACE IReset
METHOD Reset
END_METHOD
END_INTERFACE
FUNCTION_BLOCK Base
VAR n : INT; END_VAR
  ACTION Reset:
    n := 0;
  END_ACTION
END_FUNCTION_BLOCK
FUNCTION_BLOCK Derived EXTENDS Base IMPLEMENTS IReset
END_FUNCTION_BLOCK
`;
    expect(messages(compile(src))).toEqual([
      "FUNCTION_BLOCK 'DERIVED' implements 'IRESET' but does not provide method 'RESET'.",
    ]);
  });

  it("a derived FB's ACTION named like a base action is refused", () => {
    const src = `FUNCTION_BLOCK Base
VAR n : INT; END_VAR
  ACTION Reset:
    n := 0;
  END_ACTION
END_FUNCTION_BLOCK
FUNCTION_BLOCK Derived EXTENDS Base
  ACTION Reset:
    n := 1;
  END_ACTION
END_FUNCTION_BLOCK
`;
    expect(lines(compile(src))).toEqual([
      "8:3: ACTION RESET of BASE cannot be overridden by an ACTION of DERIVED",
    ]);
  });

  it("an action named like an inherited METHOD or variable is refused", () => {
    const src = `FUNCTION_BLOCK Base
VAR level : INT; END_VAR
METHOD Reset
  level := 0;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK Derived EXTENDS Base
  ACTION Reset:
    level := 1;
  END_ACTION
  ACTION Level:
    level := 2;
  END_ACTION
END_FUNCTION_BLOCK
`;
    expect(lines(compile(src))).toEqual([
      "8:3: ACTION RESET has the same name as a METHOD of DERIVED",
      "11:3: ACTION LEVEL has the same name as a variable of DERIVED",
    ]);
  });

  it("a base action is callable on a derived instance", () => {
    const src = `FUNCTION_BLOCK Base
VAR n : INT; END_VAR
  ACTION Reset:
    n := 0;
  END_ACTION
END_FUNCTION_BLOCK
FUNCTION_BLOCK Derived EXTENDS Base
  Reset();
END_FUNCTION_BLOCK
PROGRAM MAIN
VAR d : Derived; END_VAR
  d.Reset();
END_PROGRAM
`;
    expect(compile(src, { strict: true }).errors).toEqual([]);
  });
});

describe("ACTION semantics", () => {
  it("program action needs no feature under iec-3", () => {
    const src = `PROGRAM MAIN
VAR n : INT; END_VAR
  Count();
  ACTION Count:
    n := n + 1;
  END_ACTION
END_PROGRAM
ACTION MAIN.Twice
  Count();
  Count();
END_ACTION
`;
    expect(compile(src, { dialect: "iec-3" }).errors).toEqual([]);
    expect(compile(src).errors).toEqual([]);
  });

  it("an action sees the owner's VARs, VAR_INPUTs and VAR_EXTERNALs", () => {
    const src = `CONFIGURATION C
  VAR_GLOBAL g : INT; END_VAR
  RESOURCE R ON PLC
    TASK T(INTERVAL := T#100ms, PRIORITY := 1);
    PROGRAM Inst WITH T : MAIN;
  END_RESOURCE
END_CONFIGURATION
PROGRAM MAIN
VAR_INPUT k : INT; END_VAR
VAR_EXTERNAL g : INT; END_VAR
VAR n : INT; END_VAR
  Sum();
END_PROGRAM
ACTION MAIN.Sum
  n := n + k;
  g := n;
END_ACTION
`;
    expect(compile(src, { dialect: "iec-3", strict: true }).errors).toEqual([]);
  });

  it("an undeclared name inside an action is an error", () => {
    const src = `PROGRAM MAIN
VAR n : INT; END_VAR
  ACTION Bad:
    n := missing;
  END_ACTION
END_PROGRAM
`;
    expect(compile(src).errors.length).toBeGreaterThan(0);
    expect(compile(src).errors[0]!.line).toBe(4);
  });

  it("strict checks apply inside an action", () => {
    const src = `PROGRAM MAIN
VAR i : INT; d : DINT; END_VAR
  Narrow();
  ACTION Narrow:
    i := d;
  END_ACTION
END_PROGRAM
`;
    expect(lines(compile(src, { strict: true }))).toEqual([
      "5:10: Implicit conversion from DINT to INT is not allowed; use DINT_TO_INT",
    ]);
    expect(compile(src).errors).toEqual([]);
  });

  it("Name() from a method of the owner resolves", () => {
    const src = `FUNCTION_BLOCK Fb
VAR n : INT; END_VAR
METHOD Run
  Count();
  THIS.Count();
END_METHOD
  ACTION Count:
    n := n + 1;
  END_ACTION
END_FUNCTION_BLOCK
`;
    expect(compile(src, { strict: true }).errors).toEqual([]);
  });

  it("inst.Name() on an FB instance resolves", () => {
    const src = `FUNCTION_BLOCK Fb
VAR n : INT; END_VAR
  n := n + 1;
  ACTION Reset:
    n := 0;
  END_ACTION
END_FUNCTION_BLOCK
PROGRAM MAIN
VAR b : Fb; END_VAR
  b();
  b.Reset();
END_PROGRAM
`;
    expect(compile(src, { strict: true, dialect: "iec-3" }).errors).toEqual([]);
  });

  it("MAIN.Name() from another POU is refused with C12's message", () => {
    const src = `PROGRAM MAIN
VAR n : INT; END_VAR
  Count();
  ACTION Count:
    n := n + 1;
  END_ACTION
END_PROGRAM
FUNCTION_BLOCK Fb
  MAIN.Count();
END_FUNCTION_BLOCK
`;
    expect(lines(compile(src))).toEqual([
      "9:3: the methods and actions of PROGRAM MAIN can be called only inside MAIN",
    ]);
  });

  it("p.Name() through a program-typed instance in another POU is refused", () => {
    const src = `PROGRAM MAIN
VAR n : INT; END_VAR
  ACTION Count:
    n := n + 1;
  END_ACTION
END_PROGRAM
FUNCTION_BLOCK Fb
VAR p : MAIN; END_VAR
  p.Count();
END_FUNCTION_BLOCK
`;
    expect(lines(compile(src))).toEqual([
      "9:3: the methods and actions of PROGRAM MAIN can be called only inside MAIN",
    ]);
  });

  it("an action uses an inline enumeration of its owner", () => {
    const src = `PROGRAM MAIN
VAR mode : (Idle, Running) := Idle; END_VAR
  Start();
  ACTION Start:
    IF mode = Idle THEN
      mode := Running;
    END_IF
  END_ACTION
END_PROGRAM
`;
    expect(compile(src, { dialect: "iec-3" }).errors).toEqual([]);
  });

  it("an action calls another action of the same program", () => {
    const src = `PROGRAM MAIN
VAR n : INT; END_VAR
  Twice();
  ACTION Count:
    n := n + 1;
  END_ACTION
  ACTION Twice:
    Count();
    MAIN.Count();
  END_ACTION
END_PROGRAM
`;
    expect(compile(src, { dialect: "iec-3" }).errors).toEqual([]);
  });
});
