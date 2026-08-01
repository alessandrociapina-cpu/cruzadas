/* Gera imagens sintéticas de palavras cruzadas para testar o detector. */
import { rotateGray } from '../js/detector.js';

/**
 * Desenha uma cruzada em tons de cinza.
 * @param {string[]} pattern linhas com '#' (casa preta) e '.' (casa vazia)
 */
export function renderPuzzle(pattern, options = {}) {
  const cell = options.cell ?? 34;
  const line = options.line ?? 2;
  const margin = options.margin ?? 25;
  const rows = pattern.length;
  const cols = pattern[0].length;
  const width = margin * 2 + cols * cell + line;
  const height = margin * 2 + rows * cell + line;
  const paper = options.paper ?? 250;
  const ink = options.ink ?? 25;
  const g = new Uint8Array(width * height).fill(paper);

  const put = (x, y, v) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    g[y * width + x] = v;
  };
  const fillRect = (x0, y0, w, h, v) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) put(x, y, v);
  };

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const ch = pattern[r][c];
      if (ch === '#') {
        fillRect(margin + c * cell, margin + r * cell, cell + line, cell + line, ink);
      } else if (ch === '?') {
        // casa de dica: linhas de "texto" formadas por vários traços curtos
        const pad = Math.round(cell * 0.12);
        const lh = Math.max(3, Math.round(cell * 0.16));
        for (let ty = pad; ty < cell - pad - 2; ty += lh) {
          let tx = pad;
          while (tx < cell - pad) {
            const wLen = Math.min(cell - pad - tx, 3 + ((tx * 7 + ty * 3 + r + c) % 5));
            fillRect(margin + c * cell + line + tx, margin + r * cell + line + ty, wLen, 2, ink);
            tx += wLen + 3;
          }
        }
      }
    }
  }
  for (let c = 0; c <= cols; c++)
    fillRect(margin + c * cell, margin, line, rows * cell + line, ink);
  for (let r = 0; r <= rows; r++)
    fillRect(margin, margin + r * cell, cols * cell + line, line, ink);

  // numerozinhos no canto das casas iniciais (não podem virar casa preta)
  if (options.numbers !== false) {
    let n = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (pattern[r][c] === '#') continue;
        const blocked = (rr, cc) =>
          rr < 0 || cc < 0 || rr >= rows || cc >= cols || pattern[rr][cc] !== '.';
        const startsAcross = blocked(r, c - 1) && !blocked(r, c + 1);
        const startsDown = blocked(r - 1, c) && !blocked(r + 1, c);
        if (!startsAcross && !startsDown) continue;
        n++;
        fillRect(margin + c * cell + line + 2, margin + r * cell + line + 2, 5, 7, ink + 30);
      }
    }
  }

  let out = { gray: g, width, height };

  if (options.rotateDeg) {
    out = rotateGray(out.gray, out.width, out.height, (-options.rotateDeg * Math.PI) / 180);
  }

  if (options.noise || options.shading) {
    const noise = options.noise ?? 0;
    const shading = options.shading ?? 0;
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let y = 0; y < out.height; y++) {
      for (let x = 0; x < out.width; x++) {
        const i = y * out.width + x;
        const shade = shading * ((x / out.width) * 0.6 + (y / out.height) * 0.4);
        const v = out.gray[i] - shade + (rand() - 0.5) * 2 * noise;
        out.gray[i] = Math.max(0, Math.min(255, v)) | 0;
      }
    }
  }

  return out;
}

export function patternToBlocks(pattern) {
  const rows = pattern.length;
  const cols = pattern[0].length;
  const blocks = new Uint8Array(rows * cols);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) blocks[r * cols + c] = pattern[r][c] === '#' ? 1 : 0;
  return { rows, cols, blocks };
}

export function typesToPattern(rows, cols, types) {
  const glyph = ['.', '#', '?'];
  const out = [];
  for (let r = 0; r < rows; r++) {
    let s = '';
    for (let c = 0; c < cols; c++) s += glyph[types[r * cols + c]] ?? '?';
    out.push(s);
  }
  return out;
}

export function blocksToPattern(rows, cols, blocks) {
  const out = [];
  for (let r = 0; r < rows; r++) {
    let s = '';
    for (let c = 0; c < cols; c++) s += blocks[r * cols + c] ? '#' : '.';
    out.push(s);
  }
  return out;
}
