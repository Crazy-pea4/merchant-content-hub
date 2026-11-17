import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '--project', 'tsconfig.api.json'], { stdio: 'inherit' });
mkdirSync('dist/api', { recursive: true });
writeFileSync('dist/api/package.json', '{"type":"commonjs"}\n');
