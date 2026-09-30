/**
 * Repository secret scan: every tracked and untracked-but-not-ignored file. Fails on credential-
 * shaped strings, private keys, assigned Alpaca credential variables, or any local credential
 * VALUE from apps/worker/.dev.vars. Prints file:line and the rule name, never the matched text.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { localCredentialValues } from './local-credentials.mjs';

const root = join(import.meta.dirname, '..');
const listed = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], {
  cwd: root,
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean)
  .filter((f) => existsSync(join(root, f)));
const credentials = localCredentialValues(root);
const rules = [
  { name: 'Alpaca-style key id (PK/AK + 16+ chars)', pattern: /\b(PK|AK)[A-Z0-9]{16,}\b/ },
  { name: 'private key block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY/ },
  {
    name: 'assigned Alpaca credential variable',
    pattern: /ALPACA_API_(KEY_ID|SECRET_KEY)\s*[=:]\s*['"]?[A-Za-z0-9/+]{8,}/,
  },
  {
    name: 'credential header with a literal value',
    pattern: /APCA-API-(KEY-ID|SECRET-KEY)['"]?\s*[:=]\s*['"][A-Za-z0-9/+]{8,}['"]/i,
  },
  {
    name: 'generic secret assignment',
    pattern: /\b(secret|password|api[_-]?key)\s*[:=]\s*['"][A-Za-z0-9/+_-]{16,}['"]/i,
  },
];
const binary = /\.(png|jpg|jpeg|gif|ico|woff2?|ttf)$/i;
let findings = 0;
for (const file of listed) {
  if (binary.test(file)) continue;
  const lines = readFileSync(join(root, file), 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const rule of rules) {
      if (rule.pattern.test(line)) {
        console.log(`FOUND ${rule.name}: ${file}:${i + 1}`);
        findings++;
      }
    }
    for (const value of credentials) {
      if (line.includes(value)) {
        console.log(`FOUND a local credential value: ${file}:${i + 1}`);
        findings++;
      }
    }
  });
}
console.log(
  `secret scan: ${listed.length} files (tracked + untracked, not ignored), ${rules.length} patterns, ` +
    `${credentials.length} local credential value(s) compared -> ${findings} finding(s)`,
);
process.exit(findings === 0 ? 0 : 1);
