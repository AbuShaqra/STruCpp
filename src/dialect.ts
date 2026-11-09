// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * Dialect profiles: named sets of language features beyond IEC 61131-3.
 *
 * A profile is JSON data (`{id, name, extends?, features, semantics}`) read
 * from `--dialect-file` paths or `--dialect-path` folders, or passed as an
 * object through the library API. This module never touches the file
 * system: callers hand in `readFile`/`listDir` (`strucpp/node` exports
 * `nodeDialectIO`). See docs/DIALECTS.md.
 */

/** Every feature a profile may enable. */
export const KNOWN_FEATURES = [
  "program_methods",
  "pointer_to",
  "reference_to",
  "ref_assign",
  "self_caret",
  "property",
] as const;

export type FeatureId = (typeof KNOWN_FEATURES)[number];

/** Features in effect when no dialect is selected (the compiler's behaviour before profiles). */
export const DEFAULT_FEATURES: ReadonlySet<FeatureId> = new Set<FeatureId>([
  "pointer_to",
  "reference_to",
  "ref_assign",
]);

export interface DialectProfile {
  id: string;
  name: string;
  extends?: string;
  features: FeatureId[];
  semantics: Record<string, never>;
}

/** The built-in root profile `iec-3`: plain IEC 61131-3 Ed. 3, no extra features. */
export const IEC_PROFILE: DialectProfile = {
  id: "iec-3",
  name: "IEC 61131-3 Ed. 3 (2013)",
  features: [],
  semantics: {},
};

/** The retired id of the built-in profile; refused as a selection, a parent and a profile id. */
const RETIRED_IEC_ID = "iec";

/** Suffix for an error about `id`: names `iec-3` when `id` is the retired `iec`. */
function retiredIdHint(id: string): string {
  return id === RETIRED_IEC_ID
    ? `; the IEC 61131-3 Ed. 3 profile is '${IEC_PROFILE.id}'`
    : "";
}

/** A profile that cannot be read, is invalid, or a selection that cannot be resolved. */
export class DialectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DialectError";
  }
}

export interface DialectRequest {
  /** Profile id to select, or a profile object (validated, loaded and selected). */
  dialect?: string | DialectProfile;
  /** Profile files to load; one file and no `dialect` selects it. */
  dialectFiles?: string[];
  /** Folders whose `*.json` files are all loaded and validated. */
  dialectPath?: string[];
  /** `+id`, `-id` or `id` (= `+id`), applied in order after the profile. */
  features?: string[];
}

export interface ResolvedDialect {
  /** Selected profile id, or null when none is selected. */
  id: string | null;
  features: Set<FeatureId>;
  /** Every profile read from files, folders or the request (never the built-in `iec-3`). */
  loaded: DialectProfile[];
}

/** File access used to read profiles (fs-backed on Node). */
export interface DialectIO {
  readFile: (path: string) => string;
  /** Entry names (not paths) in a folder. */
  listDir: (dir: string) => string[];
}

const KNOWN_FEATURE_SET: ReadonlySet<string> = new Set(KNOWN_FEATURES);
const PROFILE_KEYS = new Set([
  "id",
  "name",
  "extends",
  "features",
  "semantics",
]);

function unknownFeature(id: string, where: string): DialectError {
  return new DialectError(
    `unknown feature '${id}' in ${where} (known: ${KNOWN_FEATURES.join(", ")})`,
  );
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Check a parsed profile; `where` prefixes every message (e.g. `dialect file x.json`). */
function validateProfile(raw: unknown, where: string): DialectProfile {
  if (!isRecord(raw)) {
    throw new DialectError(`${where}: a profile must be a JSON object`);
  }
  for (const key of Object.keys(raw)) {
    if (!PROFILE_KEYS.has(key)) {
      throw new DialectError(`${where}: key '${key}' is not known`);
    }
  }
  const { id, name, features, semantics } = raw;
  const parent = raw["extends"];
  if (typeof id !== "string" || id.length === 0) {
    throw new DialectError(`${where}: 'id' must be a non-empty string`);
  }
  if (id === RETIRED_IEC_ID) {
    throw new DialectError(
      `${where}: the id '${id}' is reserved${retiredIdHint(id)}`,
    );
  }
  if (name !== undefined && typeof name !== "string") {
    throw new DialectError(`${where}: 'name' must be a string`);
  }
  if (parent !== undefined && (typeof parent !== "string" || parent === "")) {
    throw new DialectError(`${where}: 'extends' must be a non-empty string`);
  }
  if (
    features !== undefined &&
    (!Array.isArray(features) ||
      !features.every((f): f is string => typeof f === "string"))
  ) {
    throw new DialectError(`${where}: 'features' must be an array of strings`);
  }
  const featureList: string[] = features ?? [];
  const unknown = featureList.find((f) => !KNOWN_FEATURE_SET.has(f));
  if (unknown !== undefined) throw unknownFeature(unknown, where);
  if (semantics !== undefined && !isRecord(semantics)) {
    throw new DialectError(`${where}: 'semantics' must be an object`);
  }
  const semanticsKey = Object.keys(semantics ?? {})[0];
  if (semanticsKey !== undefined) {
    throw new DialectError(
      `${where}: semantics key '${semanticsKey}' is not known`,
    );
  }
  const profile: DialectProfile = {
    id,
    name: name ?? id,
    features: [...new Set(featureList as FeatureId[])],
    semantics: {},
  };
  if (typeof parent === "string") profile.extends = parent;
  return profile;
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") || dir.endsWith("\\")
    ? `${dir}${name}`
    : `${dir}/${name}`;
}

function readProfile(
  path: string,
  readFile: (p: string) => string,
  expectedId?: string,
): DialectProfile {
  const where = `dialect file ${path}`;
  let text: string;
  let raw: unknown;
  try {
    text = readFile(path);
  } catch (e) {
    throw new DialectError(`${where}: ${errorText(e)}`);
  }
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new DialectError(`${where}: ${errorText(e)}`);
  }
  const profile = validateProfile(raw, where);
  if (expectedId !== undefined && profile.id !== expectedId) {
    throw new DialectError(
      `${where}: id '${profile.id}' does not match the file name`,
    );
  }
  return profile;
}

/** Look a profile up: built-in `iec-3` first, then loaded profiles in load order. */
function findProfile(
  id: string,
  loaded: readonly DialectProfile[],
): DialectProfile | undefined {
  if (id === IEC_PROFILE.id) return IEC_PROFILE;
  return loaded.find((p) => p.id === id);
}

/** A profile's own features plus everything it inherits through `extends`. */
function effectiveFeatures(
  profile: DialectProfile,
  loaded: readonly DialectProfile[],
): Set<FeatureId> {
  const chain: string[] = [];
  const features = new Set<FeatureId>();
  let current: DialectProfile = profile;
  for (;;) {
    const seen = chain.indexOf(current.id);
    if (seen >= 0) {
      const cycle = [...chain.slice(seen), current.id].join(" -> ");
      throw new DialectError(`dialect '${profile.id}': extends cycle ${cycle}`);
    }
    chain.push(current.id);
    for (const f of current.features) features.add(f);
    const parentId: string | undefined = current.extends;
    if (parentId === undefined) break;
    const parent = findProfile(parentId, loaded);
    if (!parent) {
      throw new DialectError(
        `dialect '${current.id}': extends '${parentId}', which is not loaded${retiredIdHint(parentId)}`,
      );
    }
    current = parent;
  }
  return features;
}

function applyFeatureOverrides(
  features: Set<FeatureId>,
  overrides: readonly string[],
): void {
  for (const spec of overrides) {
    const remove = spec.startsWith("-");
    const id = spec.startsWith("+") || remove ? spec.slice(1) : spec;
    if (!KNOWN_FEATURE_SET.has(id)) throw unknownFeature(id, "--feature");
    if (remove) features.delete(id as FeatureId);
    else features.add(id as FeatureId);
  }
}

/**
 * Resolve the dialect a compile runs under. Every loaded profile is
 * validated, including `extends` targets and cycles, whether or not it is
 * selected. Throws {@link DialectError} on any problem.
 */
export function resolveDialect(
  req: DialectRequest,
  readFile?: (p: string) => string,
  listDir?: (d: string) => string[],
): ResolvedDialect {
  const files = req.dialectFiles ?? [];
  const dirs = req.dialectPath ?? [];
  if ((files.length > 0 || dirs.length > 0) && !readFile) {
    throw new DialectError("dialect files need a file reader");
  }
  if (dirs.length > 0 && !listDir) {
    throw new DialectError("dialect folders need a folder reader");
  }

  const loaded: DialectProfile[] = [];
  let selected: DialectProfile | undefined;

  if (typeof req.dialect === "object") {
    const where = `dialect '${String((req.dialect as { id?: unknown }).id)}'`;
    selected = validateProfile(req.dialect, where);
    loaded.push(selected);
  }
  for (const path of files) {
    loaded.push(readProfile(path, readFile!));
  }
  for (const dir of dirs) {
    let names: string[];
    try {
      names = listDir!(dir);
    } catch (e) {
      throw new DialectError(`dialect path ${dir}: ${errorText(e)}`);
    }
    for (const name of [...names].sort()) {
      if (!name.toLowerCase().endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      loaded.push(readProfile(joinPath(dir, name), readFile!, id));
    }
  }

  for (const profile of loaded) effectiveFeatures(profile, loaded);

  if (typeof req.dialect === "string") {
    selected = findProfile(req.dialect, loaded);
    if (!selected) {
      const known = [
        IEC_PROFILE.id,
        ...[...new Set(loaded.map((p) => p.id))]
          .filter((id) => id !== IEC_PROFILE.id)
          .sort(),
      ];
      throw new DialectError(
        `unknown dialect '${req.dialect}' (known: ${known.join(", ")})${retiredIdHint(req.dialect)}`,
      );
    }
  } else if (req.dialect === undefined && files.length === 1) {
    selected = loaded[0];
  }

  const features = selected
    ? effectiveFeatures(selected, loaded)
    : new Set(DEFAULT_FEATURES);
  applyFeatureOverrides(features, req.features ?? []);

  return { id: selected ? selected.id : null, features, loaded };
}

/** Ids of the loaded profiles whose effective features include `f`, sorted. */
export function profilesWithFeature(
  d: ResolvedDialect,
  f: FeatureId,
): string[] {
  const ids = new Set<string>();
  for (const profile of d.loaded) {
    if (effectiveFeatures(profile, d.loaded).has(f)) ids.add(profile.id);
  }
  return [...ids].sort();
}
