/*
 * Verifica o app do jeito que o GitHub Pages serve: dentro de um subcaminho
 * (https://usuario.github.io/cruzadas/) e não na raiz do domínio. Confere
 * também a promessa de PWA: depois da primeira visita, abrir sem internet.
 *
 *   node test/visual/pages.mjs [pasta-de-saída]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { serve } from './detect-photo.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const saida = process.argv[2] ?? 'capturas';
fs.mkdirSync(saida, { recursive: true });

// monta uma raiz falsa em que o app vive em /cruzadas/, como no Pages
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-'));
fs.symlinkSync(ROOT, path.join(base, 'cruzadas'));

const { server, port } = await serve(base);
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  locale: 'pt-BR',
});
const page = await context.newPage();

const erros = [];
page.on('pageerror', (e) => erros.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') erros.push(m.text());
});
const confere = (condicao, mensagem) => {
  if (!condicao) throw new Error(`FALHOU: ${mensagem}`);
  console.log('ok —', mensagem);
};

const url = `http://127.0.0.1:${port}/cruzadas/`;
await page.goto(url);
await page.waitForFunction(() => window.__cruzadas);
confere(await page.isVisible('#tela-biblioteca'), 'o app abre servido em /cruzadas/');

// o manifesto e os ícones precisam resolver a partir do subcaminho
const recursos = await page.evaluate(async () => {
  const manifesto = await fetch('manifest.webmanifest').then((r) => r.json());
  const alvos = ['icons/icone.svg', 'icons/icone-192.png', 'css/estilo.css'];
  const situacao = {};
  for (const alvo of alvos) situacao[alvo] = (await fetch(alvo)).status;
  return { manifesto, situacao, inicio: new URL(manifesto.start_url, location.href).href };
});
confere(recursos.manifesto.name === 'Cruzadas', 'o manifesto é lido no subcaminho');
confere(
  Object.values(recursos.situacao).every((s) => s === 200),
  `ícones e estilo respondem 200 (${JSON.stringify(recursos.situacao)})`
);
confere(recursos.inicio === url, `start_url aponta para o próprio app (${recursos.inicio})`);

// espera o service worker assumir o controle da página
await page.waitForFunction(
  async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return !!reg?.active && !!navigator.serviceWorker.controller;
  },
  null,
  { timeout: 30000 }
);
const escopo = await page.evaluate(
  async () => (await navigator.serviceWorker.getRegistration()).scope
);
confere(escopo.endsWith('/cruzadas/'), `o service worker controla só o app (${escopo})`);

// guarda uma cruzada e derruba a rede
await page.setInputFiles('#entrada-arquivo', 'test/fixtures/cruzada-classica.png');
await page.waitForFunction(() => document.getElementById('carregando').hidden, null, {
  timeout: 60000,
});
await page.click('#confirmar-grade');
await page.waitForSelector('#tela-ajustar:not([hidden])');
await page.click('#salvar-ajuste');
await page.waitForSelector('#tela-jogar:not([hidden])');

await context.setOffline(true);
await page.reload();
await page.waitForFunction(() => window.__cruzadas, null, { timeout: 30000 });
confere(await page.isVisible('#tela-biblioteca'), 'o app abre de novo sem internet');
await page.waitForSelector('#lista-puzzles .item');
confere(
  (await page.locator('#lista-puzzles .item').count()) === 1,
  'a cruzada salva continua disponível offline'
);
await page.click('#lista-puzzles .item-abrir');
await page.waitForSelector('#tela-jogar:not([hidden])');
confere(
  (await page.locator('#area-jogo .casa').count()) === 100,
  'dá para jogar offline, com a grade completa'
);
await page.screenshot({ path: path.join(saida, 'offline.png') });

await context.setOffline(false);
await browser.close();
server.close();
fs.rmSync(base, { recursive: true, force: true });

if (erros.length) {
  console.error('\nErros no console do navegador:');
  for (const e of erros) console.error(' -', e);
  process.exit(1);
}
console.log('\nTudo certo para publicar num subcaminho.');
