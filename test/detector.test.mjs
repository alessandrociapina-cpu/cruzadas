import test from 'node:test';
import assert from 'node:assert/strict';
import { detectGrid, fitLattice, otsu, rgbaToGray } from '../js/detector.js';
import { renderPuzzle, blocksToPattern, typesToPattern } from './synth.mjs';

// cruzada direta (de setas): '?' são casas com o enunciado impresso dentro
const SETAS = [
  '?..?...?..',
  '..........',
  '?...?.....',
  '..........',
  '...?...?..',
  '..........',
  '?....?....',
  '..........',
];

const CLASSIC = [
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

const OPEN = ['..........', '..........', '..........', '..........', '..........'];

const SMALL = ['.#...', '.....', '..#..', '.....', '...#.'];

function detectPattern(pattern, opts = {}) {
  const img = renderPuzzle(pattern, opts);
  const res = detectGrid(img.gray, img.width, img.height, opts.detect);
  return { res, pattern: blocksToPattern(res.rows, res.cols, res.blocks) };
}

test('lê uma cruzada limpa com casas pretas', () => {
  const { res, pattern } = detectPattern(CLASSIC);
  assert.equal(res.rows, 10);
  assert.equal(res.cols, 10);
  assert.deepEqual(pattern, CLASSIC);
});

test('lê grade totalmente aberta sem inventar casas pretas', () => {
  const { res, pattern } = detectPattern(OPEN, { numbers: false });
  assert.equal(res.rows, 5);
  assert.equal(res.cols, 10);
  assert.deepEqual(pattern, OPEN);
});

test('lê grade pequena', () => {
  const { pattern } = detectPattern(SMALL, { cell: 48 });
  assert.deepEqual(pattern, SMALL);
});

test('tolera ruído e iluminação irregular', () => {
  const { res, pattern } = detectPattern(CLASSIC, { noise: 14, shading: 45, paper: 240 });
  assert.equal(res.rows, 10);
  assert.equal(res.cols, 10);
  assert.deepEqual(pattern, CLASSIC);
});

test('corrige foto inclinada', () => {
  const { res, pattern } = detectPattern(CLASSIC, { rotateDeg: 3.5, cell: 40 });
  assert.equal(res.rows, 10);
  assert.equal(res.cols, 10);
  assert.deepEqual(pattern, CLASSIC);
  assert.ok(Math.abs((res.angle * 180) / Math.PI - 3.5) < 1.2, `ângulo ${res.angle}`);
});

test('funciona com linhas grossas de moldura', () => {
  const { res, pattern } = detectPattern(CLASSIC, { line: 5, cell: 44 });
  assert.equal(res.rows, 10);
  assert.deepEqual(pattern, CLASSIC);
});

test('respeita linhas e colunas forçadas manualmente', () => {
  const img = renderPuzzle(CLASSIC);
  const res = detectGrid(img.gray, img.width, img.height, { forceRows: 10, forceCols: 10 });
  assert.equal(res.rows, 10);
  assert.equal(res.cols, 10);
  assert.deepEqual(blocksToPattern(res.rows, res.cols, res.blocks), CLASSIC);
});

test('bias empurra o limiar de casa preta', () => {
  const img = renderPuzzle(CLASSIC);
  const res = detectGrid(img.gray, img.width, img.height, { bias: -400 });
  assert.equal(
    res.types.filter((t) => t === 1).length,
    0,
    'com bias muito negativo, nenhuma casa deve ser classificada como preta'
  );
});

test('reconhece cruzada de setas: casas com enunciado viram casa de dica', () => {
  const img = renderPuzzle(SETAS, { cell: 60, numbers: false });
  const res = detectGrid(img.gray, img.width, img.height);
  assert.equal(res.rows, 8);
  assert.equal(res.cols, 10);
  assert.equal(res.kind, 'setas');
  assert.deepEqual(typesToPattern(res.rows, res.cols, res.types), SETAS);
});

test('letra já preenchida não é confundida com casa de dica', () => {
  const pattern = ['?.....', '......', '?.....', '......'];
  const img = renderPuzzle(pattern, { cell: 60, numbers: false });
  // desenha um "I" gordo (uma única mancha) numa casa de letra
  for (let y = 25 + 60 + 12; y < 25 + 120 - 12; y++) {
    for (let x = 25 + 60 + 22; x < 25 + 120 - 22; x++) img.gray[y * img.width + x] = 20;
  }
  const res = detectGrid(img.gray, img.width, img.height);
  assert.deepEqual(typesToPattern(res.rows, res.cols, res.types), pattern);
});

test('rejeita imagem sem grade', () => {
  const w = 300;
  const h = 300;
  const gray = new Uint8Array(w * h).fill(252);
  assert.throws(() => detectGrid(gray, w, h), /grade/i);
});

test('fitLattice reconstrói linhas faltantes e ignora ruído', () => {
  const truth = [10, 30, 50, 70, 90, 110];
  const noisy = [10, 30.4, 70, 89.6, 110, 41]; // faltam 50; 41 é ruído
  const fit = fitLattice(noisy);
  assert.ok(fit);
  assert.equal(fit.lines.length, truth.length);
  fit.lines.forEach((v, i) => assert.ok(Math.abs(v - truth[i]) < 1.5, `linha ${i}: ${v}`));
});

test('otsu separa duas populações', () => {
  const vals = [...Array(50).fill(30), ...Array(50).fill(230)];
  const t = otsu(vals);
  assert.ok(t >= 30 && t < 230, `limiar ${t}`);
});

test('rgbaToGray trata transparência como papel', () => {
  const data = new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 255]);
  const g = rgbaToGray(data, 2, 1);
  assert.equal(g[0], 255);
  assert.equal(g[1], 0);
});
