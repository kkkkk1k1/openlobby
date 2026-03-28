# AskUserQuestion Card Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render SDK `AskUserQuestion` tool calls as interactive question cards (single/multi select) on Web and IM, instead of generic Allow/Deny approval cards.

**Architecture:** Extend the existing `control` message flow with optional `questions` data. When `toolName === 'AskUserQuestion'`, the adapter extracts structured question data and passes it through the entire chain. Web renders a new `QuestionCard` component; IM uses sequential callback buttons. The `respondControl` method gains an optional `payload` parameter to carry answers back to the SDK.

**Tech Stack:** TypeScript, React, Tailwind CSS, Zustand, Fastify WebSocket

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/core/src/types.ts` | Modify | Add `questions` to `ControlRequest`, add `payload` to `respondControl` |
| `packages/core/src/protocol.ts` | Modify | Add `payload` to `control.respond` ClientMessage |
| `packages/core/src/adapters/claude-code.ts` | Modify | Detect `AskUserQuestion`, emit `questions`, handle `payload` in `respondControl` |
| `packages/web/src/stores/lobby-store.ts` | Modify | Add `questions` to `ControlRequestData` |
| `packages/web/src/hooks/useWebSocket.ts` | Modify | Add `payload` param to `wsRespondControl` |
| `packages/web/src/components/QuestionCard.tsx` | Create | New component: interactive question card with single/multi select |
| `packages/web/src/components/MessageList.tsx` | Modify | Conditional render: QuestionCard vs ControlCard |
| `packages/web/src/App.tsx` | Modify | Update `onControlRespond` type to include optional payload |
| `packages/server/src/session-manager.ts` | Modify | Add `payload` param to `respondControl` |
| `packages/server/src/ws-handler.ts` | Modify | Pass `questions` in `control.request`, pass `payload` in `control.respond` |
| `packages/server/src/channel-router.ts` | Modify | Detect `questions` in control msgs, implement sequential callback button interaction |

---

### Task 1: Extend core types with `questions` and `payload`

**Files:**
- Modify: `packages/core/src/types.ts:52-66`
- Modify: `packages/core/src/protocol.ts:25-30`

- [ ] **Step 1: Add `questions` to `ControlRequest` and `payload` to `respondControl`**

In `packages/core/src/types.ts`, replace lines 52-66:

```typescript
export interface ControlRequest {
  requestId: string;
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}

/** 代表一个运行中的 CLI 会话 */
export interface AgentProcess extends EventEmitter {
  sessionId: string;
  readonly adapter: string;
  status: 'running' | 'idle' | 'stopped' | 'error' | 'awaiting_approval';

  sendMessage(content: string): void;
  respondControl(requestId: string, decision: ControlDecision): void;
```

with:

```typescript
/** Structured question for AskUserQuestion tool */
export interface ControlQuestion {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
}

export interface ControlRequest {
  requestId: string;
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  /** Structured questions when toolName === 'AskUserQuestion' */
  questions?: ControlQuestion[];
}

/** 代表一个运行中的 CLI 会话 */
export interface AgentProcess extends EventEmitter {
  sessionId: string;
  readonly adapter: string;
  status: 'running' | 'idle' | 'stopped' | 'error' | 'awaiting_approval';

  sendMessage(content: string): void;
  respondControl(requestId: string, decision: ControlDecision, payload?: Record<string, unknown>): void;
```

- [ ] **Step 2: Add `payload` to `control.respond` in protocol**

In `packages/core/src/protocol.ts`, replace lines 25-30:

```typescript
  | {
      type: 'control.respond';
      sessionId: string;
      requestId: string;
      decision: ControlDecision;
    }
```

with:

```typescript
  | {
      type: 'control.respond';
      sessionId: string;
      requestId: string;
      decision: ControlDecision;
      payload?: Record<string, unknown>;
    }
```

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/protocol.ts
git commit -m "feat(core): add questions to ControlRequest and payload to respondControl

ControlRequest gains optional questions field for AskUserQuestion tool.
AgentProcess.respondControl gains optional payload for answer injection.
control.respond protocol message gains optional payload field."
```

---

### Task 2: Claude Code adapter — detect AskUserQuestion and handle payload

**Files:**
- Modify: `packages/core/src/adapters/claude-code.ts:332-410`

- [ ] **Step 1: Extract questions in `handleToolApproval`**

In `packages/core/src/adapters/claude-code.ts`, replace lines 353-362:

```typescript
    const requestId = randomUUID();
    console.log('[ClaudeCode] Tool approval requested:', toolName, 'toolUseID:', toolUseID);

    const controlMsg = makeLobbyMessage(this.sessionId, 'control', {
      requestId,
      toolName,
      toolInput,
      toolUseID,
    });
    this.emit('message', controlMsg);
```

with:

```typescript
    const requestId = randomUUID();
    console.log('[ClaudeCode] Tool approval requested:', toolName, 'toolUseID:', toolUseID);

    // Extract structured questions for AskUserQuestion tool
    const questions = toolName === 'AskUserQuestion' && Array.isArray(toolInput.questions)
      ? (toolInput.questions as Array<{
          question: string;
          header: string;
          options: Array<{ label: string; description: string }>;
          multiSelect: boolean;
        }>)
      : undefined;

    const controlMsg = makeLobbyMessage(this.sessionId, 'control', {
      requestId,
      toolName,
      toolInput,
      toolUseID,
      questions,
    });
    this.emit('message', controlMsg);
```

- [ ] **Step 2: Handle payload in `respondControl`**

In the same file, replace lines 395-410:

```typescript
  respondControl(requestId: string, decision: ControlDecision): void {
    const pending = this.pendingControls.get(requestId);
    if (!pending) {
      console.warn('[ClaudeCode] No pending control for:', requestId);
      return;
    }

    console.log('[ClaudeCode] Control response:', requestId, decision);
    this.pendingControls.delete(requestId);

    if (decision === 'allow') {
      pending.resolve({ behavior: 'allow', updatedInput: pending.toolInput });
    } else {
      pending.resolve({ behavior: 'deny', message: 'User denied the tool', interrupt: true });
    }
  }
```

with:

```typescript
  respondControl(requestId: string, decision: ControlDecision, payload?: Record<string, unknown>): void {
    const pending = this.pendingControls.get(requestId);
    if (!pending) {
      console.warn('[ClaudeCode] No pending control for:', requestId);
      return;
    }

    console.log('[ClaudeCode] Control response:', requestId, decision, payload ? 'with payload' : '');
    this.pendingControls.delete(requestId);

    if (decision === 'allow') {
      // If payload contains answers (from AskUserQuestion), inject into updatedInput
      const updatedInput = payload?.answers
        ? { ...pending.toolInput, answers: payload.answers }
        : pending.toolInput;
      pending.resolve({ behavior: 'allow', updatedInput });
    } else {
      pending.resolve({ behavior: 'deny', message: 'User denied the tool', interrupt: true });
    }
  }
```

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/adapters/claude-code.ts
git commit -m "feat(claude-code): detect AskUserQuestion and inject answers via payload

handleToolApproval extracts questions when toolName is AskUserQuestion.
respondControl injects payload.answers into updatedInput for SDK."
```

---

### Task 3: Server layer — pass payload through respondControl

**Files:**
- Modify: `packages/server/src/session-manager.ts:481-495`
- Modify: `packages/server/src/ws-handler.ts:20-36,130-139`

- [ ] **Step 1: Add `payload` to `SessionManager.respondControl`**

In `packages/server/src/session-manager.ts`, replace lines 481-495:

```typescript
  respondControl(
    sessionId: string,
    requestId: string,
    decision: ControlDecision,
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session "${sessionId}" not found`);
    session.process.respondControl(requestId, decision);
    // Restore status from awaiting_approval to running
    if (session.status === 'awaiting_approval') {
      session.status = 'running';
      this.persistSessionStatus(session);
      this.broadcastSessionUpdate(session);
    }
  }
```

with:

```typescript
  respondControl(
    sessionId: string,
    requestId: string,
    decision: ControlDecision,
    payload?: Record<string, unknown>,
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session "${sessionId}" not found`);
    session.process.respondControl(requestId, decision, payload);
    // Restore status from awaiting_approval to running
    if (session.status === 'awaiting_approval') {
      session.status = 'running';
      this.persistSessionStatus(session);
      this.broadcastSessionUpdate(session);
    }
  }
```

- [ ] **Step 2: Pass `questions` in `control.request` and `payload` in `control.respond` in ws-handler**

In `packages/server/src/ws-handler.ts`, replace lines 20-36:

```typescript
      if (msg.type === 'control') {
        const content = msg.content as Record<string, unknown>;
        send({
          type: 'control.request',
          sessionId,
          request: {
            requestId: content.requestId as string,
            sessionId,
            toolName: content.toolName as string,
            toolInput: content.toolInput as Record<string, unknown>,
          },
        });
```

with:

```typescript
      if (msg.type === 'control') {
        const content = msg.content as Record<string, unknown>;
        send({
          type: 'control.request',
          sessionId,
          request: {
            requestId: content.requestId as string,
            sessionId,
            toolName: content.toolName as string,
            toolInput: content.toolInput as Record<string, unknown>,
            questions: content.questions as Array<{
              question: string;
              header: string;
              options: Array<{ label: string; description: string }>;
              multiSelect: boolean;
            }> | undefined,
          },
        });
```

In the same file, replace lines 132-139 (the `control.respond` case):

```typescript
        case 'control.respond': {
          sessionManager.respondControl(
            data.sessionId,
            data.requestId,
            data.decision,
          );
          break;
        }
```

with:

```typescript
        case 'control.respond': {
          sessionManager.respondControl(
            data.sessionId,
            data.requestId,
            data.decision,
            (data as { payload?: Record<string, unknown> }).payload,
          );
          break;
        }
```

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/session-manager.ts packages/server/src/ws-handler.ts
git commit -m "feat(server): pass questions and payload through control flow

SessionManager.respondControl gains optional payload parameter.
ws-handler passes questions in control.request and payload in control.respond."
```

---

### Task 4: Web frontend — extend store and WebSocket with questions/payload

**Files:**
- Modify: `packages/web/src/stores/lobby-store.ts:54-59`
- Modify: `packages/web/src/hooks/useWebSocket.ts:237-244`

- [ ] **Step 1: Add `questions` to `ControlRequestData`**

In `packages/web/src/stores/lobby-store.ts`, replace lines 54-59:

```typescript
export interface ControlRequestData {
  requestId: string;
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}
```

with:

```typescript
export interface ControlQuestionData {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
}

export interface ControlRequestData {
  requestId: string;
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  /** Structured questions when toolName === 'AskUserQuestion' */
  questions?: ControlQuestionData[];
}
```

- [ ] **Step 2: Add `payload` param to `wsRespondControl`**

In `packages/web/src/hooks/useWebSocket.ts`, replace lines 237-244:

```typescript
export function wsRespondControl(
  sessionId: string,
  requestId: string,
  decision: 'allow' | 'deny',
): void {
  wsSend({ type: 'control.respond', sessionId, requestId, decision });
  useLobbyStore.getState().setPendingControl(sessionId, null);
}
```

with:

```typescript
export function wsRespondControl(
  sessionId: string,
  requestId: string,
  decision: 'allow' | 'deny',
  payload?: Record<string, unknown>,
): void {
  wsSend({ type: 'control.respond', sessionId, requestId, decision, payload });
  useLobbyStore.getState().setPendingControl(sessionId, null);
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/stores/lobby-store.ts packages/web/src/hooks/useWebSocket.ts
git commit -m "feat(web): extend ControlRequestData with questions, wsRespondControl with payload

ControlRequestData gains optional questions field for QuestionCard rendering.
wsRespondControl gains optional payload for sending answers back."
```

---

### Task 5: Web frontend — create QuestionCard component

**Files:**
- Create: `packages/web/src/components/QuestionCard.tsx`

- [ ] **Step 1: Create QuestionCard component**

Create `packages/web/src/components/QuestionCard.tsx`:

```typescript
import React, { useState, useCallback } from 'react';
import type { ControlQuestionData } from '../stores/lobby-store';

interface Props {
  requestId: string;
  questions: ControlQuestionData[];
  onSubmit: (requestId: string, decision: 'allow' | 'deny', payload?: Record<string, unknown>) => void;
}

export default function QuestionCard({ requestId, questions, onSubmit }: Props) {
  // answers[questionIndex] = selected label(s). Single-select: "label". Multi-select: "a,b".
  const [answers, setAnswers] = useState<Record<number, string[]>>({});
  // Per-question "Other" text
  const [otherTexts, setOtherTexts] = useState<Record<number, string>>({});
  const [submitted, setSubmitted] = useState(false);

  const toggleOption = useCallback((qIdx: number, label: string, multiSelect: boolean) => {
    setAnswers((prev) => {
      const current = prev[qIdx] ?? [];
      if (multiSelect) {
        // Toggle: add or remove
        const next = current.includes(label)
          ? current.filter((l) => l !== label)
          : [...current, label];
        return { ...prev, [qIdx]: next };
      } else {
        // Single select: replace (clear "Other" if selecting an option)
        if (label !== '__other__') {
          setOtherTexts((ot) => ({ ...ot, [qIdx]: '' }));
        }
        return { ...prev, [qIdx]: [label] };
      }
    });
  }, []);

  const setOtherText = useCallback((qIdx: number, text: string) => {
    setOtherTexts((prev) => ({ ...prev, [qIdx]: text }));
    // Auto-select "Other" when typing
    setAnswers((prev) => {
      const q = questions[qIdx];
      if (q.multiSelect) {
        const current = prev[qIdx] ?? [];
        if (!current.includes('__other__')) {
          return { ...prev, [qIdx]: [...current, '__other__'] };
        }
        return prev;
      } else {
        return { ...prev, [qIdx]: ['__other__'] };
      }
    });
  }, [questions]);

  const allAnswered = questions.every((_, idx) => {
    const selected = answers[idx] ?? [];
    if (selected.length === 0) return false;
    // If "Other" is selected, text must be non-empty
    if (selected.includes('__other__') && !(otherTexts[idx]?.trim())) return false;
    return true;
  });

  const handleSubmit = () => {
    if (!allAnswered || submitted) return;
    setSubmitted(true);

    // Build answers map: { "0": "label", "1": "a,b" }
    const answersMap: Record<string, string> = {};
    questions.forEach((_, idx) => {
      const selected = answers[idx] ?? [];
      const labels = selected.map((s) => s === '__other__' ? (otherTexts[idx]?.trim() ?? '') : s);
      answersMap[String(idx)] = labels.join(',');
    });

    onSubmit(requestId, 'allow', { answers: answersMap });
  };

  const handleDeny = () => {
    if (submitted) return;
    setSubmitted(true);
    onSubmit(requestId, 'deny');
  };

  return (
    <div className="rounded-lg px-4 py-3 mb-2 bg-violet-900/30 border border-violet-500/40">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs text-violet-400 font-semibold">QUESTION</span>
        {!submitted && (
          <button
            onClick={handleDeny}
            className="px-2.5 py-1 rounded bg-red-700/60 hover:bg-red-600 text-white text-xs font-medium transition-colors"
          >
            Dismiss
          </button>
        )}
      </div>

      {questions.map((q, qIdx) => {
        const selected = answers[qIdx] ?? [];
        return (
          <div key={qIdx} className={`${qIdx > 0 ? 'mt-4 pt-3 border-t border-gray-700/40' : ''}`}>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs bg-violet-800/50 text-violet-300 px-2 py-0.5 rounded-full font-medium">
                {q.header}
              </span>
              {q.multiSelect && (
                <span className="text-xs text-gray-500">(multi-select)</span>
              )}
            </div>
            <div className="text-sm text-violet-200 mb-2">{q.question}</div>

            <div className="flex flex-col gap-1.5">
              {q.options.map((opt) => {
                const isSelected = selected.includes(opt.label);
                return (
                  <button
                    key={opt.label}
                    disabled={submitted}
                    onClick={() => toggleOption(qIdx, opt.label, q.multiSelect)}
                    className={`text-left rounded-md px-3 py-2 border transition-colors ${
                      submitted
                        ? isSelected
                          ? 'border-violet-400/60 bg-violet-800/40 text-violet-100'
                          : 'border-gray-700/30 bg-gray-800/20 text-gray-500'
                        : isSelected
                          ? 'border-violet-400/60 bg-violet-800/40 text-violet-100'
                          : 'border-gray-600/40 bg-gray-800/30 text-gray-300 hover:border-violet-500/40 hover:bg-violet-900/20'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      {q.multiSelect ? (
                        <span className={`w-3.5 h-3.5 rounded-sm border-2 flex-shrink-0 flex items-center justify-center ${
                          isSelected ? 'border-violet-400 bg-violet-400' : 'border-gray-500'
                        }`}>
                          {isSelected && <span className="text-gray-900 text-[10px] font-bold">✓</span>}
                        </span>
                      ) : (
                        <span className={`w-3.5 h-3.5 rounded-full border-2 flex-shrink-0 ${
                          isSelected ? 'border-violet-400 bg-violet-400' : 'border-gray-500'
                        }`} />
                      )}
                      <span className="text-sm font-medium">{opt.label}</span>
                    </div>
                    {opt.description && (
                      <div className="text-xs text-gray-400 mt-0.5 ml-[22px]">{opt.description}</div>
                    )}
                  </button>
                );
              })}

              {/* "Other" free-text option */}
              <div
                className={`rounded-md px-3 py-2 border transition-colors ${
                  submitted
                    ? selected.includes('__other__')
                      ? 'border-violet-400/60 bg-violet-800/40'
                      : 'border-gray-700/30 bg-gray-800/20'
                    : selected.includes('__other__')
                      ? 'border-violet-400/60 bg-violet-800/40'
                      : 'border-gray-600/40 bg-gray-800/30'
                }`}
              >
                <div className="flex items-center gap-2">
                  {q.multiSelect ? (
                    <span
                      onClick={() => !submitted && toggleOption(qIdx, '__other__', true)}
                      className={`w-3.5 h-3.5 rounded-sm border-2 flex-shrink-0 flex items-center justify-center cursor-pointer ${
                        selected.includes('__other__') ? 'border-violet-400 bg-violet-400' : 'border-gray-500'
                      }`}
                    >
                      {selected.includes('__other__') && <span className="text-gray-900 text-[10px] font-bold">✓</span>}
                    </span>
                  ) : (
                    <span
                      onClick={() => !submitted && toggleOption(qIdx, '__other__', false)}
                      className={`w-3.5 h-3.5 rounded-full border-2 flex-shrink-0 cursor-pointer ${
                        selected.includes('__other__') ? 'border-violet-400 bg-violet-400' : 'border-gray-500'
                      }`}
                    />
                  )}
                  <input
                    type="text"
                    disabled={submitted}
                    placeholder="Other..."
                    value={otherTexts[qIdx] ?? ''}
                    onChange={(e) => setOtherText(qIdx, e.target.value)}
                    className="flex-1 bg-transparent text-sm text-gray-300 placeholder-gray-500 outline-none"
                  />
                </div>
              </div>
            </div>
          </div>
        );
      })}

      {!submitted && (
        <div className="flex justify-end mt-3">
          <button
            disabled={!allAnswered}
            onClick={handleSubmit}
            className={`px-4 py-1.5 rounded text-xs font-medium transition-colors ${
              allAnswered
                ? 'bg-violet-600 hover:bg-violet-500 text-white'
                : 'bg-gray-700 text-gray-500 cursor-not-allowed'
            }`}
          >
            Confirm
          </button>
        </div>
      )}

      {submitted && (
        <div className="text-xs text-gray-500 mt-2 text-right italic">
          Answers submitted
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/web/src/components/QuestionCard.tsx
git commit -m "feat(web): add QuestionCard component for AskUserQuestion

Renders single-select (radio) and multi-select (checkbox) question cards.
Includes 'Other' free-text option. Violet theme to distinguish from
regular approval cards (orange) and choice cards (amber)."
```

---

### Task 6: Web frontend — wire QuestionCard into MessageList and App

**Files:**
- Modify: `packages/web/src/components/MessageList.tsx`
- Modify: `packages/web/src/App.tsx`

- [ ] **Step 1: Update `MessageList` to conditionally render QuestionCard**

In `packages/web/src/components/MessageList.tsx`, replace lines 1-13:

```typescript
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useLobbyStore } from '../stores/lobby-store';
import MessageBubble from './MessageBubble';
import ControlCard from './ControlCard';
import TypingIndicator from './TypingIndicator';

const EMPTY_MESSAGES: never[] = [];

interface Props {
  sessionId: string;
  onControlRespond: (sessionId: string, requestId: string, decision: 'allow' | 'deny') => void;
  onChoiceSelect?: (label: string) => void;
}
```

with:

```typescript
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useLobbyStore } from '../stores/lobby-store';
import MessageBubble from './MessageBubble';
import ControlCard from './ControlCard';
import QuestionCard from './QuestionCard';
import TypingIndicator from './TypingIndicator';

const EMPTY_MESSAGES: never[] = [];

interface Props {
  sessionId: string;
  onControlRespond: (sessionId: string, requestId: string, decision: 'allow' | 'deny', payload?: Record<string, unknown>) => void;
  onChoiceSelect?: (label: string) => void;
}
```

In the same file, replace lines 87-94 (the pendingControl rendering block):

```typescript
      {pendingControl && (
        <ControlCard
          request={pendingControl}
          onRespond={(requestId, decision) =>
            onControlRespond(sessionId, requestId, decision)
          }
        />
      )}
```

with:

```typescript
      {pendingControl && (
        pendingControl.questions && pendingControl.questions.length > 0 ? (
          <QuestionCard
            requestId={pendingControl.requestId}
            questions={pendingControl.questions}
            onSubmit={(requestId, decision, payload) =>
              onControlRespond(sessionId, requestId, decision, payload)
            }
          />
        ) : (
          <ControlCard
            request={pendingControl}
            onRespond={(requestId, decision) =>
              onControlRespond(sessionId, requestId, decision)
            }
          />
        )
      )}
```

- [ ] **Step 2: Update `App.tsx` to pass payload through to wsRespondControl**

In `packages/web/src/App.tsx`, the `wsRespondControl` function is already passed directly as `onControlRespond`. Since we added the optional `payload` parameter in Task 4, the type signature already matches. Verify that `wsRespondControl` is imported and used at line 53:

```typescript
              onControlRespond={wsRespondControl}
```

This already works because `wsRespondControl(sessionId, requestId, decision, payload?)` matches the updated `onControlRespond` type. No code change needed in App.tsx.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/MessageList.tsx
git commit -m "feat(web): wire QuestionCard into MessageList

Conditionally renders QuestionCard when pending control has questions,
falls back to ControlCard for regular tool approvals."
```

---

### Task 7: IM channel — sequential question interaction with callback buttons

**Files:**
- Modify: `packages/server/src/channel-router.ts`

This task modifies the channel-router to detect `AskUserQuestion` control messages and render them as sequential callback-button questions instead of generic Allow/Deny cards. Changes are in three areas: (1) a new `pendingQuestions` state map, (2) the control message handler, (3) the callback handler.

- [ ] **Step 1: Add `pendingQuestions` state and helper types**

In `packages/server/src/channel-router.ts`, after the `StreamState` interface (line 55), add:

```typescript
/** Per-identity state for sequential AskUserQuestion interaction */
interface PendingQuestionState {
  sessionId: string;
  requestId: string;
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiSelect: boolean;
  }>;
  currentIndex: number;
  answers: Record<string, string>;
  /** For multi-select: tracks toggled option indices for current question */
  multiSelectToggled: Set<number>;
}
```

In the `ChannelRouterImpl` class, after the `messageOriginBySession` property (line 70), add:

```typescript
  /** Per-identity state for sequential AskUserQuestion interaction */
  private pendingQuestions = new Map<string, PendingQuestionState>();
```

- [ ] **Step 2: Add helper method to send a single question with buttons**

Add this method to the `ChannelRouterImpl` class, before the `handleCallback` method:

```typescript
  /** Send one question from a pending AskUserQuestion sequence to IM */
  private sendQuestionToIM(
    identityKey: string,
    provider: ChannelProvider,
    identity: { channelName: string; accountId: string; peerId: string; peerDisplayName?: string },
    state: PendingQuestionState,
  ): void {
    const q = state.questions[state.currentIndex];
    const questionNum = state.questions.length > 1
      ? ` (${state.currentIndex + 1}/${state.questions.length})`
      : '';

    const optionLines = q.options.map((opt, i) => {
      const toggled = state.multiSelectToggled.has(i);
      const prefix = q.multiSelect ? (toggled ? '☑️' : '⬜') : `${i + 1}️⃣`;
      return `${prefix} **${opt.label}** — ${opt.description}`;
    }).join('\n');

    const header = `📋 **${q.header}**${questionNum}\n${q.question}`;
    const text = `${header}\n\n${optionLines}`;

    const actions = q.options.map((opt, i) => ({
      label: q.multiSelect
        ? `${state.multiSelectToggled.has(i) ? '☑' : '⬜'} ${opt.label}`
        : opt.label,
      callbackData: q.multiSelect
        ? `askt:${state.sessionId}:${state.requestId}:${state.currentIndex}:${i}`
        : `askq:${state.sessionId}:${state.requestId}:${state.currentIndex}:${i}`,
    }));

    // For multi-select, add a confirm button
    if (q.multiSelect && state.multiSelectToggled.size > 0) {
      actions.push({
        label: '✅ 确认',
        callbackData: `askc:${state.sessionId}:${state.requestId}:${state.currentIndex}`,
      });
    }

    provider.sendMessage({
      identity,
      text,
      kind: 'approval',
      actions,
    }).catch((err) => console.error('[ChannelRouter] question send error:', err));
  }
```

- [ ] **Step 3: Detect AskUserQuestion in control message handler**

In the `handleSessionMessage` method, replace the existing `case 'control':` block (lines 627-648):

```typescript
      // ── control: approval card ──
      case 'control': {
        const content = msg.content as Record<string, unknown>;
        const toolName = (content.toolName as string) ?? 'unknown';
        const toolInput = content.toolInput as Record<string, unknown> | undefined;
        const requestId = content.requestId as string;
        const inputPreview = toolInput ? JSON.stringify(toolInput).slice(0, 200) : '';
        const taskId = `ap_${randomUUID().replace(/-/g, '').slice(0, 24)}`;

        const formatted = `**【${sessionName}】🔒 工具审批: \`${toolName}\`**\n> ${inputPreview}`;

        provider.sendMessage({
          identity,
          text: formatted,
          kind: 'approval',
          actions: [
            { label: '✅ 允许', callbackData: `approve:${sessionId}:${requestId}:${taskId}` },
            { label: '❌ 拒绝', callbackData: `deny:${sessionId}:${requestId}:${taskId}` },
          ],
        }).catch((err) => console.error('[ChannelRouter] approval send error:', err));
        break;
      }
```

with:

```typescript
      // ── control: approval card or question card ──
      case 'control': {
        const content = msg.content as Record<string, unknown>;
        const toolName = (content.toolName as string) ?? 'unknown';
        const toolInput = content.toolInput as Record<string, unknown> | undefined;
        const requestId = content.requestId as string;
        const questions = content.questions as PendingQuestionState['questions'] | undefined;

        if (questions && questions.length > 0) {
          // AskUserQuestion — start sequential question interaction
          const state: PendingQuestionState = {
            sessionId,
            requestId,
            questions,
            currentIndex: 0,
            answers: {},
            multiSelectToggled: new Set(),
          };
          this.pendingQuestions.set(identityKey, state);
          this.sendQuestionToIM(identityKey, provider, identity, state);
        } else {
          // Regular tool approval — Allow/Deny buttons
          const inputPreview = toolInput ? JSON.stringify(toolInput).slice(0, 200) : '';
          const taskId = `ap_${randomUUID().replace(/-/g, '').slice(0, 24)}`;

          const formatted = `**【${sessionName}】🔒 工具审批: \`${toolName}\`**\n> ${inputPreview}`;

          provider.sendMessage({
            identity,
            text: formatted,
            kind: 'approval',
            actions: [
              { label: '✅ 允许', callbackData: `approve:${sessionId}:${requestId}:${taskId}` },
              { label: '❌ 拒绝', callbackData: `deny:${sessionId}:${requestId}:${taskId}` },
            ],
          }).catch((err) => console.error('[ChannelRouter] approval send error:', err));
        }
        break;
      }
```

- [ ] **Step 4: Handle askq/askt/askc callbacks in `handleCallback`**

In the `handleCallback` method (line 928), add AskUserQuestion callback handling at the top of the method, before the existing approve/deny logic:

Replace the entire `handleCallback` method:

```typescript
  private async handleCallback(callbackData: string, identity: InboundChannelMessage['identity']): Promise<void> {
    const identityKey = toIdentityKey(identity);
    const parts = callbackData.split(':');

    // ── AskUserQuestion callbacks ──
    if (parts[0] === 'askq' || parts[0] === 'askt' || parts[0] === 'askc') {
      const state = this.pendingQuestions.get(identityKey);
      if (!state) {
        await this.sendToChannel(identity, '⚠️ 该问答已过期。');
        return;
      }

      const [action, , , questionIndexStr, optionIndexStr] = parts;
      const questionIndex = parseInt(questionIndexStr, 10);
      const q = state.questions[questionIndex];

      if (action === 'askq') {
        // Single-select: record answer and advance
        const optionIndex = parseInt(optionIndexStr, 10);
        state.answers[String(questionIndex)] = q.options[optionIndex].label;
        await this.sendToChannel(identity, `✅ ${q.header}: **${q.options[optionIndex].label}**`);
        this.advanceQuestion(identityKey, identity, state);
      } else if (action === 'askt') {
        // Multi-select toggle
        const optionIndex = parseInt(optionIndexStr, 10);
        if (state.multiSelectToggled.has(optionIndex)) {
          state.multiSelectToggled.delete(optionIndex);
        } else {
          state.multiSelectToggled.add(optionIndex);
        }
        // Re-send the question with updated toggle state
        const provider = this.providers.get(`${identity.channelName}:${identity.accountId}`);
        if (provider) {
          this.sendQuestionToIM(identityKey, provider, identity, state);
        }
      } else if (action === 'askc') {
        // Multi-select confirm
        if (state.multiSelectToggled.size === 0) {
          await this.sendToChannel(identity, '⚠️ 请至少选择一个选项。');
          return;
        }
        const selectedLabels = Array.from(state.multiSelectToggled)
          .sort((a, b) => a - b)
          .map((i) => q.options[i].label);
        state.answers[String(questionIndex)] = selectedLabels.join(',');
        state.multiSelectToggled.clear();
        await this.sendToChannel(identity, `✅ ${q.header}: **${selectedLabels.join(', ')}**`);
        this.advanceQuestion(identityKey, identity, state);
      }
      return;
    }

    // ── Regular approve/deny callbacks ──
    // Format: "approve:sessionId:requestId:taskId" or "deny:sessionId:requestId:taskId"
    if (parts.length < 3) return;

    const [action, origSessionId, requestId, taskId] = parts;
    const decision = action === 'approve' ? 'allow' : 'deny';
    const resultText = decision === 'allow' ? '已允许 ✅' : '已拒绝 ❌';

    console.log(`[ChannelRouter] Callback: ${action} session=${origSessionId} request=${requestId} task=${taskId}`);

    try {
      let resolvedSessionId = origSessionId;
      try {
        this.sessionManager.respondControl(resolvedSessionId, requestId, decision as 'allow' | 'deny');
      } catch {
        const identityKey = toIdentityKey(identity);
        const binding = getBinding(this.db, identityKey);
        if (binding?.active_session_id && binding.active_session_id !== origSessionId) {
          resolvedSessionId = binding.active_session_id;
          console.log(`[ChannelRouter] Retrying respondControl with synced sessionId: ${resolvedSessionId}`);
          this.sessionManager.respondControl(resolvedSessionId, requestId, decision as 'allow' | 'deny');
        } else {
          throw new Error(`Session "${origSessionId}" not found`);
        }
      }
      await this.sendToChannel(identity, resultText);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[ChannelRouter] Callback failed:`, errMsg);
      await this.sendToChannel(identity, `⚠️ 审批失败: ${errMsg}`);
    }
  }
```

- [ ] **Step 5: Add `advanceQuestion` helper method**

Add this method to the class, right after `sendQuestionToIM`:

```typescript
  /** Advance to next question or submit all answers */
  private advanceQuestion(
    identityKey: string,
    identity: { channelName: string; accountId: string; peerId: string; peerDisplayName?: string },
    state: PendingQuestionState,
  ): void {
    state.currentIndex++;

    if (state.currentIndex >= state.questions.length) {
      // All questions answered — submit
      this.pendingQuestions.delete(identityKey);
      console.log(`[ChannelRouter] AskUserQuestion complete for ${identityKey}:`, state.answers);
      try {
        this.sessionManager.respondControl(state.sessionId, state.requestId, 'allow', { answers: state.answers });
      } catch (err) {
        console.error('[ChannelRouter] AskUserQuestion respondControl failed:', err);
        this.sendToChannel(identity, `⚠️ 提交回答失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      // Send next question
      state.multiSelectToggled.clear();
      const provider = this.providers.get(`${identity.channelName}:${identity.accountId}`);
      if (provider) {
        this.sendQuestionToIM(identityKey, provider, identity, state);
      }
    }
  }
```

- [ ] **Step 6: Update `routeApprovalToIM` to handle questions**

Replace the `routeApprovalToIM` method (lines 705-753) to detect questions:

```typescript
  /** Route approval notification to IM when web is not viewing the session */
  private routeApprovalToIM(sessionId: string, msg: LobbyMessage): void {
    // If web is viewing this session, no need to push to IM
    if (this.sessionManager.isSessionViewedOnWeb(sessionId)) return;

    // Find IM binding for this session
    let bindingRow = this.resolveResponseBinding(sessionId);

    // Fallback: if no binding for this session, try Lobby Manager's binding
    if (!bindingRow && this.lobbyManager) {
      const lmSessionId = this.lobbyManager.getSessionId();
      if (lmSessionId) {
        bindingRow = this.resolveResponseBinding(lmSessionId);
      }
    }

    if (!bindingRow) return;

    const provider = this.providers.get(`${bindingRow.channel_name}:${bindingRow.account_id}`);
    if (!provider) return;

    const identity = {
      channelName: bindingRow.channel_name,
      accountId: bindingRow.account_id,
      peerId: bindingRow.peer_id,
      peerDisplayName: bindingRow.peer_display_name ?? undefined,
    };

    const content = msg.content as Record<string, unknown>;
    const toolName = (content.toolName as string) ?? 'unknown';
    const toolInput = content.toolInput as Record<string, unknown> | undefined;
    const requestId = content.requestId as string;
    const questions = content.questions as PendingQuestionState['questions'] | undefined;
    const sessionName = this.getSessionDisplayName(sessionId);

    if (questions && questions.length > 0) {
      // AskUserQuestion — start sequential interaction
      const identityKey = toIdentityKey(identity);
      const state: PendingQuestionState = {
        sessionId,
        requestId,
        questions,
        currentIndex: 0,
        answers: {},
        multiSelectToggled: new Set(),
      };
      this.pendingQuestions.set(identityKey, state);
      this.sendQuestionToIM(identityKey, provider, identity, state);
    } else {
      // Regular approval — Allow/Deny buttons
      const inputPreview = toolInput ? JSON.stringify(toolInput).slice(0, 200) : '';
      const taskId = `ap_${randomUUID().replace(/-/g, '').slice(0, 24)}`;

      const formatted = `**【${sessionName}】🔒 工具审批: \`${toolName}\`**\n> ${inputPreview}`;

      provider.sendMessage({
        identity,
        text: formatted,
        kind: 'approval',
        actions: [
          { label: '✅ 允许', callbackData: `approve:${sessionId}:${requestId}:${taskId}` },
          { label: '❌ 拒绝', callbackData: `deny:${sessionId}:${requestId}:${taskId}` },
        ],
      }).catch((err) => console.error('[ChannelRouter] approval IM push error:', err));
    }
  }
```

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/channel-router.ts
git commit -m "feat(channel-router): sequential question interaction for AskUserQuestion

Detects questions in control messages, sends one question at a time
with inline callback buttons. Single-select: direct click. Multi-select:
toggle buttons + confirm. Aggregates all answers and submits via
respondControl with payload."
```

---

### Task 8: Build verification

- [ ] **Step 1: Build all packages**

```bash
cd /Users/kone/OtherProjects/mist/OpenLobby
pnpm -r build
```

Expected: All packages build with no TypeScript errors.

- [ ] **Step 2: Verify core types**

Read `packages/core/src/types.ts` and confirm:
- `ControlQuestion` interface exists
- `ControlRequest` has optional `questions?: ControlQuestion[]`
- `AgentProcess.respondControl` has optional `payload` parameter

- [ ] **Step 3: Verify protocol**

Read `packages/core/src/protocol.ts` and confirm:
- `control.respond` ClientMessage has optional `payload` field

- [ ] **Step 4: Verify adapter**

Read `packages/core/src/adapters/claude-code.ts` and confirm:
- `handleToolApproval` extracts `questions` when `toolName === 'AskUserQuestion'`
- `respondControl` injects `payload.answers` into `updatedInput`

- [ ] **Step 5: Verify web components**

Read `packages/web/src/components/QuestionCard.tsx` and confirm:
- Single-select (radio) and multi-select (checkbox) rendering
- "Other" free-text option exists
- Submit builds answers map and calls `onSubmit` with payload

Read `packages/web/src/components/MessageList.tsx` and confirm:
- Conditional rendering: QuestionCard when `questions` present, else ControlCard
