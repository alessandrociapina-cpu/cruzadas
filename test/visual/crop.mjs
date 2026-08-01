/*
 * Recorta um pedaço de uma imagem (frações 0..1) para inspeção visual.
 *   node test/visual/crop.mjs <imagem> <saída.png> <x> <y> <w> <h> [escala]
 */
import fs from 'node:fs';
import { chromium } from 'playwright';
import { serve } from './detect-photo.mjs';

const [img, out, x, y, w, h, scale] = process.argv.slice(2);
const { server, port } = await serve();
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${port}/test/visual/harness.html`);
const png = await page.evaluate(
  async ({ url, box, scale }) => {
    const bitmap = await createImageBitmap(await (await fetch(url)).blob());
    const sx = box[0] * bitmap.width;
    const sy = box[1] * bitmap.height;
    const sw = box[2] * bitmap.width;
    const sh = box[3] * bitmap.height;
    const c = document.createElement('canvas');
    c.width = sw * scale;
    c.height = sh * scale;
    c.getContext('2d').drawImage(bitmap, sx, sy, sw, sh, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  },
  { url: '/' + img, box: [+x, +y, +w, +h], scale: +(scale ?? 1) }
);
fs.writeFileSync(out, Buffer.from(png.split(',')[1], 'base64'));
await browser.close();
server.close();
console.log('recorte salvo em', out);
