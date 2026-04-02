# Resume Cmd Button Optimization

## Problem

The "Resume Cmd" button in the web frontend has several UX issues:

1. **Unclear purpose** — "Resume Cmd" text does not convey what the button does
2. **No feedback** — clicking the button silently copies to clipboard with no visual confirmation
3. **No cross-platform fallback** — uses `navigator.clipboard.writeText()` only, which fails in non-HTTPS/non-localhost environments; no graceful degradation for Linux/Windows edge cases
4. **Scattered clipboard logic** — both `RoomHeader.tsx` and `MessageBubble.tsx` have independent `CopyButton` components that directly call `navigator.clipboard` without fallback

## Design

### 1. Universal clipboard utility — `copyToClipboard()`

**File:** `packages/web/src/utils/clipboard.ts`

A single async function with three-level degradation:

1. **`navigator.clipboard.writeText()`** — modern browsers + HTTPS/localhost
2. **`document.execCommand('copy')`** — legacy fallback using a hidden textarea
3. **Return `false`** — caller shows a lightweight popover with selectable text for manual copy

Signature:

```ts
export async function copyToClipboard(text: string): Promise<boolean>;
```

- Returns `true` if copy succeeded (level 1 or 2)
- Returns `false` if both levels failed; caller is responsible for fallback UI

### 2. Resume Cmd button — icon-based redesign

**File:** `packages/web/src/components/RoomHeader.tsx`

Replace the current text button with a clipboard icon button, consistent with the adjacent Compact button's style.

**Visual states:**

| State | Appearance |
|-------|-----------|
| Default | Clipboard SVG icon, same size/style as Compact button |
| Hover | `title` tooltip showing full command, e.g. `Copy: claude --resume abc123` |
| Click success | Icon changes to checkmark (✓) for 1.5s, then reverts |
| Click fallback | Lightweight popover appears below the button |

**Fallback popover:**

- Appears when `copyToClipboard()` returns `false`
- Contains the full command text in a `<code>` block, user-selectable
- Styled to match existing Settings panel: `bg-gray-800 border border-gray-600 rounded shadow-xl`
- Dismisses on click outside (same pattern as Settings panel backdrop)

**Component state:**

```ts
const [copied, setCopied] = useState(false);       // controls checkmark display
const [showFallback, setShowFallback] = useState(false); // controls popover

// onClick:
const ok = await copyToClipboard(session.resumeCommand);
if (ok) {
  setCopied(true);
  setTimeout(() => setCopied(false), 1500);
} else {
  setShowFallback(true);
}
```

### 3. CopyButton component — upgrade with fallback

**Files:**
- `packages/web/src/components/RoomHeader.tsx` — `CopyButton` used for CWD / Session ID in Settings panel
- `packages/web/src/components/MessageBubble.tsx` — `CopyButton` used for code block copy

Both components are updated to:

1. Replace `navigator.clipboard.writeText()` with `copyToClipboard()`
2. Add fallback popover when copy fails (same lightweight popover pattern)

The existing "Copied!" text feedback in `RoomHeader`'s `CopyButton` and `MessageBubble`'s `CopyButton` remain unchanged — only the underlying copy mechanism and fallback are added.

## Files Changed

| File | Change |
|------|--------|
| `packages/web/src/utils/clipboard.ts` | **New** — `copyToClipboard()` utility |
| `packages/web/src/components/RoomHeader.tsx` | **Modify** — Resume Cmd button: text → icon + tooltip + ✓ feedback + fallback popover; `CopyButton`: use `copyToClipboard()` + fallback popover |
| `packages/web/src/components/MessageBubble.tsx` | **Modify** — `CopyButton`: use `copyToClipboard()` + fallback popover |

## Out of Scope

- Opening system terminal directly from the browser (not feasible for web apps)
- Extracting `CopyButton` into a shared component file (the two variants serve different UIs and are small enough to keep inline)
