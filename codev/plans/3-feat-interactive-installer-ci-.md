# Plan: Interactive Installer (`ci-channel setup`)

## Metadata
- **ID**: plan-2026-04-10-interactive-installer
- **Status**: draft
- **Specification**: codev/specs/3-feat-interactive-installer-ci-.md
- **Created**: 2026-04-10

## Executive Summary

Implement the `ci-channel setup` subcommand as a pure addition on top of the existing MCP server. The dispatch happens at the top of `server.ts` with a dynamic import, so the normal server path pays no load cost.

Split into four phases ordered by dependency:

1. **CLI dispatch + arg parsing** — top-level subcommand routing in `server.ts` (dynamic import), a new `lib/setup/` directory, and an arg parser that implements the full TTY/`--yes`/`--dry-run`/`--repo` matrix. No network, no mutation, no prompts yet. Existing MCP server path must be byte-identical.
2. **Non-interactive installer core** — the headless happy path (`--yes` mode): `.mcp.json` merger, `gh` wrapper, state.json write with `chmod 600`, idempotency checks, `--smee-url` override handling, `--dry-run` support. Tests cover every idempotency row and every `.mcp.json` shape with mocked `gh` / filesystem / `fetchSmeeChannel`.
3. **Interactive prompts** — add `@inquirer/prompts` dependency, wire prompts into the orchestrator, detect non-TTY, handle decline paths. TTY detection gates the interactive path.
4. **Documentation + `arch.md`** — rewrite README and INSTALL.md to recommend `setup`, update AGENTS.md / CLAUDE.md, and update `codev/resources/arch.md` with the new `lib/setup/` module.

Each phase is committable and leaves the codebase in a working state. All existing 170 tests must continue to pass at the end of every phase.

## Success Metrics

- [ ] All specification criteria met (27 success criteria items in spec)
- [ ] All 170 existing tests continue to pass
- [ ] New unit tests for: arg parser (matrix), `.mcp.json` merger (all 7 shapes), `gh` wrapper (list + create, pagination), idempotency (every row), `--smee-url` override
- [ ] New integration tests for: happy path (`--yes` + `--repo`), dry-run, interactive prompt flow, interactive decline, non-TTY fail-fast
- [ ] MCP server regression smoke test (subcommand dispatch doesn't affect server path)
- [ ] state.json written with `chmod 600`
- [ ] `gh api --paginate` used for webhook idempotency check
- [ ] Documentation updated across README, INSTALL.md, AGENTS.md, CLAUDE.md, arch.md

## Phases (Machine Readable)

<!-- REQUIRED: porch uses this JSON to track phase progress. -->

```json
{
  "phases": [
    {"id": "cli_dispatch", "title": "CLI dispatch + arg parsing scaffolding"},
    {"id": "installer_core", "title": "Non-interactive installer core"},
    {"id": "interactive_prompts", "title": "Interactive prompts via @inquirer/prompts"},
    {"id": "documentation", "title": "Documentation + arch.md updates"}
  ]
}
```

## Phase Breakdown

### Phase 1: CLI dispatch + arg parsing scaffolding

**Dependencies**: None

#### Objectives

- Add a top-level subcommand dispatcher at the very top of `server.ts` that routes `process.argv[2] === 'setup'` to the new installer module via dynamic import, without loading any installer-only dependencies on the server path.
- Create the `lib/setup/` directory with a minimal `index.ts` and an `args.ts` that implements the full arg parsing + TTY/`--yes`/`--dry-run`/`--repo` matrix from the spec.
- Add enough scaffolding that `ci-channel setup --help`, `ci-channel setup --yes --repo owner/repo --dry-run`, and all fail-fast error cases (`--yes` without `--repo`, `--forge gitlab`, unknown flag, non-TTY without `--yes`) work and produce correct exit codes — with no side effects yet (no network, no files, no prompts, no `gh`).
- Guarantee the MCP server path is byte-identical for all non-`setup` invocations by running the existing test suite untouched.

#### Deliverables

- [ ] `server.ts` — top-level subcommand guard BEFORE any other top-level code (no `loadConfig()`, no MCP initialization) when `process.argv[2] === 'setup'`; dynamic `import('./lib/setup/index.js')`; after the installer returns, `process.exit(exitCode)`.
- [ ] `lib/setup/index.ts` — `export async function runSetup(argv: string[]): Promise<number>`; imports `parseSetupArgs` and wires the skeleton (no prompts, no gh, no fs yet — just prints the parsed args and a placeholder "would run install" message).
- [ ] `lib/setup/args.ts` — `parseSetupArgs(argv: string[]): SetupArgs` implementing the full flag set (`--repo`, `--forge`, `--yes`/`-y`, `--dry-run`, `--smee-url`, `--help`/`-h`) with the interactive/non-interactive matrix (uses an injectable `isTty: () => boolean` for testability).
- [ ] `lib/setup/types.ts` — `SetupArgs` type: `{ repo: string | null; forge: 'github'; yes: boolean; dryRun: boolean; smeeUrl: string | null }`. Typed as narrowly as possible.
- [ ] `lib/setup/errors.ts` — `class SetupError extends Error` with an `exitCode: number` and a `userMessage: string` (short, terminal-friendly). `runSetup` catches and prints these; bugs / unexpected errors get printed with a stack.
- [ ] `tests/setup-args.test.ts` — unit tests for `parseSetupArgs` covering the full matrix:
  - Happy case: `--yes --repo owner/r` → valid
  - Unknown flag → `SetupError`
  - `--forge gitlab` → `SetupError` with v1-scoping message ("MCP server itself supports all three forges")
  - `--forge gitea` → same
  - `--forge github` → accepted
  - Missing `--repo` + `--yes` (both TTY and non-TTY) → `SetupError: --yes requires --repo`
  - Missing `--repo` + `--dry-run` + `--yes` → `SetupError: --yes requires --repo`
  - Missing `--repo` + non-TTY + no `--yes` → `SetupError: stdin is not a TTY; pass --yes`
  - Missing `--repo` + TTY + no `--yes` → returned with `repo: null` (the runner will prompt)
  - Invalid `--repo` format (e.g. `bad"value`, `owner`, `owner/`, empty) → `SetupError`
  - `--help` / `-h` → returns sentinel / prints usage and signals `exitCode = 0`
  - `-y` alias works the same as `--yes`
  - Repeated flags → last value wins OR throws (pick one; tests lock the choice)
- [ ] `tests/setup-dispatch.test.ts` — integration-style smoke test that spawns `node --import tsx/esm server.ts setup --help` as a subprocess and asserts exit code 0 + usage text on stdout. Uses the existing `tsx` runtime. Also spawns `node server.ts` with no args and verifies it boots past arg parsing (existing config.test.ts will keep the arg-parser regression covered). Use `child_process.spawn` with `stdin: 'ignore'` to avoid TTY side effects.

#### Implementation Details

**Subcommand dispatch location**: `server.ts` line 1 (after the shebang). The dispatcher must run BEFORE the existing `import { loadConfig } from "./lib/config.js"` line at line 9, because `loadConfig` throws on unknown flags. The cleanest approach:

```typescript
#!/usr/bin/env node
// Subcommand dispatch must happen before any other imports that parse argv.
if (process.argv[2] === 'setup') {
  const { runSetup } = await import('./lib/setup/index.js');
  const exitCode = await runSetup(process.argv.slice(3));
  process.exit(exitCode);
}
// ... rest of existing server.ts unchanged ...
import { createServer, ... } from 'node:http';
```

Note: top-level `await` requires ESM and Node 20+, both already in place.

**Arg-parser pattern**: Reuse the style of `parseCliArgs` in `lib/config.ts` (iterate `--flag value` pairs, throw on unknown flags). Do NOT import `parseCliArgs` — the setup flag set is different from the server flag set, and sharing would create cross-coupling. Accept `-y` as an alias for `--yes`. Both `--yes` and `--dry-run` are boolean (no value consumed). `--help`/`-h` prints usage and returns `{ helpRequested: true }` to `runSetup`, which prints and exits 0.

**TTY detection**: `args.ts` takes an `isTty: () => boolean` dependency, defaulting to `() => process.stdin.isTTY === true`. Tests inject a stub. Do NOT read `process.stdin.isTTY` at module load — only when `parseSetupArgs` is called.

**Repo validation regex**: `/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/` per spec. Applied in `parseSetupArgs`.

**SetupError shape**:
```typescript
export class SetupError extends Error {
  constructor(
    public readonly userMessage: string,
    public readonly exitCode: number = 1,
  ) { super(userMessage); this.name = 'SetupError'; }
}
```

`runSetup` catches `SetupError` and writes `userMessage` to `process.stderr` with no stack. Any other error gets its full stack printed for debuggability.

**runSetup stub for this phase**:
```typescript
export async function runSetup(argv: string[]): Promise<number> {
  try {
    const args = parseSetupArgs(argv);
    if (args.helpRequested) { printUsage(); return 0; }
    console.error('[ci-channel setup] parsed args:', args);
    console.error('[ci-channel setup] installer not yet implemented (phase 1 scaffolding)');
    return 0;
  } catch (err) {
    if (err instanceof SetupError) {
      console.error(`[ci-channel setup] ${err.userMessage}`);
      return err.exitCode;
    }
    throw err;
  }
}
```

#### Acceptance Criteria

- [ ] All 170 existing tests pass without modification.
- [ ] `node --import tsx/esm server.ts setup --help` exits 0 and prints usage.
- [ ] `node --import tsx/esm server.ts setup --yes` (no `--repo`) exits non-zero with stderr matching `/--yes requires --repo/`.
- [ ] `node --import tsx/esm server.ts setup --forge gitlab --yes --repo owner/r` exits non-zero with stderr containing `MCP server itself supports all three forges`.
- [ ] `node --import tsx/esm server.ts` (no args) still boots the MCP server (existing behavior unchanged).
- [ ] `tests/setup-args.test.ts` passes with every matrix row covered.
- [ ] `tests/setup-dispatch.test.ts` passes (subprocess smoke test).
- [ ] `grep -r '@inquirer/prompts' lib/ server.ts` returns nothing (deferred to Phase 3).

#### Test Plan

- **Unit tests**: `tests/setup-args.test.ts` — every row of the matrix; uses stubbed `isTty`; no subprocesses.
- **Integration**: `tests/setup-dispatch.test.ts` — one subprocess spawn per case (help, missing-repo, forge-gitlab). Covered by three cases only; we don't need to re-run the full matrix end-to-end.
- **Manual verification**: Run the existing test suite (`npm test`) and confirm 170/170 still pass.

#### Rollback Strategy

The dispatch branch is a ~5-line addition at the top of `server.ts` and a new `lib/setup/` directory. Reverting the phase commit fully removes the subcommand path with no impact on the server. Since Phase 1 writes no state and requires no new dependencies, rollback is trivial.

#### Risks

- **Risk**: Top-level `await import(...)` before any other imports causes ordering issues with `tsx` or the MCP SDK's ESM loader.
  - **Mitigation**: Verified by the subprocess smoke test. If issues arise, fall back to wrapping the dispatch in an immediately-invoked async function inside a small `dispatch()` helper still at the top of `server.ts`.
- **Risk**: `process.argv[2]` might be `undefined` or the script name depending on how `node` is invoked (`node server.ts setup` vs `npx ci-channel setup`).
  - **Mitigation**: Both `node server.ts setup` and `ci-channel setup` produce `process.argv = ['node', '<script>', 'setup', ...]`, so `argv[2] === 'setup'` is correct. `npx -y ci-channel setup` with the built `dist/server.js` also resolves to the same shape. The subprocess smoke test verifies this.
- **Risk**: An existing user's `.mcp.json` has `{"command":"npx","args":["-y","ci-channel","setup"]}` (unlikely but possible typo) — this would no longer boot the server but run the installer.
  - **Mitigation**: Acceptable. The misconfiguration already didn't work (no `setup` command existed before). The installer exits cleanly after running once, which is the right error mode.

---

### Phase 2: Non-interactive installer core

**Dependencies**: Phase 1

#### Objectives

- Implement the full non-interactive installer (`--yes` path): detect project root, load/merge state, provision secret + smee, write state.json (`chmod 600`), create webhook (idempotently), update `.mcp.json` (idempotently, with the 7-shape fail-fast matrix), print next steps.
- Implement `--dry-run` mode that prints every planned action without executing any mutating operation (no network, no file writes, no `gh` POST).
- Implement every idempotency row from the spec, including the `--smee-url` override exception (secret reuse, new webhook, old webhook preserved, warning printed).
- Use `gh api --paginate` for the webhook list.
- Use `stdio: ['pipe', 'pipe', 'pipe']` for the `gh api ... --input -` call to satisfy the "don't inherit `process.stdin`" invariant while still piping the payload.
- Update `runSetup` to actually orchestrate these steps instead of printing "not yet implemented".
- The `--yes` path is fully testable without user input; interactive prompts come in Phase 3.

#### Deliverables

- [ ] `lib/setup/project.ts` — `detectProjectRoot(): string` wrapper around `findProjectRoot(process.cwd())` that throws `SetupError` with the "could not locate project root" message if null. Used by the orchestrator.
- [ ] `lib/setup/state.ts` — `readStateForSetup(projectRoot)` / `writeStateForSetup(projectRoot, state)`. Uses the existing `loadState(path)` / `saveState(state, path)` with an explicit project-local path `join(projectRoot, '.claude/channels/ci/state.json')`. `writeStateForSetup` calls `chmod(path, 0o600)` after writing. Also a helper `legacyGlobalStateExists(): boolean` for the informational note.
- [ ] `lib/setup/gh.ts` — `gh` CLI wrapper:
  - `ghListHooks(repo: string): Promise<GhHook[]>` — spawns `gh api --paginate repos/{repo}/hooks` with `stdio: ['ignore', 'pipe', 'pipe']` (no stdin needed). Parses JSON output. Throws `SetupError` if `gh` binary missing (catches `ENOENT`) or exits non-zero. `--paginate` returns a concatenated JSON array.
  - `ghCreateHook(repo: string, payload: object): Promise<void>` — spawns `gh api repos/{repo}/hooks --method POST --input -` with `stdio: ['pipe', 'pipe', 'pipe']`, writes `JSON.stringify(payload)` to the child's stdin, waits for exit. Throws `SetupError` on non-zero exit with `gh`'s stderr in the message.
  - Both functions take an optional `exec` dependency for testability (default: `node:child_process.spawn`).
- [ ] `lib/setup/mcp-json.ts` — `.mcp.json` read/merge/write:
  - `readMcpJson(path): McpJson` — reads, parses, **throws** on invalid JSON / top-level non-object / `mcpServers` non-object. Returns `{ exists: false }` if the file is missing.
  - `mergeCiServer(mcp: McpJson): { updated: McpJson; changed: boolean; action: 'created' | 'merged' | 'skipped_exists' }` — pure function, no I/O. Adds `mcpServers.ci` = `{ command: "npx", args: ["-y", "ci-channel"] }` if missing; no-op if already present.
  - `writeMcpJson(path, mcp, indent): void` — `JSON.stringify(mcp, null, indent) + '\\n'`; no trailing whitespace changes beyond that.
  - `detectIndent(raw: string): number` — small helper: scans the first indented line and counts leading spaces. Default 2 if not found.
- [ ] `lib/setup/orchestrator.ts` — `runInstall(args: SetupArgs, deps: InstallDeps, io: Io): Promise<void>` — the top-level orchestrator. Takes injected deps (for full testability):
  ```typescript
  interface InstallDeps {
    detectProjectRoot(): string;
    readState(root: string): PluginState;
    writeState(root: string, state: PluginState): void;
    legacyGlobalStateExists(): boolean;
    generateSecret(): string;                  // wraps randomBytes(32).toString('hex')
    fetchSmeeChannel(): Promise<string | null>; // reuses bootstrap.fetchSmeeChannel
    ghListHooks(repo: string): Promise<GhHook[]>;
    ghCreateHook(repo: string, payload: object): Promise<void>;
    readMcpJson(path: string): McpJsonReadResult;
    writeMcpJson(path: string, mcp: McpJson, indent: number): void;
  }
  interface Io {
    info(msg: string): void;   // console.error for human output (stdout reserved for data if needed later)
    warn(msg: string): void;
    confirm(prompt: string): Promise<boolean>;  // phase 3 hooks in; phase 2 uses an auto-yes stub
    prompt(prompt: string): Promise<string>;    // same
  }
  ```
- [ ] `lib/setup/index.ts` — updated `runSetup` that:
  1. Parses args (phase 1)
  2. Enforces `args.yes === true` OR throws "interactive mode not yet implemented" (phase 2 scope guard). Phase 3 relaxes this.
  3. Builds real `InstallDeps` with `fetchSmeeChannel` from `lib/bootstrap.ts`, real `gh` wrappers, real fs helpers, etc.
  4. Builds an `Io` where `confirm()` auto-returns true (because we're in `--yes` mode in phase 2; phase 3 swaps in interactive prompts).
  5. Calls `runInstall(args, deps, io)`.
- [ ] `tests/setup-mcp-json.test.ts` — unit tests for the 7-shape matrix:
  - Missing file → `mergeCiServer` on empty → creates
  - Valid JSON with `mcpServers.ci` → skipped
  - Valid JSON with `mcpServers.other` → merged, other preserved
  - Valid JSON without `mcpServers` → `mcpServers` key added
  - `mcpServers` is string/null/array → `readMcpJson` throws
  - Top-level is array → throws
  - Invalid JSON → throws with parse error detail
  - Round-trip: parse → merge → stringify → parse produces deep-equal mcp
  - Indent detection: 2-space file detected; 4-space file detected; no-indent file defaults to 2
- [ ] `tests/setup-gh.test.ts` — unit tests for `gh` wrapper with `exec` dep injected:
  - `ghListHooks` with single-page mock → returns parsed array
  - `ghListHooks` with multi-page mock (simulated by `--paginate` behavior — one response containing concatenated JSON) → returns merged array
  - `ghListHooks` with `ENOENT` (missing `gh` binary) → `SetupError` with install hint
  - `ghListHooks` with non-zero exit → `SetupError` with stderr
  - `ghCreateHook` writes the payload to stdin and resolves on exit 0 → verify payload bytes
  - `ghCreateHook` non-zero exit → `SetupError` with stderr
  - `ghCreateHook` verifies `stdio` configuration: child must have piped stdin (not `'inherit'`, not `'ignore'`)
- [ ] `tests/setup-orchestrator.test.ts` — unit tests for `runInstall` with all deps mocked, covering every idempotency row:
  - Happy path fresh install → all steps run in order, state.json + webhook + `.mcp.json` all touched
  - Re-run with valid state → steps 3–5 skipped; webhook idempotency check still runs
  - Re-run with matching webhook → create skipped
  - Re-run with non-matching webhook (user has another relay) → create still runs
  - Re-run with existing `.mcp.json` `ci` entry → step 8 skipped
  - `.mcp.json` exists without `ci` → merged
  - `.mcp.json` does not exist → created
  - `.mcp.json` malformed → throws before writing
  - `--dry-run` → no `writeState`, no `ghCreateHook`, no `writeMcpJson`; `readMcpJson` still allowed; `fetchSmeeChannel` NOT called; `generateSecret` NOT called (spec: no network, no mutating ops, and dry-run should be deterministic)
  - `--smee-url` matches state → no-op for state.json
  - `--smee-url` differs from state → state.json updated, secret reused, new webhook created, warning emitted
  - `--smee-url` passed, state has no URL → CLI value used, state.json updated
  - Missing `--repo` (phase 2 input validation, already covered by phase 1 — add a defense-in-depth assertion)
  - Legacy global state exists → informational note emitted (verify `io.info` called once with the expected text)
  - `chmod 600` — verify the state-write path eventually results in a file with `mode & 0o777 === 0o600` (use a real temp dir in this single test for the filesystem behavior; everything else uses mocks)
- [ ] `tests/setup-integration.test.ts` — one end-to-end test using a real temp project directory, mocked `gh` and `fetchSmeeChannel`, but real fs for state.json + `.mcp.json`:
  - Creates a temp dir with a `.git/` marker
  - Runs `runInstall` with `{yes: true, repo: 'owner/repo', dryRun: false, forge: 'github'}`
  - Asserts: state.json exists with expected contents, mode 0o600, `.mcp.json` exists with `ci` entry, mocked `ghCreateHook` called exactly once with expected payload
  - Runs it a second time and asserts idempotency (no extra `ghCreateHook` call, no file mutation)

#### Implementation Details

**Reuse vs new**:
- `findProjectRoot` reused from `lib/project-root.ts` — wrap in `lib/setup/project.ts` for the error-converting thin layer.
- `saveState(state, path)` and `loadState(path)` reused from `lib/state.ts` with explicit project-local paths. No changes to `lib/state.ts`.
- `fetchSmeeChannel` reused from `lib/bootstrap.ts`. No changes to `lib/bootstrap.ts`.
- `ensureSecretReal` is **not** reused — its internal `loadState()` call is cwd-based and hides the path. Instead, the installer directly calls `loadState(projectLocalPath)` + `randomBytes(32).toString('hex')` inline, which gives a cleaner, explicit control flow.

**State lifecycle in Phase 2**:
```
1. state = loadState(projectLocalPath)    // may be {}
2. if (!state.webhookSecret) state.webhookSecret = randomBytes(32).toString('hex')
3. if (args.smeeUrl) {
     if (state.smeeUrl && state.smeeUrl !== args.smeeUrl) {
       io.warn(`Overriding smeeUrl ...`);
     }
     state.smeeUrl = args.smeeUrl;
   } else if (!state.smeeUrl) {
     state.smeeUrl = await deps.fetchSmeeChannel();  // may return null → throw SetupError
   }
4. if (!args.dryRun) deps.writeState(root, state)
```

**Webhook creation**:
```
existingHooks = await deps.ghListHooks(args.repo);
if (existingHooks.some(h => h.config?.url === state.smeeUrl)) {
  io.info(`Webhook already exists for ${state.smeeUrl} — skipping`);
} else if (args.dryRun) {
  io.info(`[dry-run] Would create webhook for ${state.smeeUrl}`);
} else {
  await deps.ghCreateHook(args.repo, {
    config: { url: state.smeeUrl, content_type: 'json', secret: state.webhookSecret },
    events: ['workflow_run'],
    active: true,
  });
}
```

**gh wrapper implementation**:
```typescript
import { spawn } from 'node:child_process';

export async function ghCreateHook(repo: string, payload: object): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', ['api', `repos/${repo}/hooks`, '--method', 'POST', '--input', '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],   // Dedicated stdin pipe; don't inherit process.stdin.
    });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new SetupError('gh CLI not found. Install from https://cli.github.com/ and run `gh auth login`.'));
      } else {
        reject(err);
      }
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new SetupError(`gh api failed (exit ${code}): ${stderr.trim()}`));
    });
    child.stdin.end(JSON.stringify(payload));
  });
}
```

The `ghListHooks` variant uses `stdio: ['ignore', 'pipe', 'pipe']` (no stdin payload) and parses stdout as JSON.

**`.mcp.json` merger**:
```typescript
export function mergeCiServer(raw: McpJsonReadResult): {
  updated: McpJson;
  action: 'created' | 'merged' | 'skipped_exists';
} {
  const CI_ENTRY = { command: 'npx', args: ['-y', 'ci-channel'] };
  if (!raw.exists) {
    return { updated: { mcpServers: { ci: CI_ENTRY } }, action: 'created' };
  }
  const mcp = raw.content;
  if (typeof mcp !== 'object' || mcp === null || Array.isArray(mcp)) {
    throw new SetupError('.mcp.json top-level is not an object. Fix the file and re-run setup.');
  }
  const servers = (mcp as any).mcpServers;
  if (servers === undefined) {
    return { updated: { ...mcp, mcpServers: { ci: CI_ENTRY } }, action: 'merged' };
  }
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) {
    throw new SetupError('.mcp.json has invalid mcpServers (expected object). Fix the file and re-run setup.');
  }
  if ('ci' in servers) {
    return { updated: mcp, action: 'skipped_exists' };
  }
  return {
    updated: { ...mcp, mcpServers: { ...servers, ci: CI_ENTRY } },
    action: 'merged',
  };
}
```

**Dry-run semantics**: In dry-run, the orchestrator calls `readMcpJson` (read-only) and `ghListHooks` is NOT called (the spec forbids network calls for mutating ops, and a list hooks call is arguably not mutating but we err on the side of "no network" to keep dry-run fully offline and deterministic). Instead, dry-run prints `[dry-run] Would check existing hooks for ${repo}` and `[dry-run] Would create webhook ...`. `fetchSmeeChannel` is likewise skipped in dry-run (if state has no smeeUrl, dry-run prints `[dry-run] Would provision smee channel`). Secret generation also skipped in dry-run; output uses `[redacted]`.

**Next-steps output**: After successful install, print:
```
[ci-channel setup] Install complete.

Next steps:
  claude --dangerously-load-development-channels server:ci

If this is your first setup on this repo, approve the server in the /mcp menu
or add 'ci' to enabledMcpjsonServers in ~/.claude.json.
```

#### Acceptance Criteria

- [ ] All 170 existing tests pass.
- [ ] `node --import tsx/esm server.ts setup --yes --repo owner/r --dry-run` completes successfully with all planned actions logged and zero side effects.
- [ ] All new tests in this phase pass (`setup-mcp-json.test.ts`, `setup-gh.test.ts`, `setup-orchestrator.test.ts`, `setup-integration.test.ts`).
- [ ] state.json file created by the integration test has mode `0o600`.
- [ ] `gh api --paginate` appears in `ghListHooks` arg list (verified by test).
- [ ] `ghCreateHook` spawn config verified to use `'pipe'` for stdin (not `'inherit'`, not `'ignore'`).
- [ ] No new runtime dependency yet (`@inquirer/prompts` is Phase 3).

#### Test Plan

- **Unit tests**: 4 new test files covering mcp-json merger, gh wrapper, orchestrator, and a focused integration test.
- **Integration**: One real-fs test to verify chmod + file contents.
- **Manual**: Run `node --import tsx/esm server.ts setup --yes --repo cluesmith/ci-channel --dry-run` against the ci-channel repo itself and visually check the output.

#### Rollback Strategy

Phase 2 adds only files under `lib/setup/` and corresponding tests, plus one line in `lib/setup/index.ts` that now calls the orchestrator. Reverting the Phase 2 commit restores Phase 1's "not yet implemented" stub. The `.mcp.json`, state.json, and webhook operations are all gated behind the subcommand — there is no runtime path that reaches them outside of `setup`.

#### Risks

- **Risk**: `gh api --paginate` concatenates pages in a specific format that the parser may not handle correctly (it returns a single large JSON array, but implementations have varied).
  - **Mitigation**: Test with a mock that emits concatenated JSON matching `gh` 2.x behavior (`[...][...]` joined or `[...]` combined). Verify against a real `gh api --paginate repos/cli/cli/hooks` output during manual testing.
- **Risk**: `child_process.spawn` with `stdio: ['pipe', 'pipe', 'pipe']` hangs if the child's stdout fills up and we never read it.
  - **Mitigation**: Always attach `data` listeners to both stdout and stderr before writing to stdin; collect output into buffers; only resolve on `close`. The test verifies this by returning large mock output.
- **Risk**: `chmod 600` on Windows is a no-op (POSIX mode bits don't apply). This is the only test that depends on POSIX filesystem semantics.
  - **Mitigation**: Skip the chmod assertion on `process.platform === 'win32'` with a comment. The ci-channel repo's CI runs on ubuntu-latest (existing `.github/workflows/`), so this is covered.
- **Risk**: `.mcp.json` is JSON with comments in some Claude Code configurations (JSONC).
  - **Mitigation**: The current `.mcp.json` in this repo is pure JSON. If JSONC is encountered, `JSON.parse` will throw, and the installer will fail fast with a clear error — the correct behavior.
- **Risk**: `legacyGlobalStateExists` touches `~/.claude/channels/ci/state.json`, which may or may not exist and may have sensitive content the installer shouldn't read.
  - **Mitigation**: Use `existsSync` only (no read). The installer prints the informational note without reading the legacy file's contents.
- **Risk**: Running the real integration test in the repo's own cwd could accidentally modify the repo's own `.mcp.json`.
  - **Mitigation**: Integration test uses `os.tmpdir()` + a fresh temp dir per test; never touches `process.cwd()`. Tests use `fs.mkdtempSync` to get an isolated dir.

---

### Phase 3: Interactive prompts

**Dependencies**: Phase 2

#### Objectives

- Add `@inquirer/prompts` as a runtime dependency.
- Implement the interactive `Io` that wraps `@inquirer/prompts` (confirm + input).
- Wire the interactive path into `runSetup` so non-`--yes` invocations prompt before each side-effecting step.
- Handle the "decline" path cleanly — if the user declines any confirmation, print partial-install guidance and exit cleanly with code 0 (or 2 for "stopped by user", TBD in tests — pick one and lock it).
- Handle the interactive-repo-prompt case (TTY + no `--yes` + missing `--repo`) — prompt the user for the repo string, validate it against the regex, re-prompt on invalid input.
- Add TTY fail-fast path (non-TTY + no `--yes`) — already enforced by `parseSetupArgs` in Phase 1; Phase 3 verifies end-to-end.

#### Deliverables

- [ ] `package.json` — add `@inquirer/prompts` to `dependencies` (latest stable). Run `npm install` to update `package-lock.json`.
- [ ] `lib/setup/io.ts` — two implementations of `Io`:
  - `createAutoYesIo(): Io` — `confirm()` returns true; `prompt()` throws (shouldn't be called in `--yes` mode). Used by `runSetup` when `args.yes === true`.
  - `createInteractiveIo(): Io` — `confirm` and `prompt` wrap `@inquirer/prompts`' `confirm` and `input`. `info`/`warn` go to `process.stderr`.
- [ ] `lib/setup/index.ts` — update `runSetup` to:
  - Select `Io` based on `args.yes`
  - If `args.repo === null` (TTY + no `--yes`), prompt for it with regex validation
  - Remove the "interactive mode not yet implemented" guard from Phase 2
- [ ] `lib/setup/orchestrator.ts` — add confirmation prompts before each mutating step:
  - Before smee provisioning (if state lacks smeeUrl): `"Provision a new smee.io channel?"`
  - Before state write: `"Write credentials to <path>?"`
  - Before webhook creation: `"Create GitHub webhook on <repo>?"`
  - Before `.mcp.json` edit: `"Update <path> to register the ci MCP server?"`
  - Each prompt is `await io.confirm(...)`. If `false`, the orchestrator throws a `SetupError` with `exitCode = 0` and a "stopped by user after X step" message. (Exit 0 because a clean decline is not an error condition.)
- [ ] `tests/setup-interactive.test.ts` — tests for the interactive path using a mock `Io` that records prompts and returns scripted answers:
  - All-yes path (all confirms → true) → same outcome as `--yes` mode
  - Decline at webhook step → state.json and smee provisioning happen; webhook and `.mcp.json` do not; exit 0 with "stopped by user" message
  - Decline at `.mcp.json` step → everything else happens; `.mcp.json` untouched
  - Interactive repo prompt: mock `Io.prompt` returns `'bad'` then `'owner/repo'` — second answer accepted; orchestrator proceeds with `owner/repo`
  - Interactive repo prompt: mock `Io.prompt` returns three invalid answers — test that we cap attempts at some reasonable number (e.g., 3) and fail fast with a message
- [ ] `tests/setup-io-tty.test.ts` — TTY detection tests (partially covered in Phase 1, reinforced here):
  - `isTty=false` + `yes=false` → parse error (covered in phase 1, verify again here)
  - `isTty=true` + `yes=false` + `repo=null` → orchestrator enters the interactive-repo-prompt branch (uses a mock `Io`)

#### Implementation Details

**Interactive repo prompt** (in `runSetup` if `args.repo === null`):
```typescript
let repo: string | null = args.repo;
if (!repo) {
  const io = createInteractiveIo();
  for (let attempt = 0; attempt < 3; attempt++) {
    const value = await io.prompt('Target GitHub repo (owner/repo):');
    if (/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(value)) {
      repo = value;
      break;
    }
    io.warn(`Invalid repo format: ${value}. Expected owner/repo.`);
  }
  if (!repo) throw new SetupError('Too many invalid repo attempts; aborting.', 1);
}
```

**Decline-as-clean-exit**: The orchestrator uses a narrow `SetupError` subclass `UserDeclinedError` with `exitCode = 0`:
```typescript
if (!await io.confirm(`Create GitHub webhook on ${repo}?`)) {
  throw new UserDeclinedError('Stopped before webhook creation.');
}
```
`runSetup` catches `UserDeclinedError`, prints the message with a `(user declined)` suffix, and returns 0. Any other `SetupError` returns its `exitCode`.

**Inquirer imports**: Use specific named imports (not the umbrella):
```typescript
import { confirm } from '@inquirer/prompts';
import { input } from '@inquirer/prompts';
```
This is the ESM-native import form. If bundle concerns arise later, the package also supports individual package imports (`@inquirer/confirm`, `@inquirer/input`), but the umbrella is simpler.

**Non-TTY safeguard**: `createInteractiveIo` is only instantiated when `parseSetupArgs` has already verified TTY presence. If somehow called without a TTY, `@inquirer/prompts` will throw its own error; Phase 3 catches and converts to `SetupError` with a clearer message.

#### Acceptance Criteria

- [ ] All 170 existing tests + Phase 1/2 tests pass.
- [ ] `npm install @inquirer/prompts` completes; `package-lock.json` updated.
- [ ] `node --import tsx/esm server.ts setup --repo cluesmith/ci-channel --dry-run` (no `--yes`) launches interactive prompts in a TTY. Manually verified.
- [ ] Mock-based decline tests verify the partial-install behavior.
- [ ] Non-TTY test confirms fail-fast without `--yes`.

#### Test Plan

- **Unit tests**: `setup-interactive.test.ts` uses a scripted mock `Io`. No real TTY needed.
- **Integration**: Optional — a subprocess smoke test with `stdio: ['pipe', 'pipe', 'pipe']` writing `y\\n` to the child's stdin. May be flaky with `@inquirer/prompts` and node-pty dependencies; skip if it is.
- **Manual**: Run setup interactively against a scratch repo to visually confirm the prompt flow.

#### Rollback Strategy

Phase 3 adds `@inquirer/prompts` as a dependency and a new `io.ts` file. Reverting this phase: uninstall the dependency, delete `io.ts`, revert orchestrator to the auto-yes `Io`. The `--yes` path from Phase 2 still works unaffected.

#### Risks

- **Risk**: `@inquirer/prompts` has a hidden dependency incompatibility with node 20 + ESM-only packages.
  - **Mitigation**: Verify during dep install. If incompatible, fall back to `@inquirer/confirm` + `@inquirer/input` as individual packages.
- **Risk**: Inquirer prompts behave differently across terminal emulators (macOS Terminal vs iTerm vs tmux).
  - **Mitigation**: Use only `confirm` and `input` — the two simplest and most portable primitives. No checkboxes, lists, or fancy widgets.
- **Risk**: Stdin handling in Inquirer may conflict with our subprocess dispatch from `server.ts`.
  - **Mitigation**: The dispatch exits before the MCP server starts, so there's no conflict with MCP stdio. Verify by manual test.

---

### Phase 4: Documentation + arch.md updates

**Dependencies**: Phase 3

#### Objectives

- Rewrite `README.md` install section to recommend `ci-channel setup --repo owner/repo` as the primary install method.
- Rewrite `INSTALL.md` with the setup flow as primary and the manual five-step flow as a "Manual install (advanced / troubleshooting)" fallback section.
- Update `AGENTS.md` to tell agents to use `ci-channel setup --yes --repo ...` instead of the five manual steps.
- Update `CLAUDE.md` Architecture section with a bullet for the new `lib/setup/` module.
- Update `codev/resources/arch.md` with the `lib/setup/` module and its role.
- No code changes in this phase.

#### Deliverables

- [ ] `README.md` — replace the multi-step install block. New primary path is:
  ```bash
  cd /path/to/your-project
  npx ci-channel setup --repo owner/your-project
  ```
  Followed by a short "Manual install" link to INSTALL.md for the legacy / troubleshooting flow.
- [ ] `INSTALL.md` — restructured:
  - Section 1: `ci-channel setup` (primary recommended flow)
    - Prerequisites (node 20, `gh` CLI authenticated with `admin:repo_hook` scope)
    - Invocation examples (`--yes`, `--dry-run`, interactive)
    - GitLab / Gitea mention: "the `setup` subcommand only supports GitHub in v1; GitLab/Gitea users should follow the manual install flow below"
    - Troubleshooting section updated with setup-specific errors
  - Section 2: Manual install (advanced / troubleshooting) — the existing 5-step flow kept verbatim
- [ ] `AGENTS.md` — updated install section: "Use `npx ci-channel setup --yes --repo owner/repo` for a one-shot install."
- [ ] `CLAUDE.md` — Architecture section gets a `lib/setup/` entry:
  ```
  - `lib/setup/` — Interactive installer (`ci-channel setup` subcommand): arg parsing, project detection, `.mcp.json` merger, `gh` wrapper, orchestrator, `@inquirer/prompts` wrapper.
  ```
- [ ] `codev/resources/arch.md` — add the `lib/setup/` module section. Format matches the existing module entries (path, purpose, key functions). Also document the subcommand dispatch at the top of `server.ts`.

#### Implementation Details

**README install block** (new):
```markdown
## Installation

### Quick install (recommended)

From inside the project you want to monitor:

\`\`\`bash
npx ci-channel setup --repo owner/your-project
\`\`\`

This runs an interactive installer that:
- Provisions a smee.io channel and generates a webhook secret
- Writes credentials to `.claude/channels/ci/state.json`
- Creates the GitHub webhook via `gh api`
- Registers the `ci` MCP server in `.mcp.json`

Add `--yes` to skip all prompts, `--dry-run` to preview without making changes.

For GitLab, Gitea, or advanced/troubleshooting workflows, see [INSTALL.md](./INSTALL.md).
```

**INSTALL.md restructure**: Add a new top section "Quick install via `ci-channel setup`" that lives above the existing step-1 to step-5 flow. Rename the existing section "Manual install (advanced / troubleshooting)".

#### Acceptance Criteria

- [ ] README's first install example is `npx ci-channel setup --repo owner/repo`.
- [ ] INSTALL.md's first section title contains "Quick install" or "ci-channel setup".
- [ ] INSTALL.md's manual steps are retained verbatim under a clearly-labeled advanced section.
- [ ] AGENTS.md mentions `ci-channel setup --yes`.
- [ ] CLAUDE.md has a `lib/setup/` bullet.
- [ ] `arch.md` has a `lib/setup/` module entry.
- [ ] No code changes in this phase (`git diff` shows only doc files).

#### Test Plan

- **Automated**: None (docs only).
- **Manual**: Read all four docs and verify the new content is coherent and matches the installer's actual behavior.

#### Rollback Strategy

Reverting the Phase 4 commit restores the docs to their state before the install rewrite. Code remains untouched.

#### Risks

- **Risk**: Documentation drift — the docs say the installer does X but the code does Y.
  - **Mitigation**: Phase 4 is the last phase. All code is implemented before docs are written. The person writing docs reads the actual behavior from the test suite and the orchestrator source.
- **Risk**: The manual flow in INSTALL.md gets deleted when it should be retained.
  - **Mitigation**: Acceptance criterion explicitly requires the manual flow to be retained under a renamed section. PR review will catch if it isn't.

---

## Dependency Map

```
Phase 1 (CLI dispatch + arg parsing)
    ↓
Phase 2 (non-interactive installer core)
    ↓
Phase 3 (interactive prompts)
    ↓
Phase 4 (documentation)
```

Strict linear chain. Each phase depends on the previous one and adds a self-contained slice of functionality that leaves the codebase in a working state.

## Resource Requirements

### Development Resources
- TypeScript + Node.js knowledge
- Familiarity with the existing `lib/bootstrap.ts`, `lib/state.ts`, `lib/config.ts`, and `server.ts` flow
- Understanding of the SPIR consultation loop for the verify steps

### Infrastructure
- No new infrastructure
- No new environment variables
- One new runtime dependency: `@inquirer/prompts` (phase 3)

## Integration Points

### External Systems
- **GitHub**: `gh api` CLI. Expects the user's `gh` to be authenticated with `admin:repo_hook` scope. Phase 2.
- **smee.io**: `fetchSmeeChannel()` reused from `lib/bootstrap.ts`. Phase 2.

### Internal Systems
- **lib/project-root.ts**: `findProjectRoot` reused unchanged.
- **lib/state.ts**: `loadState(path)` and `saveState(state, path)` reused with explicit project-local paths.
- **lib/bootstrap.ts**: `fetchSmeeChannel` reused.
- **server.ts**: 5-line dispatch added at the top (before any other imports that parse `process.argv`).

## Risk Analysis

### Technical Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| `gh api --paginate` output format varies across `gh` versions | Low | Medium | Test with real output during manual validation; tests use mocks that match observed behavior. |
| `stdio: ['pipe', ...]` child hangs on large stdout | Low | High | Always attach data listeners before writing stdin; verified by a test that returns a large mock response. |
| `chmod 600` is a no-op on Windows | Medium | Low | Skip the assertion on win32 in tests; project CI runs on Linux. |
| `@inquirer/prompts` has breaking changes or incompatible transitive deps | Low | Medium | Pin the version in `package.json`; test immediately after install. |
| `.mcp.json` with comments (JSONC) exists in a user's project | Low | Medium | Fail fast with a clear parse error — correct behavior. |
| Top-level await in `server.ts` breaks tsx loader | Low | High | Subprocess smoke test in Phase 1 catches this; fallback is a small `await dispatch()` wrapper. |
| `process.argv[2] === 'setup'` misroute in unexpected `node` invocation | Low | Medium | Tests cover `node server.ts setup`, `npx ci-channel setup`, and `dist/server.js setup`. |
| `runSetup` accidentally writes outside the project root (e.g., home directory) | Low | High | All paths derive from `detectProjectRoot()`; integration test uses a temp dir and asserts no writes outside it. |
| Tests with real fs leak temp dirs across runs | Low | Low | Use `fs.mkdtempSync` + cleanup in `after`/`afterEach`; existing tests already handle this pattern. |

### Schedule Risks

Not applicable (no time estimates per SPIR guidance).

## Validation Checkpoints

1. **After Phase 1**: All 170 existing tests pass; `setup --help` works; `setup` fail-fast paths exit with correct messages; MCP server path unchanged.
2. **After Phase 2**: Non-interactive installer works end-to-end against a temp project; `--dry-run` makes no network calls or file writes; every idempotency row covered by tests.
3. **After Phase 3**: Interactive prompts work; decline flow exits cleanly; non-TTY fail-fast confirmed; `@inquirer/prompts` installed and verified.
4. **After Phase 4**: Docs match code; README recommends `setup`; INSTALL.md retains manual flow as fallback.

## Monitoring and Observability

Not applicable — this is a developer tooling feature that runs once per install. No runtime metrics or alerts needed.

## Documentation Updates Required

All covered in Phase 4:
- [ ] `README.md`
- [ ] `INSTALL.md`
- [ ] `AGENTS.md`
- [ ] `CLAUDE.md`
- [ ] `codev/resources/arch.md`

## Post-Implementation Tasks

- [ ] Run the installer against cluesmith/ci-channel itself (we are our own first user, matching Spec 1's E2E validation)
- [ ] Delete and recreate the existing webhook / state.json using `setup` to verify the flow end-to-end
- [ ] Update the GitHub repo's issue #3 with links to the PR
- [ ] Verify the npm-published binary (`ci-channel setup ...`) works after `npm publish` (out of scope for this PR; part of the next release cycle)

## Notes

- Phase 1 is intentionally scaffolding-only to isolate the top-level dispatch risk before layering on filesystem, network, and prompt logic.
- Phase 2 implements the full non-interactive path, including `--dry-run`, so that Phase 3 only needs to add the `Io` layer. This keeps prompts and orchestration concerns separate.
- Phase 4 is docs-only to minimize the chance of documentation drift — docs are written against the final implementation.
- No changes to `lib/bootstrap.ts`, `lib/state.ts`, `lib/project-root.ts`, `lib/config.ts`, `lib/forge.ts`, or any forge implementation. The installer is purely additive.
- Subcommand dispatch is a ~5-line change to `server.ts`; the rest of `server.ts` is untouched.
