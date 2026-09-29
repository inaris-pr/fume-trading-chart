import { describe, expect, test } from 'vitest';
import { resolveWeeklySessions, selectWindows } from '../src/sessions.ts';
import { EQUITY_SPEC, FUTURES_SPEC, TEST_ID } from './helpers.ts';

describe('resolveWeeklySessions: equity weekly schedule', () => {
  const sessions = resolveWeeklySessions({
    instrumentId: TEST_ID,
    spec: EQUITY_SPEC,
    from: '2026-03-02',
    to: '2026-03-13',
  });

  test('one session per weekday, none on the weekend', () => {
    expect(sessions.map((s) => s.sessionDate)).toEqual([
      '2026-03-02',
      '2026-03-03',
      '2026-03-04',
      '2026-03-05',
      '2026-03-06',
      '2026-03-09',
      '2026-03-10',
      '2026-03-11',
      '2026-03-12',
      '2026-03-13',
    ]);
  });

  test('windows are classified pre / regular / post and ordered', () => {
    const kinds = sessions[0]!.windows.map((w) => w.kind);
    expect(kinds).toEqual(['pre', 'regular', 'post']);
  });

  test('regular window follows the DST change (UTC-5 then UTC-4)', () => {
    const fri = selectWindows(sessions[4]!, 'regular')[0]!;
    const mon = selectWindows(sessions[5]!, 'regular')[0]!;
    expect(fri.start).toBe(Date.UTC(2026, 2, 6, 14, 30));
    expect(fri.end).toBe(Date.UTC(2026, 2, 6, 21, 0));
    expect(mon.start).toBe(Date.UTC(2026, 2, 9, 13, 30));
    expect(mon.end).toBe(Date.UTC(2026, 2, 9, 20, 0));
  });

  test('selectWindows(regular) keeps only regular windows', () => {
    expect(selectWindows(sessions[0]!, 'regular')).toHaveLength(1);
    expect(selectWindows(sessions[0]!, 'extended')).toHaveLength(3);
  });
});

describe('resolveWeeklySessions: futures-style session crossing midnight with a break', () => {
  const sessions = resolveWeeklySessions({
    instrumentId: TEST_ID,
    spec: FUTURES_SPEC,
    from: '2026-03-02',
    to: '2026-03-06',
  });

  test('Sunday evening trading belongs to Monday; five sessions Mon-Fri', () => {
    expect(sessions.map((s) => s.sessionDate)).toEqual([
      '2026-03-02',
      '2026-03-03',
      '2026-03-04',
      '2026-03-05',
      '2026-03-06',
    ]);
  });

  test('Monday session = Sunday 17:00 CT -> Monday 08:00, break, 08:30 -> 16:00', () => {
    const [overnight, day] = sessions[0]!.windows;
    // CST is UTC-6 before the 2026-03-08 DST change.
    expect(overnight!.start).toBe(Date.UTC(2026, 2, 1, 23, 0));
    expect(overnight!.end).toBe(Date.UTC(2026, 2, 2, 14, 0));
    expect(day!.start).toBe(Date.UTC(2026, 2, 2, 14, 30));
    expect(day!.end).toBe(Date.UTC(2026, 2, 2, 22, 0));
    expect(sessions[0]!.windows.every((w) => w.kind === 'regular')).toBe(true);
  });
});
