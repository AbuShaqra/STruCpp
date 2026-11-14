// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * STruC++ Type Code Generator
 *
 * Generates C++ type definitions from user-defined types (TYPE...END_TYPE blocks).
 * Handles structs, enums, arrays, subranges, and type aliases.
 */

import type {
  TypeDeclaration,
  StructDefinition,
  EnumDefinition,
  ArrayDefinition,
  SubrangeDefinition,
  TypeReference,
  Expression,
  LiteralExpression,
  VariableExpression,
  BinaryExpression,
  UnaryExpression,
  FunctionCallExpression,
  ElementaryType,
} from "../frontend/ast.js";
import { charLiteralUnits } from "../literal-utils.js";
import { TypeRegistry, isElementaryType } from "../semantic/type-registry.js";
import {
  dateArithmeticCpp,
  formatArrayType,
  formatIntegerLiteral,
  isComparison,
  isComparisonExpr,
  literalStringComparison,
  isNonZeroIntegerLiteral,
  literalTemporalType,
  translateIECString,
} from "./codegen-utils.js";
import { wrapReferenceChain } from "./reference-types.js";
import { mangledMemberName } from "./member-mangling.js";
import {
  bitPlaceOf,
  bitRunMemberName,
  bitRunTypeName,
  bitRuns,
  type BitRun,
} from "./bit-runs.js";
import {
  parseDateLiteralToDays,
  parseDtLiteralToNs,
  parseTimeLiteral,
  parseTodLiteralToNs,
} from "../project-model.js";
import {
  buildEnumMemberMap,
  implicitEnumBaseName,
  type EnumMemberEntry,
  enumBehindAlias,
  getTypeCategory,
} from "../semantic/type-utils.js";
import {
  generateInitializerValue,
  type StructInitEmitter,
} from "./struct-init-codegen.js";
import {
  unionHelperLines,
  unionStoredTypes,
  unionTypeLines,
  type UnionMemberSpelling,
} from "./union-codegen.js";

/**
 * Options for type code generation
 */
export interface TypeCodeGenOptions {
  indent: string;
  lineEnding: string;
  /** Wrap each generated type's emission with `//@chunk:begin/end:type:<NAME>`
   *  marker comments. Off by default; the library compiler enables it so
   *  it can slice per-symbol chunks for tree-shaking. See
   *  `CodeGenOptions.emitChunkMarkers`. */
  emitChunkMarkers: boolean;
  /** Whether a type name is user-defined, for the shared member-mangling rule
   *  (see `member-mangling.ts`). `CodeGenerator` injects its own resolution,
   *  which also recognises function blocks and programs; standalone use falls
   *  back to "anything that is not elementary", all a bare TypeCodeGenerator
   *  can tell from a list of type declarations. */
  isUserDefinedType: (typeName: string) => boolean;
  /** Member names that hide a user type of their scope (member-mangling.ts). */
  shadowingNames?: ReadonlySet<string> | undefined;
  /** Whether a type name is an INTERFACE: a field or element of one holds a reference (`IEC_ITF`). */
  isInterfaceType?: ((typeName: string) => boolean) | undefined;
  /** The C++ of a call in a STRUCT default, as a body would emit it (`INT_TO_REAL(3)` as `TO_REAL(3)`). */
  callToCpp?: ((call: FunctionCallExpression) => string) | undefined;
}

/**
 * Default type code generation options
 */
export const defaultTypeCodeGenOptions: TypeCodeGenOptions = {
  indent: "    ",
  lineEnding: "\n",
  emitChunkMarkers: false,
  isUserDefinedType: (typeName: string) =>
    !isElementaryType(typeName.toUpperCase()),
};

/**
 * Map IEC elementary type names to C++ type names
 */
const IEC_TO_CPP_TYPE: Record<string, string> = {
  BOOL: "BOOL_t",
  BYTE: "BYTE_t",
  WORD: "WORD_t",
  DWORD: "DWORD_t",
  LWORD: "LWORD_t",
  SINT: "SINT_t",
  INT: "INT_t",
  DINT: "DINT_t",
  LINT: "LINT_t",
  USINT: "USINT_t",
  UINT: "UINT_t",
  UDINT: "UDINT_t",
  ULINT: "ULINT_t",
  __XWORD: "XWORD_t",
  REAL: "REAL_t",
  LREAL: "LREAL_t",
  TIME: "TIME_t",
  DATE: "DATE_t",
  TIME_OF_DAY: "TOD_t",
  TOD: "TOD_t",
  DATE_AND_TIME: "DT_t",
  DT: "DT_t",
  LTIME: "LTIME_t",
  LDATE: "LDATE_t",
  LTOD: "LTOD_t",
  LTIME_OF_DAY: "LTOD_t",
  LDT: "LDT_t",
  LDATE_AND_TIME: "LDT_t",
  CHAR: "CHAR_t",
  WCHAR: "WCHAR_t",
  STRING: "IECString<254>",
  WSTRING: "IECWString<254>",
};

/**
 * Map IEC elementary type names to their IECVar-wrapped C++ type names.
 * Used for struct fields and array elements that need per-element forcing.
 */
export const IEC_TO_CPP_VAR_TYPE: Record<string, string> = {
  BOOL: "IEC_BOOL",
  BYTE: "IEC_BYTE",
  WORD: "IEC_WORD",
  DWORD: "IEC_DWORD",
  LWORD: "IEC_LWORD",
  SINT: "IEC_SINT",
  INT: "IEC_INT",
  DINT: "IEC_DINT",
  LINT: "IEC_LINT",
  USINT: "IEC_USINT",
  UINT: "IEC_UINT",
  UDINT: "IEC_UDINT",
  ULINT: "IEC_ULINT",
  __XWORD: "IEC_XWORD",
  REAL: "IEC_REAL",
  LREAL: "IEC_LREAL",
  TIME: "IEC_TIME",
  DATE: "IEC_DATE",
  TIME_OF_DAY: "IEC_TOD",
  TOD: "IEC_TOD",
  DATE_AND_TIME: "IEC_DT",
  DT: "IEC_DT",
  LTIME: "IEC_LTIME",
  LDATE: "IEC_LDATE",
  LTOD: "IEC_LTOD",
  LTIME_OF_DAY: "IEC_LTOD",
  LDT: "IEC_LDT",
  LDATE_AND_TIME: "IEC_LDT",
  CHAR: "IEC_CHAR",
  WCHAR: "IEC_WCHAR",
};

/**
 * The C++ type of a struct field or type alias declared POINTER TO, which is a
 * raw pointer. `cppType` is the pointee as a single level spells it today;
 * `rawType` is the unwrapped element (`INT_t`, a UDT name). With more levels,
 * the pointee is itself a reference variable, so `POINTER TO POINTER TO INT`
 * is `IEC_Ptr<INT_t>*` and `POINTER TO REF_TO INT` is `IEC_REF_TO<INT_t>*`.
 */
function rawPointerType(
  typeRef: TypeReference,
  cppType: string,
  rawType: string,
): string {
  const chain = typeRef.referenceChain ?? [typeRef.referenceKind];
  if (chain[0] !== "pointer_to") return cppType;
  if (chain.length === 1) return `${cppType}*`;
  return `${wrapReferenceChain(chain.slice(1), rawType)}*`;
}

/** A field or alias whose outermost level is REF_TO or REFERENCE TO. */
function isReferenceField(typeRef: TypeReference): boolean {
  return (
    typeRef.referenceKind === "ref_to" ||
    typeRef.referenceKind === "reference_to"
  );
}

/**
 * The decimal payload of a typed integer literal (`LINT#-5` → `-5`), or
 * undefined for an untyped or based one, which keep their existing lowering.
 */
function typedDecimalPayload(expr: LiteralExpression): string | undefined {
  if ((expr.typePrefix ?? "") === "") return undefined;
  const payload = expr.rawValue.substring(expr.rawValue.indexOf("#") + 1);
  return /^[+-]?[0-9][0-9_]*$/.test(payload) ? payload : undefined;
}

/** BYTE, WORD, DWORD or LWORD: a bit string other than BOOL. */
function isBitStringName(name: string): boolean {
  const upper = name.toUpperCase();
  return getTypeCategory(upper) === "BIT" && upper !== "BOOL";
}

/**
 * Type Code Generator for user-defined types
 */
export class TypeCodeGenerator {
  private options: TypeCodeGenOptions;
  private output: string[] = [];
  /** Track known enum type names (uppercase) so struct fields can use IEC_ wrapper */
  private knownEnumNames: Set<string> = new Set();
  /** Reverse map: enum member name (upper case) → owning enum type */
  private enumMemberToType: Map<string, EnumMemberEntry> = new Map();
  /** STRUCTs and UNIONs stored inside a UNION (upper case), see union-codegen.ts. */
  private unionStored: Set<string> = new Set();

  /**
   * Hooks for structure-initializer lowering (a STRUCT element whose own default
   * is a structure initializer: `origin : Point := (x := 0.0);`).
   *
   * The type generator works from one type definition at a time and has no
   * cross-type field index, so it cannot resolve nested element types or the
   * member-name collision mangle. Nested levels take their type from
   * `decltype(...)` of the member being assigned, which needs no metadata.
   */
  /** Each alias of the unit (upper case) to the type it names, for NOT. */
  private aliasTargets: Map<string, string> = new Map();

  private structInitEmitter: StructInitEmitter = {
    emitValue: (value: Expression): string => this.expressionToCpp(value),
    memberName: (fieldName: string, owner: string | undefined): string =>
      this.bitInitMember(fieldName, owner) ?? fieldName,
    fieldTypeName: (fieldName: string, owner: string | undefined) =>
      this.bitInitFieldType(fieldName, owner),
    arrayElementTypeName: (typeName: string | undefined) =>
      this.bitInitElementType(typeName),
  };
  /** Every type of the unit by upper-case name, for BIT members in initializers. */
  private typesByName: Map<string, TypeDeclaration> = new Map();

  constructor(options: Partial<TypeCodeGenOptions> = {}) {
    this.options = { ...defaultTypeCodeGenOptions, ...options };
  }

  /**
   * Generate C++ type definitions from a type registry.
   * Types are generated in dependency order.
   */
  generateFromRegistry(registry: TypeRegistry): string {
    this.output = [];
    const types = registry.getTypesInDependencyOrder();
    return this.generateTypes(types);
  }

  /**
   * Generate C++ type definitions from an array of type declarations.
   * Assumes types are already in dependency order.
   */
  generateTypes(types: TypeDeclaration[]): string {
    this.useTypeScope(types);
    return this.emitTypeDeclarations(types);
  }

  /**
   * Build the enum lookups (bare member qualification, enum field wrappers)
   * from every type of the unit. Done once, so a type emitted on its own later
   * (codegen emits a STRUCT holding a function block after the FB classes)
   * still qualifies a bare enum member in its initialisers.
   */
  useTypeScope(types: readonly TypeDeclaration[]): void {
    const enums = types.filter((t) => t.definition.kind === "EnumDefinition");
    // An alias of an enumeration is declared with the enumeration's wrapper.
    this.knownEnumNames = new Set(
      types
        .filter((t) => enumBehindAlias(types, t) !== undefined)
        .map((t) => t.name.toUpperCase()),
    );
    this.enumMemberToType = buildEnumMemberMap(
      enums
        .filter((t) => t.inline?.owner === undefined)
        .map((t) => ({
          name: t.name,
          members: (
            t.definition as import("../frontend/ast.js").EnumDefinition
          ).members.map((m) => m.name),
        })),
    );
    this.unionStored = unionStoredTypes(types);
    this.typesByName = new Map(types.map((t) => [t.name.toUpperCase(), t]));
    this.aliasTargets = new Map(
      types.flatMap((t) =>
        t.definition.kind === "TypeReference" &&
        t.definition.arrayDimensions === undefined
          ? [[t.name.toUpperCase(), t.definition.name.toUpperCase()]]
          : [],
      ),
    );
  }

  /** The STRUCT a type name stands for, through aliases. */
  private bitInitStruct(
    typeName: string | undefined,
  ): StructDefinition | undefined {
    let name = typeName;
    for (let depth = 0; depth < 16 && name !== undefined; depth++) {
      const def = this.typesByName.get(name.toUpperCase())?.definition;
      if (def?.kind === "StructDefinition") {
        return def.isUnion === true ? undefined : def;
      }
      if (def?.kind !== "TypeReference") return undefined;
      name = def.name;
    }
    return undefined;
  }

  /** `bits_<n>_.NAME` for a BIT member of `owner` in an initializer. */
  private bitInitMember(
    fieldName: string,
    owner: string | undefined,
  ): string | undefined {
    const def = this.bitInitStruct(owner);
    if (def === undefined) return undefined;
    const place = bitPlaceOf(def.fields, fieldName.toUpperCase());
    if (place === undefined) return undefined;
    const decl = def.fields.find((f) =>
      f.names.some((n) => n.toUpperCase() === fieldName.toUpperCase()),
    )!;
    return `${bitRunMemberName(place.run)}.${this.structFieldEmitName(fieldName, decl.type)}`;
  }

  /** The type of member `fieldName` of `owner`, to find BIT members below it. */
  private bitInitFieldType(
    fieldName: string,
    owner: string | undefined,
  ): string | undefined {
    const decl = this.bitInitStruct(owner)?.fields.find((f) =>
      f.names.some((n) => n.toUpperCase() === fieldName.toUpperCase()),
    );
    if (decl === undefined) return undefined;
    return decl.type.arrayDimensions && decl.type.elementTypeName !== undefined
      ? `__INLINE_ARRAY_${decl.type.elementTypeName}`
      : decl.type.name;
  }

  /** The element type of an ARRAY type name, through aliases. */
  private bitInitElementType(typeName: string | undefined): string | undefined {
    let name = typeName;
    for (let depth = 0; depth < 16 && name !== undefined; depth++) {
      if (name.toUpperCase().startsWith("__INLINE_ARRAY_")) {
        return name.slice("__INLINE_ARRAY_".length);
      }
      const def = this.typesByName.get(name.toUpperCase())?.definition;
      if (def?.kind === "ArrayDefinition") return def.elementType.name;
      if (def?.kind !== "TypeReference") return undefined;
      name = def.name;
    }
    return undefined;
  }

  /** BYTE, WORD, DWORD or LWORD a type name is, through aliases. */
  private bitStringBase(name: string): string | undefined {
    let upper = name.toUpperCase();
    for (let i = 0; i < 32; i++) {
      if (isBitStringName(upper)) return upper;
      const next = this.aliasTargets.get(upper);
      if (next === undefined) return undefined;
      upper = next;
    }
    return undefined;
  }

  /**
   * Emit the given types, in the order given, with the lookups set by
   * `useTypeScope`. `banner` adds the "User-defined types" heading.
   */
  emitTypeDeclarations(
    types: readonly TypeDeclaration[],
    banner = true,
  ): string {
    this.output = [];
    if (types.length === 0) {
      return "";
    }

    if (banner) {
      this.emit("// User-defined types");
      this.emit("");
    }

    for (const type of types) {
      if (this.options.emitChunkMarkers) {
        this.emit(`//@chunk:begin:type:${type.name}`);
      }
      this.generateTypeDeclaration(type);
      if (this.options.emitChunkMarkers) {
        this.emit(`//@chunk:end:type:${type.name}`);
      }
    }

    return this.output.join(this.options.lineEnding);
  }

  /**
   * Generate a single type declaration
   */
  private generateTypeDeclaration(type: TypeDeclaration): void {
    const def = type.definition;

    switch (def.kind) {
      case "StructDefinition":
        if (def.isUnion === true) {
          for (const line of unionTypeLines(
            type.name,
            def,
            this.unionSpelling,
            this.options.indent,
          )) {
            this.emit(line);
          }
        } else {
          this.generateStructType(type.name, def);
        }
        // Struct fields already contain IECVar leaves — identity alias
        this.emit(`using IEC_${type.name} = ${type.name};`);
        this.emit("");
        if (
          def.isUnion === true ||
          this.unionStored.has(type.name.toUpperCase())
        ) {
          for (const line of unionHelperLines(
            type.name,
            def,
            this.unionSpelling,
            this.options.indent,
          )) {
            this.emit(line);
          }
        }
        break;
      case "EnumDefinition":
        this.generateEnumType(type.name, def);
        // Generate IEC_ wrapper for enum variables using IEC_ENUM
        this.emit(`using IEC_${type.name} = IEC_ENUM<${type.name}>;`);
        this.emit("");
        break;
      case "ArrayDefinition":
        this.generateArrayType(type.name, def);
        // Array elements already contain IECVar leaves — identity alias
        this.emit(`using IEC_${type.name} = ${type.name};`);
        this.emit("");
        break;
      case "SubrangeDefinition":
        this.generateSubrangeType(type.name, def);
        // Generate IEC_ wrapper aliasing to base type's wrapper
        this.generateIecWrapperForSubrange(type.name, def);
        break;
      case "TypeReference":
        this.generateTypeAlias(type.name, def);
        // Generate IEC_ wrapper aliasing to base type's wrapper
        this.generateIecWrapperForAlias(type.name, def);
        break;
    }
  }

  /**
   * Generate IEC_ wrapper for a type alias
   */
  private generateIecWrapperForAlias(name: string, def: TypeReference): void {
    const baseName = def.name.toUpperCase();
    if (isElementaryType(baseName)) {
      // Alias to elementary type - use the existing IEC_ wrapper
      this.emit(`using IEC_${name} = IEC_${baseName};`);
    } else if (
      this.knownEnumNames.has(name.toUpperCase()) &&
      def.referenceKind === "none"
    ) {
      // Alias of an enumeration - the wrapper an enumeration variable gets
      this.emit(`using IEC_${name} = IEC_ENUM<${name}>;`);
    } else {
      // Alias to user-defined type - use IECVar wrapper
      this.emit(`using IEC_${name} = IECVar<${name}>;`);
    }
    this.emit("");
  }

  /**
   * Generate IEC_ wrapper for a subrange type
   */
  private generateIecWrapperForSubrange(
    name: string,
    def: SubrangeDefinition,
  ): void {
    const baseName = def.baseType.name.toUpperCase();
    if (isElementaryType(baseName)) {
      // Subrange of elementary type - use the existing IEC_ wrapper
      this.emit(`using IEC_${name} = IEC_${baseName};`);
    } else {
      // Subrange of user-defined type - use IECVar wrapper
      this.emit(`using IEC_${name} = IECVar<${name}>;`);
    }
    this.emit("");
  }

  /** Member spelling for the UNION lowering (union-codegen.ts). */
  private readonly unionSpelling: UnionMemberSpelling = {
    fieldCppType: (type) => this.structFieldCppType(type),
    memberName: (fieldName, type) => this.structFieldEmitName(fieldName, type),
  };

  /** The C++ type of a STRUCT or UNION member: IECVar leaves, arrays, references. */
  private structFieldCppType(type: TypeReference): string {
    let cppType: string;
    if (type.arrayDimensions && type.elementTypeName) {
      // Inline array type: emit Array1D/2D/3D<WrappedElementType, bounds...>
      const elemCpp = this.arrayElementTypeToCpp(
        type.elementTypeName,
        type.elementReferenceChain,
        type.elementMaxLength,
      );
      cppType = formatArrayType(elemCpp, type.arrayDimensions);
    } else {
      cppType = this.mapStructFieldTypeToCpp(type.name, type.maxLength);
    }
    const rawType = type.arrayDimensions ? cppType : this.mapTypeRefToCpp(type);
    return isReferenceField(type)
      ? // REF_TO / REFERENCE TO: the same wrapper a variable gets.
        wrapReferenceChain(type.referenceChain ?? [type.referenceKind], rawType)
      : rawPointerType(type, cppType, rawType);
  }

  /**
   * The C++ name of a STRUCT or UNION member. One rule, shared with the class
   * definition and the debug table — see member-mangling.ts. Compared against
   * the ST type name, not the C++ type (which may carry a pointer '*' suffix).
   * A STRUCT implements no interfaces, so only the type collision can apply.
   */
  private structFieldEmitName(fieldName: string, type: TypeReference): string {
    return mangledMemberName(fieldName, type.name, {
      isUserDefinedType: this.options.isUserDefinedType,
      shadowingNames: this.options.shadowingNames,
    });
  }

  /**
   * Generate a struct type definition
   *
   * ST:
   *   MyStruct : STRUCT
   *     x : INT;
   *     y : REAL;
   *   END_STRUCT;
   *
   * C++:
   *   struct STRUCPP_MAY_ALIAS MyStruct {
   *       INT_t x;
   *       REAL_t y;
   *   };
   *
   * STRUCPP_MAY_ALIAS lets a POINTER TO of another shape read and write the
   * struct's bytes without alias analysis reordering the accesses.
   */
  private generateStructType(name: string, def: StructDefinition): void {
    const runs = bitRuns(def.fields);
    for (const run of runs) this.emitBitRun(name, run);
    this.emit(`struct STRUCPP_MAY_ALIAS ${name} {`);

    for (const field of def.fields) {
      // A run of BIT members: one member holding their bitfields (feature bit_type).
      if (field.type.bit) {
        for (const run of runs.filter((r) => r.first === field)) {
          this.emit(
            `${this.options.indent}${bitRunTypeName(name, run.index)} ${bitRunMemberName(run.index)}{};`,
          );
        }
        continue;
      }
      const cppType = this.structFieldCppType(field.type);
      for (const fieldName of field.names) {
        const emitName = this.structFieldEmitName(fieldName, field.type);
        if (field.initialValue) {
          // Routes composite initialisers (array literals, structure
          // initializers) through the shared lowering and everything else
          // through expressionToCpp. Before this, an array-literal default on a
          // STRUCT element fell through to expressionToCpp's `0` fallback and
          // the `isArrayType` guard below turned it into `{}` — the declared
          // values were dropped with no diagnostic.
          const initVal = generateInitializerValue(
            field.initialValue,
            cppType,
            field.type.name,
            this.structInitEmitter,
          );
          // Array types can't be initialized with = 0; use {} instead
          const isArrayType = /^Array[123]D</.test(cppType);
          if (isArrayType && initVal === "0") {
            this.emit(`${this.options.indent}${cppType} ${emitName}{};`);
          } else {
            this.emit(
              `${this.options.indent}${cppType} ${emitName} = ${initVal};`,
            );
          }
        } else {
          if (field.type.referenceKind === "pointer_to") {
            this.emit(
              `${this.options.indent}${cppType} ${emitName} = nullptr;`,
            );
          } else {
            this.emit(`${this.options.indent}${cppType} ${emitName}{};`);
          }
        }
      }
    }

    this.emit("};");
    this.emit("");
  }

  /**
   * The struct holding one byte of BIT members as `bool` bitfields, packed
   * from the least significant bit; its constructor zeroes the byte and sets
   * their initial values.
   */
  private emitBitRun(owner: string, run: BitRun): void {
    const type = bitRunTypeName(owner, run.index);
    const inits: string[] = [];
    this.emit(`struct STRUCPP_MAY_ALIAS ${type} {`);
    for (const { field, name: fieldName } of run.members) {
      const value = field.initialValue
        ? `static_cast<bool>(${this.expressionToCpp(field.initialValue)})`
        : "false";
      const member = this.structFieldEmitName(fieldName, field.type);
      this.emit(`${this.options.indent}bool ${member} : 1;`);
      inits.push(`${member} = ${value};`);
    }
    // The unused bits of the byte are zero too.
    this.emit(
      `${this.options.indent}${type}() noexcept { std::memset(static_cast<void*>(this), 0, sizeof(*this)); ${inits.join(" ")} }`,
    );
    this.emit("};");
    this.emit("");
  }

  /**
   * Generate an enum type definition
   *
   * Simple enum (stored as INT, or DINT when its values need it):
   *   TrafficLight : (RED, YELLOW, GREEN);
   * C++:
   *   enum class TrafficLight : INT_t { RED, YELLOW, GREEN };
   *
   * Typed enum with explicit values:
   *   State : INT (IDLE := 0, RUNNING := 1, STOPPED := 2);
   * C++:
   *   enum class State : INT_t { IDLE = 0, RUNNING = 1, STOPPED = 2 };
   */
  private generateEnumType(name: string, def: EnumDefinition): void {
    // No declared base: INT (DINT when the values need it), as the debug
    // table assumes; C++ would otherwise pick a 4-byte int.
    const baseType = ` : ${this.mapTypeToCpp(
      def.baseType?.name ?? implicitEnumBaseName(def.members),
    )}`;

    const members = def.members.map((member) => {
      if (member.value) {
        const val = this.expressionToCpp(member.value);
        return `${member.name} = ${val}`;
      }
      return member.name;
    });

    this.emit(`enum class ${name}${baseType} { ${members.join(", ")} };`);
    this.emit("");
  }

  /**
   * Generate an array type definition
   *
   * ST:
   *   IntArray : ARRAY[0..9] OF INT;
   *   Matrix : ARRAY[0..2, 0..2] OF REAL;
   *   OffsetArray : ARRAY[3..7] OF INT;
   *
   * C++:
   *   using IntArray = Array1D<INT_t, 0, 9>;
   *   using Matrix = Array2D<REAL_t, 0, 2, 0, 2>;
   *   using OffsetArray = Array1D<INT_t, 3, 7>;
   *
   * Uses Array1D/2D/3D templates which preserve index bounds for proper
   * IEC 61131-3 array semantics (arrays can have arbitrary start indices).
   */
  private generateArrayType(name: string, def: ArrayDefinition): void {
    const elementKind = def.elementType.referenceKind;
    const elementType = this.arrayElementTypeToCpp(
      def.elementType.name,
      elementKind === undefined || elementKind === "none"
        ? undefined
        : (def.elementType.referenceChain ?? [elementKind]),
      def.elementType.maxLength,
    );
    const numDims = def.dimensions.length;

    // Collect bounds for all dimensions (skip variable-length dimensions)
    const bounds: Array<{ start: number; end: number }> = [];
    for (const dim of def.dimensions) {
      if (dim && !dim.isVariableLength && dim.start && dim.end) {
        const start = this.evaluateConstantExpression(dim.start);
        const end = this.evaluateConstantExpression(dim.end);
        bounds.push({ start, end });
      }
    }

    // Generate appropriate Array template based on dimensions
    let cppType: string;
    if (numDims <= 3 && bounds.length === numDims) {
      cppType = formatArrayType(elementType, bounds);
    } else {
      // Fallback for higher dimensions: use nested std::array (loses bounds info)
      // This maintains backwards compatibility but loses arbitrary index support
      cppType = elementType;
      for (let i = def.dimensions.length - 1; i >= 0; i--) {
        const dim = def.dimensions[i];
        if (dim && !dim.isVariableLength && dim.start && dim.end) {
          const start = this.evaluateConstantExpression(dim.start);
          const end = this.evaluateConstantExpression(dim.end);
          const size = end - start + 1;
          cppType = `std::array<${cppType}, ${size}>`;
        }
      }
    }

    this.emit(`using ${name} = ${cppType};`);
    this.emit("");
  }

  /**
   * Generate a subrange type definition
   *
   * ST:
   *   Percentage : INT(0..100);
   *
   * C++:
   *   using Percentage = INT_t;
   *
   * Note: Runtime bounds checking would be implemented separately.
   * For now, we just create a type alias.
   */
  private generateSubrangeType(name: string, def: SubrangeDefinition): void {
    const baseType = this.mapTypeToCpp(def.baseType.name);
    const lower = this.expressionToCpp(def.lowerBound);
    const upper = this.expressionToCpp(def.upperBound);

    this.emit(`using ${name} = ${baseType};`);
    this.emit(`constexpr ${baseType} ${name}_MIN = ${lower};`);
    this.emit(`constexpr ${baseType} ${name}_MAX = ${upper};`);
    this.emit("");
  }

  /**
   * Generate a type alias
   *
   * ST:
   *   MyInt : INT;
   *
   * C++:
   *   using MyInt = INT_t;
   */
  private generateTypeAlias(name: string, def: TypeReference): void {
    let cppType: string;
    if (def.arrayDimensions && def.elementTypeName) {
      // POINTER TO ARRAY[...] OF T — use array template
      const elemCpp = def.elementReferenceChain
        ? wrapReferenceChain(
            def.elementReferenceChain,
            this.mapTypeToCpp(def.elementTypeName),
          )
        : this.mapTypeToCpp(def.elementTypeName);
      cppType = formatArrayType(elemCpp, def.arrayDimensions);
    } else {
      cppType = this.mapTypeRefToCpp(def);
    }
    const rawType = def.arrayDimensions ? cppType : this.mapTypeRefToCpp(def);
    cppType = isReferenceField(def)
      ? wrapReferenceChain(def.referenceChain ?? [def.referenceKind], rawType)
      : rawPointerType(def, cppType, rawType);
    this.emit(`using ${name} = ${cppType};`);
    this.emit("");
  }

  /**
   * The C++ element type of an array: the IECVar-wrapped type for a value
   * element, or for an element declared POINTER TO / REF_TO the wrapper a
   * variable of that type gets (`IEC_Ptr<INT_t>`).
   */
  private arrayElementTypeToCpp(
    typeName: string,
    referenceChain: readonly string[] | undefined,
    maxLength?: number | string,
  ): string {
    return referenceChain
      ? wrapReferenceChain(
          referenceChain,
          this.mapTypeRefToCpp({
            name: typeName,
            ...(maxLength !== undefined ? { maxLength } : {}),
          }),
        )
      : this.mapStructFieldTypeToCpp(typeName, maxLength);
  }

  /**
   * Map an IEC type name to its C++ equivalent (raw/unwrapped)
   */
  mapTypeToCpp(typeName: string): string {
    const upperName = typeName.toUpperCase();

    if (isElementaryType(upperName)) {
      return IEC_TO_CPP_TYPE[upperName] ?? `${upperName}_t`;
    }

    return typeName;
  }

  /**
   * The raw C++ type a reference names, keeping a declared STRING(n) or
   * WSTRING(n) length: `IECString<10>` for `STRING(10)`.
   */
  mapTypeRefToCpp(type: { name: string; maxLength?: number | string }): string {
    if (type.maxLength !== undefined) {
      const upperName = type.name.toUpperCase();
      if (upperName === "STRING") return `IECString<${type.maxLength}>`;
      if (upperName === "WSTRING") return `IECWString<${type.maxLength}>`;
    }
    return this.mapTypeToCpp(type.name);
  }

  /**
   * Map a type name to its IECVar-wrapped C++ equivalent for struct fields
   * and array elements. Wraps elementary types with IECVar for per-field forcing.
   * Composites (structs, arrays, FBs) use bare names since their fields
   * already contain IECVar leaves.
   */
  mapStructFieldTypeToCpp(
    typeName: string,
    maxLength?: number | string,
  ): string {
    const upperName = typeName.toUpperCase();

    // STRING/WSTRING with optional length → IECStringVar/IECWStringVar (forceable)
    if (upperName === "STRING") {
      const len = maxLength ?? 254;
      return `IECStringVar<${len}>`;
    }
    if (upperName === "WSTRING") {
      const len = maxLength ?? 254;
      return `IECWStringVar<${len}>`;
    }

    // Elementary types → IEC_<TYPE> (IECVar-wrapped)
    if (isElementaryType(upperName)) {
      return IEC_TO_CPP_VAR_TYPE[upperName] ?? `IEC_${upperName}`;
    }

    // Enum types → IEC_<Name> (resolves to IEC_ENUM<Name> via alias)
    if (this.knownEnumNames.has(upperName)) {
      return `IEC_${typeName}`;
    }

    // An INTERFACE field or element holds a nullable reference, as a variable does
    if (this.options.isInterfaceType?.(typeName) === true) {
      return `IEC_ITF<${typeName}>`;
    }

    // Composite types (struct, array, FB) → bare name
    return typeName;
  }

  /**
   * Convert an AST expression to C++ code
   */
  private expressionToCpp(expr: Expression): string {
    switch (expr.kind) {
      case "LiteralExpression":
        return this.literalToCpp(expr);
      case "VariableExpression":
        return this.variableToCpp(expr);
      case "BinaryExpression":
        return this.binaryExprToCpp(expr);
      case "UnaryExpression":
        return this.unaryExprToCpp(expr);
      case "ParenthesizedExpression":
        return `(${this.expressionToCpp(expr.expression)})`;
      case "FunctionCallExpression":
        // `NOT (x)` is parsed as a call: it is the operator NOT on x
        if (
          expr.functionName.toUpperCase() === "NOT" &&
          expr.arguments.length === 1 &&
          expr.arguments[0]!.name === undefined
        ) {
          const arg = expr.arguments[0]!.value;
          return this.notToCpp(arg, `(${this.expressionToCpp(arg)})`);
        }
        {
          // SIZEOF(T) / XSIZEOF(T) of a type: its size, as in a body
          const name = expr.functionName.toUpperCase();
          const arg = expr.arguments[0]?.value;
          if (
            (name === "SIZEOF" || name === "XSIZEOF") &&
            expr.arguments.length === 1 &&
            arg?.kind === "VariableExpression" &&
            arg.namesType === true
          ) {
            const declared = this.typesByName.get(arg.name.toUpperCase());
            return sizeOfTypeCpp(
              this.options.isInterfaceType?.(arg.name) === true
                ? `IEC_ITF<${arg.name}>`
                : this.mapTypeToCpp(arg.name),
              declared?.definition.kind === "StructDefinition"
                ? "struct"
                : undefined,
            );
          }
        }
        // The body's emission maps the name (a conversion, LEN) and its arguments
        if (this.options.callToCpp !== undefined) {
          return this.options.callToCpp(expr);
        }
        // Positional arguments are kept (`LEN('abc')`)
        return expr.arguments.some((a) => a.name !== undefined || a.isOutput)
          ? `${expr.functionName}()`
          : `${expr.functionName}(${expr.arguments
              .map((a) => this.expressionToCpp(a.value))
              .join(", ")})`;
      default:
        return "0";
    }
  }

  private literalToCpp(expr: LiteralExpression): string {
    switch (expr.literalType) {
      case "BOOL":
        return expr.value === true ? "true" : "false";
      case "INT":
        // Same lowering the expression path uses, so a STRUCT element default
        // and the identical literal in a body can't disagree — and so a 64-bit
        // default keeps every digit (`String(expr.value)` rounds above 2^53).
        return formatIntegerLiteral(
          typedDecimalPayload(expr) ?? expr.rawValue,
          expr.value as number,
        );
      case "STRING": {
        // IEC STRING literals carry their surrounding single quotes
        // in `rawValue` (`'wide hello'`); strip them before wrapping
        // in C++ double quotes — otherwise we end up with `"'…'"`.
        // The body then goes through the same `$`-escape translation the
        // expression emitter uses: a literal containing `"` or `\` (OSCAT's
        // HTML-entity tables, for one) would otherwise terminate the C++ string
        // early and fail to compile.
        const inner = expr.rawValue.replace(/^'|'$/g, "");
        return `"${translateIECString(inner)}"`;
      }
      case "WSTRING": {
        // IEC WSTRING literals are double-quoted; strip either form
        // for safety. The C++ prefix is `u` (char16_t) — `L"…"`
        // (wchar_t) is 32-bit on Linux/AVR and wouldn't bind to
        // IECWStringVar's char16_t* ctor.
        const inner = expr.rawValue.replace(/^["']|["']$/g, "");
        return `u"${translateIECString(inner, true)}"`;
      }
      case "REAL": {
        // A decimal point keeps `3.0 / 2.0` a REAL division, as in a body.
        const str = String(expr.value);
        return str.includes(".") || /[eE]/.test(str) ? str : `${str}.0`;
      }
      case "TIME":
      case "LTIME": {
        const timeVal = parseTimeLiteral(String(expr.value));
        return `${timeVal.exact}LL`;
      }
      case "CHAR":
      case "WCHAR": {
        const { wide, units } = charLiteralUnits(expr.rawValue);
        return `static_cast<${wide ? "WCHAR_t" : "CHAR_t"}>(${Math.max(units[0] ?? 0, 0)})`;
      }
      case "DATE":
      case "LDATE":
        return `${parseDateLiteralToDays(String(expr.value))}LL`;
      case "TIME_OF_DAY":
      case "LTIME_OF_DAY":
        return `${parseTodLiteralToNs(String(expr.value))}LL`;
      case "DATE_AND_TIME":
      case "LDATE_AND_TIME":
        return `${parseDtLiteralToNs(String(expr.value))}LL`;
      default:
        return String(expr.value);
    }
  }

  private variableToCpp(expr: VariableExpression): string {
    let result = expr.name;
    const nameUpper = expr.name.toUpperCase();

    // A member of several enums, settled by its target's type.
    if (expr.enumType !== undefined) return `${expr.enumType}::${expr.name}`;

    // Bare enum member: Stopped → Irrigation_State::Stopped
    const enumEntry = this.enumMemberToType.get(nameUpper);
    if (enumEntry?.typeName && expr.fieldAccess.length === 0) {
      return `${enumEntry.typeName}::${expr.name}`;
    }

    // Enum qualified access: TrafficState.RED → TrafficState::RED
    if (this.knownEnumNames.has(nameUpper) && expr.fieldAccess.length === 1) {
      return `${expr.name}::${expr.fieldAccess[0]}`;
    }

    for (const subscript of expr.subscripts) {
      result += `[${this.expressionToCpp(subscript)}]`;
    }

    for (const field of expr.fieldAccess) {
      result += `.${field}`;
    }

    if (expr.isDereference) {
      result = `*${result}`;
    }

    return result;
  }

  private binaryExprToCpp(expr: BinaryExpression): string {
    const left = this.expressionToCpp(expr.left);
    const right = this.expressionToCpp(expr.right);
    // Date arithmetic in a default goes by days, as in a body.
    const temporal = (e: Expression): string | undefined => {
      const t = e.resolvedType;
      return t?.typeKind === "elementary"
        ? (t as ElementaryType).name.toUpperCase()
        : literalTemporalType(e);
    };
    const dated = dateArithmeticCpp(
      expr.operator,
      temporal(expr.left),
      temporal(expr.right),
      left,
      right,
    );
    if (dated !== undefined) return dated;

    const opMap: Record<string, string> = {
      "+": "+",
      "-": "-",
      "*": "*",
      "/": "/",
      MOD: "%",
      "**": "/* pow */",
      AND: "&",
      OR: "|",
      XOR: "^",
      "=": "==",
      "<>": "!=",
      "<": "<",
      ">": ">",
      "<=": "<=",
      ">=": ">=",
    };

    const cppOp = opMap[expr.operator] ?? expr.operator;
    // AND/OR/XOR are bitwise, as in a POU body (BOOL operands included).
    if (["AND", "OR", "XOR"].includes(expr.operator)) {
      return `(${left}) ${cppOp} (${right})`;
    }
    // Parenthesise a comparison nested in a comparison (a chain).
    if (isComparison(expr.operator)) {
      const texts = literalStringComparison(expr.left, expr.right, left, right);
      if (texts !== undefined) return `${texts[0]} ${cppOp} ${texts[1]}`;
      const l = isComparisonExpr(expr.left) ? `(${left})` : left;
      const r = isComparisonExpr(expr.right) ? `(${right})` : right;
      return `${l} ${cppOp} ${r}`;
    }
    // MOD by a divisor that may be 0 gives 0 (Table 29, note e)
    if (expr.operator === "MOD" && !isNonZeroIntegerLiteral(expr.right)) {
      return `iec_mod(${left}, ${right})`;
    }
    return `${left} ${cppOp} ${right}`;
  }

  /**
   * NOT of a typed bit string other than BOOL (an alias included) is its
   * complement in that width, as in a body; any other operand keeps `!`.
   */
  private notToCpp(operandExpr: Expression, operand: string): string {
    const base = this.operandBitString(operandExpr);
    return base === undefined
      ? `!${operand}`
      : `static_cast<${base}_t>(~${operand})`;
  }

  /** The bit string type an operand is known to have: its type, or a typed literal's prefix. */
  private operandBitString(expr: Expression): string | undefined {
    const t = expr.resolvedType;
    if (t?.typeKind === "elementary") {
      return this.bitStringBase((t as ElementaryType).name);
    }
    if (expr.kind === "ParenthesizedExpression") {
      return this.operandBitString(expr.expression);
    }
    // NOT, AND, OR, XOR of a bit string keep its type
    if (expr.kind === "UnaryExpression" && expr.operator === "NOT") {
      return this.operandBitString(expr.operand);
    }
    if (
      expr.kind === "BinaryExpression" &&
      ["AND", "OR", "XOR"].includes(expr.operator)
    ) {
      return (
        this.operandBitString(expr.left) ?? this.operandBitString(expr.right)
      );
    }
    if (expr.kind === "FunctionCallExpression") {
      const name = expr.functionName.toUpperCase();
      const first = expr.arguments[0]?.value;
      // SHL, SHR, ROL, ROR and NOT (x) give IN's type
      if (
        ["SHL", "SHR", "ROL", "ROR", "NOT"].includes(name) &&
        first !== undefined
      ) {
        return this.operandBitString(first);
      }
    }
    if (expr.kind === "LiteralExpression" && (expr.typePrefix ?? "") !== "") {
      return this.bitStringBase(expr.typePrefix!);
    }
    return undefined;
  }

  private unaryExprToCpp(expr: UnaryExpression): string {
    const operand = this.expressionToCpp(expr.operand);
    if (expr.operator === "NOT") return this.notToCpp(expr.operand, operand);

    const opMap: Record<string, string> = {
      NOT: "!",
      "-": "-",
      "+": "+",
    };

    const cppOp = opMap[expr.operator] ?? expr.operator;
    return `${cppOp}${operand}`;
  }

  /**
   * Evaluate a constant expression to a number.
   * Used for array dimension calculations.
   */
  private evaluateConstantExpression(expr: Expression): number {
    switch (expr.kind) {
      case "LiteralExpression":
        if (typeof expr.value === "number") {
          return expr.value;
        }
        return parseInt(String(expr.value), 10) || 0;
      case "UnaryExpression":
        if (expr.operator === "-") {
          return -this.evaluateConstantExpression(expr.operand);
        }
        return this.evaluateConstantExpression(expr.operand);
      case "BinaryExpression": {
        const left = this.evaluateConstantExpression(expr.left);
        const right = this.evaluateConstantExpression(expr.right);
        switch (expr.operator) {
          case "+":
            return left + right;
          case "-":
            return left - right;
          case "*":
            return left * right;
          case "/":
            return Math.floor(left / right);
          case "MOD":
            return right === 0 ? 0 : left % right;
          default:
            return 0;
        }
      }
      default:
        return 0;
    }
  }

  /**
   * Emit a line of output
   */
  private emit(line: string): void {
    this.output.push(line);
  }
}

/**
 * Generate C++ type definitions from a type registry
 */
export function generateTypeCode(
  registry: TypeRegistry,
  options?: Partial<TypeCodeGenOptions>,
): string {
  const generator = new TypeCodeGenerator(options);
  return generator.generateFromRegistry(registry);
}

/**
 * `iec_size_of_type<T>::value`, with `T` spelt so that no member, FUNCTION,
 * METHOD or ACTION of the same name hides it. `classKey` names a STRUCT
 * (`struct`) or a FUNCTION_BLOCK (`class`).
 */
export function sizeOfTypeCpp(
  cppType: string,
  classKey: "struct" | "class" | undefined,
): string {
  const itf = /^IEC_ITF<(\w+)>$/.exec(cppType);
  const spelt =
    itf !== null
      ? `::strucpp::IEC_ITF<class ::strucpp::${itf[1]}>`
      : classKey !== undefined
        ? `${classKey} ::strucpp::${cppType}`
        : /^\w+$/.test(cppType)
          ? `::strucpp::${cppType}`
          : cppType;
  return `strucpp::iec_size_of_type<${spelt}>::value`;
}
