/*
 * puzzle.js — modelo da cruzada: casas, palavras, numeração e navegação.
 * Sem dependência de DOM (também roda nos testes).
 *
 * Dois formatos convivem no mesmo modelo:
 *   - clássica: casas pretas separam as palavras, que são numeradas e têm as
 *     dicas numa lista fora da grade;
 *   - direta (de setas): o enunciado vem impresso dentro de uma casa da própria
 *     grade e a seta aponta onde a resposta começa.
 */

export const LETTER = 0; // casa para preencher
export const BLOCK = 1; // casa preta
export const CLUE = 2; // casa com enunciado (cruzada de setas)

export const ACROSS = 'h';
export const DOWN = 'v';

const GLYPH = ['.', '#', '?'];
const FROM_GLYPH = { '.': LETTER, '#': BLOCK, '?': CLUE };

export function createPuzzle({
  rows,
  cols,
  cells,
  letters,
  clues,
  title,
  id,
  kind,
  image,
  createdAt,
} = {}) {
  const r = Math.max(1, rows ?? 10);
  const c = Math.max(1, cols ?? 10);
  return {
    id: id ?? `cz-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    title: title?.trim() || 'Cruzada sem nome',
    kind: kind ?? 'classica',
    rows: r,
    cols: c,
    cells: normalizeCells(cells, r * c),
    letters: normalizeLetters(letters, r * c),
    clues: { ...(clues ?? {}) },
    image: image ?? null,
    createdAt: createdAt ?? Date.now(),
    updatedAt: Date.now(),
  };
}

function normalizeCells(cells, size) {
  const out = new Array(size).fill(LETTER);
  if (!cells) return out;
  for (let i = 0; i < Math.min(size, cells.length); i++) {
    const v = cells[i];
    out[i] = typeof v === 'string' ? (FROM_GLYPH[v] ?? LETTER) : v | 0;
  }
  return out;
}

function normalizeLetters(letters, size) {
  const out = new Array(size).fill('');
  if (!letters) return out;
  for (let i = 0; i < Math.min(size, letters.length); i++) {
    const v = letters[i];
    out[i] = !v || v === ' ' ? '' : String(v).toUpperCase();
  }
  return out;
}

export const at = (puzzle, r, c) => puzzle.cells[r * puzzle.cols + c];
export const inside = (puzzle, r, c) => r >= 0 && c >= 0 && r < puzzle.rows && c < puzzle.cols;
export const isLetter = (puzzle, r, c) => inside(puzzle, r, c) && at(puzzle, r, c) === LETTER;
export const isClue = (puzzle, r, c) => inside(puzzle, r, c) && at(puzzle, r, c) === CLUE;

export function entryId(dir, row, col) {
  return `${dir}${row}.${col}`;
}

/**
 * Palavras = sequências máximas de casas preenchíveis com 2 ou mais letras.
 * Também numera as casas iniciais (padrão das cruzadas clássicas) e liga cada
 * palavra à casa de enunciado que a antecede, quando houver (cruzada de setas).
 */
export function analyze(puzzle) {
  const { rows, cols } = puzzle;
  const entries = [];

  const collect = (dir) => {
    const outer = dir === ACROSS ? rows : cols;
    const inner = dir === ACROSS ? cols : rows;
    for (let a = 0; a < outer; a++) {
      let run = [];
      for (let b = 0; b <= inner; b++) {
        const r = dir === ACROSS ? a : b;
        const c = dir === ACROSS ? b : a;
        if (b < inner && isLetter(puzzle, r, c)) {
          run.push(r * cols + c);
          continue;
        }
        if (run.length >= 2) {
          const first = run[0];
          const row = Math.floor(first / cols);
          const col = first % cols;
          // Numa cruzada de setas o enunciado fica na casa anterior à palavra.
          // A seta pode virar a esquina — "começa aqui ao lado, mas descendo" —,
          // então a casa perpendicular também conta como origem possível.
          const alinhada = dir === ACROSS ? [row, col - 1] : [row - 1, col];
          const perpendicular = dir === ACROSS ? [row - 1, col] : [row, col - 1];
          const origens = [alinhada, perpendicular]
            .filter(([r, c]) => isClue(puzzle, r, c))
            .map(([r, c]) => r * cols + c);
          entries.push({
            id: entryId(dir, row, col),
            dir,
            row,
            col,
            cells: run,
            length: run.length,
            clueCells: origens,
            clueCell: origens.length ? origens[0] : null,
          });
        }
        run = [];
      }
    }
  };
  collect(ACROSS);
  collect(DOWN);

  const numbers = new Array(rows * cols).fill(0);
  const starts = new Set(entries.map((e) => e.row * cols + e.col));
  let n = 0;
  for (let i = 0; i < rows * cols; i++) {
    if (starts.has(i)) numbers[i] = ++n;
  }
  for (const e of entries) e.number = numbers[e.row * cols + e.col];

  const byCell = new Map();
  for (const e of entries) {
    for (const cell of e.cells) {
      if (!byCell.has(cell)) byCell.set(cell, {});
      byCell.get(cell)[e.dir] = e;
    }
  }
  entries.sort((a, b) => a.number - b.number || (a.dir === ACROSS ? -1 : 1));
  return { entries, numbers, byCell };
}

/** Palavra que passa pela casa na direção pedida (ou na outra, se só houver ela). */
export function entryAt(analysis, puzzle, r, c, dir) {
  const found = analysis.byCell.get(r * puzzle.cols + c);
  if (!found) return null;
  return found[dir] ?? found[dir === ACROSS ? DOWN : ACROSS] ?? null;
}

/** Próxima casa preenchível a partir de (r,c), andando na direção dada. */
export function nextLetterCell(puzzle, r, c, dr, dc) {
  let rr = r + dr;
  let cc = c + dc;
  while (inside(puzzle, rr, cc)) {
    if (isLetter(puzzle, rr, cc)) return { r: rr, c: cc };
    rr += dr;
    cc += dc;
  }
  return null;
}

/** Redimensiona preservando o que couber. */
export function resizePuzzle(puzzle, rows, cols) {
  const cells = new Array(rows * cols).fill(LETTER);
  const letters = new Array(rows * cols).fill('');
  for (let r = 0; r < Math.min(rows, puzzle.rows); r++) {
    for (let c = 0; c < Math.min(cols, puzzle.cols); c++) {
      cells[r * cols + c] = puzzle.cells[r * puzzle.cols + c];
      letters[r * cols + c] = puzzle.letters[r * puzzle.cols + c];
    }
  }
  return { ...puzzle, rows, cols, cells, letters, updatedAt: Date.now() };
}

export function cellsToString(puzzle) {
  return puzzle.cells.map((t) => GLYPH[t] ?? '.').join('');
}

export function lettersToString(puzzle) {
  return puzzle.letters.map((l) => l || ' ').join('');
}

/** Formato de gravação/exportação: compacto e legível. */
export function serialize(puzzle) {
  return {
    id: puzzle.id,
    title: puzzle.title,
    kind: puzzle.kind,
    rows: puzzle.rows,
    cols: puzzle.cols,
    cells: cellsToString(puzzle),
    letters: lettersToString(puzzle),
    clues: puzzle.clues,
    createdAt: puzzle.createdAt,
    updatedAt: puzzle.updatedAt,
  };
}

export function deserialize(data) {
  return createPuzzle(data);
}

/** Quanto da grade já foi preenchido. */
export function progress(puzzle) {
  let total = 0;
  let filled = 0;
  for (let i = 0; i < puzzle.cells.length; i++) {
    if (puzzle.cells[i] !== LETTER) continue;
    total++;
    if (puzzle.letters[i]) filled++;
  }
  return { total, filled, ratio: total ? filled / total : 0 };
}

/** Monta uma cruzada a partir do resultado do detector. */
export function fromDetection(detection, extra = {}) {
  return createPuzzle({
    rows: detection.rows,
    cols: detection.cols,
    cells: Array.from(detection.types),
    kind: detection.kind,
    ...extra,
  });
}
