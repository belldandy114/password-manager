const fs = require('fs');
const a = fs.readFileSync('图标.png');
const b = fs.readFileSync('buildResources/icon.png');
console.log('PNGs same?', Buffer.compare(a, b) === 0);
console.log('图标.png     hash:', require('crypto').createHash('md5').update(a).digest('hex'));
console.log('buildRes.png hash:', require('crypto').createHash('md5').update(b).digest('hex'));
