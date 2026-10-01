/**
 * Drawing undo/redo history (framework-free, deterministic). Each entry is one completed user
 * mutation, stored as the immutable drawing sets before and after it plus the selection on either
 * side, so undo/redo are exact restorations rather than re-computed inverse operations.
 *
 * Only completed user mutations enter the history (one entry per finished drag, never per pointer
 * move; nothing for cancelled gestures, view changes, live data or host replacements).
 */
import type { Drawing, DrawingChange } from './model.ts';

export interface DrawingHistoryEntry {
  before: readonly Drawing[];
  after: readonly Drawing[];
  selectedBefore: string | null;
  selectedAfter: string | null;
  /** The forward change (redo reports it; undo reports its inverse). */
  change: Pick<DrawingChange, 'kind' | 'id'>;
}

export interface DrawingHistoryState {
  canUndo: boolean;
  canRedo: boolean;
}

/** Oldest entries are dropped beyond this many undo steps. */
export const DRAWING_HISTORY_LIMIT = 100;

export class DrawingHistory {
  private readonly undoStack: DrawingHistoryEntry[] = [];
  private readonly redoStack: DrawingHistoryEntry[] = [];

  constructor(private readonly limit = DRAWING_HISTORY_LIMIT) {}

  /** Records a new mutation; any redo steps are discarded. */
  push(entry: DrawingHistoryEntry): void {
    this.undoStack.push(entry);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  /** The entry to undo (moved to the redo stack), or undefined. */
  undo(): DrawingHistoryEntry | undefined {
    const entry = this.undoStack.pop();
    if (entry) this.redoStack.push(entry);
    return entry;
  }

  /** The entry to redo (moved back to the undo stack), or undefined. */
  redo(): DrawingHistoryEntry | undefined {
    const entry = this.redoStack.pop();
    if (entry) this.undoStack.push(entry);
    return entry;
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }

  state(): DrawingHistoryState {
    return { canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0 };
  }
}

/** The change an undo of `change` reports (its effect on the drawing set). */
export function inverseChange(
  change: Pick<DrawingChange, 'kind' | 'id'>,
): Pick<DrawingChange, 'kind' | 'id'> {
  const kind = change.kind === 'add' ? 'remove' : change.kind === 'remove' ? 'add' : 'update';
  return { kind, id: change.id };
}
