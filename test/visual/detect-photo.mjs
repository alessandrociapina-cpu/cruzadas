/*
 * Harness de diagnóstico: roda o detector numa foto de verdade dentro do
 * Chromium (que é quem sabe decodificar JPEG) e salva uma imagem com as linhas
 * e os tipos de casa desenhados por cima.
 *
 *   node test/visual/detect-photo.mjs <imagem> <saída.png> [rotacao] [opções-json]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
};

export function serve(root = ROOT) {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    let file = path.join(root, rel === '/' ? '/index.html' : rel);
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory())
      file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) {
      res.writeHead(404).end('não encontrado');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function main() {
  const [imgArg, outArg, rotArg, optArg] = process.argv.slice(2);
  const imageUrl = imgArg ?? 'test/fixtures/cruzada-jornal.jpg';
  const out = outArg ?? 'diagnostico.png';
  const rotation = Number(rotArg ?? 0);
  const options = optArg ? JSON.parse(optArg) : {};

  const { server, port } = await serve();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  page.on('console', (m) => console.log('[navegador]', m.text()));

  await page.goto(`http://127.0.0.1:${port}/test/visual/harness.html`);
  const result = await page.evaluate(
    async ({ imageUrl, rotation, options }) => window.runDetection(imageUrl, rotation, options),
    { imageUrl: '/' + imageUrl, rotation, options }
  );

  fs.writeFileSync(out, Buffer.from(result.png.split(',')[1], 'base64'));
  delete result.png;
  console.log(JSON.stringify(result, null, 2));
  console.log('diagnóstico salvo em', out);

  await browser.close();
  server.close();
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
