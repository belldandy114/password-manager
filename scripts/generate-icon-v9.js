/**
 * Generate icons — Graphite Instrument V9（青瓷钥匙孔）
 * 石墨圆角方底 + 青瓷钥匙孔，3x3 超采样抗锯齿。
 * Usage: node scripts/generate-icon-v9.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// ---- 距离场工具 ----
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (edge0, edge1, x) => { const t = clamp((x - edge0) / (edge1 - edge0), 0, 1); return t * t * (3 - 2 * t); };
/** 圆角方框 SDF（p 归一化坐标，half 半宽，radius 圆角） */
function sdRoundBox(px, py, half, radius) {
  const qx = Math.abs(px) - half + radius;
  const qy = Math.abs(py) - half + radius;
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - radius;
}
function mix(a, b, t) { return a + (b - a) * t; }

// ---- V9 像素着色（返回 RGBA 0-255）----
function pixelColor(nx, ny) {
  // 圆角方底
  const boxD = sdRoundBox(nx, ny, 0.86, 0.30);
  if (boxD > 0.5 / 128) return [0, 0, 0, 0];

  // 底色：石墨纵向渐变
  const t = clamp((ny + 0.86) / 1.72, 0, 1);
  let r = mix(0x22, 0x10, t);
  let g = mix(0x28, 0x14, t);
  let b = mix(0x2c, 0x16, t);

  // 内侧 1px 高光描边
  const edge = smooth(-0.02, 0.02, Math.abs(boxD) - 0.035);
  r = mix(0x45, r, edge); g = mix(0x4e, g, edge); b = mix(0x55, b, edge);

  // 钥匙孔（圆 + 梯形柄），青瓷渐变
  const circle = Math.hypot(nx, ny + 0.14) - 0.16;
  const stemTop = ny + 0.06;
  const halfW = 0.085 + (stemTop > 0 ? stemTop * 0.30 : 0);
  const inStem = stemTop > 0 && stemTop < 0.52 && Math.abs(nx) < halfW;
  let d;
  if (inStem) {
    d = Math.min(Math.abs(nx) - halfW, 0.52 - stemTop); // 柄内部为负
  } else {
    d = circle;
  }
  const keyAA = smooth(0.02, -0.02, d);
  if (keyAA > 0) {
    const kt = clamp((ny + 0.4) / 0.9, 0, 1);
    const kr = mix(0x63, 0x35, kt), kg = mix(0xb4, 0x86, kt), kb = mix(0xaf, 0x82, kt);
    r = mix(r, kr, keyAA); g = mix(g, kg, keyAA); b = mix(b, kb, keyAA);
  }

  return [Math.round(r), Math.round(g), Math.round(b), 255];
}

function sampleColor(x, y, W) {
  // 3x3 超采样
  let r = 0, g = 0, b = 0, a = 0;
  const step = 1 / W;
  for (let sy = -1; sy <= 1; sy++) {
    for (let sx = -1; sx <= 1; sx++) {
      const [pr, pg, pb, pa] = pixelColor((x + sx * step * 0.33) / W * 2 - 1, (y + sy * step * 0.33) / W * 2 - 1);
      r += pr * pa; g += pg * pa; b += pb * pa; a += pa;
    }
  }
  if (a === 0) return [0, 0, 0, 0];
  return [Math.round(r / a), Math.round(g / a), Math.round(b / a), Math.round(a / 9)];
}

// ---- PNG 编码 ----
function crc32(b) {
  let c = 0xffffffff; const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) { let cr = i; for (let j = 0; j < 8; j++) cr = (cr & 1) ? (0xedb88320 ^ (cr >>> 1)) : (cr >>> 1); t[i] = cr; }
  for (let i = 0; i < b.length; i++) c = t[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function mkChunk(t, d) {
  const len = Buffer.alloc(4); len.writeUInt32BE(d.length);
  const tb = Buffer.from(t, 'ascii'); const cd = Buffer.concat([tb, d]);
  const cr = Buffer.alloc(4); cr.writeUInt32BE(crc32(cd));
  return Buffer.concat([len, tb, d, cr]);
}
function createPNG(W) {
  const raw = Buffer.alloc(W * W * 4 + W); let off = 0;
  for (let y = 0; y < W; y++) {
    raw[off++] = 0;
    for (let x = 0; x < W; x++) {
      const [r, g, b, a] = sampleColor(x + 0.5, y + 0.5, W);
      raw[off++] = r; raw[off++] = g; raw[off++] = b; raw[off++] = a;
    }
  }
  const sig = Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W,0); ihdr.writeUInt32BE(W,4);
  ihdr[8]=8;ihdr[9]=6;ihdr[10]=0;ihdr[11]=0;ihdr[12]=0;
  return Buffer.concat([sig, mkChunk('IHDR',ihdr), mkChunk('IDAT',zlib.deflateSync(raw)), mkChunk('IEND',Buffer.alloc(0))]);
}

// ---- Main ----
async function main() {
  console.log('Generating icons (Graphite V9)...');

  const pngPath = path.join(ROOT, '图标.png');
  const pngData = createPNG(256);
  fs.writeFileSync(pngPath, pngData);
  console.log(`PNG: ${pngPath} (${pngData.length} bytes)`);

  const { default: pngToIco } = await import('png-to-ico');
  const icoData = await pngToIco(pngPath);

  const icoPath = path.join(ROOT, '图标.ico');
  if (fs.existsSync(icoPath)) {
    const bak = icoPath + '.v8.bak';
    if (!fs.existsSync(bak)) {
      fs.copyFileSync(icoPath, bak);
      console.log(`Backup: ${path.basename(bak)}`);
    }
  }
  fs.writeFileSync(icoPath, icoData);
  console.log(`ICO: ${icoPath} (${icoData.length} bytes)`);

  console.log('\nDone!');
}

main().catch(e => { console.error(e); process.exit(1); });
