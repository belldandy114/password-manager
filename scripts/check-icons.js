const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const icons = [
  '图标.ico',
  '图标.png',
  'buildResources/icon.ico',
  'buildResources/icon.png',
];

for (const f of icons) {
  const p = path.join(ROOT, f);
  try {
    const stat = fs.statSync(p);
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(6);
    fs.readSync(fd, buf, 0, 6, 0);
    fs.closeSync(fd);
    const desc = f.endsWith('.ico') ? 'ICO header' : 'PNG header';
    console.log(f + ': ' + stat.size + ' bytes, ' + desc + '=' + buf.toString('hex'));
  } catch(e) {
    console.log(f + ': NOT FOUND');
  }
}
