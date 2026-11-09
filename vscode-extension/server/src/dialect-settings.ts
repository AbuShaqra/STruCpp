// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * Dialect selection supplied by the client (`strucpp.dialect` and
 * `strucpp.features` settings).
 *
 * The client passes a whole profile object, never a file or folder: the
 * server reads no profile files. Validation is delegated to the compiler's
 * own `resolveDialect`, so the server accepts exactly what `analyze()` and
 * `compile()` accept.
 */

import {
  resolveDialect,
  type CompileOptions,
  type DialectProfile,
} from "strucpp";

/** Dialect fields merged into every analysis and compile the server runs. */
export interface DialectSettings {
  /** Profile to analyse under; absent means the compiler's own default. */
  dialect?: DialectProfile;
  /** Single-feature overrides (`+id`, `-id` or `id`) applied after the profile. */
  features?: string[];
}

export type DialectSettingsResult =
  | { ok: true; settings: DialectSettings }
  | { ok: false; message: string };

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isPlainObject(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate raw `strucpp.dialect` / `strucpp.features` setting values.
 * `null` and `undefined` mean "not set". Never throws: problems come back
 * as `{ ok: false, message }` carrying the compiler's error text.
 */
export function parseDialectSettings(
  dialect: unknown,
  features: unknown,
): DialectSettingsResult {
  const hasDialect = dialect !== undefined && dialect !== null;
  const hasFeatures = features !== undefined && features !== null;
  if (hasDialect && !isPlainObject(dialect)) {
    return { ok: false, message: "'dialect' must be a profile object" };
  }
  let overrides: string[] | undefined;
  if (hasFeatures) {
    if (!isStringArray(features)) {
      return { ok: false, message: "'features' must be an array of strings" };
    }
    if (features.length > 0) overrides = features;
  }
  // resolveDialect validates the object's shape before it is used as a profile.
  const profile = hasDialect ? (dialect as DialectProfile) : undefined;
  try {
    resolveDialect({
      ...(profile ? { dialect: profile } : {}),
      ...(overrides ? { features: overrides } : {}),
    });
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
  const settings: DialectSettings = {};
  if (profile) settings.dialect = profile;
  if (overrides) settings.features = [...overrides];
  return { ok: true, settings };
}

/** Compile options for a selection; empty (no `dialect` key) when nothing is set. */
export function dialectOptions(
  settings: DialectSettings,
): Pick<Partial<CompileOptions>, "dialect" | "features"> {
  return {
    ...(settings.dialect ? { dialect: settings.dialect } : {}),
    ...(settings.features && settings.features.length > 0
      ? { features: settings.features }
      : {}),
  };
}
