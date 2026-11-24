// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * A pointer used as a FOR control variable is flagged in the editor, as in a
 * compile: a REF_TO is an error (g++ refused the loop), a POINTER TO stepped
 * up to a value that is not an address a warning.
 */
import { describe, it, expect } from "vitest";
import { analyze } from "strucpp";
import { DiagnosticSeverity } from "vscode-languageserver/node.js";
import { DocumentManager } from "../../server/src/document-manager.js";
import { NullWorkspaceFs } from "../../server/src/workspace-fs.js";
import { toLspDiagnostics } from "../../server/src/diagnostics.js";

const SOURCE = `PROGRAM Main
  VAR p : POINTER TO INT; r : REF_TO INT; i, x : INT; END_VAR
  FOR p := 0 TO 10 DO
    x := x + 1;
  END_FOR;
  FOR r := 0 TO 10 DO
    x := x + 1;
  END_FOR;
  FOR i := 0 TO 10 DO
    x := x + 1;
  END_FOR;
END_PROGRAM`;

describe("FOR control variable of a pointer type", () => {
  it("is flagged at each loop over a POINTER TO or REF_TO", () => {
    const dm = new DocumentManager(analyze, NullWorkspaceFs);
    const state = dm.onDocumentOpen("file:///main.st", SOURCE);
    const result = state.analysisResult!;
    const diags = toLspDiagnostics(result.errors, result.warnings, "main.st");
    expect(
      diags
        .filter((d) => d.message.startsWith("FOR control variable"))
        .map((d) => `${d.severity}:${d.range.start.line}: ${d.message}`),
    ).toEqual([
      `${DiagnosticSeverity.Error}:5: FOR control variable 'R' must be an integer type, got REF_TO INT`,
      `${DiagnosticSeverity.Warning}:2: FOR control variable 'P' is a POINTER TO INT, not an integer, and its end value is not an address`,
    ]);
  });
});
