#!/usr/bin/env node
/**
 * R14 secret scan: fails if a tracked file contains something that looks like a credential,
 * or if local state/secret files are tracked. Prints file:line and the rule name only --
 * never the matched text -- so the scan itself cannot leak a secret into CI logs.
 *
 *   npm run scan:secrets
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const RULES = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['OpenAI API key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/],
  ['HubSpot private app token', /\bpat-(?:na|eu)\d-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/],
  ['Salesforce access token', /\b00D[A-Za-z0-9]{12,15}![A-Za-z0-9._]{40,}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['connection string with password', /\bpostgres(?:ql)?:\/\/[^:\s/]+:(?!local-development-only@)[^@\s]{8,}@(?!localhost|127\.0\.0\.1)/],
];
const FORBIDDEN_PATHS = [/^data\/(?!\.gitkeep$)/, /(^|\/)\.env$/, /\.encryption-key$/];
// Test fixtures with deliberately fake values.
const ALLOW = new Set(['scripts/scanSecrets.mjs']);

const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const findings = [];
for (const file of files) {
  if (FORBIDDEN_PATHS.some((pattern) => pattern.test(file))) {
    findings.push(`${file}: tracked local state / secret file`);
    continue;
  }
  if (ALLOW.has(file) || /\.(png|jpg|jpeg|gif|ico|woff2?|zip|pdf)$/i.test(file)) continue;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  text.split(/\r?\n/).forEach((line, index) => {
    for (const [name, pattern] of RULES) if (pattern.test(line)) findings.push(`${file}:${index + 1}: ${name}`);
  });
}
if (findings.length) {
  console.error(`Secret scan found ${findings.length} problem(s):\n${findings.join('\n')}`);
  process.exit(1);
}
console.log(`Secret scan: ${files.length} files (tracked and new), no credentials found.`);
