import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useLobbyStore } from '../stores/lobby-store';
import { wsConfigureSession, wsRequestCompletions, wsInterruptSession } from '../hooks/useWebSocket';
import SlashCommandMenu, {
  filterCommands,
  getMergedCommands,
  type SlashCommand,
} from './SlashCommandMenu';

interface Attachment {
  file: File;
  preview?: string;
}

interface Props {
  onSend: (content: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

async function uploadFile(file: File, cwd: string): Promise<{ path: string }> {
  const formData = new FormData();
  formData.append('file', file);
  const res = await fetch(`/api/upload?cwd=${encodeURIComponent(cwd)}`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Upload failed' }));
    throw new Error(err.error ?? 'Upload failed');
  }
  return res.json();
}

function isImageFile(file: File): boolean {
  return file.type.startsWith('image/');
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function MessageInput({ onSend, disabled, placeholder }: Props) {
  const [value, setValue] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashFilter, setSlashFilter] = useState('');
  const [slashIndex, setSlashIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const activeSessionId = useLobbyStore((s) => s.activeSessionId);
  const activeSession = useLobbyStore((s) =>
    s.activeSessionId ? s.sessions[s.activeSessionId] : undefined,
  );
  const isRunning = activeSession?.status === 'running' || activeSession?.status === 'awaiting_approval';
  const sessionCommands = useLobbyStore((s) =>
    s.activeSessionId ? s.commandsBySession[s.activeSessionId] : undefined,
  );
  const commandsLoading = useLobbyStore((s) =>
    s.activeSessionId ? s.commandsLoadingBySession[s.activeSessionId] ?? false : false,
  );

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const maxHeight = 24 * 6;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, []);

  useEffect(() => {
    adjustHeight();
  }, [value, adjustHeight]);

  // Slash command detection
  useEffect(() => {
    if (value.startsWith('/')) {
      const query = value.slice(1).split(' ')[0]; // text after "/" before first space
      if (!value.includes(' ')) {
        // Still typing the command name
        setSlashFilter(query);
        setShowSlashMenu(true);
        setSlashIndex(0);
        // Fetch commands if not cached
        if (activeSessionId && !sessionCommands) {
          wsRequestCompletions(activeSessionId);
        }
      } else {
        setShowSlashMenu(false);
      }
    } else {
      setShowSlashMenu(false);
    }
  }, [value]);

  const isPlanMode = activeSession?.permissionMode === 'readonly';

  // Lobby-level commands are handled locally; CLI commands are passed through as messages
  const executeSlashCommand = (input: string) => {
    if (!activeSessionId) return;
    // Toggle plan mode locally instead of sending to CLI
    if (input === '/plan') {
      wsConfigureSession(activeSessionId, { permissionMode: isPlanMode ? 'supervised' : 'readonly' });
      return;
    }
    onSend(input);
  };

  const handleSlashSelect = (cmd: SlashCommand) => {
    if (cmd.args) {
      setValue(cmd.name + ' ');
    } else {
      executeSlashCommand(cmd.name);
      setValue('');
    }
    setShowSlashMenu(false);
    textareaRef.current?.focus();
  };

  const addFiles = (files: FileList | File[]) => {
    const newAttachments: Attachment[] = [];
    for (const file of files) {
      if (file.size > 10 * 1024 * 1024) {
        alert(`File "${file.name}" is too large (max 10MB)`);
        continue;
      }
      const attachment: Attachment = { file };
      if (isImageFile(file)) {
        const reader = new FileReader();
        reader.onload = (e) => {
          setAttachments((prev) =>
            prev.map((a) =>
              a.file === file ? { ...a, preview: e.target?.result as string } : a,
            ),
          );
        };
        reader.readAsDataURL(file);
      }
      newAttachments.push(attachment);
    }
    setAttachments((prev) => [...prev, ...newAttachments]);
  };

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async () => {
    const trimmed = value.trim();
    if ((!trimmed && attachments.length === 0) || disabled || uploading) return;

    // Handle slash commands
    if (trimmed.startsWith('/')) {
      executeSlashCommand(trimmed);
      setValue('');
      setShowSlashMenu(false);
      return;
    }

    const cwd = activeSession?.cwd;
    let messageContent = trimmed;

    if (attachments.length > 0 && cwd) {
      setUploading(true);
      try {
        const uploadedPaths: string[] = [];
        for (const att of attachments) {
          const result = await uploadFile(att.file, cwd);
          uploadedPaths.push(result.path);
        }
        const fileRefs = uploadedPaths
          .map((p) => `[Attached: ${p}]`)
          .join('\n');
        messageContent = messageContent
          ? `${messageContent}\n\n${fileRefs}`
          : fileRefs;
      } catch (err) {
        alert(`Upload failed: ${err instanceof Error ? err.message : String(err)}`);
        setUploading(false);
        return;
      }
      setUploading(false);
    }

    if (messageContent) {
      onSend(messageContent);
    }
    setValue('');
    setAttachments([]);
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Slash menu navigation
    if (showSlashMenu) {
      const commands = filterCommands(slashFilter, getMergedCommands(sessionCommands));
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashIndex((i) => Math.min(i + 1, commands.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        if (commands[slashIndex]) {
          handleSlashSelect(commands[slashIndex]);
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowSlashMenu(false);
        return;
      }
    }

    // Normal send
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = () => {
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      addFiles(e.target.files);
      e.target.value = '';
    }
  };

  return (
    <div
      className={`border-t border-gray-700 p-3 relative ${
        isDragOver ? 'bg-blue-900/20 border-blue-500/50' : ''
      }`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Slash command menu */}
      {showSlashMenu && (
        <SlashCommandMenu
          filter={slashFilter}
          selectedIndex={slashIndex}
          onSelect={handleSlashSelect}
          commands={sessionCommands}
          loading={commandsLoading}
        />
      )}

      {/* Attachment previews */}
      {attachments.length > 0 && (
        <div className="flex gap-2 mb-2 flex-wrap">
          {attachments.map((att, i) => (
            <div
              key={i}
              className="relative bg-gray-800 rounded-lg px-2 py-1.5 flex items-center gap-2 text-xs text-gray-300 border border-gray-700"
            >
              {att.preview ? (
                <img
                  src={att.preview}
                  alt={att.file.name}
                  className="w-8 h-8 object-cover rounded"
                />
              ) : (
                <span className="text-gray-400">📄</span>
              )}
              <div className="max-w-[120px]">
                <div className="truncate">{att.file.name}</div>
                <div className="text-[10px] text-gray-500">
                  {formatFileSize(att.file.size)}
                </div>
              </div>
              <button
                onClick={() => removeAttachment(i)}
                className="text-gray-500 hover:text-gray-300 ml-1"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2 items-end">
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled}
          className="p-2.5 text-gray-400 hover:text-gray-200 disabled:opacity-30 transition-colors"
          title="Attach file"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={handleFileSelect}
          className="hidden"
          accept="image/*,.txt,.md,.ts,.tsx,.js,.jsx,.py,.json,.yaml,.yml,.toml,.csv,.log,.sh,.bash,.zsh,.html,.css,.xml,.sql"
        />

        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            isDragOver
              ? 'Drop files here...'
              : isPlanMode
                ? 'Plan mode: describe what you want to build...'
                : placeholder ?? 'Message... (/ for commands)'
          }
          disabled={disabled || uploading}
          rows={1}
          className={`flex-1 bg-gray-800 text-gray-100 rounded-xl px-4 py-2.5 resize-none focus:outline-none focus:ring-2 disabled:opacity-50 placeholder-gray-500 text-sm leading-6 ${
            isPlanMode ? 'ring-1 ring-amber-500/40 focus:ring-amber-500/60' : 'focus:ring-blue-500/50'
          }`}
          style={{ minHeight: '42px' }}
        />

        {isRunning ? (
          <button
            onClick={() => activeSessionId && wsInterruptSession(activeSessionId)}
            className="px-4 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-white font-medium text-sm transition-colors"
          >
            ⏹ Stop
          </button>
        ) : (
          <button
            onClick={handleSubmit}
            disabled={disabled || uploading || (!value.trim() && attachments.length === 0)}
            className="px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-30 disabled:hover:bg-blue-600 text-white font-medium text-sm transition-colors"
          >
            {uploading ? '...' : 'Send'}
          </button>
        )}
      </div>

      {isDragOver && (
        <div className="text-center text-blue-400 text-xs mt-1">
          Drop files to attach
        </div>
      )}
    </div>
  );
}
