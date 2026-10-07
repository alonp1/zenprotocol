// Builds the static wallet into dist/: one bundled app.js plus index.html and style.css.
import { build } from 'esbuild';
import { mkdirSync, copyFileSync, rmSync } from 'node:fs';
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist');
await build({ entryPoints: ['web/app.js'], bundle: true, minify: true, format: 'esm', target: 'es2022', outfile: 'dist/app.js', legalComments: 'eof' });
for (const f of ['index.html', 'style.css']) copyFileSync(`web/${f}`, `dist/${f}`);
console.log('dist/ ready');
