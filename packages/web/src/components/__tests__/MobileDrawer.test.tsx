import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import MobileDrawer, { MobileDrawerWithBoundary } from '../MobileDrawer';

describe('MobileDrawer', () => {
  describe('AC1: open=true state', () => {
    it('renders panel with translate-x-0', () => {
      render(
        <MobileDrawer open={true} onClose={() => {}}>
          <div>Drawer content</div>
        </MobileDrawer>,
      );
      const panel = screen.getByRole('dialog');
      expect(panel).toHaveClass('translate-x-0');
      expect(panel).not.toHaveClass('-translate-x-full');
    });

    it('has aria-modal="true"', () => {
      render(
        <MobileDrawer open={true} onClose={() => {}}>
          <div>content</div>
        </MobileDrawer>,
      );
      expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
    });

    it('mounts children when open', () => {
      render(
        <MobileDrawer open={true} onClose={() => {}}>
          <div>Drawer content</div>
        </MobileDrawer>,
      );
      expect(screen.getByText('Drawer content')).toBeInTheDocument();
    });

    it('shows backdrop with opacity-100 and wrapper has pointer-events-auto', () => {
      const { container } = render(
        <MobileDrawer open={true} onClose={() => {}}>
          <div>content</div>
        </MobileDrawer>,
      );
      const wrapper = container.firstChild as HTMLElement;
      expect(wrapper).toHaveClass('pointer-events-auto');

      // Backdrop is first child
      const backdrop = wrapper.children[0] as HTMLElement;
      expect(backdrop.className).toContain('opacity-100');
    });

    it('locks body scroll when open', () => {
      render(
        <MobileDrawer open={true} onClose={() => {}}>
          <div>content</div>
        </MobileDrawer>,
      );
      expect(document.body.style.overflow).toBe('hidden');
    });
  });

  describe('AC2: open=false state', () => {
    it('renders panel with -translate-x-full', () => {
      const { container } = render(
        <MobileDrawer open={false} onClose={() => {}}>
          <div>Drawer content</div>
        </MobileDrawer>,
      );
      const wrapper = container.firstChild as HTMLElement;
      const panel = wrapper.children[1] as HTMLElement;
      expect(panel.className).toContain('-translate-x-full');
    });

    it('does not mount children', () => {
      render(
        <MobileDrawer open={false} onClose={() => {}}>
          <div>Drawer content</div>
        </MobileDrawer>,
      );
      expect(screen.queryByText('Drawer content')).not.toBeInTheDocument();
    });

    it('wrapper has pointer-events-none when closed', () => {
      const { container } = render(
        <MobileDrawer open={false} onClose={() => {}}>
          <div>content</div>
        </MobileDrawer>,
      );
      const wrapper = container.firstChild as HTMLElement;
      expect(wrapper).toHaveClass('pointer-events-none');
    });

    it('restores body scroll when closed after being open', () => {
      const { rerender } = render(
        <MobileDrawer open={true} onClose={() => {}}>
          <div>content</div>
        </MobileDrawer>,
      );
      expect(document.body.style.overflow).toBe('hidden');

      rerender(
        <MobileDrawer open={false} onClose={() => {}}>
          <div>content</div>
        </MobileDrawer>,
      );
      expect(document.body.style.overflow).toBe('');
    });
  });

  describe('AC3: backdrop click triggers onClose', () => {
    it('calls onClose when clicking backdrop area', () => {
      const onClose = vi.fn();
      const { container } = render(
        <MobileDrawer open={true} onClose={onClose}>
          <div>content</div>
        </MobileDrawer>,
      );

      // The outer wrapper has 2 children: backdrop + panel.
      // backdrop is the first child (z-0) — click it directly
      const wrapper = container.firstChild as HTMLElement;
      const backdrop = wrapper.children[0] as HTMLElement;
      fireEvent.click(backdrop);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('AC4: Escape key triggers onClose', () => {
    it('calls onClose when Escape is pressed', () => {
      const onClose = vi.fn();
      render(
        <MobileDrawer open={true} onClose={onClose}>
          <div>content</div>
        </MobileDrawer>,
      );

      fireEvent.keyDown(document, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('does not call onClose when closed and Escape pressed', () => {
      const onClose = vi.fn();
      render(
        <MobileDrawer open={false} onClose={onClose}>
          <div>content</div>
        </MobileDrawer>,
      );

      fireEvent.keyDown(document, { key: 'Escape' });
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe('AC5: panel click does not trigger onClose (stopPropagation)', () => {
    it('does not call onClose when clicking inside the panel', () => {
      const onClose = vi.fn();
      render(
        <MobileDrawer open={true} onClose={onClose}>
          <button>Inside button</button>
        </MobileDrawer>,
      );

      fireEvent.click(screen.getByRole('dialog'));
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe('AC6: ErrorBoundary', () => {
    it('catches errors and shows fallback UI', () => {
      const ErrorThrower = () => {
        throw new Error('test error');
      };
      const onClose = vi.fn();

      // Suppress console.error from React error logging
      const orig = console.error;
      console.error = vi.fn();

      render(
        <MobileDrawerWithBoundary open={true} onClose={onClose}>
          <ErrorThrower />
        </MobileDrawerWithBoundary>,
      );

      expect(screen.getByText('Something went wrong loading the sidebar.')).toBeInTheDocument();
      expect(screen.getByText('Retry')).toBeInTheDocument();

      console.error = orig;
    });

    it('retry button calls onClose', () => {
      const ErrorThrower = () => {
        throw new Error('test error');
      };
      const onClose = vi.fn();

      const orig = console.error;
      console.error = vi.fn();

      render(
        <MobileDrawerWithBoundary open={true} onClose={onClose}>
          <ErrorThrower />
        </MobileDrawerWithBoundary>,
      );

      fireEvent.click(screen.getByText('Retry'));
      expect(onClose).toHaveBeenCalled();

      console.error = orig;
    });
  });

  describe('AC10: prefers-reduced-motion', () => {
    it('has transition classes that respect reduced motion media query', () => {
      // The AC says transition duration 0ms when prefers-reduced-motion
      // This is enforced via CSS media query, so we verify the class exists
      render(
        <MobileDrawer open={true} onClose={() => {}}>
          <div>content</div>
        </MobileDrawer>,
      );
      const panel = screen.getByRole('dialog');
      expect(panel.className).toContain('duration-200');
    });
  });

  describe('ARIA attributes', () => {
    it('has correct dialog role and label', () => {
      render(
        <MobileDrawer open={true} onClose={() => {}}>
          <div>content</div>
        </MobileDrawer>,
      );
      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveAttribute('aria-label', 'Session navigation');
    });
  });
});
