#!/usr/bin/env node
'use strict';
// The offline page embeds the same source as Node; never hand-edit its engine.
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const engine = fs.readFileSync(path.join(root, 'arbiter-engine.js'), 'utf8');
const core = engine.slice(engine.indexOf('function ChessCore('), engine.indexOf('\n\nChessCore.call(globalThis);'));
const learning = require('../training.js').toString();
const ui = fs.readFileSync(path.join(root, 'web/training-ui.js'), 'utf8');
const block = '// BEGIN GENERATED ENGINE\n' + core + '\n\n' + learning + '\n\nChessCore();\n// END GENERATED ENGINE';
const uiBlock = '// BEGIN GENERATED TRAINING UI\n' + ui + '\n// END GENERATED TRAINING UI';
let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
html = html.includes('// BEGIN GENERATED ENGINE')
  ? html.replace(/\/\/ BEGIN GENERATED ENGINE[\s\S]*?\/\/ END GENERATED ENGINE/, () => block)
  : html.replace(/function ChessCore\([\s\S]*?\nChessCore\(\);/, () => block);
if (html.includes('// BEGIN GENERATED TRAINING UI')) html = html.replace(/\/\/ BEGIN GENERATED TRAINING UI[\s\S]*?\/\/ END GENERATED TRAINING UI/, () => uiBlock);
else html = html.replace('</body>', '<script>\n' + uiBlock + '\n</script>\n</body>');
const current = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
if (process.argv.includes('--check')) {
  if (html !== current) { console.error('Browser source is stale. Run npm run build.'); process.exitCode = 1; }
} else fs.writeFileSync(path.join(root, 'index.html'), html);
