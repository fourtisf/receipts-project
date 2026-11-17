// Generates src/generated/robinhood.ts from the single source of truth config/robinhood.json,
// so every package (web, api, worker) uses exactly the same chain config with literal types.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, '../../../config/robinhood.json');
const out = resolve(here, '../src/generated/robinhood.ts');
const json = JSON.parse(readFileSync(src, 'utf8'));
mkdirSync(dirname(out), { recursive: true });
const body =
  `// AUTO-GENERATED from config/robinhood.json by scripts/gen-config.mjs — do not edit.\n` +
  `export const robinhoodConfig = ${JSON.stringify(json, null, 2)} as const;\n`;
let prev = '';
try {
  prev = readFileSync(out, 'utf8');
} catch {
  /* first run */
}
if (prev !== body) writeFileSync(out, body);
