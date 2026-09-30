/**
 * Loads credential VALUES from apps/worker/.dev.vars (if present) so scans can prove those exact
 * values appear nowhere. Values are only compared, never printed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function localCredentialValues(root) {
  const path = join(root, 'apps', 'worker', '.dev.vars');
  if (!existsSync(path)) return [];
  const values = [];
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(ALPACA_API_KEY_ID|ALPACA_API_SECRET_KEY|MASSIVE_API_KEY)\s*=\s*(.*?)\s*$/.exec(
      line,
    );
    const value = m?.[2]?.replace(/^(['"])(.*)\1$/, '$2');
    if (value && value.length >= 8) values.push(value);
  }
  return values;
}
