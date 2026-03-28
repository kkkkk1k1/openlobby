import React, { useEffect, useRef } from 'react';

export interface SlashCommand {
  name: string;
  description: string;
  args?: string;
}

// Minimal fallback when no session is active
const FALLBACK_COMMANDS: SlashCommand[] = [
  { name: '/plan', description: 'Toggle plan mode (read-only exploration)' },
  { name: '/help', description: 'Show help' },
];

interface Props {
  filter: string;
  selectedIndex: number;
  onSelect: (cmd: SlashCommand) => void;
  commands?: SlashCommand[];
  loading?: boolean;
}

export function filterCommands(input: string, commands: SlashCommand[]): SlashCommand[] {
  const query = input.toLowerCase();
  if (!query) return commands;
  return commands.filter(
    (cmd) =>
      cmd.name.toLowerCase().includes(query) ||
      cmd.description.toLowerCase().includes(query),
  );
}

export default function SlashCommandMenu({ filter, selectedIndex, onSelect, commands, loading }: Props) {
  const list = commands && commands.length > 0 ? commands : FALLBACK_COMMANDS;
  const filtered = filterCommands(filter, list);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current?.children[selectedIndex + 1] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (filtered.length === 0) return null;

  return (
    <div
      ref={listRef}
      className="absolute bottom-full left-0 right-0 mb-1 bg-gray-900 border border-gray-700 rounded-lg shadow-xl max-h-72 overflow-y-auto z-50"
    >
      {/* Header with count and loading indicator */}
      <div className="sticky top-0 px-3 py-1 bg-gray-900/95 border-b border-gray-800 flex items-center justify-between text-[10px] text-gray-500">
        <span>{filtered.length} commands</span>
        {loading && (
          <span className="flex items-center gap-1 text-blue-400">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
            updating...
          </span>
        )}
      </div>
      {filtered.map((cmd, i) => (
        <button
          key={cmd.name}
          className={`w-full text-left px-3 py-1.5 flex items-center gap-2 text-sm transition-colors ${
            i === selectedIndex
              ? 'bg-blue-600/30 text-white'
              : 'text-gray-300 hover:bg-gray-800'
          }`}
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(cmd);
          }}
        >
          <span className="font-mono text-blue-400 font-medium w-28 shrink-0 text-xs">
            {cmd.name}
          </span>
          <span className="text-gray-400 text-xs truncate flex-1">
            {cmd.description}
          </span>
          {cmd.args && (
            <span className="text-[10px] text-gray-600 font-mono shrink-0">{cmd.args}</span>
          )}
        </button>
      ))}
    </div>
  );
}
