/**
 * Everything the chart needs from the browser, behind one interface so the engine can be driven
 * by fakes in tests and so no browser global is touched outside this file.
 */

export interface ElementSize {
  cssWidth: number;
  cssHeight: number;
  /** Exact device-pixel content box when the browser reports it. */
  device?: { width: number; height: number };
}

export interface ChartEnvironment {
  createCanvas(container: HTMLElement): HTMLCanvasElement;
  devicePixelRatio(): number;
  requestFrame(callback: () => void): number;
  cancelFrame(handle: number): void;
  /** Calls back with the element's size (on observe and on every change). Returns a disposer. */
  observeResize(target: HTMLElement, callback: (size: ElementSize) => void): () => void;
  /** Calls back when devicePixelRatio changes (zoom, moving between monitors). Returns a disposer. */
  watchPixelRatio(callback: () => void): () => void;
}

export function browserEnvironment(): ChartEnvironment {
  return {
    createCanvas: (container) => container.ownerDocument.createElement('canvas'),
    devicePixelRatio: () => window.devicePixelRatio || 1,
    requestFrame: (callback) => window.requestAnimationFrame(callback),
    cancelFrame: (handle) => window.cancelAnimationFrame(handle),
    observeResize: (target, callback) => {
      const observer = new ResizeObserver((entries) => {
        const entry = entries[entries.length - 1];
        if (!entry) return;
        const deviceBox = entry.devicePixelContentBoxSize?.[0];
        callback({
          cssWidth: entry.contentRect.width,
          cssHeight: entry.contentRect.height,
          ...(deviceBox
            ? { device: { width: deviceBox.inlineSize, height: deviceBox.blockSize } }
            : {}),
        });
      });
      try {
        observer.observe(target, { box: 'device-pixel-content-box' });
      } catch {
        // Browsers without device-pixel-content-box support fall back to CSS size * DPR.
        observer.observe(target);
      }
      return () => observer.disconnect();
    },
    watchPixelRatio: (callback) => {
      let query: MediaQueryList | null = null;
      const onChange = (): void => {
        listen();
        callback();
      };
      const listen = (): void => {
        query?.removeEventListener('change', onChange);
        query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
        query.addEventListener('change', onChange);
      };
      listen();
      return () => query?.removeEventListener('change', onChange);
    },
  };
}
