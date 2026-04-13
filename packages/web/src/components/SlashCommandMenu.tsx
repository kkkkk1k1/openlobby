import React, { useEffect, useRef } from 'react';
import { useI18nContext } from '../contexts/I18nContext';

export interface SlashCommand {
  name: string;
  description: string;
  args?: string;
}

export function getFallbackCommands(t: ReturnType<typeof useI18nContext>['t']): SlashCommand[] {
  return [
    { name: '/help', description: t('slashMenu.help') },
    { name: '/ls', description: t('slashMenu.listSessions') },
    { name: '/add', description: t('slashMenu.createSession'), args: '[name]' },
    { name: '/goto', description: t('slashMenu.gotoSession'), args: '<id|name>' },
    { name: '/exit', description: t('slashMenu.returnLobbyManager') },
    { name: '/stop', description: t('slashMenu.interruptReply') },
    { name: '/new', description: t('slashMenu.rebuildCli') },
    { name: '/rm', description: t('slashMenu.destroySession'), args: '<id|name>' },
    { name: '/plan', description: t('slashMenu.planMode') },
    { name: '/msg-only', description: t('messageMode.only') },
    { name: '/msg-tidy', description: t('messageMode.tidy') },
    { name: '/msg-total', description: t('messageMode.total') },
  ];
}

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

export function getMergedCommands(
  adapterCommands: SlashCommand[] | undefined,
  fallbackCommands: SlashCommand[],
): SlashCommand[] {
  const adapterCmds = adapterCommands && adapterCommands.length > 0 ? adapterCommands : [];
  const seen = new Set<string>();
  const result: SlashCommand[] = [];
  for (const cmd of [...adapterCmds, ...fallbackCommands]) {
    if (!seen.has(cmd.name)) {
      seen.add(cmd.name);
      result.push(cmd);
    }
  }
  return result;
}

export default function SlashCommandMenu({ filteredCommands, selectedIndex, onSelect, loading }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const { t } = useI18nContext();

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
        <span>{t('slashMenu.commandsCount', { count: filteredCommands.length })}</span>
        {loading && (
          <span className="flex items-center gap-1 text-primary">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
            {t('slashMenu.updating')}
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
