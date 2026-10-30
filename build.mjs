// Builds dist/index.html: one self-contained file, script and style inline,
// pinned by sha256 in the Content-Security-Policy. No external resource.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const out = await build({
  entryPoints: ['src/app.js'],
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2020'],
  write: false,
  legalComments: 'none',
});
const script = out.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const style = readFileSync('src/style.css', 'utf8');
const hash = (s) => `sha256-${createHash('sha256').update(s).digest('base64')}`;

const html = readFileSync('index.template.html', 'utf8')
  .replace('__SCRIPT_HASH__', hash(script))
  .replace('__STYLE_HASH__', hash(style))
  .replace('__STYLE__', () => style)
  .replace('__SCRIPT__', () => script);

mkdirSync('dist', { recursive: true });
writeFileSync('dist/index.html', html);
console.log(`dist/index.html ${(html.length / 1024).toFixed(0)} KB, sha256 ${createHash('sha256').update(html).digest('hex')}`);
