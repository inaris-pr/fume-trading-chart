/**
 * Production web bundle scan (Stage 4 security gate). Fails if apps/web/dist contains an Alpaca
 * host, an Alpaca credential header name, a local credential VALUE, or (in JS/HTML) a dev-only
 * __fume handle. Run after `pnpm build`. Prints counts and file names only.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { localCredentialValues } from './local-credentials.mjs';

const root = join(import.meta.dirname, '..');
const dist = join(root, 'apps', 'web', 'dist');
const files = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });

let all;
try {
  all = files(dist);
} catch {
  console.error('apps/web/dist not found: run `pnpm build` first');
  process.exit(2);
}
const credentials = localCredentialValues(root);
const rules = [
  {
    name: 'Access backend configuration or assertion',
    pattern: /FUME_ACCESS_(TEAM_DOMAIN|AUD)|Cf-Access-Jwt-Assertion|cloudflareaccess\.com/i,
    in: /./,
  },
  {
    name: 'Massive backend credential or host',
    pattern: /MASSIVE_API_KEY|(?:api|delayed)\.massive\.com/i,
    in: /./,
  },
  { name: 'Alpaca host', pattern: /alpaca\.markets/i, in: /./ },
  { name: 'Alpaca credential header name', pattern: /APCA-API-(KEY-ID|SECRET-KEY)/i, in: /./ },
  { name: 'Alpaca env variable name', pattern: /ALPACA_API_(KEY_ID|SECRET_KEY)/, in: /./ },
  { name: 'dev-only __fume handle', pattern: /__fume/, in: /\.(js|html)$/ },
];
let findings = 0;
for (const file of all) {
  const text = readFileSync(file, 'utf8');
  const rel = relative(root, file);
  for (const rule of rules) {
    if (rule.in.test(file) && rule.pattern.test(text)) {
      console.log(`FOUND ${rule.name} in ${rel}`);
      findings++;
    }
  }
  for (const value of credentials) {
    if (text.includes(value)) {
      console.log(`FOUND a local credential value in ${rel}`);
      findings++;
    }
  }
}
console.log(
  `web bundle scan: ${all.length} files, ${rules.length} patterns, ` +
    `${credentials.length} local credential value(s) compared -> ${findings} finding(s)`,
);
process.exit(findings === 0 ? 0 : 1);
