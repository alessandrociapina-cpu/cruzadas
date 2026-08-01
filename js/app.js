/*
 * app.js — telas e interação do aplicativo.
 *
 * Fluxo: foto -> leitura da grade -> ajuste das casas -> jogo.
 * Tudo roda no aparelho; nada é enviado para lugar nenhum.
 */
import { loadBitmap, toCanvas, detectFromCanvas, normalizeGrid, canvasToBlob } from './imaging.js';
import {
  fromDetection,
  analyze,
  entryAt,
  nextLetterCell,
  progress,
  deserialize,
  LETTER,
  BLOCK,
  CLUE,
  ACROSS,
  DOWN,
} from './puzzle.js';
import * as db from './db.js';

const CELULA_NORMAL = 108; // lado da casa na imagem normalizada
const $ = (id) => document.getElementById(id);

const estado = {
  tela: 'biblioteca',
  bitmap: null,
  deteccao: null,
  normalizada: null,
  imagemUrl: null,
  puzzle: null,
  analise: null,
  cursor: { r: 0, c: 0, dir: ACROSS },
  pincel: CLUE,
  zoom: 1,
};

/* ============================ utilidades ============================ */

let avisoTimer;
function avisar(mensagem, ms = 2600) {
  const el = $('aviso');
  el.textContent = mensagem;
  el.hidden = false;
  clearTimeout(avisoTimer);
  avisoTimer = setTimeout(() => (el.hidden = true), ms);
}

function mostrarTela(nome, titulo) {
  estado.tela = nome;
  for (const secao of document.querySelectorAll('.tela')) {
    secao.hidden = secao.id !== `tela-${nome}`;
  }
  $('titulo-tela').textContent = titulo ?? 'Cruzadas';
  $('voltar').hidden = nome === 'biblioteca';
  $('acoes-barra').innerHTML = '';
}

function acaoBarra(rotulo, aria, aoClicar) {
  const b = document.createElement('button');
  b.className = 'botao-icone';
  b.textContent = rotulo;
  b.setAttribute('aria-label', aria);
  b.addEventListener('click', aoClicar);
  $('acoes-barra').append(b);
  return b;
}

function liberarImagem() {
  if (estado.imagemUrl?.startsWith('blob:')) URL.revokeObjectURL(estado.imagemUrl);
  estado.imagemUrl = null;
}

/* ============================ biblioteca ============================ */

async function abrirBiblioteca() {
  await gravarPendente();
  liberarImagem();
  estado.puzzle = null;
  mostrarTela('biblioteca', 'Cruzadas');
  const registros = await db.listar();
  const lista = $('lista-puzzles');
  lista.innerHTML = '';
  $('biblioteca-vazia').hidden = registros.length > 0;

  for (const registro of registros) {
    const puzzle = deserialize(registro);
    const { filled, total, ratio } = progress(puzzle);
    const item = document.createElement('li');
    item.className = 'item';

    const abrir = document.createElement('button');
    abrir.className = 'item-abrir';
    abrir.innerHTML = `
      <img class="miniatura" alt="" />
      <span style="min-width:0">
        <span class="item-nome"></span>
        <span class="item-detalhe"></span>
        <span class="barra-progresso"><i style="width:${Math.round(ratio * 100)}%"></i></span>
      </span>`;
    abrir.querySelector('.item-nome').textContent = puzzle.title;
    abrir.querySelector('.item-detalhe').textContent =
      `${puzzle.rows}×${puzzle.cols} · ${filled}/${total} letras`;
    abrir.addEventListener('click', () => abrirJogo(puzzle.id));

    const img = abrir.querySelector('.miniatura');
    db.carregarImagem(puzzle.id).then((blob) => {
      if (blob) img.src = URL.createObjectURL(blob);
    });

    const apagar = document.createElement('button');
    apagar.className = 'botao-icone botao-perigo';
    apagar.textContent = '🗑';
    apagar.setAttribute('aria-label', `Apagar ${puzzle.title}`);
    apagar.addEventListener('click', async () => {
      if (!confirm(`Apagar "${puzzle.title}"?`)) return;
      await db.remover(puzzle.id);
      avisar('Cruzada apagada');
      abrirBiblioteca();
    });

    item.append(abrir, apagar);
    lista.append(item);
  }
}

/* ============================ importação ============================ */

async function comecarImportacao(arquivo) {
  try {
    estado.bitmap = await loadBitmap(arquivo);
  } catch {
    avisar('Não consegui abrir essa imagem.');
    return;
  }
  estado.deteccao = null;
  $('giro').value = '0';
  $('sensibilidade').value = '0';
  $('forcar-linhas').value = '';
  $('forcar-colunas').value = '';
  $('titulo-puzzle').value = sugerirNome();
  mostrarTela('importar', 'Ler cruzada');
  await detectar();
}

function sugerirNome() {
  const hoje = new Date();
  return `Cruzada de ${hoje.toLocaleDateString('pt-BR')}`;
}

function opcoesDeteccao() {
  const linhas = parseInt($('forcar-linhas').value, 10);
  const colunas = parseInt($('forcar-colunas').value, 10);
  return {
    bias: Number($('sensibilidade').value) || 0,
    forceRows: Number.isFinite(linhas) && linhas >= 2 ? linhas : undefined,
    forceCols: Number.isFinite(colunas) && colunas >= 2 ? colunas : undefined,
  };
}

async function detectar() {
  if (!estado.bitmap) return;
  $('carregando').hidden = false;
  $('erro-deteccao').hidden = true;
  // deixa o navegador pintar o "lendo…" antes de travar no processamento
  await new Promise((r) => setTimeout(r, 16));
  try {
    const origem = toCanvas(estado.bitmap, Number($('giro').value));
    const deteccao = detectFromCanvas(origem, opcoesDeteccao());
    estado.deteccao = deteccao;
    estado.normalizada = normalizeGrid(deteccao, CELULA_NORMAL);
    desenharPrevia(deteccao);
    const tipo = deteccao.kind === 'setas' ? 'cruzada de setas' : 'cruzada clássica';
    $('resumo-deteccao').textContent =
      `${deteccao.rows} linhas × ${deteccao.cols} colunas — ${tipo}. ` +
      (deteccao.warnings.join(' ') || 'Confira a prévia antes de continuar.');
  } catch (erro) {
    estado.deteccao = null;
    $('erro-deteccao').textContent = erro.message;
    $('erro-deteccao').hidden = false;
    $('resumo-deteccao').textContent = '';
  } finally {
    $('carregando').hidden = true;
  }
}

function desenharPrevia(deteccao) {
  const canvas = $('previa-canvas');
  const largura = Math.min(900, deteccao.canvas.width);
  const escala = largura / deteccao.canvas.width;
  canvas.width = largura;
  canvas.height = Math.round(deteccao.canvas.height * escala);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(deteccao.canvas, 0, 0, canvas.width, canvas.height);

  const k = deteccao.toCanvasScale * escala;
  const canto = (r, c) => {
    const i = (r * (deteccao.cols + 1) + c) * 2;
    return [deteccao.geom.corners[i] * k, deteccao.geom.corners[i + 1] * k];
  };
  ctx.lineWidth = Math.max(1, canvas.width / 500);
  for (let r = 0; r < deteccao.rows; r++) {
    for (let c = 0; c < deteccao.cols; c++) {
      const tipo = deteccao.types[r * deteccao.cols + c];
      const [x0, y0] = canto(r, c);
      const [x1, y1] = canto(r, c + 1);
      const [x2, y2] = canto(r + 1, c + 1);
      const [x3, y3] = canto(r + 1, c);
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.lineTo(x3, y3);
      ctx.closePath();
      ctx.strokeStyle = 'rgba(31,111,235,.85)';
      ctx.stroke();
      if (tipo === CLUE) ctx.fillStyle = 'rgba(31,111,235,.22)';
      else if (tipo === BLOCK) ctx.fillStyle = 'rgba(20,22,26,.55)';
      else continue;
      ctx.fill();
    }
  }
}

/* ============================ ajuste da grade ============================ */

function abrirAjuste() {
  if (!estado.deteccao) {
    avisar('Leia a grade antes de continuar.');
    return;
  }
  estado.puzzle = fromDetection(estado.deteccao, { title: $('titulo-puzzle').value });
  estado.pincel = estado.puzzle.kind === 'setas' ? CLUE : BLOCK;
  liberarImagem();
  mostrarTela('ajustar', 'Ajustar casas');
  atualizarPinceis();
  desenharGradeAjuste();
}

function atualizarPinceis() {
  for (const botao of $('seletor-pincel').querySelectorAll('.pincel')) {
    botao.setAttribute('aria-pressed', String(Number(botao.dataset.tipo) === estado.pincel));
  }
}

function ladoCasa(puzzle, area, zoom = 1) {
  const disponivel = Math.min(area.clientWidth || window.innerWidth, window.innerWidth) - 36;
  const cabendo = Math.max(26, Math.min(56, Math.floor(disponivel / puzzle.cols)));
  return Math.round(cabendo * zoom);
}

/** Imagem que fornece os recortes das casas de dica. */
function urlGrade() {
  if (!estado.imagemUrl && estado.normalizada?.toDataURL) {
    estado.imagemUrl = estado.normalizada.toDataURL('image/jpeg', 0.85);
  }
  return estado.imagemUrl;
}

/** Aplica o recorte da foto correspondente à casa (r,c) como fundo do elemento. */
function aplicarRecorte(el, puzzle, r, c, lado, url, margem = 0) {
  if (!url) {
    el.classList.add('sem-imagem');
    return;
  }
  // com margem, o recorte mostra um pouco além da casa — útil quando a linha
  // detectada cai por dentro do enunciado e cortaria a última palavra
  const escala = lado / (1 + 2 * margem);
  el.style.backgroundImage = `url(${url})`;
  el.style.backgroundSize = `${puzzle.cols * escala}px ${puzzle.rows * escala}px`;
  el.style.backgroundPosition = `${-(c - margem) * escala}px ${-(r - margem) * escala}px`;
}

function desenharGradeAjuste() {
  const puzzle = estado.puzzle;
  const area = $('area-ajuste');
  area.innerHTML = '';
  const lado = ladoCasa(puzzle, area);
  const url = urlGrade();

  const grade = document.createElement('div');
  grade.className = 'grade';
  grade.style.gridTemplateColumns = `repeat(${puzzle.cols}, ${lado}px)`;
  grade.style.setProperty('--casa', `${lado}px`);

  let pintando = false;
  for (let r = 0; r < puzzle.rows; r++) {
    for (let c = 0; c < puzzle.cols; c++) {
      const casa = document.createElement('button');
      casa.type = 'button';
      casa.className = 'casa';
      casa.dataset.r = r;
      casa.dataset.c = c;
      pintarCasaAjuste(casa, puzzle, r, c, lado, url);
      casa.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        pintando = true;
        aplicarPincel(casa);
      });
      casa.addEventListener('pointerenter', () => {
        if (pintando) aplicarPincel(casa);
      });
      grade.append(casa);
    }
  }
  const soltar = () => (pintando = false);
  window.addEventListener('pointerup', soltar);
  window.addEventListener('pointercancel', soltar);

  area.append(grade);
}

function pintarCasaAjuste(casa, puzzle, r, c, lado, url) {
  const tipo = puzzle.cells[r * puzzle.cols + c];
  casa.className = 'casa';
  casa.style.backgroundImage = '';
  if (tipo === BLOCK) casa.classList.add('preta');
  if (tipo === CLUE) {
    casa.classList.add('dica');
    aplicarRecorte(casa, puzzle, r, c, lado, url);
  }
}

function aplicarPincel(casa) {
  const puzzle = estado.puzzle;
  const r = Number(casa.dataset.r);
  const c = Number(casa.dataset.c);
  const i = r * puzzle.cols + c;
  if (puzzle.cells[i] === estado.pincel) return;
  puzzle.cells[i] = estado.pincel;
  const lado = ladoCasa(puzzle, $('area-ajuste'));
  pintarCasaAjuste(casa, puzzle, r, c, lado, urlGrade());
}

async function salvarAjuste() {
  const puzzle = estado.puzzle;
  // o nome só vem do formulário quando a cruzada acabou de ser lida da foto
  if (estado.deteccao) puzzle.title = $('titulo-puzzle').value.trim() || sugerirNome();
  let imagem = null;
  if (estado.normalizada) {
    imagem = await canvasToBlob(estado.normalizada, 'image/jpeg', 0.82);
  }
  await db.salvar(puzzle, imagem);
  avisar('Cruzada salva');
  await abrirJogo(puzzle.id);
}

/* ============================ jogo ============================ */

async function abrirJogo(id) {
  const puzzle = await db.carregar(id);
  if (!puzzle) {
    avisar('Cruzada não encontrada.');
    return abrirBiblioteca();
  }
  estado.puzzle = puzzle;
  estado.analise = analyze(puzzle);
  estado.deteccao = null;
  estado.normalizada = null;
  liberarImagem();
  const blob = await db.carregarImagem(id);
  estado.imagemUrl = blob ? URL.createObjectURL(blob) : null;

  const primeira = estado.analise.entries[0];
  estado.cursor = primeira
    ? { r: primeira.row, c: primeira.col, dir: primeira.dir }
    : { r: 0, c: 0, dir: ACROSS };

  mostrarTela('jogar', puzzle.title);
  acaoBarra('−', 'Diminuir a grade', () => mudarZoom(-0.2));
  acaoBarra('+', 'Aumentar a grade', () => mudarZoom(0.2));
  acaoBarra('⋮', 'Mais opções', abrirMenuJogo);

  desenharTeclado();
  desenharJogo();
}

function mudarZoom(passo) {
  estado.zoom = Math.min(2.6, Math.max(0.8, +(estado.zoom + passo).toFixed(2)));
  desenharJogo();
}

function abrirMenuJogo() {
  const puzzle = estado.puzzle;
  const escolha = prompt(
    'Digite o número da opção:\n1 — Ajustar as casas da grade\n2 — Apagar todas as letras\n3 — Renomear'
  );
  if (escolha === '1') {
    mostrarTela('ajustar', 'Ajustar casas');
    atualizarPinceis();
    desenharGradeAjuste();
  } else if (escolha === '2') {
    if (!confirm('Apagar todas as letras preenchidas?')) return;
    puzzle.letters = puzzle.letters.map(() => '');
    salvarProgresso();
    desenharJogo();
    avisar('Respostas apagadas');
  } else if (escolha === '3') {
    const nome = prompt('Novo nome:', puzzle.title);
    if (!nome?.trim()) return;
    puzzle.title = nome.trim();
    $('titulo-tela').textContent = puzzle.title;
    salvarProgresso();
  }
}

function desenharJogo() {
  const puzzle = estado.puzzle;
  estado.analise = analyze(puzzle);
  const area = $('area-jogo');
  area.innerHTML = '';
  const lado = ladoCasa(puzzle, area, estado.zoom);
  const url = estado.imagemUrl;

  const grade = document.createElement('div');
  grade.className = 'grade';
  grade.style.gridTemplateColumns = `repeat(${puzzle.cols}, ${lado}px)`;
  grade.style.setProperty('--casa', `${lado}px`);

  const atual = entradaAtual();
  const naPalavra = new Set(atual ? atual.cells : []);

  for (let r = 0; r < puzzle.rows; r++) {
    for (let c = 0; c < puzzle.cols; c++) {
      const i = r * puzzle.cols + c;
      const tipo = puzzle.cells[i];
      const casa = document.createElement('button');
      casa.type = 'button';
      casa.className = 'casa';
      casa.dataset.r = r;
      casa.dataset.c = c;

      if (tipo === BLOCK) {
        casa.classList.add('preta');
        casa.tabIndex = -1;
      } else if (tipo === CLUE) {
        casa.classList.add('dica');
        aplicarRecorte(casa, puzzle, r, c, lado, url);
        if (atual && atual.clueCell === i) casa.classList.add('alvo');
        casa.addEventListener('click', () => abrirDica(i));
      } else {
        if (puzzle.kind !== 'setas' && estado.analise.numbers[i]) {
          const n = document.createElement('span');
          n.className = 'numero';
          n.textContent = estado.analise.numbers[i];
          casa.append(n);
        }
        casa.append(document.createTextNode(puzzle.letters[i] || ''));
        if (naPalavra.has(i)) casa.classList.add('na-palavra');
        if (r === estado.cursor.r && c === estado.cursor.c) casa.classList.add('ativa');
        casa.addEventListener('click', () => tocarCasa(r, c));
      }
      grade.append(casa);
    }
  }
  area.append(grade);
  mostrarDicaAtual();
  rolarAteCursor(area, lado);
}

function rolarAteCursor(area, lado) {
  const alvo = area.querySelector('.casa.ativa');
  if (!alvo) return;
  const caixa = alvo.getBoundingClientRect();
  const areaCaixa = area.getBoundingClientRect();
  if (caixa.top < areaCaixa.top + lado || caixa.bottom > areaCaixa.bottom - lado) {
    alvo.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

function entradaAtual() {
  const { r, c, dir } = estado.cursor;
  if (!estado.analise) return null;
  return entryAt(estado.analise, estado.puzzle, r, c, dir);
}

function mostrarDicaAtual() {
  const entrada = entradaAtual();
  const rotulo = $('dica-rotulo');
  const texto = $('dica-texto');
  texto.innerHTML = '';
  if (!entrada) {
    rotulo.textContent = '';
    texto.textContent = 'Toque numa casa para começar.';
    return;
  }
  const direcao = entrada.dir === ACROSS ? 'Horizontal' : 'Vertical';
  rotulo.textContent =
    estado.puzzle.kind === 'setas'
      ? `${direcao} · ${entrada.length}`
      : `${entrada.number} ${direcao} · ${entrada.length}`;

  const escrita = estado.puzzle.clues[entrada.id];
  if (escrita) {
    texto.textContent = escrita;
    return;
  }
  // sem texto digitado, mostramos o recorte da foto com o enunciado impresso
  if (entrada.clueCell != null && estado.imagemUrl) {
    const puzzle = estado.puzzle;
    const r = Math.floor(entrada.clueCell / puzzle.cols);
    const c = entrada.clueCell % puzzle.cols;
    const alt = 'Enunciado impresso na grade';
    const caixa = document.createElement('span');
    caixa.className = 'casa dica dica-imagem';
    caixa.style.cssText = 'display:inline-block;width:64px;height:64px;border-radius:6px';
    aplicarRecorte(caixa, puzzle, r, c, 64, estado.imagemUrl, 0.1);
    caixa.setAttribute('role', 'img');
    caixa.setAttribute('aria-label', alt);
    texto.append(caixa);
    return;
  }
  texto.textContent =
    estado.puzzle.kind === 'setas'
      ? 'Toque na casa da dica para ler o enunciado.'
      : 'Toque aqui para escrever a dica desta palavra.';
}

/**
 * Toque numa casa de dica: mostra o enunciado impresso, ampliado e legível,
 * e deixa pular para a palavra correspondente ou digitar o texto.
 */
function abrirDica(indice) {
  const puzzle = estado.puzzle;
  const alvos = estado.analise.entries.filter((e) => e.clueCell === indice);
  const r = Math.floor(indice / puzzle.cols);
  const c = indice % puzzle.cols;

  const fundo = document.createElement('div');
  fundo.className = 'modal';
  const caixa = document.createElement('div');
  caixa.className = 'modal-caixa';

  const lado = Math.min(300, Math.round(window.innerWidth * 0.7));
  const recorte = document.createElement('div');
  recorte.className = 'recorte-ampliado';
  recorte.style.width = `${lado}px`;
  recorte.style.height = `${lado}px`;
  aplicarRecorte(recorte, puzzle, r, c, lado, estado.imagemUrl, 0.14);
  caixa.append(recorte);

  for (const entrada of alvos) {
    const texto = puzzle.clues[entrada.id];
    const b = document.createElement('button');
    b.className = 'botao';
    b.textContent =
      `${entrada.dir === ACROSS ? '→ Horizontal' : '↓ Vertical'} · ${entrada.length} letras` +
      (texto ? ` — ${texto}` : '');
    b.addEventListener('click', () => {
      fundo.remove();
      estado.cursor = { r: entrada.row, c: entrada.col, dir: entrada.dir };
      desenharJogo();
    });
    caixa.append(b);
  }

  if (alvos.length) {
    const escrever = document.createElement('button');
    escrever.className = 'botao';
    escrever.textContent = '✎ Escrever o enunciado';
    escrever.addEventListener('click', () => {
      const entrada = alvos[0];
      const texto = prompt('Enunciado desta dica:', puzzle.clues[entrada.id] ?? '');
      if (texto === null) return;
      if (texto.trim()) puzzle.clues[entrada.id] = texto.trim();
      else delete puzzle.clues[entrada.id];
      salvarProgresso();
      fundo.remove();
      desenharJogo();
    });
    caixa.append(escrever);
  } else {
    const aviso = document.createElement('p');
    aviso.className = 'dica-texto';
    aviso.textContent = 'Esta casa não fica ao lado de nenhuma palavra na grade.';
    caixa.append(aviso);
  }

  const fechar = document.createElement('button');
  fechar.className = 'botao botao-primario';
  fechar.textContent = 'Fechar';
  fechar.addEventListener('click', () => fundo.remove());
  caixa.append(fechar);

  fundo.addEventListener('click', (ev) => {
    if (ev.target === fundo) fundo.remove();
  });
  fundo.append(caixa);
  document.body.append(fundo);
}

function tocarCasa(r, c) {
  const igual = estado.cursor.r === r && estado.cursor.c === c;
  const dir = igual ? (estado.cursor.dir === ACROSS ? DOWN : ACROSS) : estado.cursor.dir;
  estado.cursor = { r, c, dir };
  // se não existe palavra nessa direção, entryAt devolve a outra
  const entrada = entradaAtual();
  if (entrada) estado.cursor.dir = entrada.dir;
  desenharJogo();
}

function escrever(letra) {
  const puzzle = estado.puzzle;
  const { r, c } = estado.cursor;
  const i = r * puzzle.cols + c;
  if (puzzle.cells[i] !== LETTER) return;
  puzzle.letters[i] = letra;
  const passo = estado.cursor.dir === ACROSS ? [0, 1] : [1, 0];
  const proxima = nextLetterCell(puzzle, r, c, passo[0], passo[1]);
  const entrada = entradaAtual();
  // só avança dentro da mesma palavra
  if (proxima && entrada && entrada.cells.includes(proxima.r * puzzle.cols + proxima.c)) {
    estado.cursor = { ...estado.cursor, r: proxima.r, c: proxima.c };
  }
  salvarProgresso();
  desenharJogo();
}

function apagar() {
  const puzzle = estado.puzzle;
  const { r, c } = estado.cursor;
  const i = r * puzzle.cols + c;
  if (puzzle.letters[i]) {
    puzzle.letters[i] = '';
  } else {
    const passo = estado.cursor.dir === ACROSS ? [0, -1] : [-1, 0];
    const anterior = nextLetterCell(puzzle, r, c, passo[0], passo[1]);
    const entrada = entradaAtual();
    if (anterior && entrada && entrada.cells.includes(anterior.r * puzzle.cols + anterior.c)) {
      estado.cursor = { ...estado.cursor, r: anterior.r, c: anterior.c };
      puzzle.letters[anterior.r * puzzle.cols + anterior.c] = '';
    }
  }
  salvarProgresso();
  desenharJogo();
}

function mover(dr, dc) {
  const proxima = nextLetterCell(estado.puzzle, estado.cursor.r, estado.cursor.c, dr, dc);
  if (!proxima) return;
  estado.cursor = { ...estado.cursor, r: proxima.r, c: proxima.c };
  desenharJogo();
}

function palavraSeguinte(passo) {
  const entradas = estado.analise.entries;
  if (!entradas.length) return;
  const atual = entradaAtual();
  const indice = atual ? entradas.findIndex((e) => e.id === atual.id) : -1;
  const proxima = entradas[(indice + passo + entradas.length) % entradas.length];
  estado.cursor = { r: proxima.row, c: proxima.col, dir: proxima.dir };
  desenharJogo();
}

// O salvamento é adiado para não gravar a cada letra, mas a cruzada pendente
// fica guardada aqui: sair da tela não pode perder o que foi escrito.
let salvarTimer;
let pendente = null;

function salvarProgresso(puzzle = estado.puzzle) {
  pendente = puzzle;
  clearTimeout(salvarTimer);
  salvarTimer = setTimeout(gravarPendente, 400);
}

async function gravarPendente() {
  clearTimeout(salvarTimer);
  if (!pendente) return;
  const puzzle = pendente;
  pendente = null;
  await db.salvar(puzzle);
}

/* ============================ teclado na tela ============================ */

function desenharTeclado() {
  const teclado = $('teclado');
  teclado.innerHTML = '';
  const linhas = ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'];
  linhas.forEach((linha, indice) => {
    const div = document.createElement('div');
    div.className = 'linha-teclas';
    if (indice === 2) div.append(criarTecla('↹', 'tecla-larga', () => palavraSeguinte(1)));
    for (const letra of linha) div.append(criarTecla(letra, '', () => escrever(letra)));
    if (indice === 2) div.append(criarTecla('⌫', 'tecla-larga', apagar));
    teclado.append(div);
  });
}

function criarTecla(rotulo, extra, aoTocar) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `tecla ${extra}`.trim();
  b.textContent = rotulo;
  b.addEventListener('click', (ev) => {
    ev.preventDefault();
    aoTocar();
  });
  return b;
}

/* ============================ eventos globais ============================ */

document.addEventListener('keydown', (ev) => {
  if (estado.tela !== 'jogar') return;
  const alvo = ev.target;
  if (alvo instanceof HTMLInputElement || alvo instanceof HTMLTextAreaElement) return;
  if (/^[a-zA-ZçÇáàâãéêíóôõúüÁÀÂÃÉÊÍÓÔÕÚÜ]$/.test(ev.key)) {
    ev.preventDefault();
    escrever(ev.key.toUpperCase());
  } else if (ev.key === 'Backspace') {
    ev.preventDefault();
    apagar();
  } else if (ev.key === 'ArrowRight') mover(0, 1);
  else if (ev.key === 'ArrowLeft') mover(0, -1);
  else if (ev.key === 'ArrowDown') mover(1, 0);
  else if (ev.key === 'ArrowUp') mover(-1, 0);
  else if (ev.key === ' ') {
    ev.preventDefault();
    tocarCasa(estado.cursor.r, estado.cursor.c);
  } else if (ev.key === 'Tab') {
    ev.preventDefault();
    palavraSeguinte(ev.shiftKey ? -1 : 1);
  }
});

$('dica-atual').addEventListener('click', () => {
  const entrada = entradaAtual();
  if (!entrada) return;
  const texto = prompt('Dica desta palavra:', estado.puzzle.clues[entrada.id] ?? '');
  if (texto === null) return;
  if (texto.trim()) estado.puzzle.clues[entrada.id] = texto.trim();
  else delete estado.puzzle.clues[entrada.id];
  salvarProgresso();
  mostrarDicaAtual();
});

$('voltar').addEventListener('click', () => {
  // ajuste aberto a partir de um jogo em andamento volta para o jogo
  if (estado.tela === 'ajustar' && !estado.deteccao && estado.puzzle?.id) {
    return abrirJogo(estado.puzzle.id);
  }
  abrirBiblioteca();
});

$('entrada-camera').addEventListener('change', (ev) => {
  const arquivo = ev.target.files?.[0];
  ev.target.value = '';
  if (arquivo) comecarImportacao(arquivo);
});

$('entrada-arquivo').addEventListener('change', (ev) => {
  const arquivo = ev.target.files?.[0];
  ev.target.value = '';
  if (arquivo) comecarImportacao(arquivo);
});

$('giro').addEventListener('change', detectar);
$('reler').addEventListener('click', detectar);
$('sensibilidade').addEventListener('change', detectar);
$('confirmar-grade').addEventListener('click', abrirAjuste);
$('cancelar-ajuste').addEventListener('click', () => {
  if (estado.deteccao) mostrarTela('importar', 'Ler cruzada');
  else abrirBiblioteca();
});
$('salvar-ajuste').addEventListener('click', salvarAjuste);

$('seletor-pincel').addEventListener('click', (ev) => {
  const botao = ev.target.closest('.pincel');
  if (!botao) return;
  estado.pincel = Number(botao.dataset.tipo);
  atualizarPinceis();
});

$('exportar').addEventListener('click', async () => {
  const dados = await db.exportarTudo();
  const blob = new Blob([JSON.stringify(dados)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `cruzadas-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

$('importar').addEventListener('change', async (ev) => {
  const arquivo = ev.target.files?.[0];
  ev.target.value = '';
  if (!arquivo) return;
  try {
    const n = await db.importarTudo(JSON.parse(await arquivo.text()));
    avisar(`${n} cruzada(s) importada(s)`);
    abrirBiblioteca();
  } catch (erro) {
    avisar(erro.message);
  }
});

// fechar o app ou trocar de aba não pode perder o que estava escrito
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') gravarPendente();
});
window.addEventListener('pagehide', gravarPendente);

window.addEventListener('resize', () => {
  if (estado.tela === 'jogar') desenharJogo();
  else if (estado.tela === 'ajustar') desenharGradeAjuste();
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

// exposto para os testes de interface dirigirem o app sem depender de layout
window.__cruzadas = { estado, db, abrirBiblioteca, comecarImportacao, detectar, abrirAjuste };

abrirBiblioteca();
