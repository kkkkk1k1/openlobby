import React from 'react';
import type { ControlRequestData } from '../stores/lobby-store';

interface Props {
  request: ControlRequestData;
  onRespond: (requestId: string, decision: 'allow' | 'deny') => void;
}

export default function ControlCard({ request, onRespond }: Props) {
  return (
    <div className="rounded-lg px-4 py-3 mb-2 bg-warning-surface border border-warning/50">
      <div className="flex items-center justify-between mb-2">
        <div>
          <span className="text-xs text-warning font-semibold">APPROVAL REQUIRED</span>
          <span className="text-warning font-mono font-bold text-sm ml-2">{request.toolName}</span>
        </div>
        <div className="flex gap-2">
          <button
            className="px-3 py-1 rounded bg-success hover:bg-success/80 text-white text-xs font-medium transition-colors"
            onClick={() => onRespond(request.requestId, 'allow')}
          >
            Allow
          </button>
          <button
            className="px-3 py-1 rounded bg-danger hover:bg-danger-hover text-white text-xs font-medium transition-colors"
            onClick={() => onRespond(request.requestId, 'deny')}
          >
            Deny
          </button>
        </div>
      </div>
      <pre className="text-on-surface-secondary text-xs overflow-auto max-h-40 p-2 bg-[var(--color-code-bg)] rounded font-mono">
        {JSON.stringify(request.toolInput, null, 2)}
      </pre>
    </div>
  );
}
