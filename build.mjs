import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Files are overwritten in place on each build; nothing is deleted.
const TEST = process.argv.includes('--test');
const out = TEST ? 'dist-test' : 'dist';
mkdirSync(out, { recursive: true });

await build({
  entryPoints: {
    background: 'src/background.ts',
    offscreen: 'src/offscreen.ts',
    options: 'src/options.ts',
    popup: 'src/popup.ts',
  },
  outdir: out,
  bundle: true,
  format: 'esm',
  target: 'chrome120',
  minify: true,
  // Injected functions are serialized with Function.toString, so keep them readable and helper-free.
  keepNames: false,
  legalComments: 'none',
  define: { __TEST__: String(TEST) },
  logLevel: 'info',
});

// Static pages, manifest, icons
cpSync('static', out, { recursive: true });
if (TEST) {
  // Test build only: allow scripting without a user gesture so automated tests can drive it.
  const m = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
  m.host_permissions.push('<all_urls>');
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(m, null, 2));
}

// OCR engine: worker, WASM core (LSTM builds only) and English data, all bundled locally.
const t = join(out, 'tesseract');
mkdirSync(join(t, 'core'), { recursive: true });
mkdirSync(join(t, 'lang'), { recursive: true });
cpSync('node_modules/tesseract.js/dist/worker.min.js', join(t, 'worker.min.js'));
for (const f of ['tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js']) {
  cpSync(join('node_modules/tesseract.js-core', f), join(t, 'core', f));
}
cpSync(
  'node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz',
  join(t, 'lang', 'eng.traineddata.gz'),
);

console.log('Built to dist/');
