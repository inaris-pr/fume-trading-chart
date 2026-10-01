/** Pure units: the drawing keyboard map, text-entry detection, the history stack, patches. */
import { describe, expect, test } from 'vitest';
import { DrawingHistory, inverseChange } from '../src/drawings/history.ts';
import { drawingCommandForKey, isTextEntryTarget } from '../src/drawings/keyboard.ts';
import { applyDrawingPatch, type Drawing } from '../src/drawings/model.ts';

describe('keyboard map', () => {
  test.each([
    [{ key: 'Escape' }, 'cancel'],
    [{ key: 'Delete' }, 'delete'],
    [{ key: 'Backspace' }, 'delete'],
    [{ key: 'z', ctrlKey: true }, 'undo'],
    [{ key: 'Z', ctrlKey: true, shiftKey: true }, 'redo'],
    [{ key: 'y', ctrlKey: true }, 'redo'],
    [{ key: 'z', metaKey: true }, 'undo'],
    [{ key: 'z', metaKey: true, shiftKey: true }, 'redo'],
    [{ key: 'd', ctrlKey: true }, 'duplicate'],
    [{ key: 'D', metaKey: true }, 'duplicate'],
  ])('%o -> %s', (e, cmd) => {
    expect(drawingCommandForKey(e)).toBe(cmd);
  });

  test.each([
    { key: 'z' }, // plain typing
    { key: 'Delete', shiftKey: true },
    { key: 'z', ctrlKey: true, altKey: true },
    { key: 'y', ctrlKey: true, shiftKey: true },
    { key: 'd', ctrlKey: true, shiftKey: true },
    { key: 'c', ctrlKey: true },
    { key: 'Delete', target: { tagName: 'input' } },
    { key: 'z', ctrlKey: true, target: { tagName: 'TEXTAREA' } },
    { key: 'Backspace', target: { tagName: 'SELECT' } },
    { key: 'Delete', target: { tagName: 'DIV', isContentEditable: true } },
  ])('%o -> no command', (e) => {
    expect(drawingCommandForKey(e)).toBeNull();
  });

  test('text-entry targets', () => {
    expect(isTextEntryTarget(null)).toBe(false);
    expect(isTextEntryTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(isTextEntryTarget({ tagName: 'CANVAS' })).toBe(false);
    expect(isTextEntryTarget({ tagName: 'INPUT' })).toBe(true);
  });
});

describe('history stack', () => {
  const set = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `x${i}` }) as Drawing);
  const entry = (n: number) => ({
    before: set(n),
    after: set(n + 1),
    selectedBefore: null,
    selectedAfter: `x${n}`,
    change: { kind: 'add' as const, id: `x${n}` },
  });

  test('undo/redo move entries between stacks; a push clears redo; the limit drops the oldest', () => {
    const h = new DrawingHistory(3);
    expect(h.state()).toEqual({ canUndo: false, canRedo: false });
    [0, 1, 2, 3].forEach((n) => h.push(entry(n)));
    expect(h.undo()?.change.id).toBe('x3');
    expect(h.state()).toEqual({ canUndo: true, canRedo: true });
    expect(h.redo()?.change.id).toBe('x3');
    h.undo();
    h.push(entry(9));
    expect(h.state().canRedo).toBe(false);
    expect([h.undo(), h.undo(), h.undo(), h.undo()].map((e) => e?.change.id)).toEqual([
      'x9',
      'x2',
      'x1',
      undefined, // x0 was dropped by the limit of 3
    ]);
  });

  test('inverse changes', () => {
    expect(inverseChange({ kind: 'add', id: 'a' })).toEqual({ kind: 'remove', id: 'a' });
    expect(inverseChange({ kind: 'remove', id: 'a' })).toEqual({ kind: 'add', id: 'a' });
    expect(inverseChange({ kind: 'update', id: 'a' })).toEqual({ kind: 'update', id: 'a' });
  });
});

describe('applyDrawingPatch', () => {
  const d: Drawing = {
    id: 'r',
    type: 'rectangle',
    anchors: [
      { time: 1, price: 1 },
      { time: 2, price: 2 },
    ],
    style: { color: '#fff', lineWidth: 1, lineStyle: 'solid', fillColor: 'rgba(0,0,0,0.1)' },
    visible: true,
    locked: false,
  };

  test('applies style/visible/locked, keeps anchors, returns the same object for no-ops', () => {
    const next = applyDrawingPatch(d, { style: { lineStyle: 'dotted' }, locked: true })!;
    expect(next.style.lineStyle).toBe('dotted');
    expect(next.locked).toBe(true);
    expect(next.anchors).toBe(d.anchors);
    expect(applyDrawingPatch(d, { style: { color: '#fff' }, visible: true })).toBe(d);
    expect(applyDrawingPatch(d, { style: { fillColor: null } })!.style).not.toHaveProperty(
      'fillColor',
    );
  });

  test('invalid values are refused', () => {
    expect(applyDrawingPatch(d, { style: { lineWidth: -1 } })).toBeNull();
    expect(applyDrawingPatch(d, { style: { lineWidth: Number.NaN } })).toBeNull();
    expect(applyDrawingPatch(d, { style: { lineStyle: 'wavy' as never } })).toBeNull();
    expect(applyDrawingPatch(d, { style: { fillColor: ' ' } })).toBeNull();
  });
});
