// FullscreenController: native Fullscreen API where it works for ordinary elements, otherwise a
// fixed overlay (iPhone Safari). Escape exits in both modes.

export type FullscreenMode = 'native' | 'overlay';
export interface FullscreenState {
  active: boolean;
  mode: FullscreenMode | null;
}

/** Attribute set on the host in overlay mode. */
export const OVERLAY_ATTRIBUTE = 'fullscreen-overlay';

/**
 * Shadow-root CSS for the overlay. z-index 2000 is above al-folio's Bootstrap fixed navbar (1030).
 */
export const FULLSCREEN_OVERLAY_CSS =
  ':host([fullscreen-overlay]) { position: fixed; inset: 0; z-index: 2000; height: 100dvh; }';

type FsDocument = Document & {
  webkitFullscreenEnabled?: boolean;
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};
type FsElement = Element & {
  requestFullscreen?: (options?: FullscreenOptions) => Promise<void>;
  webkitRequestFullscreen?: () => Promise<void> | void;
};

export interface FullscreenControllerOptions {
  onChange: (state: FullscreenState) => void;
  /** Injected document (tests). Default: host.ownerDocument. */
  doc?: Document;
}

export class FullscreenController {
  private readonly host: FsElement;
  private readonly doc: FsDocument;
  private readonly onChange: (s: FullscreenState) => void;
  private current: FullscreenMode | null = null;
  private savedOverflow = '';
  private pending = false;
  private disposed = false;

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && this.current) this.exit();
  };
  private readonly onFsChange = (): void => this.syncNative();

  constructor(host: Element, opts: FullscreenControllerOptions) {
    this.host = host as FsElement;
    this.doc = (opts.doc ?? host.ownerDocument) as FsDocument;
    this.onChange = opts.onChange;
    this.doc.addEventListener('keydown', this.onKey);
    this.doc.addEventListener('fullscreenchange', this.onFsChange);
    this.doc.addEventListener('webkitfullscreenchange', this.onFsChange);
  }

  isActive(): boolean {
    return this.current !== null;
  }

  mode(): FullscreenMode | null {
    return this.current;
  }

  private nativeAvailable(): boolean {
    const enabled = this.doc.fullscreenEnabled || this.doc.webkitFullscreenEnabled;
    return Boolean(enabled && (this.host.requestFullscreen || this.host.webkitRequestFullscreen));
  }

  private fsElement(): Element | null {
    return this.doc.fullscreenElement ?? this.doc.webkitFullscreenElement ?? null;
  }

  private emit(): void {
    this.onChange({ active: this.current !== null, mode: this.current });
  }

  private enterOverlay(): void {
    this.host.setAttribute(OVERLAY_ATTRIBUTE, '');
    const root = this.doc.documentElement;
    this.savedOverflow = root.style.overflow;
    root.style.overflow = 'hidden';
    this.current = 'overlay';
    this.emit();
  }

  private leaveOverlay(): void {
    this.host.removeAttribute(OVERLAY_ATTRIBUTE);
    this.doc.documentElement.style.overflow = this.savedOverflow;
    this.current = null;
    this.emit();
  }

  /** Enter full screen: native if possible, otherwise (or if the request is rejected) the overlay. */
  async enter(): Promise<void> {
    if (this.current || this.pending || this.disposed) return;
    if (this.nativeAvailable()) {
      this.pending = true;
      try {
        const res = this.host.requestFullscreen
          ? this.host.requestFullscreen()
          : this.host.webkitRequestFullscreen?.();
        await res;
        this.pending = false;
        if (this.disposed) return;
        if (!this.current) {
          this.current = 'native';
          this.emit();
        }
        return;
      } catch {
        this.pending = false;
        // fall through to the overlay
      }
    }
    if (!this.current && !this.disposed) this.enterOverlay();
  }

  async exit(): Promise<void> {
    if (this.current === 'overlay') {
      this.leaveOverlay();
      return;
    }
    if (this.current === 'native') {
      if (this.fsElement()) {
        try {
          const res = this.doc.exitFullscreen
            ? this.doc.exitFullscreen()
            : this.doc.webkitExitFullscreen?.();
          await res;
        } catch {
          /* state is corrected below */
        }
      }
      // Whatever the browser did, we are no longer in native full screen.
      if (this.current === 'native') {
        this.current = null;
        this.emit();
      }
    }
  }

  toggle(): Promise<void> {
    return this.current ? this.exit() : this.enter();
  }

  /** Keep state in sync when the browser leaves (or enters) native full screen by itself. */
  private syncNative(): void {
    if (this.disposed) return;
    const isHost = this.fsElement() === this.host;
    if (this.current === 'native' && !isHost) {
      this.current = null;
      this.emit();
    } else if (!this.current && isHost) {
      this.current = 'native';
      this.emit();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    if (this.current === 'overlay') this.leaveOverlay();
    this.disposed = true;
    this.doc.removeEventListener('keydown', this.onKey);
    this.doc.removeEventListener('fullscreenchange', this.onFsChange);
    this.doc.removeEventListener('webkitfullscreenchange', this.onFsChange);
  }
}
