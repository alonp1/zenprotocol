// Builds the static wallet into dist/: one bundled app.js plus index.html and style.css.
import { build } from 'esbuild';
import { mkdirSync, copyFileSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist');
await build({ entryPoints: ['web/app.js'], bundle: true, minify: true, format: 'esm', target: 'es2022', outfile: 'dist/app.js', legalComments: 'eof' });
copyFileSync('web/style.css', 'dist/style.css');
// the page links its files with a version taken from their content, so a browser that cached an old build fetches the new one
const ver = f => createHash('sha1').update(readFileSync(`dist/${f}`)).digest('hex').slice(0, 8);
writeFileSync('dist/index.html', readFileSync('web/index.html', 'utf8').replace('href="style.css"', `href="style.css?v=${ver('style.css')}"`).replace('src="app.js"', `src="app.js?v=${ver('app.js')}"`));
console.log('dist/ ready');
