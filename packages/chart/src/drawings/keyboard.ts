/**
 * Drawing keyboard shortcuts (pure). One map for the chart's own key listener and for hosts that
 * forward page-level keys (FumeChart.handleKeyDown), so every path behaves the same.
 *
 *   Escape                       cancel an unfinished drawing / a drag; else clear the selection
 *   Delete, Backspace            delete the selected drawing (not when locked)
 *   Ctrl+Z (⌘Z)                  undo
 *   Ctrl+Shift+Z, Ctrl+Y (⌘⇧Z)   redo
 *   Ctrl+D (⌘D)                  duplicate the selected drawing
 *
 * Keys typed into text fields, selects or editable content are never commands.
 */

export type DrawingCommand = 'cancel' | 'delete' | 'undo' | 'redo' | 'duplicate';

/** The KeyboardEvent fields the map reads. */
export interface KeyInput {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  target?: unknown;
}

export function drawingCommandForKey(e: KeyInput): DrawingCommand | null {
  if (isTextEntryTarget(e.target) || e.altKey) return null;
  const mod = Boolean(e.ctrlKey || e.metaKey);
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (!mod) {
    if (e.shiftKey) return null;
    if (key === 'Escape') return 'cancel';
    if (key === 'Delete' || key === 'Backspace') return 'delete';
    return null;
  }
  if (key === 'z') return e.shiftKey ? 'redo' : 'undo';
  if (key === 'y' && !e.shiftKey) return 'redo';
  if (key === 'd' && !e.shiftKey) return 'duplicate';
  return null;
}

/** Inputs, textareas, selects and contenteditable elements keep their keys. */
export function isTextEntryTarget(target: unknown): boolean {
  if (typeof target !== 'object' || target === null) return false;
  const el = target as { tagName?: unknown; isContentEditable?: unknown };
  if (el.isContentEditable === true) return true;
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}
