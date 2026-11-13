// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * C++ lowering of UNION types (feature union), on top of
 * runtime/include/iec_union.hpp.
 *
 * A UNION `U_A` becomes a struct holding one zero-initialised byte buffer
 * sized for `U_A_uplain`, a C++ union of every member's plain representation.
 * Each member is an in-place view of the whole buffer (`union_view_t`), so
 * the generated access spelling (`u.f`, `u.arr.at(i)`, `u.st.x`) is the one a
 * STRUCT gets. A STRUCT or UNION held by a UNION (directly or through arrays
 * and STRUCTs) also gets a plain layout (`_uplain`), an in-place view
 * (`_uview<Off, Size>`), a pointer-based ref (`_uref`) and a
 * `union_traits` specialisation that loads and stores it.
 *
 * Nothing here is emitted for a unit that declares no UNION.
 */

import type {
  StructDefinition,
  TypeDeclaration,
  TypeReference,
} from "../frontend/ast.js";
import { bitRunMemberName, bitRunTypeName, bitRuns } from "./bit-runs.js";

/** C++ spelling of a member: its field type and its (mangled) name. */
export interface UnionMemberSpelling {
  fieldCppType: (type: TypeReference) => string;
  memberName: (fieldName: string, type: TypeReference) => string;
}

/** True when `def` is a UNION. */
function isUnion(def: TypeDeclaration["definition"]): boolean {
  return def.kind === "StructDefinition" && def.isUnion === true;
}

/**
 * Upper-case names of the STRUCTs and UNIONs of `types` whose values are
 * stored inside some UNION's storage, through members, array elements and
 * STRUCT fields. Pointer and reference members store only an address, so
 * their targets are not included.
 */
export function unionStoredTypes(
  types: readonly TypeDeclaration[],
): Set<string> {
  const byName = new Map<string, TypeDeclaration>();
  for (const t of types) {
    const upper = t.name.toUpperCase();
    if (!byName.has(upper)) byName.set(upper, t);
  }
  const stored = new Set<string>();

  const visitName = (name: string, seen: Set<string>): void => {
    const upper = name.toUpperCase();
    if (seen.has(upper)) return;
    seen.add(upper);
    const decl = byName.get(upper);
    if (!decl) return;
    const def = decl.definition;
    switch (def.kind) {
      case "StructDefinition":
        stored.add(upper);
        for (const f of def.fields) visitRef(f.type, seen);
        break;
      case "ArrayDefinition":
        visitRef(def.elementType, seen);
        break;
      case "TypeReference":
        visitRef(def, seen);
        break;
      default:
        break;
    }
  };

  const visitRef = (type: TypeReference, seen: Set<string>): void => {
    if ((type.referenceKind ?? "none") !== "none") return;
    if (type.arrayDimensions) {
      if (type.elementReferenceChain || type.elementTypeName === undefined) {
        return;
      }
      visitName(type.elementTypeName, seen);
      return;
    }
    visitName(type.name, seen);
  };

  for (const t of types) {
    if (!isUnion(t.definition)) continue;
    for (const f of (t.definition as StructDefinition).fields) {
      visitRef(f.type, new Set([t.name.toUpperCase()]));
    }
  }
  return stored;
}

/** One member line per declared name, in declaration order. */
function members(
  def: StructDefinition,
  spell: UnionMemberSpelling,
): Array<{ name: string; cpp: string }> {
  return def.fields.flatMap((f) =>
    f.names.map((n) => ({
      name: spell.memberName(n, f.type),
      cpp: spell.fieldCppType(f.type),
    })),
  );
}

/**
 * The members of STRUCT `owner` in a UNION's storage: each run of BIT members
 * (feature bit_type) is one member, its bitfield struct.
 */
function membersWithBitRuns(
  owner: string,
  def: StructDefinition,
  spell: UnionMemberSpelling,
): Array<{ name: string; cpp: string }> {
  const out: Array<{ name: string; cpp: string }> = [];
  const runs = bitRuns(def.fields);
  for (const f of def.fields) {
    if (f.type.bit) {
      for (const run of runs.filter((r) => r.first === f)) {
        out.push({
          name: bitRunMemberName(run.index),
          cpp: bitRunTypeName(owner, run.index),
        });
      }
      continue;
    }
    for (const n of f.names) {
      out.push({
        name: spell.memberName(n, f.type),
        cpp: spell.fieldCppType(f.type),
      });
    }
  }
  return out;
}

/**
 * The union helpers of each BIT run of STRUCT `owner`: plain bytes, traits
 * copying them, and a ref and an in-place view whose members are bit proxies.
 */
function bitRunHelperLines(
  owner: string,
  def: StructDefinition,
  spell: UnionMemberSpelling,
  indent: string,
): string[] {
  const lines: string[] = [];
  const i1 = indent;
  const i2 = indent + indent;
  for (const run of bitRuns(def.fields)) {
    const type = bitRunTypeName(owner, run.index);
    const bits = run.members.map((m) => spell.memberName(m.name, m.field.type));
    const bytes = 1;
    lines.push(`struct ${type}_uref;`);
    lines.push(
      `template<std::size_t Off, std::size_t Size> struct ${type}_uview;`,
    );
    lines.push(`template<> struct union_traits<${type}, void> {`);
    lines.push(
      `${i1}using plain = detail::union_plain_array<unsigned char, ${bytes}>;`,
    );
    lines.push(`${i1}using ref = ${type}_uref;`);
    lines.push(
      `${i1}template<std::size_t Off, std::size_t Size> using view = ${type}_uview<Off, Size>;`,
    );
    lines.push(
      `${i1}static ${type} load(const unsigned char* p) noexcept { ${type} v; std::memcpy(static_cast<void*>(&v), p, ${bytes}); return v; }`,
    );
    lines.push(
      `${i1}static void store(unsigned char* p, const ${type}& v) noexcept { std::memcpy(p, static_cast<const void*>(&v), ${bytes}); }`,
    );
    lines.push("};");
    lines.push(`struct ${type}_uref {`);
    for (const [bit, name] of bits.entries()) {
      lines.push(`${i1}union_bit<${bit}, union_at> ${name};`);
    }
    lines.push(
      `${i1}explicit ${type}_uref(unsigned char* p) noexcept : ${bits.map((n) => `${n}(p)`).join(", ")} {}`,
    );
    lines.push("};");
    lines.push(
      `template<std::size_t Off, std::size_t Size> struct ${type}_uview {`,
    );
    lines.push(`${i1}union {`);
    lines.push(`${i2}unsigned char union_bytes_[Size];`);
    for (const [bit, name] of bits.entries()) {
      lines.push(`${i2}union_bit<${bit}, union_inplace<Off, Size>> ${name};`);
    }
    lines.push(`${i1}};`);
    lines.push(`${i1}${type}_uview() = default;`);
    lines.push(`${i1}${type}_uview(const ${type}_uview&) = default;`);
    lines.push("};");
    lines.push("");
  }
  return lines;
}

/**
 * The owning C++ type of UNION `name`, preceded by its plain layout:
 * `union U_A_uplain {...}; struct U_A { union { bytes; views... }; ... };`
 */
export function unionTypeLines(
  name: string,
  def: StructDefinition,
  spell: UnionMemberSpelling,
  indent: string,
): string[] {
  const ms = members(def, spell);
  const plain = `${name}_uplain`;
  const lines: string[] = [];
  lines.push(`union ${plain} {`);
  for (const m of ms) lines.push(`${indent}union_plain_t<${m.cpp}> ${m.name};`);
  lines.push("};");
  lines.push("");
  lines.push(`struct ${name} {`);
  lines.push(`${indent}union {`);
  lines.push(
    `${indent}${indent}alignas(${plain}) unsigned char union_bytes_[sizeof(${plain})];`,
  );
  for (const m of ms) {
    lines.push(
      `${indent}${indent}union_view_t<${m.cpp}, 0, sizeof(${plain})> ${m.name};`,
    );
  }
  lines.push(`${indent}};`);
  lines.push(
    `${indent}${name}() noexcept { std::memset(union_bytes_, 0, sizeof(union_bytes_)); }`,
  );
  lines.push(
    `${indent}${name}(const ${name}& o) noexcept { std::memcpy(union_bytes_, o.union_bytes_, sizeof(union_bytes_)); }`,
  );
  lines.push(
    `${indent}${name}& operator=(const ${name}& o) noexcept { std::memmove(union_bytes_, o.union_bytes_, sizeof(union_bytes_)); return *this; }`,
  );
  lines.push("};");
  lines.push("");
  return lines;
}

/**
 * The helpers that let STRUCT or UNION `name` live inside a UNION's storage:
 * its plain layout (a STRUCT's; a UNION's was emitted with the type), the
 * `union_traits` specialisation, the ref and the in-place view.
 */
export function unionHelperLines(
  name: string,
  def: StructDefinition,
  spell: UnionMemberSpelling,
  indent: string,
): string[] {
  const ms = membersWithBitRuns(name, def, spell);
  const union = def.isUnion === true;
  const plain = `${name}_uplain`;
  const ref = `${name}_uref`;
  const view = `${name}_uview`;
  const i1 = indent;
  const i2 = indent + indent;
  const at = (m: { name: string }): string =>
    union ? "" : ` + offsetof(${plain}, ${m.name})`;
  const lines: string[] = bitRunHelperLines(name, def, spell, indent);

  if (!union) {
    lines.push(`struct ${plain} {`);
    for (const m of ms) lines.push(`${i1}union_plain_t<${m.cpp}> ${m.name};`);
    lines.push("};");
    lines.push("");
  }
  lines.push(`struct ${ref};`);
  lines.push(`template<std::size_t Off, std::size_t Size> struct ${view};`);
  lines.push("");

  // Traits: load into / store from the IECVar-based type.
  lines.push(`template<> struct union_traits<${name}, void> {`);
  lines.push(`${i1}using plain = ${plain};`);
  lines.push(`${i1}using ref = ${ref};`);
  lines.push(
    `${i1}template<std::size_t Off, std::size_t Size> using view = ${view}<Off, Size>;`,
  );
  lines.push(`${i1}static ${name} load(const unsigned char* p) noexcept {`);
  lines.push(`${i2}${name} v;`);
  if (union) {
    lines.push(`${i2}std::memcpy(v.union_bytes_, p, sizeof(${plain}));`);
  } else {
    for (const m of ms) {
      lines.push(`${i2}v.${m.name} = union_traits<${m.cpp}>::load(p${at(m)});`);
    }
  }
  lines.push(`${i2}return v;`);
  lines.push(`${i1}}`);
  lines.push(
    `${i1}static void store(unsigned char* p, const ${name}& v) noexcept {`,
  );
  if (union) {
    lines.push(`${i2}std::memcpy(p, v.union_bytes_, sizeof(${plain}));`);
  } else {
    for (const m of ms) {
      lines.push(`${i2}union_traits<${m.cpp}>::store(p${at(m)}, v.${m.name});`);
    }
  }
  lines.push(`${i1}}`);
  lines.push("};");
  lines.push("");

  const valueMembers = (cls: string, base: string): void => {
    lines.push(`${i1}using union_proxy_tag = void;`);
    lines.push(`${i1}using union_value_type = ${name};`);
    lines.push(`${i1}using union_plain_type = ${plain};`);
    lines.push(
      `${i1}${name} get() const noexcept { return union_traits<${name}>::load(${base}); }`,
    );
    lines.push(`${i1}operator ${name}() const noexcept { return get(); }`);
    lines.push(
      `${i1}${cls}& operator=(const ${name}& v) noexcept { union_traits<${name}>::store(const_cast<unsigned char*>(${base}), v); return *this; }`,
    );
    lines.push(
      `${i1}${cls}& operator=(const ${cls}& o) noexcept { return *this = o.get(); }`,
    );
    lines.push(
      `${i1}${plain}* operator&() noexcept { return reinterpret_cast<${plain}*>(const_cast<unsigned char*>(${base})); }`,
    );
  };

  // Ref: what a run-time subscript of an array of `name` returns.
  lines.push(`struct ${ref} {`);
  for (const m of ms) lines.push(`${i1}union_ref_t<${m.cpp}> ${m.name};`);
  const inits = ms.map((m) => `${m.name}(p${at(m)})`);
  inits.push("union_ptr_(p)");
  lines.push(
    `${i1}explicit ${ref}(unsigned char* p) noexcept : ${inits.join(", ")} {}`,
  );
  lines.push(`${i1}${ref}(const ${ref}&) = default;`);
  valueMembers(ref, "union_ptr_");
  lines.push("private:");
  lines.push(`${i1}unsigned char* union_ptr_;`);
  lines.push("};");
  lines.push("");

  // View: `name` as a member of a UNION, at offset Off of a Size-byte storage.
  lines.push(`template<std::size_t Off, std::size_t Size> struct ${view} {`);
  lines.push(`${i1}union {`);
  lines.push(`${i2}unsigned char union_bytes_[Size];`);
  for (const m of ms) {
    const off = union ? "Off" : `Off + offsetof(${plain}, ${m.name})`;
    lines.push(`${i2}union_view_t<${m.cpp}, ${off}, Size> ${m.name};`);
  }
  lines.push(`${i1}};`);
  lines.push(`${i1}${view}() = default;`);
  lines.push(`${i1}${view}(const ${view}&) = default;`);
  valueMembers(view, "union_bytes_ + Off");
  lines.push("};");
  lines.push("");
  return lines;
}
