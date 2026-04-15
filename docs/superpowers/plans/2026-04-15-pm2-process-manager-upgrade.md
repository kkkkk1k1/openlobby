# Process Manager-Aware Auto-Upgrade — Implementation Plan

> Date: 2026-04-15
> Spec: [pm2-process-manager-upgrade-design.md](../specs/2026-04-15-pm2-process-manager-upgrade-design.md)

## Tasks

### Task 1: Add `isUnderProcessManager()` to bin.ts and change upgrade restart strategy

**File**: `packages/cli/src/bin.ts`

**Changes**:
1. Add `isUnderProcessManager()` function that checks `PM2_HOME`, `pm_id`, `INVOCATION_ID`, `SUPERVISOR_ENABLED` env vars
2. Modify the `update-and-restart` IPC handler:
   - If under process manager: kill Child, wait for Child exit, then `process.exit(0)` — let pm2/systemd restart the whole process
   - If not under process manager: keep existing behavior (kill Child → fork new Child)
3. Add log message distinguishing which restart path is taken

**Acceptance Criteria**:
- With `pm_id` env set: Wrapper exits after update
- Without pm env: Wrapper stays alive, forks new Child (existing behavior unchanged)

---

### Task 2: Fix version number to read from package.json in server-main.ts

**File**: `packages/cli/src/server-main.ts`

**Changes**:
1. Add `getVersion()` function that reads `../package.json` from disk
2. Fallback to `process.env.OPENLOBBY_VERSION` if file read fails
3. Use `getVersion()` instead of `process.env.OPENLOBBY_VERSION` directly

**Acceptance Criteria**:
- After upgrade, Child reports the new version number even if Wrapper env has old version

---

### Task 3: Handle cluster mode detection in /api/update

**File**: `packages/server/src/index.ts`

**Changes**:
1. Import `cluster` from `node:cluster`
2. In `POST /api/update` handler, check `cluster.isWorker`
3. If cluster mode: return `{ status: 'error', message: 'Cluster mode detected. Please use pm2 restart to apply updates.' }`

**Acceptance Criteria**:
- In pm2 cluster mode, `/api/update` returns informative error instead of sending IPC to pm2 master

---

### Task 4: Add unit tests

**File**: `packages/cli/src/__tests__/process-manager-detection.test.ts` (new)

**Tests**:
1. `isUnderProcessManager()` returns `true` when `pm_id` is set
2. `isUnderProcessManager()` returns `true` when `PM2_HOME` is set
3. `isUnderProcessManager()` returns `true` when `INVOCATION_ID` is set
4. `isUnderProcessManager()` returns `true` when `SUPERVISOR_ENABLED` is set
5. `isUnderProcessManager()` returns `false` when none are set

**File**: `packages/cli/src/__tests__/get-version.test.ts` (new)

**Tests**:
1. `getVersion()` reads version from package.json
2. `getVersion()` falls back to env when package.json not found

---

### Task 5: Build verification

Run `pnpm -r build` to verify esbuild bundles both entry points correctly with the new changes.

## Execution Order

```
Task 1 (bin.ts) ──┐
Task 2 (server-main.ts) ──┼── Task 4 (tests) ── Task 5 (build verify)
Task 3 (index.ts) ──┘
```

Tasks 1-3 are independent and can be done in parallel. Task 4 depends on 1-2. Task 5 is final verification.
