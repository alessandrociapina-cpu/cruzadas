/*
 * detector.js — extrai a grade de uma palavra cruzada a partir de uma imagem.
 *
 * O módulo trabalha apenas com arrays de luminância (Uint8Array), sem depender
 * de DOM ou Canvas, para poder rodar tanto no navegador quanto sob Node nos
 * testes. A conversão ImageData -> luminância fica em `rgbaToGray`.
 *
 * Pipeline:
 *   1. redução de escala (box filter)
 *   2. binarização adaptativa (Bradley) -> máscara de "tinta"
 *   3. estimativa e correção de inclinação (foto tirada torta)
 *   4. maior componente conexo de tinta -> retângulo da grade
 *   5. autocorrelação do perfil de tinta (após top-hat) -> passo da grade
 *   6. rede regularizada, aparada nas pontas e com inclinação por linha
 *   7. tom e manchas de tinta de cada casa -> letra, dica ou casa preta
 */

/** Converte um buffer RGBA (ImageData.data) em luminância. */
export function rgbaToGray(data, width, height) {
  const gray = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    const a = data[p + 3] / 255;
    // pixels transparentes contam como papel branco
    const lum = data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114;
    gray[i] = (lum * a + 255 * (1 - a)) | 0;
  }
  return gray;
}

/** Reduz a imagem para caber em `maxDim`, com média de área (anti-aliasing). */
export function downscale(gray, width, height, maxDim) {
  const scale = Math.min(1, maxDim / Math.max(width, height));
  if (scale >= 1) return { gray, width, height, scale: 1 };
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor((y * height) / h);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * height) / h));
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor((x * width) / w);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * width) / w));
      let sum = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        const row = sy * width;
        for (let sx = sx0; sx < sx1; sx++) {
          sum += gray[row + sx];
          n++;
        }
      }
      out[y * w + x] = (sum / n) | 0;
    }
  }
  return { gray: out, width: w, height: h, scale: w / width };
}

function integralImage(gray, w, h) {
  const ii = new Int32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += gray[y * w + x];
      ii[(y + 1) * (w + 1) + (x + 1)] = ii[y * (w + 1) + (x + 1)] + rowSum;
    }
  }
  return ii;
}

/**
 * Binarização adaptativa de Bradley: o pixel é tinta quando fica abaixo da
 * média da vizinhança multiplicada por `t`. Tolera sombra e iluminação
 * irregular, típicas de foto de celular.
 */
export function adaptiveBinarize(gray, w, h, options = {}) {
  const t = options.t ?? 0.85;
  let win = options.window ?? Math.round(Math.min(w, h) / 12);
  win = Math.max(9, win | 1);
  const r = win >> 1;
  const ii = integralImage(gray, w, h);
  const bin = new Uint8Array(w * h);
  const W = w + 1;
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h - 1, y + r);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w - 1, x + r);
      const count = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum =
        ii[(y1 + 1) * W + (x1 + 1)] -
        ii[y0 * W + (x1 + 1)] -
        ii[(y1 + 1) * W + x0] +
        ii[y0 * W + x0];
      bin[y * w + x] = gray[y * w + x] * count < sum * t ? 1 : 0;
    }
  }
  return bin;
}

/** Lista (subamostrada) das coordenadas de tinta, usada na estimativa de giro. */
function inkPoints(bin, w, h, maxPoints = 40000) {
  const pts = [];
  let total = 0;
  for (let i = 0; i < bin.length; i++) if (bin[i]) total++;
  const step = Math.max(1, Math.ceil(total / maxPoints));
  let seen = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!bin[y * w + x]) continue;
      if (seen++ % step === 0) pts.push(x, y);
    }
  }
  return pts;
}

/**
 * Estima a inclinação da folha testando ângulos e escolhendo o que deixa as
 * projeções horizontal e vertical mais "picudas" (linhas retas alinhadas
 * concentram tinta em poucas colunas/linhas).
 */
export function estimateRotation(bin, w, h, options = {}) {
  const maxDeg = options.maxDeg ?? 6;
  const stepDeg = options.stepDeg ?? 0.25;
  const pts = inkPoints(bin, w, h);
  if (pts.length < 200) return 0;
  const diag = Math.ceil(Math.hypot(w, h)) + 2;
  const profX = new Int32Array(diag * 2);
  const profY = new Int32Array(diag * 2);
  let best = 0;
  let bestScore = -Infinity;
  for (let deg = -maxDeg; deg <= maxDeg + 1e-9; deg += stepDeg) {
    const a = (deg * Math.PI) / 180;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    profX.fill(0);
    profY.fill(0);
    for (let i = 0; i < pts.length; i += 2) {
      const x = pts[i] - w / 2;
      const y = pts[i + 1] - h / 2;
      profX[((x * cos - y * sin) | 0) + diag]++;
      profY[((x * sin + y * cos) | 0) + diag]++;
    }
    let score = 0;
    for (let i = 0; i < profX.length; i++) {
      score += profX[i] * profX[i] + profY[i] * profY[i];
    }
    if (score > bestScore) {
      bestScore = score;
      best = a;
    }
  }
  return best;
}

/** Gira a imagem em `angle` radianos (sentido inverso), ampliando a moldura. */
export function rotateGray(gray, w, h, angle) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const nw = Math.ceil(Math.abs(w * cos) + Math.abs(h * sin));
  const nh = Math.ceil(Math.abs(w * sin) + Math.abs(h * cos));
  const out = new Uint8Array(nw * nh).fill(255);
  const cx = w / 2;
  const cy = h / 2;
  const ncx = nw / 2;
  const ncy = nh / 2;
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const dx = x - ncx;
      const dy = y - ncy;
      // rotação inversa: destino -> origem
      const sx = dx * cos + dy * sin + cx;
      const sy = -dx * sin + dy * cos + cy;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) continue;
      const fx = sx - x0;
      const fy = sy - y0;
      const i = y0 * w + x0;
      const v =
        gray[i] * (1 - fx) * (1 - fy) +
        gray[i + 1] * fx * (1 - fy) +
        gray[i + w] * (1 - fx) * fy +
        gray[i + w + 1] * fx * fy;
      out[y * nw + x] = v | 0;
    }
  }
  return { gray: out, width: nw, height: nh };
}

/**
 * Retângulo da grade = caixa do maior componente conexo de tinta (as linhas da
 * moldura e as casas pretas costumam formar uma única peça).
 */
export function findGridBounds(bin, w, h) {
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let best = null;
  for (let start = 0; start < bin.length; start++) {
    if (!bin[start] || seen[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    let size = 0;
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    while (sp > 0) {
      const p = stack[--sp];
      const px = p % w;
      const py = (p / w) | 0;
      size++;
      if (px < x0) x0 = px;
      if (px > x1) x1 = px;
      if (py < y0) y0 = py;
      if (py > y1) y1 = py;
      if (px > 0 && bin[p - 1] && !seen[p - 1]) ((seen[p - 1] = 1), (stack[sp++] = p - 1));
      if (px < w - 1 && bin[p + 1] && !seen[p + 1]) ((seen[p + 1] = 1), (stack[sp++] = p + 1));
      if (py > 0 && bin[p - w] && !seen[p - w]) ((seen[p - w] = 1), (stack[sp++] = p - w));
      if (py < h - 1 && bin[p + w] && !seen[p + w]) ((seen[p + w] = 1), (stack[sp++] = p + w));
    }
    if (!best || size > best.size) best = { size, x0, y0, x1, y1 };
  }
  if (!best) return null;
  return { x0: best.x0, y0: best.y0, x1: best.x1, y1: best.y1, size: best.size };
}

/**
 * Perfil de tinta: para cada coluna (axis 'v') ou linha (axis 'h') dentro do
 * retângulo da grade, a fração de pixels com tinta.
 */
export function inkProfile(bin, w, h, bounds, axis) {
  const { x0, y0, x1, y1 } = bounds;
  const along = axis === 'v' ? y1 - y0 + 1 : x1 - x0 + 1;
  const n = axis === 'v' ? x1 - x0 + 1 : y1 - y0 + 1;
  const frac = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let count = 0;
    if (axis === 'v') {
      const x = x0 + i;
      for (let y = y0; y <= y1; y++) if (bin[y * w + x]) count++;
    } else {
      const y = y0 + i;
      const row = y * w;
      for (let x = x0; x <= x1; x++) if (bin[row + x]) count++;
    }
    frac[i] = count / along;
  }
  return frac;
}

/**
 * Top-hat 1D (perfil menos sua abertura morfológica): mantém os picos estreitos
 * — as linhas da grade — e apaga os platôs largos, que vêm das casas pretas ou
 * dos blocos de texto e atrapalhariam a medida do passo.
 */
export function topHat(profile, size) {
  const n = profile.length;
  const r = Math.max(1, size >> 1);
  const eroded = new Float32Array(n);
  const opened = new Float32Array(n);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let m = Infinity;
    for (let j = Math.max(0, i - r); j <= Math.min(n - 1, i + r); j++) m = Math.min(m, profile[j]);
    eroded[i] = m;
  }
  for (let i = 0; i < n; i++) {
    let m = -Infinity;
    for (let j = Math.max(0, i - r); j <= Math.min(n - 1, i + r); j++) m = Math.max(m, eroded[j]);
    opened[i] = m;
  }
  for (let i = 0; i < n; i++) out[i] = Math.max(0, profile[i] - opened[i]);
  return out;
}

/**
 * Passo da grade pela autocorrelação do perfil. Papel amassado ou foto torta
 * borram as linhas, mas a periodicidade sobrevive.
 * Como a autocorrelação também tem pico nos múltiplos do passo, adotamos o
 * menor submúltiplo que ainda explique bem o perfil.
 */
export function dominantPeriod(profile, options = {}) {
  const n = profile.length;
  const minG = Math.max(6, options.minPeriod ?? Math.round(n / 80));
  const maxG = Math.min(n - 2, options.maxPeriod ?? Math.round(n / 2.5));
  if (maxG <= minG) return null;
  let mean = 0;
  for (const v of profile) mean += v;
  mean /= n;
  const q = new Float64Array(n);
  for (let i = 0; i < n; i++) q[i] = profile[i] - mean;

  const acf = new Float64Array(maxG + 1);
  for (let lag = minG; lag <= maxG; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < n; i++) sum += q[i] * q[i + lag];
    acf[lag] = sum / (n - lag);
  }
  let bestLag = minG;
  for (let lag = minG; lag <= maxG; lag++) if (acf[lag] > acf[bestLag]) bestLag = lag;
  if (acf[bestLag] <= 0) return null;

  // 2g, 3g... também são picos; procuramos o passo fundamental
  let fundamental = bestLag;
  for (let d = 2; d <= 8; d++) {
    const cand = Math.round(bestLag / d);
    if (cand < minG) break;
    let localBest = cand;
    for (let lag = Math.max(minG, cand - 2); lag <= Math.min(maxG, cand + 2); lag++) {
      if (acf[lag] > acf[localBest]) localBest = lag;
    }
    if (acf[localBest] >= acf[bestLag] * 0.7) fundamental = localBest;
  }
  return { period: fundamental, strength: acf[fundamental] };
}

/**
 * Posiciona as linhas: escolhe a fase que cai sobre o máximo de tinta e depois
 * reajusta cada linha na vizinhança, acompanhando a ondulação do papel.
 */
export function linePositions(profile, period, options = {}) {
  const n = profile.length;
  if (!period || period < 4) return [];
  const at = (i) => (i >= 0 && i < n ? profile[i] : 0);
  let bestPhase = 0;
  let bestScore = -Infinity;
  for (let phase = 0; phase < period; phase++) {
    let score = 0;
    for (let p = phase; p < n; p += period) score += at(Math.round(p));
    if (score > bestScore) {
      bestScore = score;
      bestPhase = phase;
    }
  }
  const win = Math.max(1, Math.round(period * 0.3));
  const lines = [];
  for (let p = bestPhase; p <= n - 1 + 0.5; p += period) {
    const predicted = p;
    const i0 = Math.max(0, Math.round(predicted) - win);
    const i1 = Math.min(n - 1, Math.round(predicted) + win);
    let peak = 0;
    for (let i = i0; i <= i1; i++) if (profile[i] > peak) peak = profile[i];
    let num = 0;
    let den = 0;
    for (let i = i0; i <= i1; i++) {
      if (profile[i] >= peak * 0.6) {
        num += i * profile[i];
        den += profile[i];
      }
    }
    const refined = den > 0 ? num / den : predicted;
    // o reajuste acompanha a distorção, mas não pode pular de casa
    lines.push(Math.abs(refined - predicted) <= period * 0.35 ? refined : predicted);
  }
  // fase pode começar depois da borda: completa para trás se sobrar espaço
  while (lines.length && lines[0] - period >= -period * 0.35) {
    lines.unshift(Math.max(0, lines[0] - period));
  }
  const cleaned = [];
  for (const v of lines) {
    if (v < -0.5 || v > n - 0.5) continue;
    if (cleaned.length && v - cleaned[cleaned.length - 1] < period * 0.5) continue;
    cleaned.push(Math.max(0, Math.min(n - 1, v)));
  }
  if (options.offset) return cleaned.map((v) => v + options.offset);
  return cleaned;
}

/**
 * Colunas (ou linhas) com alta densidade de tinta viram grupos contíguos; o
 * centro de cada grupo é uma candidata a linha da grade. Usado como reserva
 * quando a autocorrelação não encontra periodicidade.
 */
export function lineCandidates(bin, w, h, bounds, axis) {
  const frac = inkProfile(bin, w, h, bounds, axis);
  const n = frac.length;
  const x0 = bounds.x0;
  const y0 = bounds.y0;
  for (const thr of [0.9, 0.82, 0.72, 0.6, 0.5]) {
    const groups = [];
    let i = 0;
    while (i < n) {
      if (frac[i] < thr) {
        i++;
        continue;
      }
      let j = i;
      let wsum = 0;
      let vsum = 0;
      let gap = 0;
      while (j < n && gap <= 1) {
        if (frac[j] >= thr) {
          wsum += frac[j] * j;
          vsum += frac[j];
          gap = 0;
        } else {
          gap++;
        }
        j++;
      }
      groups.push((axis === 'v' ? x0 : y0) + wsum / vsum);
      i = j;
    }
    if (groups.length >= 3) return { centers: groups, threshold: thr };
  }
  return { centers: [], threshold: 0 };
}

/**
 * Ajusta uma rede regular (posição inicial + passo) às candidatas, descartando
 * ruído e reconstruindo linhas que a detecção perdeu.
 */
export function fitLattice(centers, options = {}) {
  const tol = options.tol ?? 0.18;
  const minSpacing = options.minSpacing ?? 6;
  if (centers.length < 3) return null;
  const sorted = [...centers].sort((a, b) => a - b);
  let best = null;
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const g = sorted[j] - sorted[i];
      if (g < minSpacing) continue;
      const inliers = [];
      const ks = [];
      for (const c of sorted) {
        const k = (c - sorted[i]) / g;
        const kr = Math.round(k);
        if (Math.abs(k - kr) <= tol) {
          inliers.push(c);
          ks.push(kr);
        }
      }
      if (inliers.length < 3) continue;
      const span = ks[ks.length - 1] - ks[0];
      if (span < 2) continue;
      // preferimos a rede que explica mais candidatas; empate vai para o passo
      // maior (evita travar num "meio de casa" que também casaria com tudo)
      const score = inliers.length;
      if (!best || score > best.score || (score === best.score && g > best.g)) {
        best = { score, g, inliers, ks };
      }
    }
  }
  if (!best) return null;
  // mínimos quadrados: c ~= a + b*k
  const { inliers, ks } = best;
  const n = inliers.length;
  let sk = 0;
  let sc = 0;
  let skk = 0;
  let skc = 0;
  for (let i = 0; i < n; i++) {
    sk += ks[i];
    sc += inliers[i];
    skk += ks[i] * ks[i];
    skc += ks[i] * inliers[i];
  }
  const den = n * skk - sk * sk;
  const b = den === 0 ? best.g : (n * skc - sk * sc) / den;
  const a = (sc - b * sk) / n;
  const kMin = ks[0];
  const kMax = ks[ks.length - 1];
  const lines = [];
  for (let k = kMin; k <= kMax; k++) lines.push(a + b * k);
  return { lines, spacing: b, inliers: n, candidates: centers.length };
}

/**
 * Limiar de Otsu sobre um histograma de 256 níveis.
 * Convenção: os níveis `<= t` formam a classe escura.
 */
export function otsu(values) {
  const hist = new Int32Array(256);
  for (const v of values) hist[Math.max(0, Math.min(255, Math.round(v)))]++;
  const total = values.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let bestVar = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) {
      bestVar = between;
      best = t;
    }
  }
  return best;
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Tipos de casa. LETTER é preenchível; BLOCK e CLUE não são. */
export const LETTER = 0;
export const BLOCK = 1;
export const CLUE = 2;

/** Retângulo interno da casa (r,c) em pixels, descontando as bordas da grade. */
function cellRect(geom, r, c, w, h, inset = 0.16) {
  const box = cellBox(geom, r, c, inset);
  return {
    x0: Math.max(0, Math.round(box.x0)),
    x1: Math.min(w - 1, Math.round(box.x1)),
    y0: Math.max(0, Math.round(box.y0)),
    y1: Math.min(h - 1, Math.round(box.y1)),
  };
}

/**
 * Conta manchas de tinta dentro de um retângulo, ignorando respingos.
 * Muitas manchas = texto de dica; uma ou duas = letra escrita ou seta.
 */
function countBlobs(bin, w, rect, minSize) {
  const rw = rect.x1 - rect.x0 + 1;
  const rh = rect.y1 - rect.y0 + 1;
  if (rw <= 0 || rh <= 0) return { blobs: 0, ink: 0 };
  const seen = new Uint8Array(rw * rh);
  const stack = new Int32Array(rw * rh);
  let blobs = 0;
  let ink = 0;
  for (let i = 0; i < rw * rh; i++) {
    const lx = i % rw;
    const ly = (i / rw) | 0;
    if (!bin[(rect.y0 + ly) * w + rect.x0 + lx] || seen[i]) continue;
    let sp = 0;
    stack[sp++] = i;
    seen[i] = 1;
    let size = 0;
    while (sp > 0) {
      const p = stack[--sp];
      const px = p % rw;
      const py = (p / rw) | 0;
      size++;
      const push = (q, qx, qy) => {
        if (qx < 0 || qy < 0 || qx >= rw || qy >= rh) return;
        if (seen[q] || !bin[(rect.y0 + qy) * w + rect.x0 + qx]) return;
        seen[q] = 1;
        stack[sp++] = q;
      };
      push(p - 1, px - 1, py);
      push(p + 1, px + 1, py);
      push(p - rw, px, py - 1);
      push(p + rw, px, py + 1);
    }
    ink += size;
    if (size >= minSize) blobs++;
  }
  return { blobs, ink: ink / (rw * rh) };
}

/**
 * Mede cada casa e decide o tipo:
 *   - BLOCK: miolo escuro (cruzada clássica)
 *   - CLUE:  miolo claro mas cheio de tinta espalhada (cruzada de setas, o
 *            enunciado vem impresso dentro da casa)
 *   - LETTER: casa vazia, para preencher
 *
 * `gray` mede o tom médio (mediana, que ignora o numerozinho do canto) e `bin`
 * a máscara de tinta. Sem `bin`, só a distinção claro/escuro é feita.
 */
export function classifyCells(gray, bin, w, h, geom, options = {}) {
  const bias = options.bias ?? 0;
  const clueInk = options.clueInk ?? 0.05;
  const clueBlobs = options.clueBlobs ?? 4;
  const { rows, cols } = geom;
  const values = new Float64Array(rows * cols);
  const spread = new Float32Array(rows * cols);
  const ink = new Float32Array(rows * cols);
  const blobs = new Int16Array(rows * cols);
  const samples = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const rect = cellRect(geom, r, c, w, h, 0.24);
      samples.length = 0;
      const stepX = Math.max(1, Math.floor((rect.x1 - rect.x0) / 9));
      const stepY = Math.max(1, Math.floor((rect.y1 - rect.y0) / 9));
      for (let y = rect.y0; y <= rect.y1; y += stepY) {
        for (let x = rect.x0; x <= rect.x1; x += stepX) samples.push(gray[y * w + x]);
      }
      if (samples.length) {
        const ordenada = [...samples].sort((a, b) => a - b);
        values[i] = ordenada[ordenada.length >> 1];
        // amplitude entre os percentis 10 e 90: casa pintada é escura por
        // igual, texto sempre tem papel claro entre as letras
        spread[i] =
          ordenada[Math.floor(ordenada.length * 0.9)] - ordenada[Math.floor(ordenada.length * 0.1)];
      } else {
        values[i] = 255;
        spread[i] = 0;
      }
      if (bin) {
        const inner = cellRect(geom, r, c, w, h, 0.19);
        const area = (inner.x1 - inner.x0 + 1) * (inner.y1 - inner.y0 + 1);
        const stats = countBlobs(bin, w, inner, Math.max(3, area * 0.0012));
        ink[i] = stats.ink;
        blobs[i] = stats.blobs;
      }
    }
  }

  let lo = 255;
  let hi = 0;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const types = new Uint8Array(rows * cols);
  // Casa preta é escura por inteiro; casa com enunciado tem texto, mas o miolo
  // continua da cor do papel. Por isso o limiar fica bem abaixo do tom do papel
  // (estimado no percentil 85 das casas) e nunca alcança uma casa de texto.
  const ordenados = [...values].sort((a, b) => a - b);
  const papel = ordenados[Math.floor(ordenados.length * 0.85)] ?? hi;
  const threshold = hi - lo < 55 ? null : Math.min(otsu(values), papel * 0.6) + bias;
  const uniforme = options.blockSpread ?? 70;
  for (let i = 0; i < values.length; i++) {
    // A contagem de manchas decide antes do tom: um enunciado espalha uma
    // mancha por letra, enquanto a casa preta é uma mancha só — sem isso, um
    // enunciado denso e escuro passaria por casa pintada.
    const escura = threshold !== null && values[i] <= threshold;
    if (bin && blobs[i] >= clueBlobs && ink[i] >= clueInk) {
      types[i] = CLUE;
    } else if (escura && spread[i] <= uniforme) {
      types[i] = BLOCK;
    } else if (escura && bin && ink[i] >= clueInk) {
      // escura, mas cheia de claros e escuros: é enunciado que a sombra da foto
      // borrou a ponto de as letras se juntarem numa mancha só
      types[i] = CLUE;
    } else {
      types[i] = LETTER;
    }
  }
  const blocks = new Uint8Array(rows * cols);
  for (let i = 0; i < types.length; i++) blocks[i] = types[i] === LETTER ? 0 : 1;
  return { rows, cols, types, blocks, values, spread, ink, blobs, threshold };
}

/**
 * Casa de cruzada impressa é uniforme, então vale regularizar: ajusta uma rede
 * de passo constante às posições encontradas (descartando as que destoam) e a
 * estende até cobrir toda a grade. Sem isso o erro de cada linha se acumula e
 * as últimas fileiras saem deslocadas.
 */
export function regularize(lines, from, to) {
  const fit = fitLattice(lines, { minSpacing: 4 });
  if (!fit || !(fit.spacing > 1)) return lines;
  const { spacing } = fit;
  let start = fit.lines[0];
  while (start - spacing >= from - spacing * 0.3) start -= spacing;
  const out = [];
  for (let p = start; p <= to + spacing * 0.3; p += spacing) out.push(p);
  return out.length >= 2 ? out : lines;
}

/**
 * Mede cada linha da grade em várias faixas e ajusta uma reta com inclinação
 * própria. É o que faz a leitura funcionar em foto de jornal amassado, onde a
 * grade não é um retângulo perfeito.
 *
 * @returns {{a:number,s:number}[]} posição = a + s * (coordenada perpendicular)
 */
export function fitLineSlopes(bin, w, h, bounds, axis, lines, period, options = {}) {
  const bands = options.bands ?? 5;
  const { x0, y0, x1, y1 } = bounds;
  const perpFrom = axis === 'v' ? y0 : x0;
  const perpTo = axis === 'v' ? y1 : x1;
  const bandSize = (perpTo - perpFrom) / bands;
  const offset = axis === 'v' ? x0 : y0;
  const samples = lines.map(() => []);
  const win = Math.max(2, Math.round(period * 0.35));

  for (let b = 0; b < bands; b++) {
    const from = Math.round(perpFrom + b * bandSize);
    const to = Math.round(perpFrom + (b + 1) * bandSize);
    if (to - from < 4) continue;
    const sub = axis === 'v' ? { x0, x1, y0: from, y1: to } : { x0: from, x1: to, y0, y1 };
    const prof = topHat(
      inkProfile(bin, w, h, sub, axis),
      options.lineWidth ?? Math.max(7, Math.round((axis === 'v' ? x1 - x0 : y1 - y0) / 90) | 1)
    );
    const center = (from + to) / 2;
    for (let j = 0; j < lines.length; j++) {
      const local = lines[j] - offset;
      const i0 = Math.max(0, Math.round(local) - win);
      const i1 = Math.min(prof.length - 1, Math.round(local) + win);
      let peak = 0;
      for (let i = i0; i <= i1; i++) if (prof[i] > peak) peak = prof[i];
      if (peak < 0.25) continue; // faixa sem linha visível (casa preta, sombra)
      let num = 0;
      let den = 0;
      for (let i = i0; i <= i1; i++) {
        if (prof[i] >= peak * 0.6) {
          num += i * prof[i];
          den += prof[i];
        }
      }
      if (den > 0) samples[j].push([center, num / den + offset]);
    }
  }

  return lines.map((p, j) => {
    const pts = samples[j];
    if (pts.length < 2) return { a: p, s: 0 };
    let st = 0;
    let sp = 0;
    let stt = 0;
    let stp = 0;
    for (const [t, v] of pts) {
      st += t;
      sp += v;
      stt += t * t;
      stp += t * v;
    }
    const n = pts.length;
    const den = n * stt - st * st;
    let s = den === 0 ? 0 : (n * stp - st * sp) / den;
    if (!Number.isFinite(s) || Math.abs(s) > 0.15) s = 0;
    const a = (sp - s * st) / n;
    return { a, s };
  });
}

/**
 * Nós da grade: cruzamento de cada linha vertical com cada horizontal.
 * x = ax + sx*y e y = ay + sy*x  =>  x = (ax + sx*ay) / (1 - sx*sy)
 */
export function buildGeometry(vLines, hLines) {
  const cols = vLines.length - 1;
  const rows = hLines.length - 1;
  const corners = new Float64Array((rows + 1) * (cols + 1) * 2);
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      const { a: ax, s: sx } = vLines[c];
      const { a: ay, s: sy } = hLines[r];
      const den = 1 - sx * sy;
      const x = den === 0 ? ax : (ax + sx * ay) / den;
      const y = ay + sy * x;
      const i = (r * (cols + 1) + c) * 2;
      corners[i] = x;
      corners[i + 1] = y;
    }
  }
  return {
    rows,
    cols,
    corners,
    vLines,
    hLines,
    xs: vLines.map((l) => l.a),
    ys: hLines.map((l) => l.a),
  };
}

export function corner(geom, r, c) {
  const i = (r * (geom.cols + 1) + c) * 2;
  return [geom.corners[i], geom.corners[i + 1]];
}

/** Maior retângulo alinhado aos eixos que cabe dentro da casa (r,c). */
export function cellBox(geom, r, c, inset = 0) {
  const [tlx, tly] = corner(geom, r, c);
  const [trx, try_] = corner(geom, r, c + 1);
  const [blx, bly] = corner(geom, r + 1, c);
  const [brx, bry] = corner(geom, r + 1, c + 1);
  let x0 = Math.max(tlx, blx);
  let x1 = Math.min(trx, brx);
  let y0 = Math.max(tly, try_);
  let y1 = Math.min(bly, bry);
  const dx = (x1 - x0) * inset;
  const dy = (y1 - y0) * inset;
  return { x0: x0 + dx, x1: x1 - dx, y0: y0 + dy, y1: y1 - dy };
}

/**
 * Linhas da grade num eixo: tenta a periodicidade (robusta a papel ondulado) e,
 * se não achar, cai no agrupamento de colunas cheias de tinta.
 */
export function gridLines(bin, w, h, bounds, axis, options = {}) {
  const offset = axis === 'v' ? bounds.x0 : bounds.y0;
  const end = axis === 'v' ? bounds.x1 : bounds.y1;
  const raw = inkProfile(bin, w, h, bounds, axis);
  const thickness = options.lineWidth ?? Math.max(7, Math.round(raw.length / 90) | 1);
  const profile = topHat(raw, thickness);
  const period = dominantPeriod(profile, options);
  if (period) {
    const found = linePositions(profile, period.period, { offset });
    if (found.length >= 3) {
      const lines = regularize(found, offset, end);
      const spacing = (lines[lines.length - 1] - lines[0]) / (lines.length - 1);
      return { lines, spacing, method: 'periodo', period: period.period };
    }
  }
  const cand = lineCandidates(bin, w, h, bounds, axis);
  const fit = fitLattice(cand.centers);
  if (fit) return { lines: fit.lines, spacing: fit.spacing, method: 'rede' };
  return null;
}

/**
 * Quanto uma faixa de casas é atravessada pelas linhas perpendiculares.
 * Dentro da grade dá perto de 1; num fio de diagramação que o detector pegou
 * junto, dá quase 0 — é assim que aparamos as bordas sobrando.
 */
function crossingScore(bin, w, h, from, to, crossLines, axis, tol = 1) {
  let total = 0;
  let hits = 0;
  for (const cl of crossLines) {
    const c = Math.round(cl);
    for (let p = Math.ceil(from) + 1; p < to; p++) {
      let inked = 0;
      for (let d = -tol; d <= tol && !inked; d++) {
        const x = axis === 'v' ? p : c + d;
        const y = axis === 'v' ? c + d : p;
        if (x >= 0 && y >= 0 && x < w && y < h && bin[y * w + x]) inked = 1;
      }
      total++;
      hits += inked;
    }
  }
  return total ? hits / total : 0;
}

/** Remove faixas das pontas que não fazem parte da grade. */
export function trimToGrid(bin, w, h, xs, ys, options = {}) {
  const minScore = options.minScore ?? 0.45;
  // a tolerância absorve a ondulação do papel: a linha perpendicular pode estar
  // alguns pixels fora do lugar previsto sem que a faixa seja descartada
  const tol = (lines) => {
    const spacing = (lines[lines.length - 1] - lines[0]) / Math.max(1, lines.length - 1);
    return Math.max(1, Math.round(spacing * 0.18));
  };
  const trim = (lines, cross, axis, t) => {
    let a = 0;
    let b = lines.length - 1;
    while (
      b - a >= 2 &&
      crossingScore(bin, w, h, lines[a], lines[a + 1], cross, axis, t) < minScore
    ) {
      a++;
    }
    while (
      b - a >= 2 &&
      crossingScore(bin, w, h, lines[b - 1], lines[b], cross, axis, t) < minScore
    ) {
      b--;
    }
    return lines.slice(a, b + 1);
  };
  const newXs = trim(xs, ys, 'v', tol(ys));
  const newYs = trim(ys, newXs, 'h', tol(newXs));
  return { xs: newXs, ys: newYs };
}

function uniformLines(from, to, count) {
  const lines = [];
  for (let i = 0; i <= count; i++) lines.push(from + ((to - from) * i) / count);
  return lines;
}

/**
 * Detecta a grade completa.
 *
 * @param {Uint8Array} gray luminância da imagem
 * @param {object} options
 *   maxDim      — maior dimensão de trabalho (padrão 900)
 *   deskew      — corrigir inclinação (padrão true)
 *   bias        — desloca o limiar de casa preta (+ = mais casas pretas)
 *   forceRows / forceCols — impõe a quantidade de linhas/colunas
 * @returns {{rows,cols,blocks,xs,ys,angle,work,warnings}}
 */
export function detectGrid(gray, width, height, options = {}) {
  const maxDim = options.maxDim ?? 900;
  const warnings = [];
  let work = downscale(gray, width, height, maxDim);
  let bin = adaptiveBinarize(work.gray, work.width, work.height, options);

  let angle = 0;
  if (options.deskew !== false) {
    angle = estimateRotation(bin, work.width, work.height);
    if (Math.abs(angle) > 0.0025) {
      const rot = rotateGray(work.gray, work.width, work.height, angle);
      work = { ...rot, scale: work.scale };
      bin = adaptiveBinarize(work.gray, work.width, work.height, options);
    } else {
      angle = 0;
    }
  }

  const bounds = findGridBounds(bin, work.width, work.height);
  if (!bounds || bounds.size < work.width * work.height * 0.004) {
    throw new Error('Não encontrei uma grade nesta imagem.');
  }

  let xs;
  let ys;
  let periodX = 0;
  let periodY = 0;
  if (options.forceCols && options.forceRows) {
    xs = uniformLines(bounds.x0, bounds.x1, options.forceCols);
    ys = uniformLines(bounds.y0, bounds.y1, options.forceRows);
  } else {
    const vLines = gridLines(bin, work.width, work.height, bounds, 'v', options);
    const hLines = gridLines(bin, work.width, work.height, bounds, 'h', options);
    if (!vLines || !hLines) {
      throw new Error(
        'Não consegui identificar as linhas da grade. Tente uma foto mais reta e sem sombra.'
      );
    }
    xs = vLines.lines;
    ys = hLines.lines;
    periodX = vLines.spacing;
    periodY = hLines.spacing;
    if (options.trim !== false) {
      const trimmed = trimToGrid(bin, work.width, work.height, xs, ys, options);
      xs = trimmed.xs;
      ys = trimmed.ys;
    }
    if (options.forceCols) xs = uniformLines(xs[0], xs[xs.length - 1], options.forceCols);
    if (options.forceRows) ys = uniformLines(ys[0], ys[ys.length - 1], options.forceRows);
    const ratio = vLines.spacing / hLines.spacing;
    if (ratio < 0.7 || ratio > 1.4) {
      warnings.push('As casas não ficaram quadradas — confira o número de linhas e colunas.');
    }
  }

  if (xs.length < 2 || ys.length < 2) {
    throw new Error('Grade pequena demais para ser lida.');
  }

  // cada linha ganha inclinação própria, acompanhando a distorção do papel
  const spacingX = periodX || (xs[xs.length - 1] - xs[0]) / Math.max(1, xs.length - 1);
  const spacingY = periodY || (ys[ys.length - 1] - ys[0]) / Math.max(1, ys.length - 1);
  const gridBounds = {
    x0: Math.max(bounds.x0, Math.round(xs[0])),
    x1: Math.min(bounds.x1, Math.round(xs[xs.length - 1])),
    y0: Math.max(bounds.y0, Math.round(ys[0])),
    y1: Math.min(bounds.y1, Math.round(ys[ys.length - 1])),
  };
  const geom =
    options.slopes === false
      ? buildGeometry(
          xs.map((a) => ({ a, s: 0 })),
          ys.map((a) => ({ a, s: 0 }))
        )
      : buildGeometry(
          fitLineSlopes(bin, work.width, work.height, gridBounds, 'v', xs, spacingX, options),
          fitLineSlopes(bin, work.width, work.height, gridBounds, 'h', ys, spacingY, options)
        );

  const cells = classifyCells(work.gray, bin, work.width, work.height, geom, options);
  const { rows, cols, types, blocks, values, ink, blobs, threshold } = cells;

  if (rows > 60 || cols > 60) {
    warnings.push('Detectei muitas casas; talvez a imagem tenha ruído.');
  }

  let clueCount = 0;
  let blockCount = 0;
  for (const t of types) {
    if (t === CLUE) clueCount++;
    else if (t === BLOCK) blockCount++;
  }
  // com enunciados dentro das casas é cruzada direta (de setas); senão, clássica
  const kind = clueCount > blockCount && clueCount >= 3 ? 'setas' : 'classica';

  return {
    rows,
    cols,
    types,
    blocks,
    kind,
    geom,
    xs,
    ys,
    angle,
    work,
    values,
    ink,
    blobs,
    threshold,
    bounds,
    warnings,
  };
}
