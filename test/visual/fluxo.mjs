/*
 * Percorre o aplicativo inteiro num Chromium com tela de celular: importa a
 * foto, lê a grade, salva, joga e confere a persistência. Tira uma captura de
 * cada etapa em `capturas/`.
 *
 *   node test/visual/fluxo.mjs [pasta-de-saída]
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { serve } from './detect-photo.mjs';

const saida = process.argv[2] ?? 'capturas';
fs.mkdirSync(saida, { recursive: true });

const { server, port } = await serve();
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 390, height: 844 }, // formato de celular
  deviceScaleFactor: 2,
  hasTouch: true,
  isMobile: true,
  locale: 'pt-BR',
});

const erros = [];
page.on('pageerror', (e) => erros.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') erros.push(m.text());
});

const captura = (nome) => page.screenshot({ path: path.join(saida, `${nome}.png`) });
const confere = (condicao, mensagem) => {
  if (!condicao) throw new Error(`FALHOU: ${mensagem}`);
  console.log('ok —', mensagem);
};

await page.goto(`http://127.0.0.1:${port}/index.html`);
await page.waitForFunction(() => window.__cruzadas);
await captura('1-biblioteca');
confere(await page.isVisible('#biblioteca-vazia'), 'biblioteca começa vazia');

/** Manda uma imagem para o app e espera a leitura terminar de fato. */
async function importar(arquivo) {
  await page.evaluate(() => {
    window.__cruzadas.estado.deteccao = 'aguardando';
  });
  await page.setInputFiles('#entrada-arquivo', arquivo);
  await page.waitForSelector('#tela-importar:not([hidden])');
  await page.waitForFunction(
    () =>
      window.__cruzadas.estado.deteccao !== 'aguardando' &&
      document.getElementById('carregando').hidden,
    null,
    { timeout: 60000 }
  );
}

// ---- importa a foto de verdade pelo seletor de arquivo ----
await importar('test/fixtures/cruzada-jornal.jpg');
await captura('2-importacao');

const resumo = await page.textContent('#resumo-deteccao');
console.log('   resumo:', resumo.trim());
confere(!(await page.isVisible('#erro-deteccao')), 'a leitura da foto não deu erro');
confere(/setas/.test(resumo), 'reconheceu que é uma cruzada de setas');

// a primeira fileira foi conferida à mão contra a foto original
const linha0 = await page.evaluate(() => {
  const d = window.__cruzadas.estado.deteccao;
  return [...d.types]
    .slice(0, d.cols)
    .map((t) => '.#?'[t])
    .join('');
});
confere(linha0 === '?.?.???.???', `a primeira fileira saiu correta (${linha0})`);

// ---- ajuste ----
await page.click('#confirmar-grade');
await page.waitForSelector('#tela-ajustar:not([hidden])');
await captura('3-ajuste');
const totalCasas = await page.locator('#area-ajuste .casa').count();
const casasDica = await page.locator('#area-ajuste .casa.dica').count();
const casasPretas = await page.locator('#area-ajuste .casa.preta').count();
confere(totalCasas === 176, `a grade de ajuste montou ${totalCasas} casas`);
confere(casasDica > 35, `${casasDica} casas de dica trazem o recorte da foto`);
confere(casasPretas === 0, 'a cruzada de setas não inventou casas pretas');

// ---- salva e joga ----
await page.click('#salvar-ajuste');
await page.waitForSelector('#tela-jogar:not([hidden])');
await captura('4-jogo');

// escreve uma palavra usando o teclado da tela
const primeiraLivre = page.locator('#area-jogo .casa:not(.preta):not(.dica)').first();
await primeiraLivre.click();
for (const letra of 'SOL') await page.click(`#teclado .tecla:text-is("${letra}")`);
await captura('5-preenchendo');
const escritas = await page
  .locator('#area-jogo .casa')
  .evaluateAll((casas) =>
    casas.map((c) => c.childNodes[c.childNodes.length - 1]?.textContent?.trim() ?? '').join('')
  );
confere(escritas.includes('SOL'), 'as letras digitadas aparecem na grade');

// apaga a última
await page.click('#teclado .tecla:text-is("⌫")');
confere(
  (
    await page
      .locator('#area-jogo .casa')
      .evaluateAll((casas) =>
        casas.map((c) => c.childNodes[c.childNodes.length - 1]?.textContent?.trim() ?? '').join('')
      )
  ).includes('SO'),
  'a tecla apagar remove a última letra'
);

// ---- volta para a biblioteca e reabre: o progresso tem que estar salvo ----
await page.click('#voltar');
await page.waitForSelector('#tela-biblioteca:not([hidden])');
await page.waitForSelector('#lista-puzzles .item');
await captura('6-biblioteca-com-cruzada');
const detalhe = await page.textContent('#lista-puzzles .item-detalhe');
confere(/\d+×\d+/.test(detalhe), `a cruzada aparece na lista (${detalhe.trim()})`);

await page.click('#lista-puzzles .item-abrir');
await page.waitForSelector('#tela-jogar:not([hidden])');
const depois = await page
  .locator('#area-jogo .casa')
  .evaluateAll((casas) =>
    casas.map((c) => c.childNodes[c.childNodes.length - 1]?.textContent?.trim() ?? '').join('')
  );
confere(depois.includes('SO'), 'as letras continuam lá depois de fechar e reabrir');
await captura('7-reaberto');

// ---- o outro formato: cruzada clássica, com casas pretas e numeração ----
await page.click('#voltar');
await page.waitForSelector('#tela-biblioteca:not([hidden])');
await importar('test/fixtures/cruzada-classica.png');
const resumoClassica = await page.textContent('#resumo-deteccao');
confere(
  /clássica/.test(resumoClassica),
  `reconheceu a cruzada clássica (${resumoClassica.trim()})`
);
await page.click('#confirmar-grade');
await page.waitForSelector('#tela-ajustar:not([hidden])');
const pretas = await page.locator('#area-ajuste .casa.preta').count();
confere(pretas === 20, `as 20 casas pretas do padrão foram encontradas (${pretas})`);
await page.click('#salvar-ajuste');
await page.waitForSelector('#tela-jogar:not([hidden])');
await captura('8-classica');
confere(
  (await page.locator('#area-jogo .casa .numero').count()) > 10,
  'a cruzada clássica mostra a numeração das palavras'
);

// ---- escrever a dica de uma palavra na cruzada clássica ----
page.once('dialog', (d) => d.accept('Astro que ilumina o dia'));
await page.click('#dica-atual');
confere(
  (await page.textContent('#dica-texto')).includes('Astro que ilumina'),
  'a dica escrita à mão aparece na barra'
);

// ---- backup: exportar e reimportar não pode perder nada ----
const backup = await page.evaluate(async () => {
  const dados = await window.__cruzadas.db.exportarTudo();
  const antes = dados.puzzles.length;
  const importadas = await window.__cruzadas.db.importarTudo(dados);
  const depois = (await window.__cruzadas.db.listar()).length;
  return { antes, importadas, depois, imagens: Object.keys(dados.imagens).length };
});
confere(
  backup.antes === 2 && backup.depois === 2 && backup.imagens === 2,
  `backup exporta e reimporta as ${backup.antes} cruzadas com suas imagens`
);

// ---- service worker registrado (requisito de PWA) ----
const sw = await page.evaluate(async () => {
  const reg = await navigator.serviceWorker.getRegistration();
  return !!reg;
});
confere(sw, 'service worker registrado');

if (erros.length) {
  console.error('\nErros no console do navegador:');
  for (const e of erros) console.error(' -', e);
}

await browser.close();
server.close();
console.log(`\nCapturas em ${saida}/`);
if (erros.length) process.exit(1);
