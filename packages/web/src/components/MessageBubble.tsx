import React, { Component, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { LobbyMessageData } from '../stores/lobby-store';
import { wsCompactSession } from '../hooks/useWebSocket';
import ChoiceCard, { type ChoiceOption } from './ChoiceCard';

interface Props {
  msg: LobbyMessageData;
  onChoiceSelect?: (label: string) => void;
}

class MessageErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  render() {
    if (this.state.hasError) {
      return <div className="text-danger text-xs italic">[Render error]</div>;
    }
    return this.props.children;
  }
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="text-[10px] text-on-surface-muted hover:text-on-surface px-1.5 py-0.5 rounded hover:bg-surface-elevated transition-colors"
    >
      {copied ? 'Copied!' : 'Copy'}
    </button>
  );
}

function CodeBlock({ className, children }: { className?: string; children?: ReactNode }) {
  const match = /language-(\w+)/.exec(className ?? '');
  const code = String(children ?? '').replace(/\n$/, '');

  if (match) {
    return (
      <div className="relative group">
        <div className="flex items-center justify-between text-[10px] text-on-surface-muted px-3 pt-1.5">
          <span>{match[1]}</span>
          <CopyButton text={code} />
        </div>
        <pre className="bg-[var(--color-code-bg)] rounded-md px-3 pb-2 pt-1 overflow-x-auto text-sm">
          <code className={className}>{code}</code>
        </pre>
      </div>
    );
  }
  return (
    <code className="bg-[var(--color-code-inline-bg)] px-1 py-0.5 rounded text-sm">{children}</code>
  );
}

const CHOICE_REGEX = /<!-- CHOICE -->\s*([\s\S]*?)\s*<!-- \/CHOICE -->/g;

interface ParsedChoiceBlock {
  question: string;
  options: ChoiceOption[];
}

function parseChoiceBlocks(content: string): { segments: (string | ParsedChoiceBlock)[] } {
  const segments: (string | ParsedChoiceBlock)[] = [];
  let lastIndex = 0;

  for (const match of content.matchAll(CHOICE_REGEX)) {
    const before = content.slice(lastIndex, match.index);
    if (before.trim()) segments.push(before);

    try {
      const parsed = JSON.parse(match[1]);
      if (parsed.question && Array.isArray(parsed.options)) {
        segments.push(parsed as ParsedChoiceBlock);
      } else {
        segments.push(match[0]);
      }
    } catch {
      segments.push(match[0]);
    }

    lastIndex = match.index! + match[0].length;
  }

  const after = content.slice(lastIndex);
  if (after.trim()) segments.push(after);

  return { segments };
}

function MarkdownBlock({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code: CodeBlock as never,
        pre: ({ children }) => <>{children}</>,
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

function AssistantContent({ content, onChoiceSelect }: { content: string; onChoiceSelect?: (label: string) => void }) {
  const hasChoice = content.includes('<!-- CHOICE -->');

  if (!hasChoice) {
    return (
      <div className="markdown-body text-sm">
        <MarkdownBlock content={content} />
      </div>
    );
  }

  const { segments } = parseChoiceBlocks(content);

  return (
    <div className="markdown-body text-sm">
      {segments.map((seg, i) =>
        typeof seg === 'string' ? (
          <MarkdownBlock key={i} content={seg} />
        ) : (
          <ChoiceCard
            key={i}
            question={seg.question}
            options={seg.options}
            onSelect={onChoiceSelect ?? (() => {})}
          />
        ),
      )}
    </div>
  );
}

function ToolUseContent({ msg }: { msg: LobbyMessageData }) {
  const toolName = msg.meta?.toolName ?? 'Unknown';
  const raw = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content, null, 2);
  const summary = raw.length > 100 ? raw.slice(0, 100) + '...' : raw;
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="font-mono text-xs">
      <div className="flex items-center gap-1.5">
        <span className="text-warning font-bold">{String(toolName)}</span>
        <span className="text-on-surface-secondary truncate flex-1">{summary}</span>
      </div>
      {raw.length > 100 && (
        <div>
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-[10px] text-on-surface-muted hover:text-on-surface mt-0.5"
          >
            {expanded ? '- Collapse' : '+ Expand'}
          </button>
          {expanded && (
            <pre className="text-on-surface-secondary mt-1 overflow-auto max-h-60 p-2 bg-[var(--color-code-bg)] rounded">
              {raw}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function ToolResultContent({ msg }: { msg: LobbyMessageData }) {
  const raw = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content, null, 2);
  const isError = msg.meta?.isError;
  const lines = raw.split('\n');
  const isLong = lines.length > 6 || raw.length > 300;
  const [expanded, setExpanded] = useState(false);
  const preview = isLong ? lines.slice(0, 4).join('\n') : raw;

  return (
    <div className="font-mono text-xs">
      {isError === true && <span className="text-danger text-[10px]">Error </span>}
      <pre className={`text-on-surface-secondary overflow-auto ${!expanded && isLong ? 'max-h-24' : 'max-h-60'} whitespace-pre-wrap`}>
        {expanded ? raw : preview}
      </pre>
      {isLong && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-[10px] text-on-surface-muted hover:text-on-surface mt-0.5"
        >
          {expanded ? '- Show less' : `+ Show all (${lines.length} lines)`}
        </button>
      )}
    </div>
  );
}

function ResultContent({ msg }: { msg: LobbyMessageData }) {
  const meta = msg.meta ?? {};
  const content = typeof msg.content === 'string' ? msg.content : '';
  const tokenUsage = meta.tokenUsage as { input: number; output: number } | undefined;
  const costUsd = meta.costUsd as number | undefined;

  return (
    <div className="flex items-center gap-3 text-xs">
      {content && <span>{content}</span>}
      {tokenUsage != null && (
        <span className="text-on-surface-secondary">{tokenUsage.input + tokenUsage.output} tokens</span>
      )}
      {costUsd != null && (
        <span className="text-on-surface-secondary">${costUsd.toFixed(4)}</span>
      )}
    </div>
  );
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);

function isImagePath(path: string): boolean {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  return IMAGE_EXTS.has(ext);
}

function fileUrl(path: string): string {
  return `/api/file?path=${encodeURIComponent(path)}`;
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function stripProtocolTags(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '')
    .replace(/<command-name>[\s\S]*?<\/command-name>/g, '')
    .replace(/<local-command[\s\S]*?<\/local-command>/g, '')
    .replace(/^Read the output file to retrieve the result:\s*\/\S+$/gm, '')
    .trim();
}

function UserContent({ content }: { content: string }) {
  const attachRegex = /\[Attached:\s*(.+?)\]/g;
  const attachments: string[] = [];
  let textContent = stripProtocolTags(content);
  let match: RegExpExecArray | null;

  while ((match = attachRegex.exec(textContent)) !== null) {
    attachments.push(match[1]);
  }
  if (attachments.length > 0) {
    textContent = textContent.replace(attachRegex, '').trim();
  }

  return (
    <div>
      {textContent && (
        <div className="whitespace-pre-wrap break-words text-sm">{textContent}</div>
      )}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-2">
          {attachments.map((path, i) =>
            isImagePath(path) ? (
              <a key={i} href={fileUrl(path)} target="_blank" rel="noopener noreferrer" className="block">
                <img
                  src={fileUrl(path)}
                  alt={fileName(path)}
                  className="max-w-[200px] max-h-[150px] rounded-lg object-cover border border-primary/30 hover:border-primary transition-colors"
                />
              </a>
            ) : (
              <a
                key={i}
                href={fileUrl(path)}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 bg-primary-surface rounded-lg px-2.5 py-1.5 text-xs text-primary hover:bg-primary-surface/80 transition-colors"
              >
                <span>📄</span>
                <span className="truncate max-w-[150px]">{fileName(path)}</span>
              </a>
            ),
          )}
        </div>
      )}
    </div>
  );
}

function CompactContent({ msg }: { msg: LobbyMessageData }) {
  const content = typeof msg.content === 'object' ? msg.content as Record<string, unknown> : {};

  if (content.compactSuggestion) {
    const tokensK = Math.round((content.currentTokens as number) / 1000);
    return (
      <div className="flex items-center gap-2 text-xs text-warning">
        <span>Context approaching limit ({tokensK}K tokens).</span>
        <button
          onClick={() => wsCompactSession(msg.sessionId)}
          className="px-2 py-0.5 bg-warning-surface hover:bg-warning-surface/80 text-warning rounded text-xs transition-colors"
        >
          Compact Now
        </button>
      </div>
    );
  }

  if (content.compacting) {
    return (
      <div className="flex items-center gap-2 text-xs text-primary">
        <span className="animate-pulse">Compacting conversation...</span>
      </div>
    );
  }

  if (content.compact) {
    const preTokens = content.preTokens as number | undefined;
    const preK = preTokens ? Math.round(preTokens / 1000) : null;
    return (
      <div className="flex items-center gap-2 text-xs text-success">
        <span>Conversation compacted{preK ? ` (was ${preK}K tokens)` : ''}</span>
      </div>
    );
  }

  return null;
}

export default function MessageBubble({ msg, onChoiceSelect }: Props) {
  const content =
    typeof msg.content === 'string'
      ? msg.content
      : JSON.stringify(msg.content, null, 2);

  const isUser = msg.type === 'user';
  const isSystem = msg.type === 'system';
  const isTool = msg.type === 'tool_use' || msg.type === 'tool_result';
  const isResult = msg.type === 'result';

  if (isSystem && typeof msg.content === 'object') {
    const c = msg.content as Record<string, unknown>;
    if (c.compactSuggestion || c.compacting || c.compact) {
      return (
        <div className="flex justify-center py-1">
          <div className="bg-surface-elevated/50 border border-outline-subtle/50 rounded-full px-4 py-1">
            <CompactContent msg={msg} />
          </div>
        </div>
      );
    }
  }

  if (isSystem) {
    return (
      <div className="text-center text-on-surface-muted text-xs italic py-1">
        {content}
      </div>
    );
  }

  if (isResult) {
    return (
      <div className="flex justify-center py-1">
        <div className="bg-surface-elevated/50 border border-outline-subtle/50 rounded-full px-4 py-1">
          <ResultContent msg={msg} />
        </div>
      </div>
    );
  }

  if (isTool) {
    return (
      <MessageErrorBoundary>
        <div className={`ml-2 pl-3 border-l-2 ${
          msg.type === 'tool_use' ? 'border-warning/40' : 'border-success/40'
        } py-1 mb-1`}>
          {msg.type === 'tool_use' ? (
            <ToolUseContent msg={msg} />
          ) : (
            <ToolResultContent msg={msg} />
          )}
        </div>
      </MessageErrorBoundary>
    );
  }

  return (
    <MessageErrorBoundary>
      <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-2`}>
        <div className={`max-w-[75%] rounded-2xl px-4 py-2.5 ${
          isUser
            ? 'bg-[var(--color-user-bubble)] text-[var(--color-user-bubble-text)] rounded-br-md'
            : 'bg-[var(--color-assistant-bubble)] text-[var(--color-assistant-bubble-text)] rounded-bl-md'
        }`}>
          {isUser ? (
            <UserContent content={content} />
          ) : (
            <AssistantContent content={content} onChoiceSelect={onChoiceSelect} />
          )}
          <div className={`text-[10px] mt-1 ${isUser ? 'text-[var(--color-user-bubble-timestamp)]' : 'text-on-surface-muted'} text-right`}>
            {formatTime(msg.timestamp)}
          </div>
        </div>
      </div>
    </MessageErrorBoundary>
  );
}
