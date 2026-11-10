// Builds the bookmarklet and the GitHub Pages install page from opa-optics.user.js.
// Usage: npm install && npm run build
const fs = require('fs');
const path = require('path');
const { minify } = require('terser');

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const write = (f, s) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), s); };
const htmlEscape = (s, quotes) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, quotes ? '&quot;' : '"').replace(/'/g, quotes ? '&#x27;' : "'");

(async () => {
  const source = read('opa-optics.user.js');
  const version = (source.match(/@version\s+(\S+)/) || [])[1];
  if (!version) throw new Error('No @version in opa-optics.user.js');

  const { code } = await minify(source, { compress: true, mangle: true, format: { comments: false } });
  const oneLine = code.trim().replace(/\n/g, ' ');
  const encoded = oneLine.replace(/%/g, '%25').replace(/"/g, '%22').replace(/#/g, '%23')
    .replace(/</g, '%3C').replace(/>/g, '%3E').replace(/ /g, '%20');
  if (decodeURIComponent(encoded) !== oneLine) throw new Error('Bookmarklet encoding check failed');
  new Function(oneLine); // throws if the minified code doesn't parse
  const bookmarklet = 'javascript:' + encoded;
  write('opa-optics-bookmarklet.txt', bookmarklet);

  const page = read('build/install-template.html')
    // Function replacers so "$" sequences in the code are inserted literally.
    .replace('__HREF__', () => htmlEscape(bookmarklet, true))
    .replace('__RAW__', () => htmlEscape(bookmarklet, false))
    .replace('__VERSION__', () => version);
  write('docs/index.html', page);

  console.log(`Built version ${version}: bookmarklet ${bookmarklet.length} characters, docs/index.html updated.`);
})().catch(e => { console.error(e.message); process.exit(1); });
