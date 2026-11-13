// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * BIT members of a STRUCT (feature bit_type), in C++. Consecutive BIT members
 * fill bytes from the least significant bit, 8 per byte; a member of another
 * type ends the run. Each byte of a run is one C++ member `bits_<n>_` of a
 * struct type `<STRUCT>_bits<n>` holding up to 8 `bool` bitfields, so it is
 * one byte with alignment 1 and its address is the byte's.
 */

import type { VarDeclaration } from "../frontend/ast.js";

/** One byte of BIT members: up to 8 names, bit 0 first. */
export interface BitRun {
  /** 0 for the first byte of the STRUCT's BIT members. */
  index: number;
  /** The declaration holding the first name of this byte. */
  first: VarDeclaration;
  /** The first name of this byte, as written in `first`. */
  firstName: string;
  members: Array<{ field: VarDeclaration; name: string }>;
}

/** The bytes of BIT members of a STRUCT's fields, in order. */
export function bitRuns(fields: readonly VarDeclaration[]): BitRun[] {
  const runs: BitRun[] = [];
  let current: BitRun | undefined;
  for (const field of fields) {
    if (!field.type.bit) {
      current = undefined;
      continue;
    }
    for (const name of field.names) {
      if (!current || current.members.length === 8) {
        current = {
          index: runs.length,
          first: field,
          firstName: name,
          members: [],
        };
        runs.push(current);
      }
      current.members.push({ field, name });
    }
  }
  return runs;
}

/** C++ type of byte `index` of `owner` (the STRUCT's C++ name). */
export function bitRunTypeName(owner: string, index: number): string {
  return `${owner}_bits${index}`;
}

/** C++ member name of byte `index` in its STRUCT. */
export function bitRunMemberName(index: number): string {
  return `bits_${index}_`;
}

/** Where a BIT member lives: its byte and its bit, 0 the least significant. */
export interface BitPlace {
  run: number;
  bit: number;
}

/** The place of BIT member `fieldUpper` among a STRUCT's fields, or undefined. */
export function bitPlaceOf(
  fields: readonly VarDeclaration[],
  fieldUpper: string,
): BitPlace | undefined {
  for (const run of bitRuns(fields)) {
    const bit = run.members.findIndex(
      (m) => m.name.toUpperCase() === fieldUpper,
    );
    if (bit >= 0) return { run: run.index, bit };
  }
  return undefined;
}
