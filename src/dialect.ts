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
  "postfix_enum_base",
  "named_global_lists",
  "struct_extends",
  "union",
  "fb_init",
  "trunc_dint",
  "interface_zero",
  "end_semicolon_optional",
  "conditional_pragmas",
  "vendor_operators",
  "type_colon_optional",
  "conditional_return",
  "platform_types",
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
  /**
   * Problems that did not stop the resolution: a `--dialect-path` profile
   * that is not selected and cannot be loaded, or several profile files and
   * no selection.
   */
  warnings: string[];
}

/** File access used to read profiles (fs-backed on Node). */
export interface DialectIO {
  readFile: (path: string) => string;
  /** Entry names (not paths) in a folder. */
  listDir: (dir: string) => string[];
  /** The canonical path of a file or folder, so one reached twice is loaded once. */
  realPath?: (path: string) => string;
  /** Paths differing only in letter case name one file (true on Windows). */
  foldCase?: boolean;
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
  if (id === IEC_PROFILE.id) {
    // The built-in profile itself (IEC_PROFILE, or `{"id":"iec-3"}` with no
    // feature) is accepted as it; any other profile of that id is refused.
    const same =
      (name === undefined || name === IEC_PROFILE.name) &&
      raw["extends"] === undefined &&
      (features === undefined ||
        (Array.isArray(features) && features.length === 0)) &&
      (semantics === undefined ||
        (isRecord(semantics) && Object.keys(semantics).length === 0));
    if (same) return IEC_PROFILE;
    throw new DialectError(
      `${where}: the id '${id}' is the built-in profile's; a profile that differs from it needs its own id and "extends": "${IEC_PROFILE.id}"`,
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

/** `a/./b//c/` as `a/b/c`: one spelling of a path when no real path is known. */
function normalisePath(p: string): string {
  const parts: string[] = [];
  for (const part of p.replace(/\\/g, "/").split("/")) {
    if (part === "." || (part === "" && parts.length > 0)) continue;
    if (part === ".." && parts.length > 0 && parts[parts.length - 1] !== "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/") || ".";
}

/** The items of `list` whose key was not seen before, in order. */
function uniqueBy<T>(list: readonly T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  return list.filter((t) => {
    const k = key(t);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
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
  skipped?: ReadonlyMap<string, string>,
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
      const why = skipped?.get(parentId);
      throw new DialectError(
        why === undefined
          ? `dialect '${current.id}': extends '${parentId}', which is not loaded${retiredIdHint(parentId)}`
          : `dialect '${current.id}': extends '${parentId}', which is skipped (${why})`,
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
    if (id === "") {
      throw new DialectError(
        `--feature '${spec}' names no feature: write +id, -id or id (known: ${KNOWN_FEATURES.join(", ")})`,
      );
    }
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
  realPath?: (p: string) => string,
  foldCase?: boolean,
): ResolvedDialect {
  /** One spelling per file or folder: its real path when known, else a normalised one. */
  const spelling = (p: string): string => {
    try {
      if (realPath) return realPath(p);
    } catch {
      // an unreadable path is reported where it is read
    }
    return normalisePath(p);
  };
  const key = (p: string): string =>
    foldCase === true ? spelling(p).toLowerCase() : spelling(p);
  const files = uniqueBy(req.dialectFiles ?? [], key);
  const dirs = uniqueBy(req.dialectPath ?? [], key);
  if ((files.length > 0 || dirs.length > 0) && !readFile) {
    throw new DialectError("dialect files need a file reader");
  }
  if (dirs.length > 0 && !listDir) {
    throw new DialectError("dialect folders need a folder reader");
  }

  const loaded: DialectProfile[] = [];
  const warnings: string[] = [];
  /** Where each loaded profile id comes from, for a duplicate's error. */
  const source = new Map<string, string>();
  /** The real path of the file each loaded profile id was read from. */
  const sourceKey = new Map<string, string>();
  /** Add a profile; the same file reached again is the same profile. True when added. */
  const add = (
    profile: DialectProfile,
    where: string,
    fileKey?: string,
  ): boolean => {
    if (profile === IEC_PROFILE) return false;
    const first = source.get(profile.id);
    if (first !== undefined) {
      if (fileKey !== undefined && sourceKey.get(profile.id) === fileKey) {
        return false;
      }
      throw new DialectError(
        `dialect '${profile.id}' is defined twice: by ${first} and by ${where}`,
      );
    }
    source.set(profile.id, where);
    if (fileKey !== undefined) sourceKey.set(profile.id, fileKey);
    loaded.push(profile);
    return true;
  };
  let selected: DialectProfile | undefined;
  let selectedId = typeof req.dialect === "string" ? req.dialect : undefined;

  if (typeof req.dialect === "object") {
    const where = `dialect '${String((req.dialect as { id?: unknown }).id)}'`;
    selected = validateProfile(req.dialect, where);
    add(selected, "the dialect option");
    selectedId = selected.id;
  }
  /** The profile read from each --dialect-file, in order. */
  const fromFiles: Array<{ path: string; profile: DialectProfile }> = [];
  for (const path of files) {
    const profile = readProfile(path, readFile!);
    add(profile, `dialect file ${path}`, key(path));
    fromFiles.push({ path, profile });
  }
  // One --dialect-file and no --dialect selects it, for the folders too.
  if (req.dialect === undefined && fromFiles.length === 1) {
    selectedId = fromFiles[0]!.profile.id;
  }
  /** Profiles of a dialect path, which only stop the resolution when selected. */
  const fromPath = new Set<DialectProfile>();
  const skipped = new Map<string, string>();
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
      const path = joinPath(dir, name);
      let profile: DialectProfile;
      try {
        profile = readProfile(path, readFile!, id);
      } catch (e) {
        if (!(e instanceof DialectError) || id === selectedId) throw e;
        skipped.set(id, e.message);
        warnings.push(`${e.message}; it is not selected, so it is skipped`);
        continue;
      }
      if (add(profile, `dialect file ${path}`, key(path))) {
        fromPath.add(profile);
      }
    }
  }

  // Every loaded profile is checked; one from a dialect path that is not
  // selected and does not resolve is skipped with a warning.
  for (const profile of [...loaded]) {
    try {
      effectiveFeatures(profile, loaded, skipped);
    } catch (e) {
      if (
        !(e instanceof DialectError) ||
        !fromPath.has(profile) ||
        profile.id === selectedId
      ) {
        throw e;
      }
      skipped.set(profile.id, e.message);
      warnings.push(
        `${source.get(profile.id)}: ${e.message}; it is not selected, so it is skipped`,
      );
      loaded.splice(loaded.indexOf(profile), 1);
    }
  }

  if (selectedId !== undefined) {
    selected = findProfile(selectedId, loaded);
    if (!selected) {
      const known = [
        IEC_PROFILE.id,
        ...[...new Set(loaded.map((p) => p.id))]
          .filter((id) => id !== IEC_PROFILE.id)
          .sort(),
      ];
      throw new DialectError(
        `unknown dialect '${selectedId}' (known: ${known.join(", ")})${retiredIdHint(selectedId)}`,
      );
    }
  } else if (req.dialect === undefined && fromFiles.length > 1) {
    warnings.push(
      `${fromFiles.length} dialect files and no --dialect: none is selected, so the default features apply; select one with --dialect (${fromFiles
        .map(({ path, profile }) => `${profile.id} from ${path}`)
        .join(", ")})`,
    );
  }

  const features = selected
    ? effectiveFeatures(selected, loaded)
    : new Set(DEFAULT_FEATURES);
  applyFeatureOverrides(features, req.features ?? []);

  return { id: selected ? selected.id : null, features, loaded, warnings };
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
