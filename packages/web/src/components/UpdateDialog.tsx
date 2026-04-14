import { useState } from 'react';
import { setExpectingRestart } from '../hooks/useWebSocket';

interface UpdateDialogProps {
  latestVersion: string;
  installMode: 'global' | 'npx';
  onClose: () => void;
}

export function UpdateDialog({ latestVersion, installMode, onClose }: UpdateDialogProps) {
  const [status, setStatus] = useState<'confirm' | 'updating' | 'error'>('confirm');
  const [errorMessage, setErrorMessage] = useState('');

  const handleUpdate = async () => {
    setStatus('updating');
    setExpectingRestart(true);
    try {
      const res = await fetch('/api/update', { method: 'POST' });
      const data = await res.json();

      if (data.status === 'updating') {
        return;
      }
      if (data.status === 'already-updating') {
        return;
      }
      if (data.status === 'error') {
        setExpectingRestart(false);
        setStatus('error');
        setErrorMessage(data.message ?? 'Update failed');
      }
    } catch {
      setExpectingRestart(false);
      setStatus('error');
      setErrorMessage('Failed to connect to server');
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-surface-primary rounded-lg shadow-lg p-6 max-w-md mx-4">
        {installMode === 'npx' ? (
          <>
            <h3 className="text-lg font-semibold text-on-surface mb-3">
              New Version Available
            </h3>
            <p className="text-on-surface-secondary mb-4">
              v{latestVersion} is available. You are running via npx — the latest
              version will be used automatically next time you run{' '}
              <code className="bg-surface-elevated px-1 rounded text-sm">npx openlobby</code>.
            </p>
            <div className="flex justify-end">
              <button
                onClick={onClose}
                className="px-4 py-2 bg-primary text-on-primary rounded hover:bg-primary-hover transition-colors"
              >
                OK
              </button>
            </div>
          </>
        ) : status === 'confirm' ? (
          <>
            <h3 className="text-lg font-semibold text-on-surface mb-3">
              Update Available
            </h3>
            <p className="text-on-surface-secondary mb-4">
              Update to v{latestVersion}? The server will restart automatically after the update.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={onClose}
                className="px-4 py-2 text-on-surface-secondary hover:bg-surface-elevated rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleUpdate}
                className="px-4 py-2 bg-primary text-on-primary rounded hover:bg-primary-hover transition-colors"
              >
                Update
              </button>
            </div>
          </>
        ) : status === 'updating' ? (
          <>
            <h3 className="text-lg font-semibold text-on-surface mb-3">
              Updating...
            </h3>
            <p className="text-on-surface-secondary mb-4">
              Installing the latest version. The server will restart shortly...
            </p>
            <div className="flex justify-center">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
            </div>
          </>
        ) : (
          <>
            <h3 className="text-lg font-semibold text-danger mb-3">
              Update Failed
            </h3>
            <p className="text-on-surface-secondary mb-4">
              {errorMessage}
            </p>
            <div className="flex justify-end">
              <button
                onClick={onClose}
                className="px-4 py-2 bg-primary text-on-primary rounded hover:bg-primary-hover transition-colors"
              >
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
