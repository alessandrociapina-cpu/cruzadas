/*
 * Gera a imagem de teste de uma cruzada clássica (casas pretas e numeração),
 * para exercitar no aplicativo o formato que a foto do jornal não cobre.
 *
 *   node test/visual/gerar-fixture.mjs test/fixtures/cruzada-classica.png
 */
import fs from 'node:fs';
import { chromium } from 'playwright';
import { renderPuzzle } from '../synth.mjs';

const destino = process.argv[2] ?? 'test/fixtures/cruzada-classica.png';
const PADRAO = [
  '..#....#..',
  '..#....#..',
  '..........',
  '###..##...',
  '....#.....',
  '.....#....',
  '...##..###',
  '..........',
  '..#....#..',
  '..#....#..',
];

const { gray, width, height } = renderPuzzle(PADRAO, { cell: 46, line: 3, margin: 30 });

const browser = await chromium.launch();
const page = await browser.newPage();
const png = await page.evaluate(
  ({ dados, width, height }) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(width, height);
    for (let i = 0; i < dados.length; i++) {
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = dados[i];
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return canvas.toDataURL('image/png');
  },
  { dados: Array.from(gray), width, height }
);
fs.writeFileSync(destino, Buffer.from(png.split(',')[1], 'base64'));
await browser.close();
console.log('gerado', destino, `${width}×${height}`);
