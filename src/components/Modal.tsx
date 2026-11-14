import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

interface ModalProps {
  onClose: () => void;
  /** id of the element that names the dialog (aria-labelledby). */
  labelledBy: string;
  variant?: 'center' | 'side' | 'left';
  size?: 'sm' | 'lg';
  className?: string;
  children: ReactNode;
}

/**
 * Accessible modal built on the native <dialog> element: showModal() gives us the focus trap,
 * an inert background, Esc handling, top-layer stacking and a styleable ::backdrop for free.
 * Mount it only while it should be visible; unmounting closes it and returns focus.
 * Page scroll is locked by CSS (`html:has(dialog[open])`).
 */
export function Modal({ onClose, labelledBy, variant = 'center', size = 'lg', className = '', children }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const pressStartedOnBackdrop = useRef(false);
  const onCloseRef = useRef(onClose);
  const unmountingRef = useRef(false);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    unmountingRef.current = false;
    if (!dialog.open) dialog.showModal();
    document.documentElement.classList.add('has-open-dialog');
    return () => {
      unmountingRef.current = true;
      if (dialog.open) dialog.close();
      if (!document.querySelector('dialog[open]')) {
        document.documentElement.classList.remove('has-open-dialog');
      }
      if (previouslyFocused && previouslyFocused.isConnected) previouslyFocused.focus({ preventScroll: true });
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className={`modal-dialog ${className}`}
      data-variant={variant}
      data-size={size}
      aria-labelledby={labelledBy}
      onCancel={(e) => {
        // Esc: let React state decide, so the parent stays the single source of truth.
        e.preventDefault();
        onCloseRef.current();
      }}
      onClose={(e) => {
        // The browser may close a dialog natively (e.g. a repeated Esc ignores preventDefault):
        // keep React state in sync so the parent doesn't think it is still open.
        // `close` is dispatched asynchronously: in dev, StrictMode closes and immediately re-opens
        // the dialog, so a late event for the first close must be ignored while it is open again.
        if (!unmountingRef.current && !e.currentTarget.open) onCloseRef.current();
      }}
      onMouseDown={(e) => {
        pressStartedOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && pressStartedOnBackdrop.current) onCloseRef.current();
        pressStartedOnBackdrop.current = false;
      }}
    >
      {children}
    </dialog>
  );
}

interface ModalHeaderProps {
  titleId: string;
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  onClose: () => void;
  closeLabel?: string;
}

/** Shared header: title wired to aria-labelledby plus a 44px close button. */
export function ModalHeader({ titleId, title, subtitle, icon, onClose, closeLabel = 'Cerrar' }: ModalHeaderProps) {
  return (
    <div
      className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3 sm:px-5"
      style={{
        backgroundColor: 'var(--bg-surface)',
        borderColor: 'var(--border-hairline)',
        paddingTop: 'max(0.75rem, env(safe-area-inset-top))'
      }}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        {icon}
        <div className="min-w-0">
          <h2 id={titleId} className="font-editorial truncate text-lg font-semibold leading-tight">
            {title}
          </h2>
          {subtitle ? (
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {subtitle}
            </p>
          ) : null}
        </div>
      </div>
      <button type="button" onClick={onClose} className="btn btn-quiet btn-icon btn-sm" aria-label={closeLabel}>
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
