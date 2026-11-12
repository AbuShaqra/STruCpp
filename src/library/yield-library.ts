// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * The Ed. 3 Table 36 date and time FUNCTIONs of the bundled library give way
 * to anything another library declares under the same name: a FUNCTION,
 * FUNCTION_BLOCK, TYPE or global (OSCAT's DAY_OF_WEEK, a `-L` library's FB
 * SPLIT_TOD), whatever order the libraries load in. A user declaration of the
 * name wins on its own, as over any library symbol.
 */
import {
  YIELDING_FUNCTIONS_LIBRARY,
  type StlibArchive,
} from "./library-manifest.js";

/**
 * The archives with the yielding library's FUNCTIONs that another archive
 * also names left out, along with those of its FUNCTIONs that call one.
 */
export function withYieldedFunctions(
  archives: readonly StlibArchive[],
): StlibArchive[] {
  const yielding = archives.find(
    (a) => a.manifest.name === YIELDING_FUNCTIONS_LIBRARY,
  );
  if (yielding === undefined) return [...archives];
  const taken = new Set<string>();
  for (const archive of archives) {
    if (archive === yielding) continue;
    const m = archive.manifest;
    for (const entry of [...m.functions, ...m.functionBlocks, ...m.types]) {
      taken.add(entry.name.toUpperCase());
    }
    for (const g of m.globals ?? []) taken.add(g.name.toUpperCase());
    for (const c of archive.chunks ?? []) taken.add(c.name.toUpperCase());
  }
  const own = new Set(
    yielding.manifest.functions.map((f) => f.name.toUpperCase()),
  );
  const dropped = new Set([...own].filter((n) => taken.has(n)));
  if (dropped.size === 0) return [...archives];
  // A kept FUNCTION calling a dropped one would reach the other library's.
  for (let grew = true; grew; ) {
    grew = false;
    for (const chunk of yielding.chunks ?? []) {
      const name = chunk.name.toUpperCase();
      if (!own.has(name) || dropped.has(name)) continue;
      const callsDropped = chunk.deps.some(
        (d) =>
          d.library === YIELDING_FUNCTIONS_LIBRARY &&
          dropped.has(d.name.toUpperCase()),
      );
      if (callsDropped) {
        dropped.add(name);
        grew = true;
      }
    }
  }
  const filtered: StlibArchive = {
    ...yielding,
    manifest: {
      ...yielding.manifest,
      functions: yielding.manifest.functions.filter(
        (f) => !dropped.has(f.name.toUpperCase()),
      ),
    },
    chunks: (yielding.chunks ?? []).filter(
      (c) => !(c.kind === "function" && dropped.has(c.name.toUpperCase())),
    ),
  };
  return archives.map((a) => (a === yielding ? filtered : a));
}
