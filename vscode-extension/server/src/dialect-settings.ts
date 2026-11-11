// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * Dialect selection supplied by the client (`strucpp.dialect`,
 * `strucpp.features` and `strucpp.pragmaDefines` settings).
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
  /** Conditional-pragma defines, name → value (`''` for a bare name). */
  pragmaDefines?: Record<string, string>;
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

const DEFINE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A `pragmaDefines` problem, or undefined when the value is a name → string map. */
function pragmaDefinesProblem(value: object): string | undefined {
  for (const [name, v] of Object.entries(value)) {
    if (!DEFINE_NAME.test(name)) {
      return `'pragmaDefines' key ${JSON.stringify(name)} is not an identifier`;
    }
    if (typeof v !== "string") {
      return `'pragmaDefines' value of ${JSON.stringify(name)} must be a string`;
    }
  }
  return undefined;
}

/**
 * Validate raw `strucpp.dialect` / `strucpp.features` /
 * `strucpp.pragmaDefines` setting values. `null` and `undefined` mean
 * "not set". Never throws: problems come back as `{ ok: false, message }`
 * carrying the compiler's error text.
 */
export function parseDialectSettings(
  dialect: unknown,
  features: unknown,
  pragmaDefines?: unknown,
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
  let defines: Record<string, string> | undefined;
  if (pragmaDefines !== undefined && pragmaDefines !== null) {
    if (!isPlainObject(pragmaDefines)) {
      return { ok: false, message: "'pragmaDefines' must be an object" };
    }
    const problem = pragmaDefinesProblem(pragmaDefines);
    if (problem !== undefined) return { ok: false, message: problem };
    if (Object.keys(pragmaDefines).length > 0) {
      defines = { ...(pragmaDefines as Record<string, string>) };
    }
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
  if (defines) settings.pragmaDefines = defines;
  return { ok: true, settings };
}

/** Compile options for a selection; empty (no `dialect` key) when nothing is set. */
export function dialectOptions(
  settings: DialectSettings,
): Pick<Partial<CompileOptions>, "dialect" | "features" | "pragmaDefines"> {
  return {
    ...(settings.dialect ? { dialect: settings.dialect } : {}),
    ...(settings.features && settings.features.length > 0
      ? { features: settings.features }
      : {}),
    ...(settings.pragmaDefines && Object.keys(settings.pragmaDefines).length > 0
      ? { pragmaDefines: settings.pragmaDefines }
      : {}),
  };
}
