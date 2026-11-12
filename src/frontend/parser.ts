// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * STruC++ Parser
 *
 * Parses IEC 61131-3 Structured Text tokens into an Abstract Syntax Tree.
 * Uses Chevrotain's embedded DSL for grammar definition.
 */

import {
  CstParser,
  CstNode,
  EOF,
  type IToken,
  type TokenType,
} from "chevrotain";
import * as tokens from "./lexer.js";
import { resolveErrorMessageProvider } from "./parser-error-message-provider.js";

/**
 * STruC++ Parser for IEC 61131-3 Structured Text.
 *
 * This parser produces a Concrete Syntax Tree (CST) which is then
 * transformed into an Abstract Syntax Tree (AST) by the visitor.
 */
export class STParser extends CstParser {
  constructor(tokenVocabulary?: import("chevrotain").TokenType[]) {
    // `errorMessageProvider` swaps chevrotain's default
    // alternation-path dump (1,400+ lines for a top-level statement
    // failure) for a rule-aware sentence.  `resolveErrorMessageProvider`
    // returns `undefined` when `STRUCPP_VERBOSE_PARSER_ERRORS=1` is set
    // in the env, falling back to chevrotain's default for
    // grammar-debugging.  See parser-error-message-provider.ts.
    const errorMessageProvider = resolveErrorMessageProvider();
    super(tokenVocabulary ?? tokens.allTokens, {
      recoveryEnabled: true,
      maxLookahead: 3,
      ...(errorMessageProvider ? { errorMessageProvider } : {}),
    });

    this.performSelfAnalysis();
  }

  // ==========================================================================
  // Top-level rules
  // ==========================================================================

  /**
   * Entry point: A compilation unit contains one or more POUs or type definitions.
   */
  public compilationUnit = this.RULE("compilationUnit", () => {
    this.MANY(() => {
      this.OR({
        DEF: [
          {
            ALT: () => this.SUBRULE(this.programDeclaration),
            GATE: () => this.LA(1).tokenType === tokens.PROGRAM,
          },
          {
            ALT: () => this.SUBRULE(this.functionDeclaration),
            GATE: () => this.LA(1).tokenType === tokens.FUNCTION,
          },
          {
            ALT: () => this.SUBRULE(this.functionBlockDeclaration),
            GATE: () => this.LA(1).tokenType === tokens.FUNCTION_BLOCK,
          },
          {
            ALT: () => this.SUBRULE(this.interfaceDeclaration),
            GATE: () => this.LA(1).tokenType === tokens.INTERFACE,
          },
          {
            ALT: () => this.SUBRULE(this.typeDeclaration),
            GATE: () => this.LA(1).tokenType === tokens.TYPE,
          },
          {
            ALT: () => this.SUBRULE(this.configurationDeclaration),
            GATE: () => this.LA(1).tokenType === tokens.CONFIGURATION,
          },
          {
            // ACTION Owner.Name ... END_ACTION outside its POU
            ALT: () => this.SUBRULE(this.topLevelActionDeclaration),
            GATE: () => this.isActionDeclarationAhead(true),
          },
          {
            // Top-level VAR_GLOBAL ... END_VAR (GVL files)
            ALT: () => this.SUBRULE(this.varBlock),
            GATE: () => this.LA(1).tokenType === tokens.VAR_GLOBAL,
          },
        ],
        IGNORE_AMBIGUITIES: true,
      });
    });
  });

  // ==========================================================================
  // Program Organization Units
  // ==========================================================================

  /**
   * PROGRAM declaration
   */
  public programDeclaration = this.RULE("programDeclaration", () => {
    this.CONSUME(tokens.PROGRAM);
    this.CONSUME(tokens.Identifier);
    // VAR blocks, methods and actions interleaved (before body), as in a
    // FUNCTION_BLOCK; the analyzer refuses methods without the feature
    // program_methods. PROPERTY stays out of programs.
    this.MANY(() => {
      this.OR({
        DEF: [
          {
            ALT: () => this.SUBRULE(this.varBlock),
            GATE: () => this.isVarBlockAhead(),
          },
          {
            ALT: () => this.SUBRULE(this.methodDeclaration),
            GATE: () => this.LA(1).tokenType === tokens.METHOD,
          },
          {
            ALT: (): CstNode => this.SUBRULE2(this.actionDeclaration),
            GATE: (): boolean => this.isActionDeclarationAhead(false),
          },
        ],
        IGNORE_AMBIGUITIES: true,
      });
    });
    this.OPTION(() => {
      this.SUBRULE(this.statementList);
    });
    this.MANY2({
      GATE: () => this.isActionDeclarationAhead(false),
      DEF: () => this.SUBRULE(this.actionDeclaration),
    });
    this.CONSUME(tokens.END_PROGRAM);
  });

  /**
   * FUNCTION declaration
   */
  public functionDeclaration = this.RULE("functionDeclaration", () => {
    this.CONSUME(tokens.FUNCTION);
    this.SUBRULE(this.identifierOrKeyword);
    this.CONSUME(tokens.Colon);
    this.SUBRULE(this.dataType);
    this.MANY(() => {
      this.SUBRULE(this.varBlock);
    });
    this.OPTION(() => {
      this.SUBRULE(this.statementList);
    });
    this.CONSUME(tokens.END_FUNCTION);
  });

  /**
   * FUNCTION_BLOCK declaration with OOP extensions
   * Supports: ABSTRACT, FINAL, EXTENDS, IMPLEMENTS, methods, properties
   */
  public functionBlockDeclaration = this.RULE(
    "functionBlockDeclaration",
    () => {
      this.CONSUME(tokens.FUNCTION_BLOCK);
      // Optional ABSTRACT and/or FINAL modifier (semantic analysis catches contradictions)
      this.OPTION(() => {
        this.CONSUME(tokens.ABSTRACT);
      });
      this.OPTION6(() => {
        this.CONSUME(tokens.FINAL);
      });
      this.SUBRULE(this.identifierOrKeyword);
      // Optional EXTENDS clause
      this.OPTION2(() => {
        this.CONSUME(tokens.EXTENDS);
        this.CONSUME2(tokens.Identifier);
      });
      // Optional IMPLEMENTS clause
      this.OPTION3(() => {
        this.CONSUME(tokens.IMPLEMENTS);
        this.AT_LEAST_ONE_SEP({
          SEP: tokens.Comma,
          DEF: () => this.CONSUME3(tokens.Identifier),
        });
      });
      // VAR blocks, methods, properties, actions interleaved (before body)
      this.MANY(() => {
        this.OR2({
          DEF: [
            {
              ALT: () => this.SUBRULE(this.varBlock),
              GATE: () => this.isVarBlockAhead(),
            },
            {
              ALT: () => this.SUBRULE(this.methodDeclaration),
              GATE: () => this.LA(1).tokenType === tokens.METHOD,
            },
            {
              ALT: () => this.SUBRULE(this.propertyDeclaration),
              GATE: () => this.LA(1).tokenType === tokens.PROPERTY,
            },
            {
              ALT: (): CstNode => this.SUBRULE2(this.actionDeclaration),
              GATE: (): boolean => this.isActionDeclarationAhead(false),
            },
          ],
          IGNORE_AMBIGUITIES: true,
        });
      });
      // Optional body statements (the FB's operator() body)
      this.OPTION4(() => {
        this.SUBRULE(this.statementList);
      });
      this.MANY3({
        GATE: () => this.isActionDeclarationAhead(false),
        DEF: () => this.SUBRULE(this.actionDeclaration),
      });
      this.CONSUME(tokens.END_FUNCTION_BLOCK);
    },
  );

  /**
   * ACTION Name [:] statements END_ACTION, inside a PROGRAM or FUNCTION_BLOCK
   * before or after its body. An action has no VAR blocks of its own.
   */
  public actionDeclaration = this.RULE("actionDeclaration", () => {
    this.CONSUME(tokens.ACTION);
    this.SUBRULE(this.identifierOrKeyword);
    this.OPTION(() => {
      this.CONSUME(tokens.Colon);
    });
    this.OPTION2(() => {
      this.SUBRULE(this.statementList);
    });
    this.CONSUME(tokens.END_ACTION);
  });

  /**
   * ACTION Owner.Name [:] statements END_ACTION, outside the owning POU.
   */
  public topLevelActionDeclaration = this.RULE(
    "topLevelActionDeclaration",
    () => {
      this.CONSUME(tokens.ACTION);
      this.SUBRULE(this.identifierOrKeyword); // owner
      this.CONSUME(tokens.Dot);
      this.SUBRULE2(this.identifierOrKeyword); // action name
      this.OPTION(() => {
        this.CONSUME(tokens.Colon);
      });
      this.OPTION2(() => {
        this.SUBRULE(this.statementList);
      });
      this.CONSUME(tokens.END_ACTION);
    },
  );

  // ==========================================================================
  // OOP Extensions (IEC 61131-3 Edition 3)
  // ==========================================================================

  /**
   * INTERFACE declaration
   */
  public interfaceDeclaration = this.RULE("interfaceDeclaration", () => {
    this.CONSUME(tokens.INTERFACE);
    this.CONSUME(tokens.Identifier);
    // Optional EXTENDS clause (interface inheritance)
    this.OPTION(() => {
      this.CONSUME(tokens.EXTENDS);
      this.AT_LEAST_ONE_SEP({
        SEP: tokens.Comma,
        DEF: () => this.CONSUME2(tokens.Identifier),
      });
    });
    // Method prototypes; PROPERTY prototypes (feature property, checked in
    // the analyzer) reuse the FB rule, whose accessors must have no body here.
    this.MANY(() => {
      this.OR({
        DEF: [
          {
            ALT: () => this.SUBRULE(this.interfaceMethodDeclaration),
            GATE: () => this.LA(1).tokenType === tokens.METHOD,
          },
          {
            ALT: () => this.SUBRULE(this.propertyDeclaration),
            GATE: () => this.LA(1).tokenType === tokens.PROPERTY,
          },
        ],
        IGNORE_AMBIGUITIES: true,
      });
    });
    this.CONSUME(tokens.END_INTERFACE);
  });

  /**
   * Interface method declaration (no body, implicitly abstract)
   */
  public interfaceMethodDeclaration = this.RULE(
    "interfaceMethodDeclaration",
    () => {
      this.CONSUME(tokens.METHOD);
      this.CONSUME(tokens.Identifier);
      // Optional return type
      this.OPTION(() => {
        this.CONSUME(tokens.Colon);
        this.SUBRULE(this.dataType);
      });
      // Optional VAR_INPUT blocks
      this.MANY(() => {
        this.SUBRULE(this.varBlock);
      });
      this.CONSUME(tokens.END_METHOD);
    },
  );

  /**
   * METHOD declaration within a Function Block
   */
  public methodDeclaration = this.RULE("methodDeclaration", () => {
    this.CONSUME(tokens.METHOD);
    // Optional visibility modifier
    this.OPTION(() => {
      this.OR({
        DEF: [
          { ALT: () => this.CONSUME(tokens.PUBLIC) },
          { ALT: () => this.CONSUME(tokens.PRIVATE) },
          { ALT: () => this.CONSUME(tokens.PROTECTED) },
        ],
        IGNORE_AMBIGUITIES: true,
      });
    });
    // Optional ABSTRACT/FINAL/OVERRIDE (can appear in any combination and order)
    this.MANY2(() => {
      this.OR2({
        DEF: [
          {
            ALT: () => this.CONSUME(tokens.ABSTRACT),
            GATE: () => this.LA(1).tokenType === tokens.ABSTRACT,
          },
          {
            ALT: () => this.CONSUME(tokens.FINAL),
            GATE: () => this.LA(1).tokenType === tokens.FINAL,
          },
          {
            ALT: () => this.CONSUME(tokens.OVERRIDE),
            GATE: () => this.LA(1).tokenType === tokens.OVERRIDE,
          },
        ],
        IGNORE_AMBIGUITIES: true,
      });
    });
    this.CONSUME(tokens.Identifier);
    // Optional return type
    this.OPTION3(() => {
      this.CONSUME(tokens.Colon);
      this.SUBRULE(this.dataType);
    });
    // VAR blocks inside method
    this.MANY(() => {
      this.SUBRULE(this.methodVarBlock);
    });
    // Method body (unless abstract)
    this.OPTION4(() => {
      this.SUBRULE(this.statementList);
    });
    this.CONSUME(tokens.END_METHOD);
  });

  /**
   * Variable block inside a method (supports VAR_INST in addition to standard blocks)
   */
  public methodVarBlock = this.RULE("methodVarBlock", () => {
    this.OR({
      DEF: [
        { ALT: () => this.CONSUME(tokens.VAR) },
        { ALT: () => this.CONSUME(tokens.VAR_INPUT) },
        { ALT: () => this.CONSUME(tokens.VAR_OUTPUT) },
        { ALT: () => this.CONSUME(tokens.VAR_IN_OUT) },
        { ALT: () => this.CONSUME(tokens.VAR_TEMP) },
        { ALT: () => this.CONSUME(tokens.VAR_INST) },
      ],
      IGNORE_AMBIGUITIES: true,
    });
    // MANY, not OPTION: IEC and CODESYS both allow a combination, and
    // `VAR RETAIN PERSISTENT` is the form a converted CODESYS project actually
    // carries. Contradictory or repeated qualifiers are a semantic error, not a
    // grammar one — `validateVarModifiers` reports them with a source span,
    // which reads far better than a parser "expecting END_VAR".
    this.MANY2(() => {
      this.OR2([
        { ALT: () => this.CONSUME(tokens.CONSTANT) },
        { ALT: () => this.CONSUME(tokens.RETAIN) },
        { ALT: () => this.CONSUME(tokens.NON_RETAIN) },
        { ALT: () => this.CONSUME(tokens.PERSISTENT) },
      ]);
    });
    this.MANY(() => {
      this.SUBRULE(this.varDeclaration);
    });
    this.CONSUME(tokens.END_VAR);
  });

  /**
   * PROPERTY declaration within a Function Block
   */
  public propertyDeclaration = this.RULE("propertyDeclaration", () => {
    this.CONSUME(tokens.PROPERTY);
    // Optional visibility modifier
    this.OPTION(() => {
      this.OR({
        DEF: [
          { ALT: () => this.CONSUME(tokens.PUBLIC) },
          { ALT: () => this.CONSUME(tokens.PRIVATE) },
          { ALT: () => this.CONSUME(tokens.PROTECTED) },
        ],
        IGNORE_AMBIGUITIES: true,
      });
    });
    this.CONSUME(tokens.Identifier);
    this.CONSUME(tokens.Colon);
    this.SUBRULE(this.dataType);
    // GET and/or SET blocks; GET and SET are identifiers, accessors only here
    this.MANY({
      GATE: () =>
        this.isWord(this.LA(1), "GET") || this.isWord(this.LA(1), "SET"),
      DEF: () => {
        this.OR2({
          DEF: [
            {
              GATE: () => this.isWord(this.LA(1), "GET"),
              ALT: () => this.SUBRULE(this.propertyGetter),
            },
            {
              GATE: () => this.isWord(this.LA(1), "SET"),
              ALT: () => this.SUBRULE(this.propertySetter),
            },
          ],
          IGNORE_AMBIGUITIES: true,
        });
      },
    });
    this.CONSUME(tokens.END_PROPERTY);
  });

  /**
   * Property GET accessor
   */
  public propertyGetter = this.RULE("propertyGetter", () => {
    this.CONSUME(tokens.Identifier); // GET
    // An optional declaration part: the accessor's own locals
    this.MANY({
      GATE: (): boolean => this.isVarBlockAhead(),
      DEF: (): CstNode => this.SUBRULE(this.varBlock),
    });
    this.OPTION(() => {
      this.SUBRULE(this.statementList);
    });
    this.CONSUME(tokens.END_GET);
  });

  /**
   * Property SET accessor
   */
  public propertySetter = this.RULE("propertySetter", () => {
    this.CONSUME(tokens.Identifier); // SET
    // An optional declaration part: the accessor's own locals
    this.MANY({
      GATE: (): boolean => this.isVarBlockAhead(),
      DEF: (): CstNode => this.SUBRULE(this.varBlock),
    });
    this.OPTION(() => {
      this.SUBRULE(this.statementList);
    });
    this.CONSUME(tokens.END_SET);
  });

  // ==========================================================================
  // Contextual keyword-as-identifier support (CODESYS compatibility)
  // ==========================================================================

  /**
   * Identifier or contextual keyword.
   * Allows ON, OVERRIDE, ABSTRACT, FINAL to be used as
   * variable/parameter/function names in contexts where they are unambiguous.
   */
  public identifierOrKeyword = this.RULE("identifierOrKeyword", () => {
    this.OR({
      DEF: [
        { ALT: () => this.CONSUME(tokens.Identifier) },
        { ALT: () => this.CONSUME(tokens.ON) },
        { ALT: () => this.CONSUME(tokens.OVERRIDE) },
        { ALT: () => this.CONSUME(tokens.ABSTRACT) },
        { ALT: () => this.CONSUME(tokens.FINAL) },
        // CONTINUE is a statement only where a statement starts (see continueStatement)
        { ALT: () => this.CONSUME(tokens.CONTINUE) },
        // ACTION starts a declaration only before `Name` (see isActionDeclarationAhead)
        { ALT: () => this.CONSUME(tokens.ACTION) },
        // IEC 61131-3 operator keywords that can also be called as functions
        // (e.g. AND(a, b, c), OR(x, y), NOT(z), MOD(a, b), XOR(a, b))
        { ALT: () => this.CONSUME(tokens.AND) },
        { ALT: () => this.CONSUME(tokens.OR) },
        { ALT: () => this.CONSUME(tokens.XOR) },
        { ALT: () => this.CONSUME(tokens.NOT) },
        { ALT: () => this.CONSUME(tokens.MOD) },
      ],
      IGNORE_AMBIGUITIES: true,
    });
  });

  // ==========================================================================
  // Variable declarations
  // ==========================================================================

  /**
   * Variable block (VAR, VAR_INPUT, VAR_OUTPUT, etc.)
   */
  public varBlock = this.RULE("varBlock", () => {
    this.OR([
      { ALT: () => this.CONSUME(tokens.VAR) },
      { ALT: () => this.CONSUME(tokens.VAR_INPUT) },
      { ALT: () => this.CONSUME(tokens.VAR_OUTPUT) },
      { ALT: () => this.CONSUME(tokens.VAR_IN_OUT) },
      { ALT: () => this.CONSUME(tokens.VAR_EXTERNAL) },
      { ALT: () => this.CONSUME(tokens.VAR_GLOBAL) },
      { ALT: () => this.CONSUME(tokens.VAR_TEMP) },
    ]);
    // MANY, not OPTION: IEC and CODESYS both allow a combination, and
    // `VAR RETAIN PERSISTENT` is the form a converted CODESYS project actually
    // carries. Contradictory or repeated qualifiers are a semantic error, not a
    // grammar one — `validateVarModifiers` reports them with a source span,
    // which reads far better than a parser "expecting END_VAR".
    this.MANY2({
      GATE: (): boolean => this.isVarQualifierAhead(),
      DEF: (): void => {
        this.OR2([
          { ALT: (): IToken => this.CONSUME(tokens.CONSTANT) },
          { ALT: (): IToken => this.CONSUME(tokens.RETAIN) },
          { ALT: (): IToken => this.CONSUME(tokens.NON_RETAIN) },
          { ALT: (): IToken => this.CONSUME(tokens.PERSISTENT) },
          // Variable access specifiers (Ed. 3 Table 53, 11a-11d); INTERNAL is
          // no keyword (the MANY2 gate admits it only before a non-declaration).
          { ALT: (): IToken => this.CONSUME(tokens.PUBLIC) },
          { ALT: (): IToken => this.CONSUME(tokens.PRIVATE) },
          { ALT: (): IToken => this.CONSUME(tokens.PROTECTED) },
          { ALT: (): IToken => this.CONSUME(tokens.Identifier) },
        ]);
      },
    });
    this.MANY(() => {
      this.SUBRULE(this.varDeclaration);
    });
    this.CONSUME(tokens.END_VAR);
  });

  /**
   * Single variable declaration
   *
   * IEC 61131-3 puts the `AT %X…` location directive between the
   * variable name and the colon (`v AT %QX0.0 : BOOL;`).  Several
   * real-world editors — OpenPLC among them — emit the location
   * after the type instead (`v : BOOL AT %QX0.0;`).  Accept both
   * forms so the parser doesn't bail on the second form and skip
   * every subsequent declaration in the VAR block.
   *
   * The operand may also be a plain identifier (`v AT Motor_Start :
   * BOOL;`).  That is not IEC: it is an OpenPLC Editor *alias*, a
   * symbolic name for an I/O channel that the editor resolves to a
   * real `%` address before it ever asks for a compile.  The parser
   * accepts it so the editor can use this parser as its single source
   * of truth for reading declarations — it previously had to keep a
   * second, hand-written parser alive purely because this one refused
   * the alias form, and the two drifted apart.
   *
   * Accepting it here does NOT make it compilable: `analyzer.ts`
   * rejects an address that is not a well-formed `%` location, so an
   * alias that reaches a real compile is still an error, and says so.
   */
  public varDeclaration = this.RULE("varDeclaration", () => {
    this.AT_LEAST_ONE_SEP({
      SEP: tokens.Comma,
      DEF: () => this.SUBRULE(this.identifierOrKeyword),
    });
    this.OPTION(() => {
      this.CONSUME(tokens.AT);
      this.OR2([
        { ALT: () => this.CONSUME(tokens.DirectAddress) },
        { ALT: () => this.CONSUME(tokens.Identifier) },
      ]);
    });
    this.CONSUME(tokens.Colon);
    // Optional POINTER TO prefix (for POINTER TO ARRAY[...] OF REAL etc.)
    this.OPTION5(() => {
      this.CONSUME(tokens.POINTER);
      this.CONSUME2(tokens.TO);
    });
    this.OR([
      {
        ALT: () => this.SUBRULE(this.arrayType),
        GATE: () => this.LA(1).tokenType === tokens.ARRAY,
      },
      // Anonymous enumeration: `state : (Idle, Running) := Idle;`
      {
        ALT: (): CstNode => this.SUBRULE(this.inlineEnumType),
        GATE: (): boolean => this.LA(1).tokenType === tokens.LParen,
      },
      {
        ALT: (): void => {
          this.SUBRULE(this.dataType);
          // Anonymous subrange: `level : INT(0..100) := 50;`
          this.OPTION6({
            GATE: () =>
              this.LA(1).tokenType === tokens.LParen && this.isSubrangeAhead(),
            DEF: () => {
              this.CONSUME(tokens.LParen);
              this.SUBRULE(this.subrangeBounds);
              this.CONSUME(tokens.RParen);
            },
          });
        },
      },
    ]);
    // Init arguments of an FB instance, `fb : FB_A(p := 1)` (feature fb_init).
    this.OPTION7({
      GATE: () => this.LA(1).tokenType === tokens.LParen,
      DEF: () => this.SUBRULE(this.fbInitArguments),
    });
    // Non-standard but widely-used: AT directive after the type.
    this.OPTION3(() => {
      this.CONSUME2(tokens.AT);
      this.OR3([
        { ALT: () => this.CONSUME2(tokens.DirectAddress) },
        { ALT: () => this.CONSUME2(tokens.Identifier) },
      ]);
    });
    this.OPTION2(() => {
      this.CONSUME(tokens.Assign);
      this.SUBRULE(this.initializerExpression);
    });
    this.CONSUME(tokens.Semicolon);
  });

  /**
   * Init arguments after an FB instance's type: `(p := 1, q := x)`. Positional
   * and `=>` arguments parse too, so the analyzer can refuse them by name.
   */
  public fbInitArguments = this.RULE("fbInitArguments", () => {
    this.CONSUME(tokens.LParen);
    this.SUBRULE(this.argumentList);
    this.CONSUME(tokens.RParen);
  });

  /**
   * Initializer expression: a single value, or a comma-separated list for the
   * bracket-less array-initialiser form OpenPLC emits.
   * Handles: `x := 5;`, `arr := 0, 31, 59, 90;` and `arr := 4(0), 31;`
   */
  public initializerExpression = this.RULE("initializerExpression", () => {
    this.AT_LEAST_ONE_SEP({
      SEP: tokens.Comma,
      DEF: () => this.SUBRULE(this.arrayInitialElements),
    });
  });

  /**
   * Array literal: `[value, value, ...]`
   *
   * IEC 61131-3 Annex B.1.4.3 `array_initialization`.
   */
  public arrayLiteral = this.RULE("arrayLiteral", () => {
    this.CONSUME(tokens.LBracket);
    this.AT_LEAST_ONE_SEP({
      SEP: tokens.Comma,
      DEF: () => this.SUBRULE(this.arrayInitialElements),
    });
    this.CONSUME(tokens.RBracket);
  });

  /**
   * One entry of an array initialiser: a single value, or a repetition group
   * `count(value)` standing for `count` copies of that value.
   *
   * IEC 61131-3 Annex B.1.4.3 `array_initial_elements`:
   *
   *   arr : ARRAY[0..9] OF INT := [10(0)];
   *   arr : ARRAY[0..4] OF INT := [3(1), 2(5)];
   *   pts : ARRAY[0..1] OF Point := [2((x := 1.0, y := 2.0))];
   *
   * The repeated value is a full expression, so a repetition group may itself
   * hold a structure initializer or a nested array literal.
   */
  public arrayInitialElements = this.RULE("arrayInitialElements", () => {
    this.OR([
      {
        ALT: () => {
          this.CONSUME(tokens.IntegerLiteral);
          this.CONSUME(tokens.LParen);
          this.SUBRULE(this.expression);
          this.CONSUME(tokens.RParen);
        },
        GATE: () => this.isArrayRepetitionAhead(),
      },
      { ALT: () => this.SUBRULE2(this.expression) },
    ]);
  });

  /**
   * Structure initializer: `(field := value, field := value)`
   *
   * IEC 61131-3 Annex B.1.4.3 `structure_initialization`, used to initialise a
   * STRUCT-typed variable (`p : Point := (x := 1.0, y := 2.0)`) or the inputs of
   * a function block instance (`t : TON := (PT := T#1s)`).
   *
   * Reached through `primaryExpression`, which is what lets element values be
   * arbitrary expressions — including a nested structure initializer or an array
   * literal — without a second grammar for initialisers.
   */
  public structInitializer = this.RULE("structInitializer", () => {
    this.CONSUME(tokens.LParen);
    this.AT_LEAST_ONE_SEP({
      SEP: tokens.Comma,
      DEF: () => this.SUBRULE(this.structElementInitializer),
    });
    this.CONSUME(tokens.RParen);
  });

  /**
   * One `element := value` pair of a structure initializer.
   */
  public structElementInitializer = this.RULE(
    "structElementInitializer",
    () => {
      this.SUBRULE(this.identifierOrKeyword);
      this.CONSUME(tokens.Assign);
      this.SUBRULE(this.expression);
    },
  );

  // ==========================================================================
  // Type declarations
  // ==========================================================================

  /**
   * TYPE declaration block
   */
  public typeDeclaration = this.RULE("typeDeclaration", () => {
    this.CONSUME(tokens.TYPE);
    this.MANY(() => {
      this.SUBRULE(this.singleTypeDeclaration);
    });
    this.CONSUME(tokens.END_TYPE);
  });

  /**
   * Single type definition
   * Supports: struct, enum (simple or typed), array, subrange, or alias
   */
  public singleTypeDeclaration = this.RULE("singleTypeDeclaration", () => {
    this.CONSUME(tokens.Identifier);
    // `TYPE X EXTENDS Base : STRUCT`; gated by the feature struct_extends in the analyzer.
    this.OPTION5(() => {
      this.CONSUME(tokens.EXTENDS);
      this.CONSUME2(tokens.Identifier);
    });
    this.CONSUME(tokens.Colon);
    // IGNORE_AMBIGUITIES: ARRAY keyword has LONGER_ALT=Identifier which causes
    // Chevrotain to see ambiguity between arrayType (starts with ARRAY token) and
    // typedEnumOrSubrangeOrAlias (starts with Identifier). The GATE on arrayType
    // ensures correct runtime disambiguation.
    this.OR({
      DEF: [
        { ALT: () => this.SUBRULE(this.structType) },
        // `UNION ... END_UNION`, recognised by spelling only; gated by the feature union in the analyzer.
        {
          ALT: (): CstNode => this.SUBRULE(this.unionType),
          GATE: (): boolean => this.isUnionTypeAhead(),
        },
        { ALT: () => this.SUBRULE(this.simpleEnumType) },
        {
          // POINTER TO ARRAY[...] OF T (must come before bare arrayType)
          ALT: () => {
            this.CONSUME(tokens.POINTER);
            this.CONSUME(tokens.TO);
            this.SUBRULE2(this.arrayType);
          },
          GATE: () =>
            this.LA(1).tokenType === tokens.POINTER &&
            this.LA(2).tokenType === tokens.TO &&
            this.LA(3).tokenType === tokens.ARRAY,
        },
        {
          ALT: () => this.SUBRULE(this.arrayType),
          GATE: () => this.LA(1).tokenType === tokens.ARRAY,
        },
        { ALT: () => this.SUBRULE(this.typedEnumOrSubrangeOrAlias) },
      ],
      IGNORE_AMBIGUITIES: true,
    });
    // Default value carried by the type itself: `Temp : REAL := 25.0;`,
    // `Origin : Point := (x := 0.0, y := 0.0);`. IEC 61131-3 Annex B.1.3.3
    // (`initialized_simple_type_declaration` and friends). Every declaration of
    // the type inherits it unless it supplies its own initialiser.
    this.OPTION4(() => {
      this.CONSUME(tokens.Assign);
      this.SUBRULE(this.initializerExpression);
    });
    // Semicolon is optional after END_STRUCT END_TYPE (CODESYS tolerance)
    this.OPTION3(() => {
      this.CONSUME(tokens.Semicolon);
    });
  });

  /**
   * Structure type definition
   */
  public structType = this.RULE("structType", () => {
    this.CONSUME(tokens.STRUCT);
    this.MANY(() => {
      this.SUBRULE(this.varDeclaration);
    });
    this.CONSUME(tokens.END_STRUCT);
  });

  /**
   * Union type definition: `UNION <fields> END_UNION`. UNION and END_UNION are
   * identifiers, not keywords, so they stay usable as names everywhere else.
   * Entered only when {@link isUnionTypeAhead} holds.
   */
  public unionType = this.RULE("unionType", () => {
    this.CONSUME(tokens.Identifier); // UNION
    this.MANY({
      GATE: (): boolean => !this.isWord(this.LA(1), "END_UNION"),
      DEF: (): CstNode => this.SUBRULE(this.varDeclaration),
    });
    this.CONSUME2(tokens.Identifier); // END_UNION
  });

  /**
   * Simple enumeration type definition: (RED, YELLOW, GREEN)
   * Optionally with default value: (RED, YELLOW, GREEN) := RED, or the
   * type-qualified := E_Color#RED or := E_Color.RED
   * Optionally with a base type after the list: (RED, GREEN) DINT := RED.
   * That order is gated by the feature postfix_enum_base in the analyzer.
   */
  public simpleEnumType = this.RULE("simpleEnumType", () => {
    this.CONSUME(tokens.LParen);
    this.AT_LEAST_ONE_SEP({
      SEP: tokens.Comma,
      DEF: () => this.SUBRULE(this.enumMember),
    });
    this.CONSUME(tokens.RParen);
    // A type name, not the name of the next declaration (`Next : ...`).
    this.OPTION2({
      GATE: () =>
        this.LA(1).tokenType === tokens.Identifier &&
        this.LA(2).tokenType !== tokens.Colon,
      DEF: () => this.SUBRULE(this.dataType),
    });
    this.OPTION(() => {
      this.CONSUME(tokens.Assign);
      this.OR([
        {
          ALT: (): void => {
            this.CONSUME(tokens.Identifier);
            // Dotted default: (RED, GREEN) := E_Color.RED
            this.OPTION3(() => {
              this.CONSUME(tokens.Dot);
              this.CONSUME2(tokens.Identifier);
            });
          },
        },
        // Type-qualified default: (RED, GREEN) := E_Color#RED
        { ALT: (): IToken => this.CONSUME(tokens.EnumLiteral) },
      ]);
    });
  });

  /**
   * Anonymous enumeration inside a declaration: (IDLE, RUNNING := 5). Its
   * default is the declaration's own initializer, so unlike simpleEnumType it
   * takes no `:= member` of its own.
   */
  public inlineEnumType = this.RULE("inlineEnumType", () => {
    this.CONSUME(tokens.LParen);
    this.AT_LEAST_ONE_SEP({
      SEP: tokens.Comma,
      DEF: () => this.SUBRULE(this.enumMember),
    });
    this.CONSUME(tokens.RParen);
  });

  /**
   * Enumeration member: NAME or NAME := value
   */
  public enumMember = this.RULE("enumMember", () => {
    this.CONSUME(tokens.Identifier);
    this.OPTION(() => {
      this.CONSUME(tokens.Assign);
      this.SUBRULE(this.expression);
    });
  });

  /**
   * Typed enumeration, subrange, or simple alias
   * - Typed enum: INT (IDLE := 0, RUNNING := 1)
   * - Subrange: INT(0..100)
   * - Alias: INT
   */
  public typedEnumOrSubrangeOrAlias = this.RULE(
    "typedEnumOrSubrangeOrAlias",
    () => {
      this.SUBRULE(this.dataType);
      this.OPTION(() => {
        this.CONSUME(tokens.LParen);
        this.OR([
          {
            ALT: () => {
              // Subrange: expression..expression
              this.SUBRULE(this.subrangeBounds);
            },
            GATE: () => this.isSubrangeAhead(),
          },
          {
            ALT: () => {
              // Typed enum: member, member, ...
              this.AT_LEAST_ONE_SEP({
                SEP: tokens.Comma,
                DEF: () => this.SUBRULE(this.enumMember),
              });
            },
          },
        ]);
        this.CONSUME(tokens.RParen);
      });
    },
  );

  /**
   * Subrange bounds: expression..expression
   */
  public subrangeBounds = this.RULE("subrangeBounds", () => {
    this.SUBRULE(this.expression);
    this.CONSUME(tokens.DoubleDot);
    this.SUBRULE2(this.expression);
  });

  /**
   * Lookahead helper to detect if we're parsing a subrange (has ..)
   */
  private isSubrangeAhead(): boolean {
    // Look ahead to see if there's a DoubleDot token before RParen or Comma
    const MAX_LOOKAHEAD = 100;
    for (let i = 1; i <= MAX_LOOKAHEAD; i++) {
      const token = this.LA(i);
      if (token === undefined || token.tokenType === tokens.RParen) {
        return false;
      }
      if (token.tokenType === tokens.DoubleDot) {
        return true;
      }
      if (token.tokenType === tokens.Comma) {
        return false;
      }
    }
    return false;
  }

  /**
   * Array type definition
   */
  public arrayType = this.RULE("arrayType", () => {
    this.CONSUME(tokens.ARRAY);
    this.CONSUME(tokens.LBracket);
    this.SUBRULE(this.arrayDimension);
    this.MANY(() => {
      this.CONSUME(tokens.Comma);
      this.SUBRULE2(this.arrayDimension);
    });
    this.CONSUME(tokens.RBracket);
    this.CONSUME(tokens.OF);
    this.SUBRULE(this.dataType);
  });

  /**
   * Array dimension: either fixed bounds (start..end) or variable-length (*)
   */
  public arrayDimension = this.RULE("arrayDimension", () => {
    this.OR([
      {
        ALT: () => {
          // Variable-length: ARRAY[*]
          this.CONSUME(tokens.Star);
        },
      },
      {
        ALT: () => {
          // Fixed bounds: ARRAY[1..10]
          this.SUBRULE(this.expression);
          this.CONSUME(tokens.DoubleDot);
          this.SUBRULE2(this.expression);
        },
      },
    ]);
  });

  /**
   * Data type reference: a type name after any number of reference prefixes
   * (`REF_TO`, `REFERENCE TO`, `POINTER TO`), so `REF_TO REF_TO INT` and
   * `POINTER TO REF_TO INT` keep every level.
   */
  public dataType = this.RULE("dataType", () => {
    this.MANY(() => {
      this.OR([
        { ALT: () => this.CONSUME(tokens.REF_TO) },
        { ALT: () => this.CONSUME(tokens.REFERENCE_TO) },
        {
          ALT: () => {
            this.CONSUME(tokens.POINTER);
            this.CONSUME(tokens.TO);
          },
        },
      ]);
    });
    const typeNameTok = this.CONSUME(tokens.Identifier);
    // Optional parameterized length for STRING(n) / WSTRING(n) / STRING(CONSTANT_NAME)
    // GATE: only when the type name is STRING or WSTRING, consume ( IntegerLiteral ) or ( Identifier )
    // Avoid ( Identifier ) for typed enums and ( IntegerLiteral .. ) for subrange types
    this.OPTION2({
      GATE: () => {
        const name = typeNameTok.image.toUpperCase();
        return (
          (name === "STRING" || name === "WSTRING") &&
          this.LA(1).tokenType === tokens.LParen &&
          ((this.LA(2).tokenType === tokens.IntegerLiteral &&
            this.LA(3).tokenType === tokens.RParen) ||
            (this.LA(2).tokenType === tokens.Identifier &&
              this.LA(3).tokenType === tokens.RParen))
        );
      },
      DEF: () => {
        this.CONSUME(tokens.LParen);
        this.OR4({
          DEF: [
            { ALT: () => this.CONSUME(tokens.IntegerLiteral) },
            { ALT: () => this.CONSUME4(tokens.Identifier) },
          ],
          IGNORE_AMBIGUITIES: true,
        });
        this.CONSUME(tokens.RParen);
      },
    });
    // Ed. 3 spelling of the same length: STRING[n] / WSTRING[n] / STRING[CONSTANT_NAME]
    this.OPTION3({
      GATE: () => {
        const name = typeNameTok.image.toUpperCase();
        // Not after a parenthesised length, and only an Unsigned_Int (no base)
        return (
          (name === "STRING" || name === "WSTRING") &&
          this.LA(0).tokenType !== tokens.RParen &&
          this.LA(1).tokenType === tokens.LBracket &&
          ((this.LA(2).tokenType === tokens.IntegerLiteral &&
            !this.LA(2).image.includes("#")) ||
            this.LA(2).tokenType === tokens.Identifier) &&
          this.LA(3).tokenType === tokens.RBracket
        );
      },
      DEF: () => {
        this.CONSUME(tokens.LBracket);
        this.OR5({
          DEF: [
            { ALT: (): IToken => this.CONSUME2(tokens.IntegerLiteral) },
            { ALT: (): IToken => this.CONSUME5(tokens.Identifier) },
          ],
          IGNORE_AMBIGUITIES: true,
        });
        this.CONSUME(tokens.RBracket);
      },
    });
  });

  // ==========================================================================
  // Configuration
  // ==========================================================================

  /**
   * CONFIGURATION declaration
   */
  public configurationDeclaration = this.RULE(
    "configurationDeclaration",
    () => {
      this.CONSUME(tokens.CONFIGURATION);
      this.CONSUME(tokens.Identifier);
      this.MANY(() => {
        this.OR([
          { ALT: () => this.SUBRULE(this.varBlock) },
          { ALT: () => this.SUBRULE(this.resourceDeclaration) },
        ]);
      });
      this.CONSUME(tokens.END_CONFIGURATION);
    },
  );

  /**
   * RESOURCE declaration
   */
  public resourceDeclaration = this.RULE("resourceDeclaration", () => {
    this.CONSUME(tokens.RESOURCE);
    this.CONSUME(tokens.Identifier);
    this.CONSUME(tokens.ON);
    this.CONSUME2(tokens.Identifier);
    this.MANY(() => {
      this.OR([
        { ALT: (): CstNode => this.SUBRULE(this.varBlock) },
        { ALT: () => this.SUBRULE(this.taskDeclaration) },
        { ALT: () => this.SUBRULE(this.programInstance) },
      ]);
    });
    this.CONSUME(tokens.END_RESOURCE);
  });

  /**
   * TASK declaration
   */
  public taskDeclaration = this.RULE("taskDeclaration", () => {
    this.CONSUME(tokens.TASK);
    this.CONSUME(tokens.Identifier);
    this.CONSUME(tokens.LParen);
    this.MANY_SEP({
      SEP: tokens.Comma,
      DEF: () => {
        this.CONSUME2(tokens.Identifier);
        this.CONSUME(tokens.Assign);
        this.SUBRULE(this.expression);
      },
    });
    this.CONSUME(tokens.RParen);
    this.CONSUME(tokens.Semicolon);
  });

  /**
   * Program instance declaration
   */
  public programInstance = this.RULE("programInstance", () => {
    this.CONSUME(tokens.PROGRAM);
    this.CONSUME(tokens.Identifier);
    this.OPTION(() => {
      this.CONSUME(tokens.WITH);
      this.CONSUME2(tokens.Identifier);
    });
    this.CONSUME(tokens.Colon);
    this.CONSUME3(tokens.Identifier);
    this.CONSUME(tokens.Semicolon);
  });

  // ==========================================================================
  // Statements
  // ==========================================================================

  /**
   * List of statements
   */
  public statementList = this.RULE("statementList", () => {
    this.MANY({
      // an ACTION block after the body ends the statement list
      GATE: () => !this.isActionDeclarationAhead(false),
      DEF: () => {
        this.SUBRULE(this.statement);
      },
    });
  });

  /**
   * Single statement
   */
  public statement = this.RULE("statement", () => {
    this.OR({
      DEF: [
        // `a.b.M();` — before the THIS/SUPER and assignment alternatives,
        // which would claim the chain's first tokens.
        {
          ALT: () => this.SUBRULE(this.memberChainCallStatement),
          GATE: () => this.isMemberChainCallAhead(),
        },
        {
          ALT: () => this.SUBRULE(this.refAssignStatement),
          GATE: () => this.isRefAssignAhead(),
        },
        {
          ALT: () => this.SUBRULE(this.thisStatement),
          GATE: () => this.LA(1).tokenType === tokens.THIS,
        },
        {
          ALT: () => this.SUBRULE(this.superCallStatement),
          GATE: () => this.isSuperAhead(),
        },
        // methodCallStatement must come before assignmentStatement/functionCallStatement
        // since all start with Identifier but methodCall needs Ident.Ident( lookahead
        {
          ALT: () => this.SUBRULE(this.methodCallStatement),
          GATE: () => this.isMethodCallAhead(),
        },
        // `units[0](…)` — invoking an FB instance in an array element. Must also
        // precede assignmentStatement, which would otherwise consume the
        // subscripted variable and then demand `:=`.
        {
          ALT: () => this.SUBRULE(this.instanceCallStatement),
          GATE: () => this.isInstanceCallAhead(),
        },
        // assignmentStatement and functionCallStatement both start with Identifier;
        // Chevrotain resolves by trying assignmentStatement first (it has := after the LHS)
        { ALT: () => this.SUBRULE(this.assignmentStatement) },
        {
          ALT: () => this.SUBRULE(this.ifStatement),
          GATE: () => this.LA(1).tokenType === tokens.IF,
        },
        {
          ALT: () => this.SUBRULE(this.caseStatement),
          GATE: () => this.LA(1).tokenType === tokens.CASE,
        },
        {
          ALT: () => this.SUBRULE(this.forStatement),
          GATE: () => this.LA(1).tokenType === tokens.FOR,
        },
        {
          ALT: () => this.SUBRULE(this.whileStatement),
          GATE: () => this.LA(1).tokenType === tokens.WHILE,
        },
        {
          ALT: () => this.SUBRULE(this.repeatStatement),
          GATE: () => this.LA(1).tokenType === tokens.REPEAT,
        },
        {
          ALT: () => this.SUBRULE(this.exitStatement),
          GATE: () => this.LA(1).tokenType === tokens.EXIT,
        },
        {
          ALT: () => this.SUBRULE(this.continueStatement),
          GATE: () => this.isContinueStatementAhead(),
        },
        {
          ALT: () => this.SUBRULE(this.returnStatement),
          GATE: () => this.LA(1).tokenType === tokens.RETURN,
        },
        {
          ALT: () => this.SUBRULE(this.deleteStatement),
          GATE: () => this.LA(1).tokenType === tokens.__DELETE,
        },
        { ALT: () => this.SUBRULE(this.functionCallStatement) },
        {
          ALT: () => this.SUBRULE(this.externalCodePragma),
          GATE: () => this.LA(1).tokenType === tokens.ExternalPragma,
        },
        {
          ALT: () => this.SUBRULE(this.assertCall),
          GATE: () => this.isAssertAhead(),
        },
        {
          // Empty statement (bare semicolon) — tolerates ELSE; and similar CODESYS patterns
          ALT: () => this.CONSUME2(tokens.Semicolon),
          GATE: () => this.LA(1).tokenType === tokens.Semicolon,
        },
      ],
      IGNORE_AMBIGUITIES: true,
    });
  });

  /**
   * THIS.member := expr; THIS.member REF= var; or THIS.method(args); statement.
   * `THIS^.` is accepted here and gated by the feature self_caret in the analyzer.
   */
  public thisStatement = this.RULE("thisStatement", () => {
    this.CONSUME(tokens.THIS);
    this.OPTION4(() => this.CONSUME(tokens.Caret));
    this.CONSUME(tokens.Dot);
    this.SUBRULE(this.identifierOrKeyword);
    // `THIS.a.b`, `THIS.arr[i]`: further steps of the access path
    this.OPTION5({
      GATE: (): boolean => this.isMemberStepAhead(),
      DEF: () => this.SUBRULE(this.memberSteps),
    });
    // Determine if this is an assignment or method call
    this.OR([
      {
        // Assignment: THIS.member := expression;
        ALT: () => {
          this.CONSUME(tokens.Assign);
          this.SUBRULE(this.expression);
          this.CONSUME(tokens.Semicolon);
        },
      },
      {
        // Reference assignment: THIS.member REF= variable; (feature ref_assign)
        ALT: () => {
          this.CONSUME(tokens.RefAssign);
          this.SUBRULE(this.variable);
          this.CONSUME4(tokens.Semicolon);
        },
      },
      {
        // Method call: THIS.method(args);
        ALT: () => {
          this.CONSUME(tokens.LParen);
          this.OPTION(() => {
            this.SUBRULE(this.argumentList);
          });
          this.CONSUME(tokens.RParen);
          this.CONSUME2(tokens.Semicolon);
        },
      },
      {
        // Simple semicolon: THIS.method; (no-arg call)
        ALT: () => {
          this.CONSUME3(tokens.Semicolon);
        },
      },
    ]);
  });

  /**
   * Lookahead helper to detect if next token starts a VAR block.
   */
  /** A VAR section qualifier next: CONSTANT, RETAIN, ..., or an access specifier. */
  private isVarQualifierAhead(): boolean {
    const t = this.LA(1).tokenType;
    if (
      t === tokens.CONSTANT ||
      t === tokens.RETAIN ||
      t === tokens.NON_RETAIN ||
      t === tokens.PERSISTENT ||
      t === tokens.PUBLIC ||
      t === tokens.PRIVATE ||
      t === tokens.PROTECTED
    ) {
      return true;
    }
    const next = this.LA(2).tokenType;
    return (
      t === tokens.Identifier &&
      this.LA(1).image.toUpperCase() === "INTERNAL" &&
      next !== tokens.Colon &&
      next !== tokens.Comma &&
      next !== tokens.AT
    );
  }

  private isVarBlockAhead(): boolean {
    const t = this.LA(1).tokenType;
    return (
      t === tokens.VAR ||
      t === tokens.VAR_INPUT ||
      t === tokens.VAR_OUTPUT ||
      t === tokens.VAR_IN_OUT ||
      t === tokens.VAR_EXTERNAL ||
      t === tokens.VAR_GLOBAL ||
      t === tokens.VAR_TEMP
    );
  }

  /**
   * Contextual keyword tokens that can also be used as identifiers.
   * Keep in sync with the identifierOrKeyword rule alternatives.
   */
  private static readonly CONTEXTUAL_KEYWORDS: TokenType[] = [
    tokens.ON,
    tokens.OVERRIDE,
    tokens.ABSTRACT,
    tokens.FINAL,
    tokens.CONTINUE,
    tokens.ACTION,
    // IEC 61131-3 operator keywords usable as function names
    tokens.AND,
    tokens.OR,
    tokens.XOR,
    tokens.NOT,
    tokens.MOD,
  ];

  /**
   * Lookahead helper to detect if a token type is an identifier or contextual keyword.
   * Used by isMethodCallAhead() for lookahead decisions.
   */
  private isIdentifierOrKeywordToken(tokenType: TokenType): boolean {
    return (
      tokenType === tokens.Identifier ||
      STParser.CONTEXTUAL_KEYWORDS.includes(tokenType)
    );
  }

  /** True when `token` is an Identifier spelled `word` (any case). */
  private isWord(token: IToken, word: string): boolean {
    return (
      token.tokenType === tokens.Identifier &&
      token.image.toUpperCase() === word
    );
  }

  /**
   * Lookahead helper, after the `:` of a TYPE: does `UNION <fields> END_UNION`
   * start here? `UNION` must be followed by END_UNION or by a field (`name :`,
   * `name ,` or `name AT`), and END_UNION must come before the next END_TYPE,
   * so an alias of a type named UNION (`T : Union;`) still parses as an alias.
   */
  private isUnionTypeAhead(): boolean {
    if (!this.isWord(this.LA(1), "UNION")) return false;
    const second = this.LA(2);
    if (!this.isWord(second, "END_UNION")) {
      const third = this.LA(3).tokenType;
      if (
        !this.isIdentifierOrKeywordToken(second.tokenType) ||
        (third !== tokens.Colon &&
          third !== tokens.Comma &&
          third !== tokens.AT)
      ) {
        return false;
      }
    }
    for (let i = 2; ; i++) {
      const token = this.LA(i);
      if (token.tokenType === EOF || token.tokenType === tokens.END_TYPE) {
        return false;
      }
      if (this.isWord(token, "END_UNION")) return true;
    }
  }

  /**
   * Lookahead helper: does a structure initializer start here?
   *
   * `(NAME :=` can only be `structure_initialization` — `:=` is not an operator
   * inside an expression, so this never competes with a parenthesised
   * expression.
   */
  private isStructInitializerAhead(): boolean {
    return (
      this.LA(1).tokenType === tokens.LParen &&
      this.isIdentifierOrKeywordToken(this.LA(2).tokenType) &&
      this.LA(3).tokenType === tokens.Assign
    );
  }

  /**
   * Lookahead helper: does an array repetition group `count(value)` start here?
   *
   * An integer immediately followed by `(` is never an expression — ST has no
   * implicit multiplication and only an identifier can be called — so this never
   * competes with a function call or a parenthesised sub-expression.
   */
  private isArrayRepetitionAhead(): boolean {
    return (
      this.LA(1).tokenType === tokens.IntegerLiteral &&
      this.LA(2).tokenType === tokens.LParen
    );
  }

  /**
   * Lookahead helper to detect if the current position starts a CASE label.
   * Scans forward looking for a bare Colon (:) before finding Assign (:=),
   * Semicolon, or LParen — which would indicate a statement, not a label.
   * Handles: `42:`, `x:`, `MyEnum.RED:`, `1..5:`
   */
  private isCaseLabelStart(): boolean {
    const la1Type = this.LA(1).tokenType;
    // Case labels must start with a value expression: integer literal,
    // identifier, contextual keyword, typed literal (INT#-7) or typed enum
    // value (E_State#Idle)
    if (
      la1Type !== tokens.IntegerLiteral &&
      la1Type !== tokens.TypedLiteral &&
      la1Type !== tokens.Minus &&
      la1Type !== tokens.EnumLiteral &&
      la1Type !== tokens.CharLiteral &&
      la1Type !== tokens.StringLiteral &&
      la1Type !== tokens.WideStringLiteral &&
      !this.isIdentifierOrKeywordToken(la1Type)
    ) {
      return false;
    }
    // Scan forward looking for Colon before Assign/Semicolon/LParen.
    // 8-token cap covers all realistic label patterns:
    //   42:                → 2 tokens    EnumType.MEMBER:  → 4 tokens
    //   -5:                → 3 tokens    1, 2, 3, 4:       → 8 tokens
    //   1..10:             → 4 tokens
    // The AT_LEAST_ONE_SEP in caseElement handles comma-separated labels
    // internally, so the gate only needs to detect the first label's colon.
    for (let i = 2; i <= 8; i++) {
      const t = this.LA(i).tokenType;
      if (t === tokens.Colon) return true;
      if (
        t === tokens.Assign ||
        t === tokens.Semicolon ||
        t === tokens.LParen ||
        t === tokens.END_CASE ||
        t === tokens.ELSE
      ) {
        return false;
      }
    }
    return false;
  }

  /**
   * CONTINUE starts the statement unless the next token makes it a name
   * (`Continue := x`, `Continue.a`, `Continue[0]`, `Continue(...)`, `Continue^`),
   * so a variable or member named Continue keeps compiling.
   */
  private isContinueStatementAhead(): boolean {
    if (this.LA(1).tokenType !== tokens.CONTINUE) return false;
    const next = this.LA(2).tokenType;
    return (
      next !== tokens.Assign &&
      next !== tokens.RefAssign &&
      next !== tokens.Dot &&
      next !== tokens.LBracket &&
      next !== tokens.LParen &&
      next !== tokens.Caret
    );
  }

  /**
   * ACTION starts a declaration when a name follows (`ACTION Name`; the name may
   * itself be a contextual keyword such as Set or On). The top-level form
   * `ACTION Owner.Name` also needs the dot. Anything else (`action := 1`,
   * `action.x`) is the identifier `action`.
   */
  private isActionDeclarationAhead(topLevel: boolean): boolean {
    if (this.LA(1).tokenType !== tokens.ACTION) return false;
    if (!this.isIdentifierOrKeywordToken(this.LA(2).tokenType)) return false;
    return topLevel ? this.LA(3).tokenType === tokens.Dot : true;
  }

  private isMethodCallAhead(): boolean {
    return (
      this.isIdentifierOrKeywordToken(this.LA(1).tokenType) &&
      this.LA(2).tokenType === tokens.Dot &&
      this.isIdentifierOrKeywordToken(this.LA(3).tokenType) &&
      this.LA(4)?.tokenType === tokens.LParen
    );
  }

  /**
   * Lookahead helper: does a method call through a member chain start here?
   * The chain has at least two field or subscript steps and ends in
   * `.Name(`: `a.b.M(`, `arr[i].M(`, `THIS.f.M(`, `SUPER^.f.M(`. One step
   * (`a.M(`, `THIS.M(`) and `arr[i](` stay with their own rules. A THIS or
   * SUPER root takes field steps only.
   */
  private isMemberChainCallAhead(): boolean {
    const first = this.LA(1).tokenType;
    const selfRoot = first === tokens.THIS || first === tokens.SUPER;
    if (!selfRoot && !this.isIdentifierOrKeywordToken(first)) return false;
    let i = 2;
    if (selfRoot && this.LA(2).tokenType === tokens.Caret) i = 3;
    let steps = 0;
    let lastWasField = false;
    // 256 tokens covers any realistic chain, subscripts included.
    const MAX_LOOKAHEAD = 256;
    while (i <= MAX_LOOKAHEAD) {
      const t = this.LA(i)?.tokenType;
      if (t === undefined) return false;
      if (
        t === tokens.Dot &&
        this.isIdentifierOrKeywordToken(this.LA(i + 1).tokenType)
      ) {
        steps++;
        lastWasField = true;
        i += 2;
      } else if (!selfRoot && t === tokens.Caret) {
        // `p^.M(`: a dereference step
        steps++;
        lastWasField = false;
        i++;
      } else if (!selfRoot && t === tokens.LBracket) {
        let depth = 0;
        for (; i <= MAX_LOOKAHEAD; i++) {
          const inner = this.LA(i)?.tokenType;
          if (inner === undefined || inner === tokens.Semicolon) return false;
          if (inner === tokens.LBracket) depth++;
          else if (inner === tokens.RBracket && --depth === 0) break;
        }
        steps++;
        lastWasField = false;
        i++;
      } else {
        return t === tokens.LParen && lastWasField && steps >= 2;
      }
    }
    return false;
  }

  /**
   * Lookahead helper: does an invocation of a subscripted function block
   * instance start here (`units[0](…)`, `grid[i, j]()`)?
   *
   * Requires the `(` to follow the closing `]` directly, so this claims exactly
   * the array-element invocation and leaves `arr[0].m(…)` — which could equally
   * be a method call on the element — to the existing rules.
   */
  private isInstanceCallAhead(): boolean {
    if (!this.isIdentifierOrKeywordToken(this.LA(1).tokenType)) return false;
    // `pf^(…)`: invoking the function block a pointer or REF_TO points at
    if (
      this.LA(2).tokenType === tokens.Caret &&
      this.LA(3).tokenType === tokens.LParen
    ) {
      return true;
    }
    // `units[0](`, also after field steps (`GVL_A.units[0](`, `a.b[i](`):
    // a path whose last step is a subscript, followed directly by `(`.
    // 64 tokens covers any realistic path and index list.
    const MAX_LOOKAHEAD = 64;
    let i = 2;
    let subscripted = false;
    while (i <= MAX_LOOKAHEAD) {
      const t = this.LA(i)?.tokenType;
      if (t === undefined) return false;
      if (
        t === tokens.Dot &&
        this.isIdentifierOrKeywordToken(this.LA(i + 1).tokenType)
      ) {
        subscripted = false;
        i += 2;
      } else if (t === tokens.LBracket) {
        // Walk to the matching `]`, allowing nested subscripts (`a[b[i]]`)
        let depth = 0;
        for (; i <= MAX_LOOKAHEAD; i++) {
          const inner = this.LA(i)?.tokenType;
          if (inner === undefined || inner === tokens.Semicolon) return false;
          if (inner === tokens.LBracket) depth++;
          else if (inner === tokens.RBracket && --depth === 0) break;
        }
        subscripted = true;
        i++;
      } else {
        return t === tokens.LParen && subscripted;
      }
    }
    return false;
  }

  /**
   * instance.method(args); statement
   */
  public methodCallStatement = this.RULE("methodCallStatement", () => {
    this.SUBRULE(this.identifierOrKeyword); // instance name
    this.CONSUME(tokens.Dot);
    this.SUBRULE2(this.identifierOrKeyword); // method name
    this.CONSUME(tokens.LParen);
    this.OPTION(() => {
      this.SUBRULE(this.argumentList);
    });
    this.CONSUME(tokens.RParen);
    // Method chaining: .method2(args).method3(args)...
    this.MANY(() => {
      this.SUBRULE(this.chainedMethodCall);
    });
    this.CONSUME(tokens.Semicolon);
  });

  /** `a.b.M(args);` — a method call through a member chain as a statement. */
  public memberChainCallStatement = this.RULE(
    "memberChainCallStatement",
    () => {
      this.SUBRULE(this.memberChainCall);
      this.CONSUME(tokens.Semicolon);
    },
  );

  /**
   * A method call through a member chain: `a.b.M(args)`, `arr[i].M(args)`,
   * `THIS.f.M(args)`, `SUPER.f.M(args)`. The `variable` holds
   * the chain with the method name as its last field.
   */
  public memberChainCall = this.RULE("memberChainCall", () => {
    this.OPTION(() => {
      this.OR([
        { ALT: () => this.CONSUME(tokens.THIS) },
        { ALT: () => this.CONSUME(tokens.SUPER) },
      ]);
      this.OPTION2(() => this.CONSUME(tokens.Caret));
      this.CONSUME(tokens.Dot);
    });
    this.SUBRULE(this.variable);
    this.CONSUME(tokens.LParen);
    this.OPTION3(() => {
      this.SUBRULE(this.argumentList);
    });
    this.CONSUME(tokens.RParen);
    this.MANY(() => {
      this.SUBRULE(this.chainedMethodCall);
    });
  });

  /**
   * `units[0](args);` — invoke a function block instance held in an array
   * element. IEC 61131-3 allows an array of function block instances, and an
   * element is invoked like any other instance.
   */
  public instanceCallStatement = this.RULE("instanceCallStatement", () => {
    this.SUBRULE(this.variable);
    this.CONSUME(tokens.LParen);
    this.OPTION(() => {
      this.SUBRULE(this.argumentList);
    });
    this.CONSUME(tokens.RParen);
    this.CONSUME(tokens.Semicolon);
  });

  /**
   * SUPER.method(args); (IEC) or the caret forms SUPER^(); and SUPER^.method(args);
   */
  public superCallStatement = this.RULE("superCallStatement", () => {
    this.CONSUME(tokens.SUPER);
    this.OR([
      {
        // SUPER(); — parent body call (Ed. 3 form)
        GATE: (): boolean => this.LA(1).tokenType === tokens.LParen,
        ALT: (): void => {
          this.CONSUME2(tokens.LParen);
          this.OPTION2(() => this.SUBRULE2(this.argumentList));
          this.CONSUME2(tokens.RParen);
        },
      },
      {
        GATE: (): boolean => this.LA(1).tokenType === tokens.Caret,
        ALT: (): void => {
          this.CONSUME(tokens.Caret);
          this.OR2([
            {
              // SUPER^(); — parent body call
              GATE: (): boolean => this.LA(1).tokenType === tokens.LParen,
              ALT: (): void => {
                this.CONSUME(tokens.LParen);
                this.OPTION(() => this.SUBRULE(this.argumentList));
                this.CONSUME(tokens.RParen);
              },
            },
            {
              // SUPER^.method(args);
              ALT: (): CstNode => this.SUBRULE(this.superMemberTail),
            },
          ]);
        },
      },
      {
        // SUPER.method(args);
        ALT: (): CstNode => this.SUBRULE2(this.superMemberTail),
      },
    ]);
    // SUPER.member := expr; SUPER.member REF= variable;
    this.OPTION3(() => {
      this.OR3([
        {
          ALT: (): void => {
            this.CONSUME(tokens.Assign);
            this.SUBRULE(this.expression);
          },
        },
        {
          ALT: (): void => {
            this.CONSUME(tokens.RefAssign);
            this.SUBRULE(this.variable);
          },
        },
      ]);
    });
    this.CONSUME(tokens.Semicolon);
  });

  /** Further steps of a THIS or SUPER access path: `.b`, `.0`, `[i, j]`, `^`. */
  public memberSteps = this.RULE("memberSteps", () => {
    this.AT_LEAST_ONE(() => {
      this.OR([
        {
          ALT: (): void => {
            this.CONSUME(tokens.LBracket);
            this.AT_LEAST_ONE_SEP({
              SEP: tokens.Comma,
              DEF: () => this.SUBRULE(this.expression),
            });
            this.CONSUME(tokens.RBracket);
          },
        },
        {
          ALT: (): void => {
            this.CONSUME(tokens.Dot);
            this.OR2({
              DEF: [
                { ALT: (): CstNode => this.SUBRULE(this.identifierOrKeyword) },
                { ALT: (): IToken => this.CONSUME(tokens.IntegerLiteral) },
              ],
              IGNORE_AMBIGUITIES: true,
            });
          },
        },
        { ALT: (): IToken => this.CONSUME(tokens.Caret) },
      ]);
    });
  });

  /** `.member` or `.method(args)` after SUPER or SUPER^. */
  public superMemberTail = this.RULE("superMemberTail", () => {
    this.CONSUME(tokens.Dot);
    this.SUBRULE(this.identifierOrKeyword);
    this.OR([
      {
        GATE: (): boolean => this.LA(1).tokenType === tokens.LParen,
        ALT: (): void => {
          this.CONSUME(tokens.LParen);
          this.OPTION2(() => this.SUBRULE(this.argumentList));
          this.CONSUME(tokens.RParen);
        },
      },
      {
        GATE: (): boolean => this.isMemberStepAhead(),
        ALT: (): CstNode => this.SUBRULE(this.memberSteps),
      },
      { ALT: (): void => undefined },
    ]);
  });

  /** SUPER followed by `^` (caret form) or `.` (IEC form). */
  private isSuperAhead(): boolean {
    if (this.LA(1).tokenType !== tokens.SUPER) return false;
    const next = this.LA(2).tokenType;
    return (
      next === tokens.Caret || next === tokens.Dot || next === tokens.LParen
    );
  }

  /** A further step of an access path next: `.name`, `.0`, `[i]` or `^`. */
  private isMemberStepAhead(): boolean {
    const t = this.LA(1).tokenType;
    return t === tokens.Dot || t === tokens.LBracket || t === tokens.Caret;
  }

  /**
   * External code pragma: {external ... }
   * Content is passed through AS-IS to generated C++ code.
   */
  public externalCodePragma = this.RULE("externalCodePragma", () => {
    this.CONSUME(tokens.ExternalPragma);
  });

  /**
   * Lookahead helper to detect if we're parsing a refAssign statement (has REF=)
   */
  private isRefAssignAhead(): boolean {
    // Look ahead to see if there's a RefAssign token before Semicolon or Assign
    const MAX_LOOKAHEAD = 50;
    for (let i = 1; i <= MAX_LOOKAHEAD; i++) {
      const token = this.LA(i);
      if (token === undefined || token.tokenType === tokens.Semicolon) {
        return false;
      }
      if (token.tokenType === tokens.RefAssign) {
        return true;
      }
      if (token.tokenType === tokens.Assign) {
        return false;
      }
    }
    return false;
  }

  /**
   * REF= assignment statement (bind REFERENCE_TO to a variable)
   */
  public refAssignStatement = this.RULE("refAssignStatement", () => {
    this.SUBRULE(this.variable);
    this.CONSUME(tokens.RefAssign);
    this.SUBRULE2(this.variable);
    this.CONSUME(tokens.Semicolon);
  });

  /**
   * Assignment statement, including CODESYS-style chained assignment
   * `a := b := expr;` (every target on the chain receives the value).
   * Each extra `target :=` is a gated `assignTargetTail`; the BACKTRACK
   * gate distinguishes a chained target from the final RHS expression
   * (both can start with an identifier).
   */
  public assignmentStatement = this.RULE("assignmentStatement", () => {
    this.SUBRULE(this.variable);
    this.CONSUME(tokens.Assign);
    this.MANY({
      GATE: this.BACKTRACK(this.assignTargetTail),
      DEF: () => this.SUBRULE(this.assignTargetTail),
    });
    this.SUBRULE(this.expression);
    this.CONSUME(tokens.Semicolon);
  });

  /** One extra `target :=` link in a chained assignment (`… := target := …`). */
  public assignTargetTail = this.RULE("assignTargetTail", () => {
    this.SUBRULE(this.variable);
    this.CONSUME(tokens.Assign);
  });

  /**
   * IF statement
   */
  public ifStatement = this.RULE("ifStatement", () => {
    this.CONSUME(tokens.IF);
    this.SUBRULE(this.expression);
    this.CONSUME(tokens.THEN);
    this.SUBRULE(this.statementList);
    this.MANY(() => {
      this.CONSUME(tokens.ELSIF);
      this.SUBRULE2(this.expression);
      this.CONSUME2(tokens.THEN);
      this.SUBRULE2(this.statementList);
    });
    this.OPTION(() => {
      this.CONSUME(tokens.ELSE);
      this.SUBRULE3(this.statementList);
    });
    this.CONSUME(tokens.END_IF);
    this.OPTION2(() => {
      this.CONSUME(tokens.Semicolon);
    });
  });

  /**
   * CASE statement
   */
  public caseStatement = this.RULE("caseStatement", () => {
    this.CONSUME(tokens.CASE);
    this.SUBRULE(this.expression);
    this.CONSUME(tokens.OF);
    this.MANY({
      GATE: () => this.isCaseLabelStart(),
      DEF: () => this.SUBRULE(this.caseElement),
    });
    this.OPTION(() => {
      this.CONSUME(tokens.ELSE);
      this.SUBRULE(this.statementList);
    });
    this.CONSUME(tokens.END_CASE);
    this.OPTION2(() => {
      this.CONSUME(tokens.Semicolon);
    });
  });

  /**
   * CASE element (one or more case labels with statements)
   */
  public caseElement = this.RULE("caseElement", () => {
    this.AT_LEAST_ONE_SEP({
      SEP: tokens.Comma,
      DEF: () => this.SUBRULE(this.caseLabel),
    });
    this.CONSUME(tokens.Colon);
    this.SUBRULE(this.caseStatementList);
  });

  /**
   * Statement list inside a CASE element.
   * Stops iterating when the next tokens look like a new case label
   * (identifier/integer followed by Colon), preventing the parser from
   * consuming the next case label as an assignment statement.
   */
  public caseStatementList = this.RULE("caseStatementList", () => {
    this.MANY({
      GATE: () => !this.isCaseLabelStart(),
      DEF: () => this.SUBRULE(this.statement),
    });
  });

  /**
   * Case label (single value or range)
   */
  public caseLabel = this.RULE("caseLabel", () => {
    this.SUBRULE(this.expression);
    this.OPTION(() => {
      this.CONSUME(tokens.DoubleDot);
      this.SUBRULE2(this.expression);
    });
  });

  /**
   * FOR statement
   */
  public forStatement = this.RULE("forStatement", () => {
    this.CONSUME(tokens.FOR);
    this.CONSUME(tokens.Identifier);
    this.CONSUME(tokens.Assign);
    this.SUBRULE(this.expression);
    this.CONSUME(tokens.TO);
    this.SUBRULE2(this.expression);
    this.OPTION(() => {
      this.CONSUME(tokens.BY);
      this.SUBRULE3(this.expression);
    });
    this.CONSUME(tokens.DO);
    this.SUBRULE(this.statementList);
    this.CONSUME(tokens.END_FOR);
    this.OPTION2(() => {
      this.CONSUME(tokens.Semicolon);
    });
  });

  /**
   * WHILE statement
   */
  public whileStatement = this.RULE("whileStatement", () => {
    this.CONSUME(tokens.WHILE);
    this.SUBRULE(this.expression);
    this.CONSUME(tokens.DO);
    this.SUBRULE(this.statementList);
    this.CONSUME(tokens.END_WHILE);
    this.OPTION(() => {
      this.CONSUME(tokens.Semicolon);
    });
  });

  /**
   * REPEAT statement
   */
  public repeatStatement = this.RULE("repeatStatement", () => {
    this.CONSUME(tokens.REPEAT);
    this.SUBRULE(this.statementList);
    this.CONSUME(tokens.UNTIL);
    this.SUBRULE(this.expression);
    this.CONSUME(tokens.END_REPEAT);
    this.OPTION(() => {
      this.CONSUME(tokens.Semicolon);
    });
  });

  /**
   * EXIT statement
   */
  public exitStatement = this.RULE("exitStatement", () => {
    this.CONSUME(tokens.EXIT);
    this.CONSUME(tokens.Semicolon);
  });

  /**
   * CONTINUE statement
   */
  public continueStatement = this.RULE("continueStatement", () => {
    this.CONSUME(tokens.CONTINUE);
    this.CONSUME(tokens.Semicolon);
  });

  /**
   * RETURN statement
   */
  public returnStatement = this.RULE("returnStatement", () => {
    this.CONSUME(tokens.RETURN);
    this.CONSUME(tokens.Semicolon);
  });

  /**
   * Function/FB call as statement
   */
  public functionCallStatement = this.RULE("functionCallStatement", () => {
    this.SUBRULE(this.functionCall);
    this.CONSUME(tokens.Semicolon);
  });

  /**
   * __DELETE(expression) statement - deallocate dynamic memory
   */
  public deleteStatement = this.RULE("deleteStatement", () => {
    this.CONSUME(tokens.__DELETE);
    this.CONSUME(tokens.LParen);
    this.SUBRULE(this.expression);
    this.CONSUME(tokens.RParen);
    this.CONSUME(tokens.Semicolon);
  });

  // ==========================================================================
  // Expressions
  // ==========================================================================

  /**
   * Expression (entry point for expression parsing)
   */
  public expression = this.RULE("expression", () => {
    this.SUBRULE(this.orExpression);
  });

  /**
   * OR expression
   */
  public orExpression = this.RULE("orExpression", () => {
    this.SUBRULE(this.xorExpression);
    this.MANY(() => {
      this.CONSUME(tokens.OR);
      this.SUBRULE2(this.xorExpression);
    });
  });

  /**
   * XOR expression
   */
  public xorExpression = this.RULE("xorExpression", () => {
    this.SUBRULE(this.andExpression);
    this.MANY(() => {
      this.CONSUME(tokens.XOR);
      this.SUBRULE2(this.andExpression);
    });
  });

  /**
   * AND expression
   */
  public andExpression = this.RULE("andExpression", () => {
    this.SUBRULE(this.comparisonExpression);
    this.MANY(() => {
      this.OR([
        { ALT: () => this.CONSUME(tokens.AND) },
        { ALT: () => this.CONSUME(tokens.Ampersand) },
      ]);
      this.SUBRULE2(this.comparisonExpression);
    });
  });

  /**
   * Comparison expression: relational expressions joined by `=` or `<>`.
   * Follows the IEC 61131-3 Annex A grammar: `=` and `<>` bind looser than
   * `<`, `>`, `<=`, `>=`, and both levels repeat left-associatively, so
   * `a < b = c` is `(a < b) = c` and `a = b = c` is `(a = b) = c`.
   */
  public comparisonExpression = this.RULE("comparisonExpression", () => {
    this.SUBRULE(this.relationalExpression);
    this.MANY(() => {
      this.OR([
        { ALT: () => this.CONSUME(tokens.Equal) },
        { ALT: () => this.CONSUME(tokens.NotEqual) },
      ]);
      this.SUBRULE2(this.relationalExpression);
    });
  });

  /**
   * Relational expression: additive expressions joined by `<`, `>`, `<=`
   * or `>=`, left-associative (`a < b < c` is `(a < b) < c`).
   */
  public relationalExpression = this.RULE("relationalExpression", () => {
    this.SUBRULE(this.addExpression);
    this.MANY(() => {
      this.OR([
        { ALT: () => this.CONSUME(tokens.Less) },
        { ALT: () => this.CONSUME(tokens.Greater) },
        { ALT: () => this.CONSUME(tokens.LessEqual) },
        { ALT: () => this.CONSUME(tokens.GreaterEqual) },
      ]);
      this.SUBRULE2(this.addExpression);
    });
  });

  /**
   * Addition/subtraction expression
   */
  public addExpression = this.RULE("addExpression", () => {
    this.SUBRULE(this.mulExpression);
    this.MANY(() => {
      this.OR([
        { ALT: () => this.CONSUME(tokens.Plus) },
        { ALT: () => this.CONSUME(tokens.Minus) },
      ]);
      this.SUBRULE2(this.mulExpression);
    });
  });

  /**
   * Multiplication/division expression
   */
  public mulExpression = this.RULE("mulExpression", () => {
    this.SUBRULE(this.powerExpression);
    this.MANY(() => {
      this.OR([
        { ALT: () => this.CONSUME(tokens.Star) },
        { ALT: () => this.CONSUME(tokens.Slash) },
        { ALT: () => this.CONSUME(tokens.MOD) },
      ]);
      this.SUBRULE2(this.powerExpression);
    });
  });

  /**
   * Power expression
   */
  public powerExpression = this.RULE("powerExpression", () => {
    this.SUBRULE(this.unaryExpression);
    this.OPTION(() => {
      this.CONSUME(tokens.Power);
      this.SUBRULE2(this.unaryExpression);
    });
  });

  /**
   * Unary expression
   */
  public unaryExpression = this.RULE("unaryExpression", () => {
    this.OPTION({
      // When NOT is followed by '(', skip the unary prefix so it falls through
      // to primaryExpression → functionCall, parsing NOT(x) as a function call.
      GATE: () =>
        this.LA(1).tokenType !== tokens.NOT ||
        this.LA(2).tokenType !== tokens.LParen,
      DEF: () => {
        this.OR([
          { ALT: () => this.CONSUME(tokens.NOT) },
          { ALT: () => this.CONSUME(tokens.Minus) },
          { ALT: () => this.CONSUME(tokens.Plus) },
        ]);
      },
    });
    this.SUBRULE(this.primaryExpression);
  });

  /**
   * Primary expression
   */
  public primaryExpression = this.RULE("primaryExpression", () => {
    this.OR({
      DEF: [
        // Typed enumeration value `E_State#Idle`; built as `E_State.Idle`.
        { ALT: (): IToken => this.CONSUME(tokens.EnumLiteral) },
        { ALT: () => this.SUBRULE(this.literal) },
        {
          ALT: () => this.SUBRULE(this.refExpression),
          GATE: () => this.LA(1).tokenType === tokens.REF,
        },
        {
          ALT: () => this.SUBRULE(this.drefExpression),
          GATE: () => this.LA(1).tokenType === tokens.DREF,
        },
        {
          ALT: () => this.SUBRULE(this.newExpression),
          GATE: () => this.LA(1).tokenType === tokens.__NEW,
        },
        {
          ALT: () => this.SUBRULE(this.memberChainCall),
          GATE: () => this.isMemberChainCallAhead(),
        },
        {
          ALT: () => this.SUBRULE(this.thisAccess),
          GATE: () => this.LA(1).tokenType === tokens.THIS,
        },
        {
          ALT: () => this.SUBRULE(this.superAccess),
          GATE: () => this.isSuperAhead(),
        },
        {
          ALT: () => this.SUBRULE(this.methodCall),
          GATE: () => this.isMethodCallAhead(),
        },
        {
          ALT: () => this.SUBRULE(this.arrayLiteral),
          GATE: () => this.LA(1).tokenType === tokens.LBracket,
        },
        // Structure initializer `(field := value, ...)` — must precede the
        // parenthesised-expression alternative below, which would otherwise
        // consume the `(` and then demand `)` at the `:=`.
        {
          ALT: () => this.SUBRULE(this.structInitializer),
          GATE: () => this.isStructInitializerAhead(),
        },
        // functionCall and variable both start with Identifier;
        // functionCall needs Ident( lookahead to disambiguate
        { ALT: () => this.SUBRULE(this.functionCall) },
        { ALT: () => this.SUBRULE(this.variable) },
        {
          ALT: () => {
            this.CONSUME(tokens.LParen);
            this.SUBRULE(this.expression);
            this.CONSUME(tokens.RParen);
          },
          GATE: () => this.LA(1).tokenType === tokens.LParen,
        },
      ],
      IGNORE_AMBIGUITIES: true,
    });
  });

  /**
   * instance.method(args) expression
   */
  public methodCall = this.RULE("methodCall", () => {
    this.SUBRULE(this.identifierOrKeyword); // instance name
    this.CONSUME(tokens.Dot);
    this.SUBRULE2(this.identifierOrKeyword); // method name
    this.CONSUME(tokens.LParen);
    this.OPTION(() => {
      this.SUBRULE(this.argumentList);
    });
    this.CONSUME(tokens.RParen);
    // Method chaining: .method2(args).method3(args)...
    this.MANY(() => {
      this.SUBRULE(this.chainedMethodCall);
    });
  });

  /**
   * Chained method call: .methodName(args)
   * Used inside methodCall/methodCallStatement for fluent interface patterns.
   */
  public chainedMethodCall = this.RULE("chainedMethodCall", () => {
    this.CONSUME(tokens.Dot);
    this.SUBRULE(this.identifierOrKeyword);
    this.CONSUME(tokens.LParen);
    this.OPTION(() => {
      this.SUBRULE(this.argumentList);
    });
    this.CONSUME(tokens.RParen);
  });

  /**
   * THIS.member or THIS.method(args) access; bare THIS^ is the own instance,
   * and bare THIS refers to it (e.g. passed into an interface-typed input).
   * `THIS^.member` is accepted here and gated by the feature self_caret in the analyzer.
   */
  public thisAccess = this.RULE("thisAccess", () => {
    this.CONSUME(tokens.THIS);
    this.OPTION(() => {
      this.OR([
        {
          // THIS^ (dereference - return self), optionally THIS^.member
          GATE: () => this.LA(1).tokenType === tokens.Caret,
          ALT: () => {
            this.CONSUME(tokens.Caret);
            this.OPTION3(() => this.SUBRULE2(this.selfMemberTail));
          },
        },
        {
          // THIS.member or THIS.method(args)
          ALT: () => this.SUBRULE(this.selfMemberTail),
        },
      ]);
    });
  });

  /** `.member` or `.method(args)` after THIS or THIS^. */
  public selfMemberTail = this.RULE("selfMemberTail", () => {
    this.CONSUME(tokens.Dot);
    this.SUBRULE(this.identifierOrKeyword);
    this.OR([
      {
        GATE: (): boolean => this.LA(1).tokenType === tokens.LParen,
        ALT: (): void => {
          this.CONSUME(tokens.LParen);
          this.OPTION2(() => this.SUBRULE(this.argumentList));
          this.CONSUME(tokens.RParen);
        },
      },
      {
        GATE: (): boolean => this.isMemberStepAhead(),
        ALT: (): CstNode => this.SUBRULE(this.memberSteps),
      },
      { ALT: (): void => undefined },
    ]);
  });

  /**
   * SUPER.method(args) or SUPER.member (IEC), or the caret forms SUPER^(),
   * SUPER^.method(args) and SUPER^.member.
   */
  public superAccess = this.RULE("superAccess", () => {
    this.CONSUME(tokens.SUPER);
    this.OR([
      {
        GATE: () => this.LA(1).tokenType === tokens.Caret,
        ALT: () => {
          this.CONSUME(tokens.Caret);
          this.OR2([
            {
              // SUPER^() — parent body call
              GATE: () => this.LA(1).tokenType === tokens.LParen,
              ALT: () => {
                this.CONSUME(tokens.LParen);
                this.OPTION(() => this.SUBRULE(this.argumentList));
                this.CONSUME(tokens.RParen);
              },
            },
            {
              // SUPER^.method(args) or SUPER^.member
              ALT: () => this.SUBRULE(this.superMemberTail),
            },
          ]);
        },
      },
      {
        // SUPER.method(args) or SUPER.member
        ALT: () => this.SUBRULE2(this.superMemberTail),
      },
    ]);
  });

  /**
   * REF(variable) expression - get reference to a variable
   */
  public refExpression = this.RULE("refExpression", () => {
    this.CONSUME(tokens.REF);
    this.CONSUME(tokens.LParen);
    this.SUBRULE(this.variable);
    this.CONSUME(tokens.RParen);
  });

  /**
   * DREF(expression) expression - dereference a reference
   */
  public drefExpression = this.RULE("drefExpression", () => {
    this.CONSUME(tokens.DREF);
    this.CONSUME(tokens.LParen);
    this.SUBRULE(this.expression);
    this.CONSUME(tokens.RParen);
  });

  /**
   * __NEW(dataType) or __NEW(dataType, expression) - allocate dynamic memory
   */
  public newExpression = this.RULE("newExpression", () => {
    this.CONSUME(tokens.__NEW);
    this.CONSUME(tokens.LParen);
    this.SUBRULE(this.dataType);
    this.OPTION(() => {
      this.CONSUME(tokens.Comma);
      this.SUBRULE(this.expression);
    });
    this.CONSUME(tokens.RParen);
  });

  /**
   * Variable reference (with optional array subscripts and field access)
   */
  public variable = this.RULE("variable", () => {
    this.SUBRULE(this.identifierOrKeyword);
    this.MANY(() => {
      this.OR([
        {
          ALT: () => {
            this.CONSUME(tokens.LBracket);
            this.AT_LEAST_ONE_SEP({
              SEP: tokens.Comma,
              DEF: () => this.SUBRULE(this.expression),
            });
            this.CONSUME(tokens.RBracket);
          },
        },
        {
          ALT: () => {
            this.CONSUME(tokens.Dot);
            this.OR3({
              DEF: [
                { ALT: () => this.SUBRULE2(this.identifierOrKeyword) },
                // Bit access: var.0, var.31
                { ALT: () => this.CONSUME(tokens.IntegerLiteral) },
              ],
              IGNORE_AMBIGUITIES: true,
            });
          },
        },
        {
          ALT: () => {
            this.CONSUME(tokens.Caret);
          },
        },
      ]);
    });
  });

  /**
   * Function or FB call
   */
  public functionCall = this.RULE("functionCall", () => {
    this.SUBRULE(this.identifierOrKeyword);
    this.CONSUME(tokens.LParen);
    this.OPTION(() => {
      this.SUBRULE(this.argumentList);
    });
    this.CONSUME(tokens.RParen);
  });

  /**
   * Argument list for function calls
   */
  public argumentList = this.RULE("argumentList", () => {
    this.AT_LEAST_ONE_SEP({
      SEP: tokens.Comma,
      DEF: () => this.SUBRULE(this.argument),
    });
  });

  /**
   * Single argument (positional or named)
   */
  public argument = this.RULE("argument", () => {
    this.OPTION(() => {
      this.SUBRULE(this.identifierOrKeyword);
      this.OR([
        { ALT: () => this.CONSUME(tokens.Assign) },
        { ALT: () => this.CONSUME(tokens.OutputAssign) },
      ]);
    });
    this.SUBRULE(this.expression);
  });

  /**
   * Literal value
   */
  public literal = this.RULE("literal", () => {
    this.OR([
      { ALT: () => this.CONSUME(tokens.TRUE) },
      { ALT: () => this.CONSUME(tokens.FALSE) },
      { ALT: () => this.CONSUME(tokens.TypedLiteral) },
      { ALT: () => this.CONSUME(tokens.IntegerLiteral) },
      { ALT: () => this.CONSUME(tokens.RealLiteral) },
      { ALT: () => this.CONSUME(tokens.StringLiteral) },
      { ALT: () => this.CONSUME(tokens.WideStringLiteral) },
      { ALT: (): IToken => this.CONSUME(tokens.CharLiteral) },
      { ALT: () => this.CONSUME(tokens.TimeLiteral) },
      { ALT: () => this.CONSUME(tokens.DateLiteral) },
      { ALT: () => this.CONSUME(tokens.TimeOfDayLiteral) },
      { ALT: () => this.CONSUME(tokens.DateTimeLiteral) },
      { ALT: () => this.CONSUME(tokens.NULL) },
    ]);
  });

  // ==========================================================================
  // Test file rules (used only when parsing test files)
  // ==========================================================================

  /**
   * Top-level rule for test files: optional SETUP, optional TEARDOWN, then TEST blocks
   */
  public testFile = this.RULE("testFile", () => {
    this.OPTION(() => {
      this.SUBRULE(this.setupBlock);
    });
    this.OPTION2(() => {
      this.SUBRULE(this.teardownBlock);
    });
    this.MANY(() => {
      this.SUBRULE(this.testCase);
    });
  });

  /**
   * SETUP ... END_SETUP block with optional VAR declarations and statements
   */
  public setupBlock = this.RULE("setupBlock", () => {
    this.CONSUME(tokens.SETUP);
    this.MANY(() => {
      this.SUBRULE(this.varBlock);
    });
    this.SUBRULE(this.testStatementList);
    this.CONSUME(tokens.END_SETUP);
  });

  /**
   * TEARDOWN ... END_TEARDOWN block
   */
  public teardownBlock = this.RULE("teardownBlock", () => {
    this.CONSUME(tokens.TEARDOWN);
    this.SUBRULE(this.testStatementList);
    this.CONSUME(tokens.END_TEARDOWN);
  });

  /**
   * Individual TEST block
   */
  public testCase = this.RULE("testCase", () => {
    this.CONSUME(tokens.TEST);
    this.CONSUME(tokens.StringLiteral); // Test name
    this.MANY(() => {
      this.SUBRULE(this.varBlock);
    });
    this.SUBRULE(this.testStatementList);
    this.CONSUME(tokens.END_TEST);
  });

  /**
   * List of statements inside a test block (includes assert calls)
   */
  public testStatementList = this.RULE("testStatementList", () => {
    this.MANY(() => {
      this.SUBRULE(this.testStatement);
    });
  });

  /**
   * Single statement inside a test block: assert call, mock statement, or regular statement
   */
  public testStatement = this.RULE("testStatement", () => {
    this.OR({
      DEF: [
        {
          ALT: () => this.SUBRULE(this.assertCall),
          GATE: () => this.isAssertAhead(),
        },
        {
          ALT: () => this.SUBRULE(this.advanceTimeStatement),
          GATE: () => this.LA(1).tokenType === tokens.ADVANCE_TIME,
        },
        {
          ALT: () => this.SUBRULE(this.mockVerifyStatement),
          GATE: () => this.isMockVerifyAhead(),
        },
        {
          ALT: () => this.SUBRULE(this.mockStatement),
          GATE: () => this.isMockAhead(),
        },
        { ALT: () => this.SUBRULE(this.statement) },
      ],
      IGNORE_AMBIGUITIES: true,
    });
  });

  /**
   * ADVANCE_TIME(expression) ; - Advance scan-cycle time in tests
   */
  public advanceTimeStatement = this.RULE("advanceTimeStatement", () => {
    this.CONSUME(tokens.ADVANCE_TIME);
    this.CONSUME(tokens.LParen);
    this.SUBRULE(this.expression);
    this.CONSUME(tokens.RParen);
    this.CONSUME(tokens.Semicolon);
  });

  /**
   * Assert function call (all assert types)
   */
  public assertCall = this.RULE("assertCall", () => {
    this.OR([
      { ALT: () => this.CONSUME(tokens.ASSERT_EQ) },
      { ALT: () => this.CONSUME(tokens.ASSERT_NEQ) },
      { ALT: () => this.CONSUME(tokens.ASSERT_TRUE) },
      { ALT: () => this.CONSUME(tokens.ASSERT_FALSE) },
      { ALT: () => this.CONSUME(tokens.ASSERT_GT) },
      { ALT: () => this.CONSUME(tokens.ASSERT_LT) },
      { ALT: () => this.CONSUME(tokens.ASSERT_GE) },
      { ALT: () => this.CONSUME(tokens.ASSERT_LE) },
      { ALT: () => this.CONSUME(tokens.ASSERT_NEAR) },
    ]);
    this.CONSUME(tokens.LParen);
    this.SUBRULE(this.expression);
    this.MANY(() => {
      this.CONSUME(tokens.Comma);
      this.SUBRULE2(this.expression);
    });
    this.CONSUME(tokens.RParen);
    this.CONSUME(tokens.Semicolon);
  });

  /**
   * Lookahead helper to detect if next token is an ASSERT_* keyword
   */
  private isAssertAhead(): boolean {
    const t = this.LA(1).tokenType;
    return (
      t === tokens.ASSERT_EQ ||
      t === tokens.ASSERT_NEQ ||
      t === tokens.ASSERT_TRUE ||
      t === tokens.ASSERT_FALSE ||
      t === tokens.ASSERT_GT ||
      t === tokens.ASSERT_LT ||
      t === tokens.ASSERT_GE ||
      t === tokens.ASSERT_LE ||
      t === tokens.ASSERT_NEAR
    );
  }

  // ==========================================================================
  // Mock framework rules (used only when parsing test files)
  // ==========================================================================

  /**
   * Mock statement: MOCK instance.path ; or MOCK_FUNCTION FuncName RETURNS expr ;
   */
  public mockStatement = this.RULE("mockStatement", () => {
    this.OR([
      {
        // MOCK_FUNCTION FuncName RETURNS expression ;
        ALT: () => {
          this.CONSUME(tokens.MOCK_FUNCTION);
          this.CONSUME(tokens.Identifier);
          this.CONSUME(tokens.RETURNS);
          this.SUBRULE(this.expression);
          this.CONSUME(tokens.Semicolon);
        },
        GATE: () => this.LA(1).tokenType === tokens.MOCK_FUNCTION,
      },
      {
        // MOCK instance.path ;
        ALT: () => {
          this.CONSUME2(tokens.MOCK);
          this.SUBRULE(this.qualifiedIdentifier);
          this.CONSUME2(tokens.Semicolon);
        },
      },
    ]);
  });

  /**
   * Mock verification statements
   */
  public mockVerifyStatement = this.RULE("mockVerifyStatement", () => {
    this.OR([
      {
        // MOCK_VERIFY_CALL_COUNT(instance.path, count);
        ALT: () => {
          this.CONSUME(tokens.MOCK_VERIFY_CALL_COUNT);
          this.CONSUME(tokens.LParen);
          this.SUBRULE(this.qualifiedIdentifier);
          this.CONSUME(tokens.Comma);
          this.SUBRULE(this.expression);
          this.CONSUME(tokens.RParen);
          this.CONSUME(tokens.Semicolon);
        },
        GATE: () => this.LA(1).tokenType === tokens.MOCK_VERIFY_CALL_COUNT,
      },
      {
        // MOCK_VERIFY_CALLED(instance.path);
        ALT: () => {
          this.CONSUME2(tokens.MOCK_VERIFY_CALLED);
          this.CONSUME2(tokens.LParen);
          this.SUBRULE2(this.qualifiedIdentifier);
          this.CONSUME2(tokens.RParen);
          this.CONSUME2(tokens.Semicolon);
        },
      },
    ]);
  });

  /**
   * Qualified identifier: Identifier (.Identifier)*
   * Used for mock instance paths like ctrl.sensor or ctrl.subsystem.valve
   */
  public qualifiedIdentifier = this.RULE("qualifiedIdentifier", () => {
    this.CONSUME(tokens.Identifier);
    this.MANY(() => {
      this.CONSUME(tokens.Dot);
      this.CONSUME2(tokens.Identifier);
    });
  });

  /**
   * Lookahead helper to detect MOCK or MOCK_FUNCTION
   */
  private isMockAhead(): boolean {
    const t = this.LA(1).tokenType;
    return t === tokens.MOCK || t === tokens.MOCK_FUNCTION;
  }

  /**
   * Lookahead helper to detect MOCK_VERIFY_CALLED or MOCK_VERIFY_CALL_COUNT
   */
  private isMockVerifyAhead(): boolean {
    const t = this.LA(1).tokenType;
    return (
      t === tokens.MOCK_VERIFY_CALLED || t === tokens.MOCK_VERIFY_CALL_COUNT
    );
  }
}

/**
 * Singleton parser instance for source files.
 */
export const parser = new STParser();

/**
 * Singleton parser instance for test files.
 * Uses the test token list which includes TEST/END_TEST/ASSERT_* tokens.
 */
export const testParser = new STParser(tokens.allTestTokens);

/**
 * Parse ST source code into a CST.
 *
 * The lexer skips characters it cannot match and still yields the other
 * tokens, so a lexer error does not stop parsing: the result carries the
 * lexer errors followed by the parser's, and the CST of what was recognised.
 *
 * @param source - The ST source code to parse
 * @returns Parse result with CST, any errors (lexer errors first) and the
 *   skipped pragma tokens
 */
export function parse(source: string): {
  cst: CstNode | null;
  errors: unknown[];
  pragmas: IToken[];
} {
  const lexResult = tokens.tokenize(source);

  parser.input = lexResult.tokens;
  const cst = parser.compilationUnit();

  return {
    cst,
    errors: [...lexResult.errors, ...parser.errors],
    pragmas: lexResult.groups[tokens.PRAGMA_GROUP] ?? [],
  };
}

/**
 * Parse a test file into a CST using the test lexer/parser. Like
 * {@link parse}, it keeps parsing after lexer errors.
 *
 * @param source - The test file source code to parse
 * @returns Parse result with CST and any errors
 */
export function parseTestSource(source: string): {
  cst: CstNode | null;
  errors: unknown[];
  pragmas: IToken[];
} {
  const lexResult = tokens.tokenizeTest(source);

  testParser.input = lexResult.tokens;
  const cst = testParser.testFile();

  return {
    cst,
    errors: [...lexResult.errors, ...testParser.errors],
    pragmas: lexResult.groups[tokens.PRAGMA_GROUP] ?? [],
  };
}
