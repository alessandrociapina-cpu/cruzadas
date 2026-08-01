/*
 * imaging.js — ponte entre o Canvas do navegador e o detector.
 * Carrega a foto, aplica o giro escolhido pela pessoa, converte para
 * luminância e, depois da detecção, reamostra a grade numa imagem uniforme
 * (cada casa vira um quadrado de lado fixo) para que os enunciados possam ser
 * mostrados como recorte da foto original.
 */
import { rgbaToGray, detectGrid } from './detector.js';

/** Aceita File, Blob, URL ou HTMLImageElement e devolve algo desenhável. */
export async function loadBitmap(source) {
  if (typeof source === 'string') {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`Não consegui abrir a imagem (${res.status}).`);
    return createImageBitmap(await res.blob());
  }
  if (source instanceof Blob) return createImageBitmap(source);
  return source;
}

function makeCanvas(w, h) {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  return new OffscreenCanvas(w, h);
}

/**
 * Desenha a imagem girada em múltiplos de 90° e limitada a `maxDim`.
 * @param {number} quarters 0, 1, 2 ou 3 giros de 90° no sentido horário
 */
export function toCanvas(bitmap, quarters = 0, maxDim = 2200) {
  const q = ((quarters % 4) + 4) % 4;
  const swap = q % 2 === 1;
  const srcW = bitmap.width;
  const srcH = bitmap.height;
  const scale = Math.min(1, maxDim / Math.max(srcW, srcH));
  const w = Math.round(srcW * scale);
  const h = Math.round(srcH * scale);
  const canvas = makeCanvas(swap ? h : w, swap ? w : h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((q * Math.PI) / 2);
  ctx.drawImage(bitmap, -w / 2, -h / 2, w, h);
  ctx.restore();
  return canvas;
}

/** Gira o canvas por um ângulo qualquer, ampliando a moldura (fundo branco). */
export function rotateCanvas(canvas, angle) {
  if (!angle) return canvas;
  const { width: w, height: h } = canvas;
  const cos = Math.abs(Math.cos(angle));
  const sin = Math.abs(Math.sin(angle));
  const nw = Math.ceil(w * cos + h * sin);
  const nh = Math.ceil(w * sin + h * cos);
  const out = makeCanvas(nw, nh);
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, nw, nh);
  ctx.translate(nw / 2, nh / 2);
  ctx.rotate(angle);
  ctx.drawImage(canvas, -w / 2, -h / 2);
  return out;
}

export function canvasToGray(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return {
    gray: rgbaToGray(data.data, canvas.width, canvas.height),
    width: canvas.width,
    height: canvas.height,
  };
}

/**
 * Lê a grade de uma imagem já orientada.
 * Devolve o resultado do detector mais o canvas endireitado e a escala que
 * leva das coordenadas de trabalho (xs/ys) para esse canvas.
 */
export function detectFromCanvas(canvas, options = {}) {
  const { gray, width, height } = canvasToGray(canvas);
  const result = detectGrid(gray, width, height, options);
  const straight = rotateCanvas(canvas, result.angle);
  return { ...result, canvas: straight, toCanvasScale: straight.width / result.work.width };
}

/**
 * Reamostra a grade detectada numa imagem em que toda casa é um quadrado de
 * `cellPx`. Cada casa é redesenhada pela transformação afim que leva seus três
 * primeiros cantos ao quadrado de destino, o que endireita a distorção do papel
 * e deixa o recorte de cada casa numa conta trivial: (col*cellPx, lin*cellPx).
 */
export function normalizeGrid(detection, cellPx = 110, options = {}) {
  const { canvas, geom, rows, cols, toCanvasScale: k } = detection;
  // folga opcional na origem; acima de ~2% começa a puxar o conteúdo da casa
  // vizinha para dentro do recorte, então o padrão é sem folga
  const overscan = options.overscan ?? 0;
  const out = makeCanvas(cols * cellPx, rows * cellPx);
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.imageSmoothingQuality = 'high';
  const at = (r, c) => {
    const i = (r * (cols + 1) + c) * 2;
    return [geom.corners[i] * k, geom.corners[i + 1] * k];
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const tl = at(r, c);
      const tr = at(r, c + 1);
      const bl = at(r + 1, c);
      const br = at(r + 1, c + 1);
      const cx = (tl[0] + tr[0] + bl[0] + br[0]) / 4;
      const cy = (tl[1] + tr[1] + bl[1] + br[1]) / 4;
      const grow = 1 + 2 * overscan;
      const [x0, y0] = [cx + (tl[0] - cx) * grow, cy + (tl[1] - cy) * grow];
      const [x1, y1] = [cx + (tr[0] - cx) * grow, cy + (tr[1] - cy) * grow];
      const [x2, y2] = [cx + (bl[0] - cx) * grow, cy + (bl[1] - cy) * grow];
      const dx = c * cellPx;
      const dy = r * cellPx;
      // afim que leva (0,0)->canto superior esquerdo, (1,0)->direito, (0,1)->inferior
      const a = (x1 - x0) / cellPx;
      const b = (y1 - y0) / cellPx;
      const cc = (x2 - x0) / cellPx;
      const d = (y2 - y0) / cellPx;
      const det = a * d - b * cc;
      if (!det) continue;
      ctx.save();
      ctx.beginPath();
      ctx.rect(dx, dy, cellPx, cellPx);
      ctx.clip();
      // inverte a afim: destino -> origem vira origem -> destino no contexto
      const ia = d / det;
      const ib = -b / det;
      const ic = -cc / det;
      const id = a / det;
      const ie = -(x0 * ia + y0 * ic) + dx;
      const iF = -(x0 * ib + y0 * id) + dy;
      ctx.setTransform(ia, ib, ic, id, ie, iF);
      ctx.drawImage(canvas, 0, 0);
      ctx.restore();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
  }
  return out;
}

export async function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.82) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality });
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

export function canvasToDataUrl(canvas, type = 'image/jpeg', quality = 0.82) {
  if (canvas.toDataURL) return canvas.toDataURL(type, quality);
  throw new Error('Canvas sem toDataURL');
}
