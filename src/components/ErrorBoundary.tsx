import { Component, type ErrorInfo, type ReactNode } from 'react';
import { clearLocalData } from '../lib/storage';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Custom fallback. Omit for the full-page recovery screen; pass `null` to render nothing. */
  fallback?: ReactNode;
  /** When this value changes the boundary tries to render its children again. */
  resetKey?: string | number | null;
  onError?: (error: Error) => void;
}

interface ErrorBoundaryState {
  failed: boolean;
  confirmReset: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failed: false, confirmReset: false };

  static getDerivedStateFromError(): Partial<ErrorBoundaryState> {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[coleebri] render error', error, info.componentStack);
    this.props.onError?.(error);
  }

  componentDidUpdate(prev: ErrorBoundaryProps): void {
    if (this.state.failed && prev.resetKey !== this.props.resetKey) {
      this.setState({ failed: false, confirmReset: false });
    }
  }

  private reload = () => {
    window.location.reload();
  };

  private resetData = () => {
    clearLocalData();
    window.location.reload();
  };

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    if (this.props.fallback !== undefined) return this.props.fallback;

    return (
      <div
        role="alert"
        className="flex min-h-dvh items-center justify-center p-6"
        style={{ backgroundColor: 'var(--bg-page)', color: 'var(--text-primary)' }}
      >
        <div
          className="w-full max-w-md rounded-md border p-6"
          style={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border-strong)' }}
        >
          <h1 className="font-editorial text-2xl font-semibold">Algo salió mal</h1>
          <p className="mt-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
            No pudimos mostrar esta página. Tus estanterías y tu progreso de lectura siguen guardados en este
            dispositivo. Prueba a recargar.
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            <button type="button" className="btn btn-primary" onClick={this.reload}>
              Recargar
            </button>
            {!this.state.confirmReset ? (
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => this.setState({ confirmReset: true })}
              >
                Restablecer datos locales
              </button>
            ) : null}
          </div>
          {this.state.confirmReset ? (
            <div className="callout mt-4" data-tone="warn">
              <div>
                <p>
                  Esto borra estanterías, notas, progreso y preferencias guardadas en este dispositivo. No se puede
                  deshacer.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" className="btn btn-danger btn-sm" onClick={this.resetData}>
                    Sí, borrar y recargar
                  </button>
                  <button
                    type="button"
                    className="btn btn-quiet btn-sm"
                    onClick={() => this.setState({ confirmReset: false })}
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    );
  }
}
