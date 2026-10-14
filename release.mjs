import { execSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('static/manifest.json', 'utf8'));
execSync('node build.mjs', { stdio: 'inherit' });
mkdirSync('release', { recursive: true });
const out = `release/copy-text-from-image-v${version}.zip`;
execSync(`cd dist && zip -qr ../${out} .`, { stdio: 'inherit' });
console.log(`Release ready: ${out}`);
