# Cruzadas

Aplicativo (PWA) que lê a **foto de uma palavra cruzada** e a transforma numa
grade preenchível na tela do celular. Funciona sem internet e guarda tudo no
próprio aparelho.

Reconhece os dois formatos que aparecem nos jornais:

- **cruzada de setas** (direta): o enunciado vem impresso dentro de uma casa da
  grade. O aplicativo recorta a foto casa por casa, então a dica aparece do
  jeitinho que está no papel — sem ninguém precisar digitar nada;
- **cruzada clássica**: casas pretas separam as palavras, que são numeradas
  automaticamente; as dicas podem ser digitadas conforme se joga.

## Como usar

1. Abra o aplicativo e toque em **Fotografar cruzada** (ou escolha uma imagem
   já salva).
2. Confira a prévia: a grade lida aparece desenhada por cima da foto. Se a
   leitura tiver errado o número de linhas/colunas ou o giro da foto, ajuste ali
   mesmo e toque em **Ler de novo**.
3. Na tela de ajuste, toque (ou arraste) para corrigir alguma casa que tenha
   saído com o tipo errado.
4. Jogue: toque numa casa e escreva. Tocar de novo na mesma casa alterna entre
   horizontal e vertical; tocar numa casa de dica mostra o enunciado ampliado.

O progresso é salvo sozinho. Em **Backup** dá para exportar tudo (grades,
imagens e respostas) num arquivo e importar depois em outro aparelho.

### Instalar no celular

Abra o endereço no navegador e use "Adicionar à tela de início". O aplicativo
passa a abrir em tela cheia e continua funcionando offline.

## Como a leitura da imagem funciona

Tudo acontece no próprio navegador, sem enviar a foto para lugar nenhum
(`js/detector.js`, sem dependências):

1. **Redução e binarização adaptativa** (Bradley) — tolera sombra e iluminação
   irregular de foto de celular.
2. **Correção de inclinação**: testa ângulos e fica com o que deixa as
   projeções de tinta mais "picudas".
3. **Retângulo da grade**: maior componente conexo de tinta.
4. **Passo da grade por autocorrelação** do perfil de tinta, depois de um
   *top-hat* que apaga os platôs largos (casas pretas, blocos de texto) e deixa
   só os picos estreitos das linhas. É o que faz a leitura sobreviver a papel
   ondulado, onde nenhuma linha fica reta de ponta a ponta.
5. **Regularização e aparo**: a rede é reajustada com passo constante e as
   faixas das pontas que não são cruzadas pelas linhas perpendiculares (fios da
   diagramação do jornal) são descartadas.
6. **Inclinação por linha**: cada linha da grade é medida em faixas e ganha sua
   própria reta, o que endireita a distorção do papel.
7. **Tipo de cada casa**: conta as manchas de tinta no miolo — enunciado espalha
   uma mancha por letra, casa preta é uma mancha só e casa vazia não tem
   nenhuma.

Por fim, `js/imaging.js` reamostra a foto numa imagem onde toda casa é um
quadrado de lado fixo (uma transformação afim por casa), e é dela que saem os
recortes dos enunciados exibidos na grade.

## Estrutura

```
index.html            uma página, quatro telas (biblioteca, importação, ajuste, jogo)
css/estilo.css        interface pensada primeiro para celular, tema claro/escuro
js/detector.js        leitura da grade a partir da imagem (sem DOM, testável)
js/imaging.js         ponte com o Canvas: giro, endireitamento e recortes
js/puzzle.js          modelo: casas, palavras, numeração e navegação
js/db.js              banco local em IndexedDB + backup em JSON
js/app.js             telas e interação
sw.js                 service worker (funciona offline)
test/                 testes automatizados
```

## Testes

```bash
npm run testar        # testes do detector e do modelo (Node, sem navegador)
npm run testar:fluxo  # percorre o app inteiro num Chromium e salva capturas
npm run diagnostico   # desenha a grade lida por cima da foto, para inspeção
npm run servir        # sobe um servidor local para abrir o app
```

Os testes do detector usam imagens sintéticas (`test/synth.mjs`) com ruído,
sombra e inclinação; o teste de fluxo usa uma **foto real de jornal**
(`test/fixtures/cruzada-jornal.jpg`) e confere o que foi lido casa a casa na
primeira fileira, além de escrever, salvar, fechar e reabrir a cruzada.

Os scripts com navegador precisam do Playwright instalado (`npm install`).
