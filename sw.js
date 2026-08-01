/*
 * sw.js — service worker: deixa o aplicativo abrir e jogar sem internet.
 * Estratégia: os arquivos do app vão para o cache na instalação e são servidos
 * de lá; a rede só é consultada em segundo plano para atualizar.
 */
const VERSAO = 'cruzadas-v1';
const ARQUIVOS = [
  './',
  'index.html',
  'css/estilo.css',
  'js/app.js',
  'js/detector.js',
  'js/imaging.js',
  'js/puzzle.js',
  'js/db.js',
  'manifest.webmanifest',
  'icons/icone.svg',
  'icons/icone-192.png',
  'icons/icone-512.png',
  'icons/icone-mascara.png',
];

self.addEventListener('install', (evento) => {
  evento.waitUntil(
    caches
      .open(VERSAO)
      .then((cache) => cache.addAll(ARQUIVOS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (evento) => {
  evento.waitUntil(
    caches
      .keys()
      .then((chaves) =>
        Promise.all(chaves.filter((c) => c !== VERSAO).map((c) => caches.delete(c)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (evento) => {
  const req = evento.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  evento.respondWith(
    caches.match(req).then((guardado) => {
      const rede = fetch(req)
        .then((resposta) => {
          if (resposta.ok) {
            const copia = resposta.clone();
            caches.open(VERSAO).then((cache) => cache.put(req, copia));
          }
          return resposta;
        })
        .catch(() => guardado ?? caches.match('index.html'));
      return guardado ?? rede;
    })
  );
});
