// Рисует иконку приложения (SVG → PNG разных размеров → .ico). Запуск: electron electron/make-icon.js
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
<defs>
  <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8a6cff"/><stop offset="1" stop-color="#3fb6ff"/></linearGradient>
  <linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".28"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/></linearGradient>
</defs>
<rect x="8" y="8" width="240" height="240" rx="58" fill="url(#g)"/>
<rect x="8" y="8" width="240" height="240" rx="58" fill="url(#s)"/>
<g stroke="#fff" stroke-width="13" stroke-linecap="round" fill="none">
  <path d="M86 86l26 26M170 86l-26 26M86 170l26-26M170 170l-26-26"/>
</g>
<g fill="#fff">
  <circle cx="128" cy="128" r="30"/>
  <circle cx="74" cy="74" r="20"/><circle cx="182" cy="74" r="20"/>
  <circle cx="74" cy="182" r="20"/><circle cx="182" cy="182" r="20"/>
</g>
</svg>`;

function ico(pngs) { // pngs: [{size, buf}]
  const head = Buffer.alloc(6); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let off = 6 + dir.length;
  pngs.forEach((p, i) => {
    const o = i * 16;
    dir.writeUInt8(p.size >= 256 ? 0 : p.size, o); dir.writeUInt8(p.size >= 256 ? 0 : p.size, o + 1);
    dir.writeUInt8(0, o + 2); dir.writeUInt8(0, o + 3); dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(p.buf.length, o + 8); dir.writeUInt32LE(off, o + 12); off += p.buf.length;
  });
  return Buffer.concat([head, dir, ...pngs.map((p) => p.buf)]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 256, height: 256, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<html><body style="margin:0;background:transparent">${SVG.replace('<svg ', '<svg width="256" height="256" ')}</body></html>`));
  await new Promise((r) => setTimeout(r, 400));
  const img = await w.webContents.capturePage({ x: 0, y: 0, width: 256, height: 256 });
  const base = img.resize({ width: 256, height: 256, quality: 'best' });
  const sizes = [256, 128, 64, 48, 32, 24, 16];
  const pngs = sizes.map((size) => ({ size, buf: (size === 256 ? base : base.resize({ width: size, height: size, quality: 'best' })).toPNG() }));
  fs.writeFileSync(path.join(__dirname, 'icon.ico'), ico(pngs));
  fs.writeFileSync(path.join(__dirname, 'icon.png'), pngs[0].buf);
  console.log('icon ok', pngs.map((p) => p.size + ':' + p.buf.length).join(' '));
  app.quit();
});
