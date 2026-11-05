/**
 * Generate icons with a minimal, ultra-compatible ICO.
 * Uses png-to-ico for reliability, then verifies with app-builder.
 *
 * Usage: node scripts/generate-icon.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// ---- Shield icon pixel generator ----
function pixelColor(nx, ny) {
  const d = Math.sqrt(nx * nx + ny * ny);
  const rx = Math.abs(nx) - 0.82, ry = Math.abs(ny) - 0.82;
  const rd = Math.sqrt(Math.max(rx, 0) ** 2 + Math.max(ry, 0) ** 2) + Math.min(Math.max(rx, ry), 0);
  if (rd > 0.88) return [0, 0, 0, 0];
  const t = Math.min(d * 0.7, 1);
  const rr = Math.round(0x7c * (1 - t * 0.5) + 0x4a * (t * 0.5));
  const gg = Math.round(0x5c * (1 - t * 0.5) + 0x2a * (t * 0.5));
  const bb = Math.round(0xfc * (1 - t * 0.5) + 0xd0 * (t * 0.5));
  const inTop = ny >= -0.4 && ny <= 0.15 && Math.abs(nx) <= 0.42 * (1 - (ny + 0.4) / 0.55 * 0.3);
  const inBot = ny > 0.15 && ny <= 0.5 && Math.abs(nx) <= 0.42 * (1 - (ny - 0.15) / 0.35 * 0.45);
  const inKeyhole = (nx * nx + (ny + 0.22) * (ny + 0.22)) <= 0.012;
  if ((inTop || inBot) && !inKeyhole) return [255, 255, 255, 235];
  return [rr, gg, bb, 255];
}

// ---- Generate PNG ----
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
      const [r, g, b, a] = pixelColor((x / W) * 2 - 1, (y / W) * 2 - 1);
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
  console.log('Generating icons...');

  // 1. Generate 256x256 PNG
  const pngPath = path.join(ROOT, '图标.png');
  const pngData = createPNG(256);
  fs.writeFileSync(pngPath, pngData);
  console.log(`PNG: ${pngPath} (${pngData.length} bytes)`);

  // 2. Convert to ICO using png-to-ico
  const { default: pngToIco } = await import('png-to-ico');
  const icoData = await pngToIco(pngPath);

  const icoPath = path.join(ROOT, '图标.ico');
  if (fs.existsSync(icoPath)) {
    const bak = icoPath + '.bak';
    if (!fs.existsSync(bak)) {
      fs.copyFileSync(icoPath, bak);
      console.log(`Backup: ${path.basename(bak)}`);
    }
  }
  fs.writeFileSync(icoPath, icoData);
  console.log(`ICO: ${icoPath} (${icoData.length} bytes)`);

  // 3. Verify with app-builder
  const appBuilder = path.join(ROOT, 'node_modules', 'app-builder-bin', 'win', 'x64', 'app-builder.exe');
  if (fs.existsSync(appBuilder)) {
    const outDir = path.join(ROOT, '.icon-verify');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
    try {
      const cmd = `"${appBuilder}" icon --format ico --root "${ROOT}" --out "${outDir}" --input "${icoPath}"`;
      const r = execSync(cmd, { shell: true, timeout: 30000 });
      console.log('app-builder verification:', r.toString().trim());
    } catch (e) {
      console.error('app-builder FAILED:', (e.stderr || e.message).toString().slice(0, 300));
    }
    try { fs.rmSync(outDir, { recursive: true }); } catch(e) {}
  }

  // 4. Quick ICO structure summary
  const v = fs.readFileSync(icoPath);
  console.log(`\nICO structure: ${v.readUInt16LE(4)} entries`);
  for (let i = 0; i < v.readUInt16LE(4); i++) {
    const e = v.slice(6 + i * 16, 6 + i * 16 + 16);
    const w = e[0] || 256, h = e[1] || 256;
    const bpp = e.readUInt16LE(6);
    const bytes = e.readUInt32LE(8);
    const off = e.readUInt32LE(12);
    const isBMP = v.readUInt32LE(off) === 40;
    console.log(`  [${i}] ${w}x${h} ${bpp}bpp ${bytes}bytes BMP=${isBMP}`);
  }

  console.log('\nDone!');
}

main().catch(e => { console.error(e); process.exit(1); });
