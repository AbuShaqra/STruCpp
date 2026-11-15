// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * The length of a STRING or WSTRING declared without one: 254 by default,
 * 80 with the feature string_default_80. Lowered before semantic analysis,
 * so a plain STRING is exactly STRING(80) in every later rule; the
 * reference keeps `defaultLength` to tell it from a written STRING(80).
 */

import type { FeatureId } from "../dialect.js";
import type { TypeReference } from "../frontend/ast.js";

/** The IEC default length of a STRING or WSTRING with none written. */
export const IEC_DEFAULT_STRING_LENGTH = 254;

/** The default length under the feature string_default_80. */
export const VENDOR_DEFAULT_STRING_LENGTH = 80;

/** The length a STRING or WSTRING with none written has under `features`. */
export function defaultStringLength(features: ReadonlySet<FeatureId>): number {
  return features.has("string_default_80")
    ? VENDOR_DEFAULT_STRING_LENGTH
    : IEC_DEFAULT_STRING_LENGTH;
}

const isString = (name: string | undefined): boolean => {
  const upper = name?.toUpperCase();
  return upper === "STRING" || upper === "WSTRING";
};

/** Give every STRING and WSTRING under `root` written without a length `length`. */
export function lowerDefaultStringLength(root: object, length: number): void {
  const seen = new Set<object>();
  const visit = (node: unknown): void => {
    if (typeof node !== "object" || node === null || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if ((node as { kind?: unknown }).kind === "TypeReference") {
      const ref = node as TypeReference;
      if (
        isString(ref.name) &&
        ref.maxLength === undefined &&
        ref.arrayDimensions === undefined
      ) {
        ref.maxLength = length;
        ref.defaultLength = true;
      }
      if (isString(ref.elementTypeName) && ref.elementMaxLength === undefined) {
        ref.elementMaxLength = length;
        ref.elementDefaultLength = true;
      }
    }
    for (const value of Object.values(node)) visit(value);
  };
  visit(root);
}
