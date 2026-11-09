// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * End-to-end: drives the real Node language server over stdio with the LSP
 * protocol and checks that the `strucpp.dialect` / `strucpp.features`
 * workspace settings decide the published diagnostics and compile results.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node.js";
import { analyze, compile, type DialectProfile } from "strucpp";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.resolve(here, "..", "..", "server", "src", "server.ts");

const PROGRAM_WITH_METHOD = `PROGRAM Main
  VAR x : INT; END_VAR
  METHOD Inc : INT
    Inc := 1;
  END_METHOD
  x := x + 1;
END_PROGRAM`;

const POINTER_PROGRAM = `PROGRAM PtrMain
  VAR p : POINTER TO INT; x : INT; END_VAR
  x := x + 1;
END_PROGRAM`;

const POINTER_FB = `FUNCTION_BLOCK Holder
  VAR p : POINTER TO INT; END_VAR
END_FUNCTION_BLOCK`;

function profile(id: string, features: DialectProfile["features"]): DialectProfile {
  return { id, name: id, extends: "iec-3", features, semantics: {} };
}

const IEC_ONLY = profile("test-plain", []);
const WITH_BOTH = profile("test-both", ["program_methods", "pointer_to"]);

interface LspDiagnostic {
  range: { start: { line: number; character: number } };
  message: string;
}

interface CompileReply {
  success: boolean;
  errors: Array<{ message: string; line: number; file?: string }>;
}

interface ShowMessage {
  type: number;
  message: string;
}

/** Minimal LSP client over a spawned server process. */
class TestClient {
  readonly conn: MessageConnection;
  /** Settings returned for the `strucpp` configuration section. */
  config: Record<string, unknown>;
  readonly shown: ShowMessage[] = [];
  readonly logged: string[] = [];
  private readonly diagnostics = new Map<string, LspDiagnostic[]>();
  private waiters: Array<() => void> = [];

  constructor(
    private readonly proc: ChildProcess,
    config: Record<string, unknown>,
  ) {
    this.config = config;
    if (!proc.stdout || !proc.stdin) throw new Error("server stdio not piped");
    this.conn = createMessageConnection(
      new StreamMessageReader(proc.stdout),
      new StreamMessageWriter(proc.stdin),
    );
    this.conn.onRequest("workspace/configuration", (params: { items: Array<{ section?: string }> }) =>
      params.items.map((item) => (item.section === "strucpp" ? this.config : null)),
    );
    this.conn.onRequest("client/registerCapability", () => null);
    this.conn.onNotification(
      "textDocument/publishDiagnostics",
      (params: { uri: string; diagnostics: LspDiagnostic[] }) => {
        this.diagnostics.set(params.uri, params.diagnostics);
        this.notify();
      },
    );
    // showErrorMessage arrives as window/showMessageRequest (no actions).
    this.conn.onRequest("window/showMessageRequest", (params: ShowMessage) => {
      this.shown.push(params);
      this.notify();
      return null;
    });
    this.conn.onNotification("window/showMessage", (params: ShowMessage) => {
      this.shown.push(params);
      this.notify();
    });
    this.conn.onNotification("window/logMessage", (params: { message: string }) => {
      this.logged.push(params.message);
    });
    this.conn.onNotification("strucpp/librariesChanged", () => {
      this.librariesChanged++;
      this.notify();
    });
    this.conn.listen();
  }

  librariesChanged = 0;

  private notify(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  /** Resolve once `check` returns a value, or fail after `ms`. */
  async waitFor<T>(check: () => T | undefined, what: string, ms = 15000): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = check();
      if (value !== undefined) return value;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out waiting for ${what}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(left, 250));
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /** Wait until the published diagnostics for `uri` satisfy `pred`. */
  waitForDiagnostics(uri: string, pred: (d: LspDiagnostic[]) => boolean): Promise<LspDiagnostic[]> {
    return this.waitFor(() => {
      const d = this.diagnostics.get(uri);
      return d && pred(d) ? d : undefined;
    }, `diagnostics on ${uri}`);
  }

  clearDiagnostics(): void {
    this.diagnostics.clear();
  }

  async start(rootDir: string): Promise<void> {
    const rootUri = pathToFileURL(rootDir).toString();
    await this.conn.sendRequest("initialize", {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: "ws" }],
      capabilities: { workspace: { configuration: true, didChangeConfiguration: {} } },
    });
    const before = this.librariesChanged;
    await this.conn.sendNotification("initialized", {});
    // onInitialized announces libraries after it has fetched the settings.
    await this.waitFor(() => (this.librariesChanged > before ? true : undefined), "initialized");
  }

  async open(uri: string, text: string): Promise<void> {
    await this.conn.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId: "structured-text", version: 1, text },
    });
  }

  async change(uri: string, version: number, text: string): Promise<void> {
    await this.conn.sendNotification("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  /** Replace the settings and tell the server they changed. */
  async reconfigure(config: Record<string, unknown>): Promise<void> {
    this.config = config;
    const before = this.librariesChanged;
    await this.conn.sendNotification("workspace/didChangeConfiguration", { settings: null });
    // The change handler announces libraries after re-fetching the settings.
    await this.waitFor(() => (this.librariesChanged > before ? true : undefined), "configuration change");
  }

  compile(uri: string, workspace = false): Promise<CompileReply> {
    return this.conn.sendRequest("strucpp/compile", { uri, workspace });
  }

  async stop(): Promise<void> {
    try {
      await this.conn.sendRequest("shutdown");
      await this.conn.sendNotification("exit");
    } catch {
      // the process may already be gone
    }
    this.conn.dispose();
    this.proc.kill();
  }

  get alive(): boolean {
    return this.proc.exitCode === null && this.proc.signalCode === null;
  }
}

let bundleDir: string;
let bundlePath: string;
let workspaceDir: string;

function startServer(config: Record<string, unknown>): TestClient {
  const proc = spawn(process.execPath, [bundlePath, "--stdio"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  return new TestClient(proc, config);
}

function fileUri(name: string): string {
  return pathToFileURL(path.join(workspaceDir, name)).toString();
}

/** Diagnostics as `<0-based line>: <message>` for comparison with compiler errors. */
function lspLines(diags: LspDiagnostic[]): string[] {
  return diags.map((d) => `${d.range.start.line}: ${d.message}`).sort();
}

function compilerLines(errors: Array<{ line: number; message: string }>): string[] {
  return errors.map((e) => `${Math.max(e.line - 1, 0)}: ${e.message}`).sort();
}

beforeAll(async () => {
  bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-lsp-e2e-"));
  bundlePath = path.join(bundleDir, "server.cjs");
  await build({
    entryPoints: [serverEntry],
    outfile: bundlePath,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "ES2022",
    logLevel: "silent",
  });
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-lsp-ws-"));
  fs.writeFileSync(path.join(workspaceDir, "holder.st"), POINTER_FB, "utf-8");
}, 120000);

afterAll(() => {
  fs.rmSync(bundleDir, { recursive: true, force: true });
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

describe("LSP server dialect profile (stdio)", () => {
  it("profile from the initial configuration decides diagnostics; a change re-publishes", async () => {
    const client = startServer({ dialect: IEC_ONLY });
    try {
      await client.start(workspaceDir);
      const methodUri = fileUri("method.st");
      const ptrUri = fileUri("ptr.st");
      await client.open(methodUri, PROGRAM_WITH_METHOD);
      await client.open(ptrUri, POINTER_PROGRAM);

      const methodDiags = await client.waitForDiagnostics(methodUri, (d) => d.length > 0);
      expect(lspLines(methodDiags)).toEqual([
        "2: METHOD in a PROGRAM needs the feature program_methods",
      ]);
      const ptrDiags = await client.waitForDiagnostics(ptrUri, (d) => d.length > 0);
      expect(lspLines(ptrDiags)).toEqual(["1: POINTER TO needs the feature pointer_to"]);

      // Server diagnostics and the compile request agree with compile() under the profile.
      for (const [uri, src, name] of [
        [methodUri, PROGRAM_WITH_METHOD, "method.st"],
        [ptrUri, POINTER_PROGRAM, "ptr.st"],
      ] as const) {
        const expected = compile(src, { fileName: name, dialect: IEC_ONLY });
        const reply = await client.compile(uri);
        expect(compilerLines(reply.errors)).toEqual(compilerLines(expected.errors));
        expect(reply.success).toBe(false);
      }
      expect(lspLines(methodDiags)).toEqual(
        compilerLines(compile(PROGRAM_WITH_METHOD, { fileName: "method.st", dialect: IEC_ONLY }).errors),
      );

      // Workspace sources read from disk are compiled under the profile too.
      const wsReply = await client.compile(ptrUri, true);
      expect(
        wsReply.errors.filter((e) => e.file === "holder.st").map((e) => e.message),
      ).toEqual(["POINTER TO needs the feature pointer_to"]);

      client.clearDiagnostics();
      await client.reconfigure({ dialect: WITH_BOTH });
      expect(await client.waitForDiagnostics(methodUri, (d) => d.length === 0)).toEqual([]);
      expect(await client.waitForDiagnostics(ptrUri, (d) => d.length === 0)).toEqual([]);
      const okReply = await client.compile(ptrUri, true);
      expect(okReply.errors).toEqual([]);
      expect(okReply.success).toBe(true);

      // Feature overrides alone re-publish as well.
      client.clearDiagnostics();
      await client.reconfigure({ dialect: WITH_BOTH, features: ["-pointer_to"] });
      const overridden = await client.waitForDiagnostics(ptrUri, (d) => d.length > 0);
      expect(overridden).toHaveLength(1);
      expect(overridden[0]?.range.start.line).toBe(1);
      expect(overridden[0]?.message).toMatch(/^POINTER TO needs the feature pointer_to/);
      expect(await client.waitForDiagnostics(methodUri, (d) => d.length === 0)).toEqual([]);
      expect(client.shown).toEqual([]);
    } finally {
      await client.stop();
    }
  }, 60000);

  it("a malformed profile is rejected with an error message and the previous one stays", async () => {
    const client = startServer({ dialect: IEC_ONLY });
    try {
      await client.start(workspaceDir);
      const ptrUri = fileUri("ptr.st");
      await client.open(ptrUri, POINTER_PROGRAM);
      await client.waitForDiagnostics(ptrUri, (d) => d.length > 0);

      const malformed: Array<[Record<string, unknown>, RegExp]> = [
        [{ dialect: { id: "test-bad", features: ["no_such_feature"] } }, /unknown feature 'no_such_feature'/],
        [{ dialect: { id: 7, features: [] } }, /'id' must be a non-empty string/],
        [{ dialect: { id: "test-loop", extends: "test-loop", features: [] } }, /extends cycle/],
        [{ dialect: { id: "test-orphan", extends: "test-missing", features: [] } }, /not loaded/],
        [
          { dialect: { id: "test-old", extends: "iec", features: [] } },
          /extends 'iec', which is not loaded; the IEC 61131-3 Ed\. 3 profile is 'iec-3'/,
        ],
        [{ dialect: "test-pointers" }, /must be a profile object/],
        [{ dialect: WITH_BOTH, features: "pointer_to" }, /'features' must be an array of strings/],
        [{ dialect: WITH_BOTH, features: ["no_such_feature"] }, /unknown feature 'no_such_feature'/],
      ];
      for (const [config, pattern] of malformed) {
        const before = client.shown.length;
        client.clearDiagnostics();
        await client.reconfigure(config);
        const msg = await client.waitFor(
          () => client.shown[before],
          `error message for ${JSON.stringify(config)}`,
        );
        expect(msg.type).toBe(1);
        expect(msg.message.startsWith("STruC++: dialect profile rejected: ")).toBe(true);
        expect(msg.message).toMatch(pattern);
        expect(client.logged.some((l) => l.includes(msg.message))).toBe(true);
        // Diagnostics are re-published under the previous valid profile.
        expect(lspLines(await client.waitForDiagnostics(ptrUri, () => true))).toEqual([
          "1: POINTER TO needs the feature pointer_to",
        ]);
        expect(client.alive).toBe(true);
      }

      // Analysis keeps working: an edit is diagnosed under the kept profile.
      client.clearDiagnostics();
      await client.change(ptrUri, 2, PROGRAM_WITH_METHOD);
      expect(lspLines(await client.waitForDiagnostics(ptrUri, (d) => d.length > 0))).toEqual([
        "2: METHOD in a PROGRAM needs the feature program_methods",
      ]);

      // A valid profile afterwards is adopted.
      client.clearDiagnostics();
      await client.reconfigure({ dialect: WITH_BOTH });
      expect(await client.waitForDiagnostics(ptrUri, (d) => d.length === 0)).toEqual([]);
    } finally {
      await client.stop();
    }
  }, 60000);

  it("a malformed profile in the initial configuration falls back to no profile", async () => {
    const client = startServer({ dialect: { id: "test-bad", features: ["no_such_feature"] } });
    try {
      await client.start(workspaceDir);
      const msg = await client.waitFor(() => client.shown[0], "initial error message");
      expect(msg.message).toMatch(/^STruC\+\+: dialect profile rejected: unknown feature/);
      const ptrUri = fileUri("ptr.st");
      await client.open(ptrUri, POINTER_PROGRAM);
      const expected = analyze(POINTER_PROGRAM, { fileName: "ptr.st" });
      const diags = await client.waitForDiagnostics(ptrUri, () => true);
      expect(lspLines(diags)).toEqual(compilerLines(expected.errors));
    } finally {
      await client.stop();
    }
  }, 60000);

  it("no profile: diagnostics and compile results are those of a call without a dialect", async () => {
    const client = startServer({});
    try {
      await client.start(workspaceDir);
      for (const [name, src] of [
        ["method.st", PROGRAM_WITH_METHOD],
        ["ptr.st", POINTER_PROGRAM],
      ] as const) {
        const uri = fileUri(name);
        await client.open(uri, src);
        const diags = await client.waitForDiagnostics(uri, () => true);
        expect(lspLines(diags)).toEqual(compilerLines(analyze(src, { fileName: name }).errors));
        const reply = await client.compile(uri);
        expect(compilerLines(reply.errors)).toEqual(
          compilerLines(compile(src, { fileName: name }).errors),
        );
      }
      expect(client.shown).toEqual([]);
    } finally {
      await client.stop();
    }
  }, 60000);
});
