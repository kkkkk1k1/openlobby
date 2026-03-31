# WeCom QR Code Scan — Add Bot via Scan

## Problem

Adding a WeCom bot currently requires manually filling in `botId` and `secret` fields. The WeCom CLI tool provides a QR code scanning flow that automatically provisions a bot and returns credentials. Integrating this flow into OpenLobby lets users add a WeCom bot in seconds by scanning a QR code with their WeCom app.

## Design

### Interaction Flow

When adding a WeCom channel provider, the UI defaults to QR code scan mode:

1. User enters an Account ID (to identify this bot in OpenLobby)
2. User clicks "Generate QR Code"
3. Frontend sends `wecom.qr-start` via WebSocket
4. Backend calls WeCom API to generate QR code, returns `qrUrl` to frontend
5. Frontend renders QR code from `qrUrl` using a lightweight QR library
6. Backend polls WeCom API every 3 seconds (up to 5 minutes) for scan result
7. On scan success, backend verifies credentials via WeCom API, then pushes `botId` + `secret` to frontend
8. Frontend auto-calls `channel.add-provider` with the obtained credentials — same path as manual add
9. Bottom of the form has a "Manual input" toggle that reveals the existing `botId` + `secret` fields

### WebSocket Protocol

**New ClientMessage types:**

```typescript
| { type: 'wecom.qr-start' }
| { type: 'wecom.qr-cancel' }
```

**New ServerMessage type:**

```typescript
| {
    type: 'wecom.qr-status';
    status: 'generating' | 'waiting' | 'success' | 'expired' | 'error';
    qrUrl?: string;     // present when status === 'waiting'
    botId?: string;      // present when status === 'success'
    secret?: string;     // present when status === 'success'
    error?: string;      // present when status === 'error'
  }
```

### Backend Module: `wecom-qr.ts`

New file: `packages/server/src/channels/wecom-qr.ts`

Single exported function:

```typescript
export async function startWeComQrFlow(
  onStatus: (status: WeComQrStatus) => void,
  signal: AbortSignal,
): Promise<void>
```

**Internal flow:**

1. `POST https://work.weixin.qq.com/ai/qc/generate` with `{ source: "wecom_cli_external", type: platformType }` — returns `scode` + `auth_url`
2. Call `onStatus({ status: 'waiting', qrUrl: auth_url })`
3. Poll `GET https://work.weixin.qq.com/ai/qc/query_result?scode={scode}` every 3 seconds
4. On success response, extract `bot_id` + `bot_secret`
5. Verify via `POST https://qyapi.weixin.qq.com/cgi-bin/aibot/cli/get_mcp_config` with SHA-256 signature: `hash = SHA256(secret + bot_id + timestamp + nonce)`
6. Call `onStatus({ status: 'success', botId, secret })`
7. On timeout (5 min) or abort: `onStatus({ status: 'expired' })` or `onStatus({ status: 'error', error })`

Platform type detection: use `process.platform` — `darwin` → 1, `win32` → 2, `linux` → 3.

### WebSocket Handler Integration

In `ws-handler.ts`, add handlers for:

- `wecom.qr-start`: Create an `AbortController`, call `startWeComQrFlow`, pipe `onStatus` callbacks to the WebSocket as `wecom.qr-status` messages. Store the abort controller keyed by listener ID.
- `wecom.qr-cancel`: Abort the stored controller for this listener.
- On WebSocket close: abort any active QR flow for that listener.

Only one QR flow per WebSocket connection at a time.

### Frontend Changes

In `ChannelManagePanel.tsx` (`AddProviderForm`):

- When `channelName === 'wecom'`, default to QR scan mode
- QR scan mode UI: Account ID input + "Generate QR Code" button + QR code display area + status text
- QR code rendered using `qrcode` npm package (lightweight, generates SVG/canvas from a URL string)
- State machine: `idle` → `generating` → `waiting` → `success` (auto-add) / `expired` (retry) / `error`
- On `success`: auto-assemble `ChannelProviderConfig` with `{ botId, secret }` and call `wsAddProvider`, then close form
- "Manual input" link at bottom toggles to the existing credential fields (`botId`, `secret`)

### Credential Field Fix

The current UI collects `corpId` and `agentId`, but the WeCom SDK expects `botId`. Fix the `CHANNEL_FIELDS` definition:

```typescript
wecom: [
  { key: 'botId', label: 'Bot ID', required: true, type: 'text', placeholder: 'aibxxxxxxxx' },
  { key: 'secret', label: 'Secret', required: true, type: 'password' },
],
```

Remove the unused `corpId` field.

### Error Handling

- Network errors during QR generation: push `{ status: 'error', error: message }`, frontend shows error with retry button
- Polling timeout (5 min): push `{ status: 'expired' }`, frontend shows "QR code expired" with regenerate button
- Credential verification failure: push `{ status: 'error', error: 'Credential verification failed' }`
- User cancels (navigates away or clicks cancel): frontend sends `wecom.qr-cancel`, backend aborts polling
- WebSocket disconnection during polling: abort controller triggers cleanup

### Dependencies

- `qrcode` npm package added to `packages/web` for QR code rendering
- No new server-side dependencies — uses native `fetch` for HTTP calls and `crypto` for SHA-256
