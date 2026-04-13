import React, { useEffect, useRef } from 'react';

export interface SlashCommand {
  name: string;
  description: string;
  args?: string;
}

const FALLBACK_COMMANDS: SlashCommand[] = [
  { name: '/help', description: '显示帮助信息' },
  { name: '/ls', description: '列出所有会话' },
  { name: '/add', description: '创建新会话', args: '[name]' },
  { name: '/goto', description: '切换到指定会话', args: '<id|name>' },
  { name: '/exit', description: '返回 Lobby Manager' },
  { name: '/stop', description: '打断当前模型回复' },
  { name: '/new', description: '重建当前会话的 CLI 进程' },
  { name: '/rm', description: '销毁指定会话', args: '<id|name>' },
  { name: '/plan', description: 'Toggle plan mode (read-only exploration)' },
  { name: '/msg-only', description: '仅推送回复内容' },
  { name: '/msg-tidy', description: '工具调用折叠为摘要' },
  { name: '/msg-total', description: '推送全部消息' },
];

interface Props {
  filteredCommands: SlashCommand[];
  selectedIndex: number;
  onSelect: (cmd: SlashCommand) => void;
  loading?: boolean;
}

export function filterCommands(input: string, commands: SlashCommand[]): SlashCommand[] {
  const query = input.toLowerCase();
  if (!query) return commands;

  const scored: { cmd: SlashCommand; score: number }[] = [];
  for (const cmd of commands) {
    const name = cmd.name.toLowerCase();
    if (name === query || name === '/' + query) {
      scored.push({ cmd, score: -1 });
    } else {
      const nameIdx = name.indexOf(query);
      if (nameIdx !== -1) {
        scored.push({ cmd, score: nameIdx });
      } else if (cmd.description.toLowerCase().includes(query)) {
        scored.push({ cmd, score: 1000 });
      }
    }
  }

  scored.sort((a, b) => a.score - b.score);
  return scored.map((s) => s.cmd);
}

export function getMergedCommands(adapterCommands?: SlashCommand[]): SlashCommand[] {
  const adapterCmds = adapterCommands && adapterCommands.length > 0 ? adapterCommands : [];
  const seen = new Set<string>();
  const result: SlashCommand[] = [];
  for (const cmd of [...adapterCmds, ...FALLBACK_COMMANDS]) {
    if (!seen.has(cmd.name)) {
      seen.add(cmd.name);
      result.push(cmd);
    }
  }
  return result;
}

export default function SlashCommandMenu({ filteredCommands, selectedIndex, onSelect, loading }: Props) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current?.children[selectedIndex + 1] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex, filteredCommands]);

  if (filteredCommands.length === 0) return null;

  return (
    <div
      ref={listRef}
      className="absolute bottom-full left-0 right-0 mb-1 bg-surface-secondary border border-outline rounded-lg shadow-xl max-h-72 overflow-y-auto z-50"
    >
      <div className="sticky top-0 px-3 py-1 bg-surface-secondary/95 border-b border-outline-subtle flex items-center justify-between text-[10px] text-on-surface-muted">
        <span>{filteredCommands.length} commands</span>
        {loading && (
          <span className="flex items-center gap-1 text-primary">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
            updating...
          </span>
        )}
      </div>
      {filteredCommands.map((cmd, i) => (
        <button
          key={cmd.name}
          className={`w-full text-left px-3 py-1.5 flex items-center gap-2 text-sm transition-colors ${
            i === selectedIndex
              ? 'bg-primary-surface text-on-surface'
              : 'text-on-surface-secondary hover:bg-surface-elevated'
          }`}
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(cmd);
          }}
        >
          <span className="font-mono text-primary font-medium w-28 shrink-0 text-xs">
            {cmd.name}
          </span>
          <span className="text-on-surface-secondary text-xs truncate flex-1">
            {cmd.description}
          </span>
          {cmd.args && (
            <span className="text-[10px] text-on-surface-muted font-mono shrink-0">{cmd.args}</span>
          )}
        </button>
      ))}
    </div>
  );
}
