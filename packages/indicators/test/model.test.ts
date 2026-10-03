/** Indicator instance schema v1: normalization, validation, patches, stable serialization. */
import { describe, expect, test } from 'vitest';
import {
  applyIndicatorPatch,
  BUILTIN_INDICATORS,
  builtinIndicators,
  createIndicator,
  IndicatorRegistry,
  IndicatorSchemaError,
  normalizeIndicator,
  parseIndicatorDocument,
  serializeIndicators,
  SMA,
} from '../src/index.ts';

describe('instances', () => {
  test('createIndicator fills every param and style field in definition order', () => {
    expect(createIndicator('sma', 'a')).toEqual({
      id: 'a',
      type: 'sma',
      params: { period: 20 },
      style: { color: '#f5a623', lineWidth: 1.5 },
      visible: true,
    });
    expect(createIndicator('rsi', 'r', { params: { period: 9 }, visible: false })).toMatchObject({
      params: { period: 9 },
      visible: false,
    });
    expect(createIndicator('volume', 'v').params).toEqual({});
  });

  test.each([
    [{ id: '', type: 'sma' }, /id/],
    [{ id: 'x', type: 'macd' }, /unknown indicator type/],
    [{ id: 'x', type: 'sma', params: { period: 0 } }, /period/],
    [{ id: 'x', type: 'sma', params: { period: 2.5 } }, /period/],
    [{ id: 'x', type: 'sma', params: { period: 1001 } }, /period/],
    [{ id: 'x', type: 'sma', params: { period: '20' } }, /period/],
    [{ id: 'x', type: 'sma', params: { length: 20 } }, /unknown parameter/],
    [{ id: 'x', type: 'sma', style: { color: '' } }, /color/],
    [{ id: 'x', type: 'sma', style: { lineWidth: 9 } }, /width/],
    [{ id: 'x', type: 'sma', style: { glow: 1 } }, /unknown style/],
    [{ id: 'x', type: 'sma', visible: 'yes' }, /visible/],
  ])('rejects %o', (raw, message) => {
    expect(() => normalizeIndicator(raw)).toThrow(IndicatorSchemaError);
    expect(() => normalizeIndicator(raw)).toThrow(message);
  });

  test('patches: validated, same object for no-ops, null for invalid values', () => {
    const a = createIndicator('ema', 'e');
    const b = applyIndicatorPatch(a, { params: { period: 50 }, style: { color: '#fff' } })!;
    expect(b).toMatchObject({ id: 'e', params: { period: 50 }, style: { color: '#fff' } });
    expect(applyIndicatorPatch(a, { params: { period: 20 }, visible: true })).toBe(a);
    expect(applyIndicatorPatch(a, { visible: false })!.visible).toBe(false);
    expect(applyIndicatorPatch(a, { params: { period: -1 } })).toBeNull();
    expect(applyIndicatorPatch(a, { params: { nope: 1 } })).toBeNull();
  });
});

describe('document schema v1', () => {
  const list = [
    createIndicator('sma', 'sma-1'),
    createIndicator('rsi', 'rsi-1', { params: { period: 9 }, visible: false }),
  ];

  test('the persisted JSON of schema version 1 is exactly this', () => {
    expect(JSON.stringify(serializeIndicators(list))).toBe(
      '{"format":"fume.indicators","version":1,"indicators":[' +
        '{"id":"sma-1","type":"sma","params":{"period":20},"style":{"color":"#f5a623","lineWidth":1.5},"visible":true},' +
        '{"id":"rsi-1","type":"rsi","params":{"period":9},"style":{"color":"#b36bff","lineWidth":1.5},"visible":false}]}',
    );
  });

  test('round-trips; computed values and runtime fields are never part of it', () => {
    const json = JSON.stringify(serializeIndicators(list));
    expect(parseIndicatorDocument(JSON.parse(json))).toEqual(list);
    expect(json).not.toMatch(/"values"|"index"|"x"|"y"|"slot"/);
  });

  test('rejects other formats, versions, duplicates and invalid instances', () => {
    const doc = serializeIndicators(list);
    expect(() => parseIndicatorDocument({ ...doc, format: 'other' })).toThrow(IndicatorSchemaError);
    expect(() => parseIndicatorDocument({ ...doc, version: 2 })).toThrow(/version 2/);
    expect(() => parseIndicatorDocument({ ...doc, indicators: [list[0], list[0]] })).toThrow(
      /Duplicate/,
    );
    expect(() =>
      parseIndicatorDocument({ ...doc, indicators: [{ ...list[0], visible: undefined }] }),
    ).toThrow(/visible/);
    expect(() =>
      parseIndicatorDocument({ ...doc, indicators: [{ ...list[0], params: { period: 0 } }] }),
    ).toThrow(/period/);
  });
});

describe('registry', () => {
  test('built-ins in display order; definitions are validated', () => {
    expect(BUILTIN_INDICATORS.map((d) => d.type)).toEqual(['sma', 'ema', 'volume', 'rsi']);
    expect(builtinIndicators.get('rsi')?.scale).toEqual({ kind: 'fixed', min: 0, max: 100 });
    expect(builtinIndicators.get('rsi')?.guides).toEqual([30, 70]);
    expect(() => new IndicatorRegistry([SMA, SMA])).toThrow(/Duplicate/);
    expect(
      () =>
        new IndicatorRegistry([{ ...SMA, type: 'x', scale: { kind: 'fixed', min: 0, max: 1 } }]),
    ).toThrow(/price scale/);
  });
});
