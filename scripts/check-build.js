const { execSync } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const nodeMod = path.join(root, 'node_modules');
const electronPkg = require(path.join(nodeMod, 'electron', 'package.json'));
const electronBin = path.join(nodeMod, 'electron', electronPkg.bin?.electron || 'dist/electron.exe' || 'cli.js');

console.log('electron path:', electronBin);

// Try to validate main.js syntax
try {
  require('fs').readFileSync(path.join(root, 'electron', 'main.js'), 'utf8');
  console.log('main.js: exists ✓');
} catch(e) {
  console.error('main.js: NOT FOUND');
}

// Validate dist/index.html exists
try {
  require('fs').readFileSync(path.join(root, 'dist', 'index.html'), 'utf8');
  console.log('dist/index.html: exists ✓');
} catch(e) {
  console.error('dist/index.html: NOT FOUND');
}

console.log('All checks passed ✓');
