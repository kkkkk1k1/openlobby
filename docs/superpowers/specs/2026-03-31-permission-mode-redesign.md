# Permission Mode Redesign

## Problem Statement

The current permission system has four critical issues:

1. **Configured permissions don't take effect** — Setting `bypassPermissions` still triggers approval messages because `handleToolApproval` in Claude Code adapter never checks `permissionMode`, and `updateOptions` doesn't affect already-running SDK queries.
2. **UI persistence broken** — Refreshing sometimes resets permission display to "Keep current" (empty string fallback). Users cannot see which permission mode is actually active.
3. **CLI-centric naming** — Permission modes (`bypassPermissions`, `default`, `plan`) are Claude Code SDK terms hardcoded in lobby business logic. Different CLI types have different native permission vocabularies.
4. **Config doesn't apply in real-time** — `updateOptions` only updates `spawnOptions` via `Object.assign` but the running query already captured the old value at start time.

## Design

### 1. Unified Permission Enum

OpenLobby defines its own three-level permission model. All lobby-layer code (SessionManager, ChannelRouter, UI) uses only these values.

```typescript
// packages/core/src/types.ts
export type PermissionMode = 'auto' | 'supervised' | 'readonly';
```

| Mode | Semantics |
|---|---|
| `auto` | Fully automatic — skip all approval prompts, auto-approve everything |
| `supervised` | Dangerous operations require user approval |
| `readonly` | Read-only — deny all write/mutate operations |

The `"dontAsk"` alias (used by LobbyManager) maps to `auto`.

### 2. Adapter-Declared Permission Mapping

Each Adapter declares its own mapping from OpenLobby modes to native CLI labels. This is **not** hardcoded in lobby business code.

```typescript
// packages/core/src/types.ts
export interface AdapterPermissionMeta {
  /** Human-readable native label for each OpenLobby permission mode */
  modeLabels: Record<PermissionMode, string>;
}
```

Each adapter exports this via a static method or property on the Adapter class:

```typescript
// packages/core/src/adapters/claude-code.ts
static permissionMeta: AdapterPermissionMeta = {
  modeLabels: {
    auto: 'bypassPermissions',
    supervised: 'default',
    readonly: 'plan',
  },
};

// packages/core/src/adapters/codex-cli.ts
static permissionMeta: AdapterPermissionMeta = {
  modeLabels: {
    auto: 'never',
    supervised: 'on-request',
    readonly: 'on-request + plan',
  },
};

// packages/core/src/adapters/opencode.ts
static permissionMeta: AdapterPermissionMeta = {
  modeLabels: {
    auto: 'auto-approve',
    supervised: 'prompt',
    readonly: 'plan + auto-reject',
  },
};
```

The lobby UI reads `permissionMeta.modeLabels` from the adapter to render labels like `Auto (bypassPermissions)`.

### 3. Two-Layer Configuration

#### 3a. Global Defaults (per adapter type)

New SQLite table:

```sql
CREATE TABLE IF NOT EXISTS adapter_defaults (
  adapter_name TEXT PRIMARY KEY,
  permission_mode TEXT NOT NULL DEFAULT 'supervised'
);
```

- One row per registered adapter type.
- Fallback if no row exists: `'supervised'`.
- Managed via a new "Global Settings" UI section and a new WebSocket command (`ws:getAdapterDefaults` / `ws:setAdapterDefaults`).

#### 3b. Session-Level Override

Existing `sessions.permission_mode` column. Values: `'auto' | 'supervised' | 'readonly' | NULL`.

- `NULL` means "inherit from global default for this adapter type".
- Non-null means explicit override for this session.

#### 3c. Resolution Order

```
effectiveMode = session.permission_mode ?? adapterDefaults[session.adapter_name] ?? 'supervised'
```

This resolution happens in `SessionManager` via a helper:

```typescript
resolvePermissionMode(session: ManagedSession): PermissionMode {
  if (session.permissionMode) return session.permissionMode;
  const adapterDefault = this.db.getAdapterDefault(session.adapterName);
  return adapterDefault?.permission_mode ?? 'supervised';
}
```

### 4. Immediate Effect Mechanism

Permission changes must take effect immediately, even for currently running queries.

#### 4a. Claude Code Adapter

`handleToolApproval` checks the **current** `this.spawnOptions.permissionMode` on every invocation:

```typescript
private handleToolApproval(toolName, toolInput, toolUseID) {
  const mode = this.spawnOptions.permissionMode ?? 'supervised';

  // Auto mode: approve everything immediately
  if (mode === 'auto') {
    return Promise.resolve({ behavior: 'allow', updatedInput: toolInput, toolUseID });
  }

  // Readonly mode: deny non-read-only tools
  if (mode === 'readonly' && !READONLY_TOOLS.includes(toolName)) {
    return Promise.resolve({ behavior: 'deny', message: 'Readonly mode', toolUseID });
  }

  // Supervised mode: emit control message and wait for user
  // ... existing approval flow ...
}
```

Since `canUseTool` is called per tool-use and reads `this.spawnOptions` each time, and `updateOptions` mutates `this.spawnOptions`, changes take effect on the very next tool call within the same query.

The existing `planMode` flag is **removed** from the adapter. Its functionality is subsumed by `readonly` permission mode.

#### 4b. Codex CLI Adapter

`handleToolApproval` (the `requestApproval` RPC handler) applies the same pattern: check `this.spawnOptions.permissionMode` at each invocation. In `auto` mode, immediately respond with approval via RPC. In `readonly` mode, auto-deny write operations.

The `approvalPolicy` sent at session start is set based on the initial permission mode. Runtime changes are enforced at the adapter layer (intercepting approval requests before they reach the user), not via RPC policy update.

#### 4c. OpenCode Adapter

`handlePermissionUpdated` applies the same pattern: check `this.spawnOptions.permissionMode`. In `auto` mode, immediately reply `once` via the OpenCode API without emitting a control message. In `readonly` mode, auto-reply `reject` for write operations.

### 5. UI Changes

#### 5a. Permission Badge in RoomHeader

Always-visible badge next to session name showing the effective permission mode:

- `Auto` — green badge (bg-green-900/30 text-green-400)
- `Supervised` — yellow badge (bg-yellow-900/30 text-yellow-400)
- `Readonly` — blue badge (bg-blue-900/30 text-blue-400)

If inherited from global default, append `(default)` — e.g., `Supervised (default)`.

Badge text includes the native CLI label in a tooltip: `"Supervised — maps to 'default' in Claude Code"`.

#### 5b. Session Settings Panel (RoomHeader dropdown)

Replace the permission `<select>` options:

```
- Use global default (currently: Supervised)   ← shown when session has no override
- Auto (<native_label>)
- Supervised (<native_label>)
- Readonly (<native_label>)
```

Where `<native_label>` is fetched from `permissionMeta.modeLabels` for the session's adapter type.

Remove the "Keep current" concept entirely. The select always shows the actual effective mode.

Initialization: when opening Settings, set the select value to `session.permissionMode ?? ''` where `''` represents "Use global default". The label for `''` dynamically shows the resolved default.

#### 5c. Global Defaults UI

New section accessible from sidebar or a "Global Settings" button. For each registered adapter type, show:

```
Claude Code:  [Auto (bypassPermissions) | Supervised (default) | Readonly (plan)]
Codex CLI:    [Auto (never) | Supervised (on-request) | Readonly (on-request + plan)]
OpenCode:     [Auto (auto-approve) | Supervised (prompt) | Readonly (plan + auto-reject)]
```

Changes saved immediately via WebSocket to `adapter_defaults` table.

#### 5d. NewSessionDialog

The permission mode select in the new-session dialog also uses the unified modes with native labels, based on the selected adapter type. Default selection is "Use global default".

### 6. Server-Side Changes

#### 6a. Database (`packages/server/src/db.ts`)

- New `adapter_defaults` table creation in migration block.
- New methods: `getAdapterDefault(adapterName)`, `setAdapterDefault(adapterName, permissionMode)`, `getAllAdapterDefaults()`.

#### 6b. SessionManager

- New `resolvePermissionMode(session)` helper.
- `configureSession()`: when `permissionMode` is updated, also call `session.process.updateOptions({ permissionMode })` so the adapter reads the new value immediately.
- `spawnSession()`: resolve permission mode at spawn time using the two-layer resolution.
- Remove `planMode` tracking — it becomes `readonly` permission mode.
- Remove `pendingPlanMode` map.

#### 6c. WebSocket Handler

- New commands: `getAdapterDefaults`, `setAdapterDefaults`.
- Existing `configureSession` command: accept the new `PermissionMode` values.
- Existing `togglePlanMode` command: translate to `configureSession({ permissionMode: enabled ? 'readonly' : 'supervised' })`.

#### 6d. ChannelRouter

- Approval message routing: before formatting and sending to IM, check if the session's effective permission mode is `auto`. If so, skip sending — the adapter already auto-approved.
- This is a safety net; the adapter layer is the primary enforcement point.

### 7. AdapterPermissionMeta Delivery to Frontend

The frontend needs `modeLabels` to render native labels. Delivery mechanism:

- Each adapter's `permissionMeta` is registered in `SessionManager` when the adapter is loaded.
- The `session:list` / `session:update` WebSocket responses include an `adapterPermissionMeta` field (or a separate `adapter:meta` command returns all adapter metadata including `permissionMeta`).
- Frontend stores this in `lobby-store` keyed by adapter name.

### 8. Migration Path

- Existing `permission_mode` values in `sessions` table (`'bypassPermissions'`, `'default'`, `'plan'`, `'dontAsk'`, `''`, `NULL`):
  - `'bypassPermissions'` / `'dontAsk'` → `'auto'`
  - `'default'` / `''` / `NULL` → `NULL` (inherit global default)
  - `'plan'` → `'readonly'`
- Run migration in `db.ts` initialization block.
- Frontend: replace all old permission mode string references.

### 9. Testing Strategy

- **Unit tests**: `resolvePermissionMode` with all combinations (session override, global default, fallback).
- **Adapter tests**: Each adapter's `handleToolApproval` behavior in all three modes.
- **Integration tests**: Permission change via WebSocket → immediate effect on next tool approval.
- **Migration test**: Old values correctly mapped to new enum.
