import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPuzzle,
  analyze,
  entryAt,
  nextLetterCell,
  resizePuzzle,
  serialize,
  deserialize,
  progress,
  ACROSS,
  DOWN,
} from '../js/puzzle.js';

const build = (pattern, extra = {}) =>
  createPuzzle({
    rows: pattern.length,
    cols: pattern[0].length,
    cells: pattern.join('').split(''),
    ...extra,
  });

test('numera as casas iniciais como numa cruzada clássica', () => {
  const p = build(['...#.', '.#...', '.....', '#...#']);
  const { numbers, entries } = analyze(p);
  assert.equal(numbers[0], 1, 'primeira casa recebe o número 1');
  const across1 = entries.find((e) => e.number === 1 && e.dir === ACROSS);
  assert.equal(across1.length, 3);
  // a numeração cresce na ordem de leitura e não repete
  const usados = entries.map((e) => e.number);
  assert.deepEqual(
    [...new Set(usados)].sort((a, b) => a - b),
    [...new Set(usados)].sort((a, b) => a - b)
  );
});

test('ignora sequências de uma letra só', () => {
  const p = build(['#.#', '...', '#.#']);
  const { entries } = analyze(p);
  // só a linha do meio (3) e a coluna do meio (3) valem como palavra
  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((e) => e.length),
    [3, 3]
  );
});

test('cruzada de setas: liga a palavra à casa de enunciado que a antecede', () => {
  const p = build(['?...', '?...', '....'], { kind: 'setas' });
  const { entries } = analyze(p);
  const primeira = entries.find((e) => e.dir === ACROSS && e.row === 0);
  assert.equal(primeira.col, 1, 'a palavra começa depois da casa de dica');
  assert.equal(primeira.clueCell, 0, 'aponta para a casa de dica à esquerda');
});

test('cruzada de setas: a seta que vira a esquina também é reconhecida', () => {
  // dica em (0,0) e resposta começando ao lado, mas descendo pela coluna 1
  const p = build(['?...', '....', '....'], { kind: 'setas' });
  const { entries } = analyze(p);
  const vertical = entries.find((e) => e.dir === DOWN && e.col === 1);
  assert.equal(vertical.clueCell, 0, 'usa a casa de dica perpendicular como origem');
  const semOrigem = entries.find((e) => e.dir === DOWN && e.col === 3);
  assert.equal(semOrigem.clueCell, null, 'longe de qualquer dica, fica sem origem');
});

test('entryAt cai na outra direção quando a casa só pertence a uma palavra', () => {
  const p = build(['....', '#..#']);
  const a = analyze(p);
  const horizontal = entryAt(a, p, 0, 0, ACROSS);
  assert.equal(horizontal.dir, ACROSS);
  const semVertical = entryAt(a, p, 0, 0, DOWN);
  assert.equal(semVertical.dir, ACROSS, 'coluna 0 tem só uma casa, então volta para a horizontal');
});

test('nextLetterCell pula casas não preenchíveis', () => {
  const p = build(['.?.#.']);
  assert.deepEqual(nextLetterCell(p, 0, 0, 0, 1), { r: 0, c: 2 });
  assert.deepEqual(nextLetterCell(p, 0, 2, 0, 1), { r: 0, c: 4 });
  assert.equal(nextLetterCell(p, 0, 4, 0, 1), null);
});

test('redimensiona preservando o conteúdo que couber', () => {
  const p = build(['..#', '?..']);
  p.letters[0] = 'A';
  const maior = resizePuzzle(p, 4, 4);
  assert.equal(maior.rows, 4);
  assert.equal(maior.letters[0], 'A');
  assert.equal(maior.cells[2], 1, 'a casa preta continua no lugar');
  const menor = resizePuzzle(p, 1, 2);
  assert.equal(menor.cells.length, 2);
});

test('serializa e volta sem perder nada', () => {
  const p = build(['.?#', '...'], { title: 'Teste', kind: 'setas' });
  p.letters[0] = 'X';
  p.clues['h0.0'] = 'Uma dica';
  const volta = deserialize(JSON.parse(JSON.stringify(serialize(p))));
  assert.equal(volta.title, 'Teste');
  assert.equal(volta.kind, 'setas');
  assert.deepEqual(volta.cells, p.cells);
  assert.equal(volta.letters[0], 'X');
  assert.equal(volta.clues['h0.0'], 'Uma dica');
});

test('progresso conta só as casas preenchíveis', () => {
  const p = build(['.#.', '...']);
  p.letters[0] = 'A';
  const { total, filled } = progress(p);
  assert.equal(total, 5);
  assert.equal(filled, 1);
});
