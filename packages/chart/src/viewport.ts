/**
 * Horizontal viewport: slot <-> x in CSS px. A slot's center sits at slotToX(slot).
 * The latest slot is anchored `rightOffset` slots from the plot's right edge (Stage 1 has no
 * panning, so this anchor is the whole viewport state).
 */

export interface Viewport {
  readonly plotLeft: number;
  readonly plotWidth: number;
  /** CSS px per slot. */
  readonly barSpacing: number;
  /** Slot whose center is `rightOffset` slots left of the right edge. */
  readonly anchorSlot: number;
  readonly rightOffset: number;
  slotToX(slot: number): number;
  xToSlot(x: number): number;
  /** Integer slots whose center lies inside the plot, inclusive. Empty when from > to. */
  visibleSlots(): { from: number; to: number };
}

export function createViewport(args: {
  plotLeft: number;
  plotWidth: number;
  barSpacing: number;
  anchorSlot: number;
  rightOffset: number;
}): Viewport {
  const { plotLeft, plotWidth, barSpacing, anchorSlot, rightOffset } = args;
  if (!(barSpacing > 0)) throw new Error('barSpacing must be positive');
  const rightX = plotLeft + plotWidth;
  // Center of anchorSlot: rightOffset slots plus half a slot inside the right edge.
  const anchorX = rightX - (rightOffset + 0.5) * barSpacing;
  const slotToX = (slot: number): number => anchorX - (anchorSlot - slot) * barSpacing;
  const xToSlot = (x: number): number => anchorSlot - (anchorX - x) / barSpacing;
  return {
    plotLeft,
    plotWidth,
    barSpacing,
    anchorSlot,
    rightOffset,
    slotToX,
    xToSlot,
    visibleSlots: () => ({
      from: Math.ceil(xToSlot(plotLeft) - 1e-9),
      to: Math.floor(xToSlot(rightX) + 1e-9),
    }),
  };
}
