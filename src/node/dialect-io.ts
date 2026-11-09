// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * File-system access for dialect profiles (`--dialect-file`, `--dialect-path`).
 */
import { readFileSync, readdirSync } from "fs";
import type { DialectIO } from "../dialect.js";

export const nodeDialectIO: DialectIO = {
  readFile: (path) => readFileSync(path, "utf-8"),
  listDir: (dir) => readdirSync(dir),
};
