/*
 * db.js — banco local das cruzadas (IndexedDB).
 *
 * Guarda a grade, a imagem normalizada (blob), as dicas e o progresso do
 * preenchimento. Fica no aparelho, funciona sem internet e aguenta as imagens,
 * que não caberiam no localStorage. Se o IndexedDB não estiver disponível
 * (navegação privada antiga, por exemplo), cai para um armazenamento em memória
 * para o app continuar utilizável na sessão.
 */
import { serialize, deserialize } from './puzzle.js';

const DB_NAME = 'cruzadas';
const DB_VERSION = 1;
const STORE = 'puzzles';
const IMAGES = 'images';

let dbPromise = null;
const memoria = { puzzles: new Map(), images: new Map(), aviso: false };

function abrir() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('sem IndexedDB'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains(IMAGES)) {
        db.createObjectStore(IMAGES);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch((erro) => {
    if (!memoria.aviso) {
      console.warn('Banco local indisponível, usando memória volátil:', erro);
      memoria.aviso = true;
    }
    return null;
  });
  return dbPromise;
}

function transacao(db, stores, modo, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, modo);
    let resultado;
    tx.oncomplete = () => resolve(resultado);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
    resultado = fn(tx);
    if (resultado && typeof resultado.then === 'function') {
      reject(new Error('a função da transação deve ser síncrona'));
    }
  });
}

function pedido(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Grava (ou atualiza) uma cruzada. `imagem` é opcional e só vai na criação. */
export async function salvar(puzzle, imagem) {
  const registro = serialize({ ...puzzle, updatedAt: Date.now() });
  const db = await abrir();
  if (!db) {
    memoria.puzzles.set(registro.id, registro);
    if (imagem) memoria.images.set(registro.id, imagem);
    return registro;
  }
  const lojas = imagem ? [STORE, IMAGES] : [STORE];
  await transacao(db, lojas, 'readwrite', (tx) => {
    tx.objectStore(STORE).put(registro);
    if (imagem) tx.objectStore(IMAGES).put(imagem, registro.id);
  });
  return registro;
}

export async function listar() {
  const db = await abrir();
  if (!db) {
    return [...memoria.puzzles.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }
  const tx = db.transaction(STORE, 'readonly');
  const todos = await pedido(tx.objectStore(STORE).getAll());
  return todos.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function carregar(id) {
  const db = await abrir();
  const registro = db
    ? await pedido(db.transaction(STORE, 'readonly').objectStore(STORE).get(id))
    : memoria.puzzles.get(id);
  return registro ? deserialize(registro) : null;
}

export async function carregarImagem(id) {
  const db = await abrir();
  if (!db) return memoria.images.get(id) ?? null;
  return (await pedido(db.transaction(IMAGES, 'readonly').objectStore(IMAGES).get(id))) ?? null;
}

export async function remover(id) {
  const db = await abrir();
  if (!db) {
    memoria.puzzles.delete(id);
    memoria.images.delete(id);
    return;
  }
  await transacao(db, [STORE, IMAGES], 'readwrite', (tx) => {
    tx.objectStore(STORE).delete(id);
    tx.objectStore(IMAGES).delete(id);
  });
}

/** Exporta tudo (com as imagens em base64) para um arquivo de backup. */
export async function exportarTudo() {
  const puzzles = await listar();
  const imagens = {};
  for (const p of puzzles) {
    const blob = await carregarImagem(p.id);
    if (blob) imagens[p.id] = await blobParaDataUrl(blob);
  }
  return { formato: 'cruzadas-v1', exportadoEm: new Date().toISOString(), puzzles, imagens };
}

/** Importa um backup; devolve quantas cruzadas entraram. */
export async function importarTudo(dados) {
  if (!dados || !Array.isArray(dados.puzzles)) {
    throw new Error('Arquivo de backup não reconhecido.');
  }
  let n = 0;
  for (const registro of dados.puzzles) {
    const imagem = dados.imagens?.[registro.id]
      ? await dataUrlParaBlob(dados.imagens[registro.id])
      : null;
    await salvar(deserialize(registro), imagem);
    n++;
  }
  return n;
}

export function blobParaDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const leitor = new FileReader();
    leitor.onload = () => resolve(leitor.result);
    leitor.onerror = () => reject(leitor.error);
    leitor.readAsDataURL(blob);
  });
}

export async function dataUrlParaBlob(url) {
  return (await fetch(url)).blob();
}
