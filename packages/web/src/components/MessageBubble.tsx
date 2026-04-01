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
      return <div className="text-red-400 text-xs italic">[Render error]</div>;
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
      className="text-[10px] text-gray-500 hover:text-gray-300 px-1.5 py-0.5 rounded hover:bg-gray-700 transition-colors"
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
        <div className="flex items-center justify-between text-[10px] text-gray-500 px-3 pt-1.5">
          <span>{match[1]}</span>
          <CopyButton text={code} />
        </div>
        <pre className="bg-gray-900 rounded-md px-3 pb-2 pt-1 overflow-x-auto text-sm">
          <code className={className}>{code}</code>
        </pre>
      </div>
    );
  }
  return (
    <code className="bg-gray-700 px-1 py-0.5 rounded text-sm">{children}</code>
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
  // Show a one-line summary of the input
  const summary = raw.length > 100 ? raw.slice(0, 100) + '...' : raw;
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="font-mono text-xs">
      <div className="flex items-center gap-1.5">
        <span className="text-yellow-400 font-bold">{String(toolName)}</span>
        <span className="text-gray-400 truncate flex-1">{summary}</span>
      </div>
      {raw.length > 100 && (
        <div>
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-[10px] text-gray-500 hover:text-gray-300 mt-0.5"
          >
            {expanded ? '- Collapse' : '+ Expand'}
          </button>
          {expanded && (
            <pre className="text-gray-300 mt-1 overflow-auto max-h-60 p-2 bg-gray-900/50 rounded">
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
      {isError === true && <span className="text-red-400 text-[10px]">Error </span>}
      <pre className={`text-gray-300 overflow-auto ${!expanded && isLong ? 'max-h-24' : 'max-h-60'} whitespace-pre-wrap`}>
        {expanded ? raw : preview}
      </pre>
      {isLong && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-[10px] text-gray-500 hover:text-gray-300 mt-0.5"
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
        <span className="text-gray-400">{tokenUsage.input + tokenUsage.output} tokens</span>
      )}
      {costUsd != null && (
        <span className="text-gray-400">${costUsd.toFixed(4)}</span>
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

function UserContent({ content }: { content: string }) {
  // Parse [Attached: /path/to/file] patterns
  const attachRegex = /\[Attached:\s*(.+?)\]/g;
  const attachments: string[] = [];
  let textContent = content;
  let match: RegExpExecArray | null;

  while ((match = attachRegex.exec(content)) !== null) {
    attachments.push(match[1]);
  }
  if (attachments.length > 0) {
    textContent = content.replace(attachRegex, '').trim();
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
              <a
                key={i}
                href={fileUrl(path)}
                target="_blank"
                rel="noopener noreferrer"
                className="block"
              >
                <img
                  src={fileUrl(path)}
                  alt={fileName(path)}
                  className="max-w-[200px] max-h-[150px] rounded-lg object-cover border border-blue-400/30 hover:border-blue-300 transition-colors"
                />
              </a>
            ) : (
              <a
                key={i}
                href={fileUrl(path)}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 bg-blue-500/20 rounded-lg px-2.5 py-1.5 text-xs text-blue-100 hover:bg-blue-500/30 transition-colors"
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

  // Compact suggestion
  if (content.compactSuggestion) {
    const tokensK = Math.round((content.currentTokens as number) / 1000);
    return (
      <div className="flex items-center gap-2 text-xs text-yellow-400">
        <span>Context approaching limit ({tokensK}K tokens).</span>
        <button
          onClick={() => wsCompactSession(msg.sessionId)}
          className="px-2 py-0.5 bg-yellow-500/20 hover:bg-yellow-500/30 text-yellow-300 rounded text-xs transition-colors"
        >
          Compact Now
        </button>
      </div>
    );
  }

  // Compacting in progress
  if (content.compacting) {
    return (
      <div className="flex items-center gap-2 text-xs text-blue-400">
        <span className="animate-pulse">Compacting conversation...</span>
      </div>
    );
  }

  // Compact complete
  if (content.compact) {
    const preTokens = content.preTokens as number | undefined;
    const preK = preTokens ? Math.round(preTokens / 1000) : null;
    return (
      <div className="flex items-center gap-2 text-xs text-green-400">
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

  // Compact system messages: centered bar (like result messages)
  if (isSystem && typeof msg.content === 'object') {
    const c = msg.content as Record<string, unknown>;
    if (c.compactSuggestion || c.compacting || c.compact) {
      return (
        <div className="flex justify-center py-1">
          <div className="bg-gray-800/50 border border-gray-700/50 rounded-full px-4 py-1">
            <CompactContent msg={msg} />
          </div>
        </div>
      );
    }
  }

  // System messages: centered, minimal
  if (isSystem) {
    return (
      <div className="text-center text-gray-500 text-xs italic py-1">
        {content}
      </div>
    );
  }

  // Result messages: centered bar
  if (isResult) {
    return (
      <div className="flex justify-center py-1">
        <div className="bg-gray-800/50 border border-gray-700/50 rounded-full px-4 py-1">
          <ResultContent msg={msg} />
        </div>
      </div>
    );
  }

  // Tool messages: compact, left-aligned, no bubble style
  if (isTool) {
    return (
      <MessageErrorBoundary>
        <div className={`ml-2 pl-3 border-l-2 ${
          msg.type === 'tool_use' ? 'border-yellow-500/40' : 'border-green-500/40'
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

  // User and assistant messages: IM-style left/right alignment
  return (
    <MessageErrorBoundary>
      <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-2`}>
        <div className={`max-w-[75%] rounded-2xl px-4 py-2.5 ${
          isUser
            ? 'bg-blue-600 text-white rounded-br-md'
            : 'bg-gray-800 text-gray-100 rounded-bl-md'
        }`}>
          {isUser ? (
            <UserContent content={content} />
          ) : (
            <AssistantContent content={content} onChoiceSelect={onChoiceSelect} />
          )}
          <div className={`text-[10px] mt-1 ${isUser ? 'text-blue-200/60' : 'text-gray-500'} text-right`}>
            {formatTime(msg.timestamp)}
          </div>
        </div>
      </div>
    </MessageErrorBoundary>
  );
}
