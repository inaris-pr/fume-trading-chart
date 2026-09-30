import { describe, expect, test } from 'vitest';
import {
  clampView,
  DEFAULT_VIEW_LIMITS as L,
  isLatestInView,
  panView,
  rightOffsetBounds,
  wheelAction,
  zoomView,
  type ViewContext,
  type ViewState,
} from '../src/view-state.ts';
import { createViewport } from '../src/viewport.ts';

const ctx: ViewContext = { plotWidth: 1000, firstSlot: 0, lastSlot: 9_999 };
const view: ViewState = { barSpacing: 7, rightOffset: 6 };
const vp = (v: ViewState, c: ViewContext = ctx) =>
  createViewport({
    plotLeft: 0,
    plotWidth: c.plotWidth,
    barSpacing: v.barSpacing,
    anchorSlot: c.lastSlot,
    rightOffset: v.rightOffset,
  });

describe('zoomView', () => {
  test('zoom in widens bars; zoom out narrows them', () => {
    expect(zoomView(view, 1.5, 300, ctx, L).barSpacing).toBeCloseTo(10.5, 12);
    expect(zoomView(view, 0.5, 300, ctx, L).barSpacing).toBeCloseTo(3.5, 12);
  });

  test('the slot under the pointer stays under the pointer', () => {
    const anchorX = 300;
    const before = vp(view).xToSlot(anchorX);
    for (const factor of [1.3, 0.7, 2, 0.5]) {
      const next = zoomView(view, factor, anchorX, ctx, L);
      expect(vp(next).xToSlot(anchorX)).toBeCloseTo(before, 9);
    }
  });

  test('repeated zooming in and out returns to the same view (no drift)', () => {
    let v = view;
    for (let i = 0; i < 200; i++) v = zoomView(v, 1.1, 420, ctx, L);
    for (let i = 0; i < 200; i++) v = zoomView(v, 1 / 1.1, 420, ctx, L);
    // Spacing was clamped on the way in, so compare the slot under the anchor, not the spacing.
    expect(Number.isFinite(v.barSpacing) && Number.isFinite(v.rightOffset)).toBe(true);
    expect(v.barSpacing).toBeGreaterThanOrEqual(L.minBarSpacing);
    expect(v.barSpacing).toBeLessThanOrEqual(L.maxBarSpacing);
    let w = view;
    for (let i = 0; i < 20; i++) w = zoomView(w, 1.05, 420, ctx, L);
    for (let i = 0; i < 20; i++) w = zoomView(w, 1 / 1.05, 420, ctx, L);
    expect(w.barSpacing).toBeCloseTo(view.barSpacing, 9);
    expect(w.rightOffset).toBeCloseTo(view.rightOffset, 9);
  });

  test('clamped to min/max spacing at extreme factors', () => {
    let v = view;
    for (let i = 0; i < 50; i++) v = zoomView(v, 2, 500, ctx, L);
    expect(v.barSpacing).toBe(L.maxBarSpacing);
    for (let i = 0; i < 50; i++) v = zoomView(v, 0.5, 500, ctx, L);
    expect(v.barSpacing).toBe(L.minBarSpacing);
  });

  test('pointer on/right of the latest bar keeps the right offset (live edge does not jump)', () => {
    const lastX = vp(view).slotToX(ctx.lastSlot);
    for (const anchorX of [lastX, lastX + 10, 990]) {
      const next = zoomView(view, 1.4, anchorX, ctx, L);
      expect(next.rightOffset).toBe(view.rightOffset);
    }
  });

  test('zoom near the left boundary of the data stays within pan bounds', () => {
    const atStart = clampView({ barSpacing: 7, rightOffset: -1e9 }, ctx, L);
    const next = zoomView(atStart, 0.5, 10, ctx, L);
    const bounds = rightOffsetBounds(next.barSpacing, ctx, L);
    expect(next.rightOffset).toBeGreaterThanOrEqual(bounds.min);
    expect(next.rightOffset).toBeLessThanOrEqual(bounds.max);
  });

  test('invalid factors leave the view unchanged (and valid)', () => {
    for (const f of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(zoomView(view, f, 100, ctx, L)).toEqual(clampView(view, ctx, L));
    }
  });
});

describe('panView / clampView', () => {
  test('drag right (dx > 0) moves content right = back in history (rightOffset decreases)', () => {
    const next = panView(view, 70, ctx, L);
    expect(next.rightOffset).toBeCloseTo(view.rightOffset - 10, 12);
    expect(panView(view, -35, ctx, L).rightOffset).toBeCloseTo(view.rightOffset + 5, 12);
    expect(next.barSpacing).toBe(view.barSpacing);
  });

  test('drag distance maps exactly to slots: a bar under the cursor follows the cursor', () => {
    const x0 = 400;
    const slot = vp(view).xToSlot(x0);
    const next = panView(view, 123, ctx, L);
    expect(vp(next).slotToX(slot)).toBeCloseTo(x0 + 123, 9);
  });

  test('left bound: panning into history stops with the oldest bars still visible', () => {
    const far = panView(view, 1e9, ctx, L);
    const v = vp(far);
    const firstX = v.slotToX(ctx.firstSlot);
    expect(firstX).toBeLessThanOrEqual(ctx.plotWidth - L.minVisibleBars * far.barSpacing + 1e-9);
    expect(v.slotToX(ctx.firstSlot + L.minVisibleBars - 1)).toBeLessThan(ctx.plotWidth);
  });

  test('right bound: overscroll into the future is limited', () => {
    const far = panView(view, -1e9, ctx, L);
    const slotsOnScreen = ctx.plotWidth / far.barSpacing;
    expect(far.rightOffset).toBeCloseTo(slotsOnScreen * L.maxRightOverscroll, 9);
    // The newest bars are still on screen.
    expect(vp(far).slotToX(ctx.lastSlot)).toBeGreaterThan(0);
  });

  test('non-finite input never produces a non-finite view', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const v = panView(view, bad, ctx, L);
      expect(Number.isFinite(v.rightOffset)).toBe(true);
      const c = clampView({ barSpacing: bad, rightOffset: bad }, ctx, L);
      expect(Number.isFinite(c.barSpacing) && Number.isFinite(c.rightOffset)).toBe(true);
    }
  });

  test('tiny series (fewer bars than minVisibleBars) still has a valid range', () => {
    const small: ViewContext = { plotWidth: 800, firstSlot: 10, lastSlot: 12 };
    const { min, max } = rightOffsetBounds(7, small, L);
    expect(min).toBeLessThanOrEqual(max);
    const v = panView(view, 1e6, small, L);
    expect(v.rightOffset).toBeGreaterThanOrEqual(min);
  });

  test('empty series (first = last = 0) does not break', () => {
    const empty: ViewContext = { plotWidth: 800, firstSlot: 0, lastSlot: 0 };
    const v = clampView(view, empty, L);
    expect(Number.isFinite(v.rightOffset)).toBe(true);
  });
});

describe('wheelAction', () => {
  test('vertical wheel zooms: scroll up = zoom in, down = zoom out', () => {
    const up = wheelAction({ deltaX: 0, deltaY: -100, deltaMode: 0, ctrlKey: false }, 800);
    const down = wheelAction({ deltaX: 0, deltaY: 100, deltaMode: 0, ctrlKey: false }, 800);
    if (up?.kind !== 'zoom' || down?.kind !== 'zoom') throw new Error('expected zoom');
    expect(up.factor).toBeGreaterThan(1);
    expect(down.factor).toBeLessThan(1);
  });

  test('many small deltas compose like one large delta (exponential)', () => {
    const one = wheelAction({ deltaX: 0, deltaY: 100, deltaMode: 0, ctrlKey: false }, 800);
    const ten = wheelAction({ deltaX: 0, deltaY: 10, deltaMode: 0, ctrlKey: false }, 800);
    if (one?.kind !== 'zoom' || ten?.kind !== 'zoom') throw new Error('expected zoom');
    expect(ten.factor ** 10).toBeCloseTo(one.factor, 9);
  });

  test('line and page delta modes are normalized to pixels', () => {
    const lines = wheelAction({ deltaX: 0, deltaY: 3, deltaMode: 1, ctrlKey: false }, 800);
    const pixels = wheelAction({ deltaX: 0, deltaY: 48, deltaMode: 0, ctrlKey: false }, 800);
    expect(lines).toEqual(pixels);
  });

  test('one event can never zoom more than 2x either way', () => {
    const huge = wheelAction({ deltaX: 0, deltaY: -1e6, deltaMode: 0, ctrlKey: false }, 800);
    const hugeOut = wheelAction({ deltaX: 0, deltaY: 1e6, deltaMode: 0, ctrlKey: false }, 800);
    expect(huge).toEqual({ kind: 'zoom', factor: 2 });
    expect(hugeOut).toEqual({ kind: 'zoom', factor: 0.5 });
  });

  test('trackpad pinch (ctrlKey) zooms faster per pixel than a wheel', () => {
    const pinch = wheelAction({ deltaX: 0, deltaY: -10, deltaMode: 0, ctrlKey: true }, 800);
    const wheel = wheelAction({ deltaX: 0, deltaY: -10, deltaMode: 0, ctrlKey: false }, 800);
    if (pinch?.kind !== 'zoom' || wheel?.kind !== 'zoom') throw new Error('expected zoom');
    expect(pinch.factor).toBeGreaterThan(wheel.factor);
  });

  test('mostly-horizontal trackpad scroll pans', () => {
    expect(wheelAction({ deltaX: 40, deltaY: 5, deltaMode: 0, ctrlKey: false }, 800)).toEqual({
      kind: 'pan',
      dxPx: -40,
    });
  });

  test('zero or invalid deltas do nothing', () => {
    expect(wheelAction({ deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false }, 800)).toBeNull();
    expect(
      wheelAction({ deltaX: Number.NaN, deltaY: 1, deltaMode: 0, ctrlKey: false }, 800),
    ).toBeNull();
  });
});

describe('isLatestInView (single live-edge definition)', () => {
  test('default view follows; panned back or scrolled off does not', () => {
    expect(isLatestInView({ barSpacing: 7, rightOffset: 6 }, 700)).toBe(true);
    expect(isLatestInView({ barSpacing: 7, rightOffset: -0.5 }, 700)).toBe(true); // edge, tolerant
    expect(isLatestInView({ barSpacing: 7, rightOffset: -0.6 }, 700)).toBe(false);
    expect(isLatestInView({ barSpacing: 7, rightOffset: -40 }, 700)).toBe(false);
    expect(isLatestInView({ barSpacing: 7, rightOffset: 99.4 }, 700)).toBe(true);
    expect(isLatestInView({ barSpacing: 7, rightOffset: 99.6 }, 700)).toBe(false);
  });

  test('degenerate sizes count as following (nothing to return to)', () => {
    expect(isLatestInView({ barSpacing: 7, rightOffset: -100 }, 0)).toBe(true);
  });
});
