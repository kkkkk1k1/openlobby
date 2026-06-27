import React, { Component, useEffect, useRef, type ReactNode } from 'react';

// ── ErrorBoundary ──

interface ErrorBoundaryProps {
  children: ReactNode;
  fallbackText: string;
  onRetry: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

class DrawerErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  handleRetry = () => {
    this.setState({ hasError: false });
    this.props.onRetry();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="p-4 text-sm text-danger">
          <p className="mb-2">{this.props.fallbackText}</p>
          <button
            onClick={this.handleRetry}
            className="px-3 py-1 rounded bg-primary text-primary-on text-sm"
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ── MobileDrawer ──

export interface MobileDrawerProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}

function MobileDrawerInner({ open, onClose, children }: MobileDrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Escape key handler
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  // Scroll lock
  useEffect(() => {
    if (open) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = prev;
      };
    }
  }, [open]);

  return (
    <div
      className={`fixed inset-0 z-45 ${
        open ? 'pointer-events-auto' : 'pointer-events-none'
      }`}
    >
      {/* Backdrop */}
      <div
        className={`absolute inset-0 bg-black/50 z-0 transition-opacity duration-200 ${
          open ? 'opacity-100' : 'opacity-0'
        }`}
        onClick={onClose}
      />

      {/* Panel */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Session navigation"
        className={`absolute top-0 left-0 h-full w-[85vw] max-w-[320px] z-10 bg-surface-secondary border-r border-outline transition-transform duration-200 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {open && children}
      </div>
    </div>
  );
}

const MobileDrawer = React.memo(MobileDrawerInner);

// ── Wrapper with ErrorBoundary ──

interface MobileDrawerWithBoundaryProps extends MobileDrawerProps {
  errorFallbackText?: string;
}

export function MobileDrawerWithBoundary({
  open,
  onClose,
  children,
  errorFallbackText = 'Something went wrong loading the sidebar.',
}: MobileDrawerWithBoundaryProps) {
  return (
    <MobileDrawer open={open} onClose={onClose}>
      <DrawerErrorBoundary
        fallbackText={errorFallbackText}
        onRetry={onClose}
      >
        {children}
      </DrawerErrorBoundary>
    </MobileDrawer>
  );
}

export default MobileDrawer;
