# Sessão 2026-07-05 — OBRA 300: fiscal estendido + painel da matriz fatiado

> Handoff. Contexto: o dono perguntou "o sistema está saudável ou tem arquivo pedindo
> refatoração?" → censo completo → decisão dele: "vai, começa, da maneira mais segura
> possível". Executado nesta sessão: etapa 0 (fiscal) + obra nº 1 (painel da matriz).

## O que subiu (3 commits no main, aguardam Deploy do dono)

| Commit | O quê |
|---|---|
| `15605f6` | fix: texto da aba Colaboradores (dizia "colaborador não entra no sistema"; o portal /entregas JÁ existe e a flag tá ON em prod) |
| `dd64a35` | **Etapa 0 — fiscal estendido**: teto 300 pro repo inteiro |
| `a29a163` | **Obra — painel da matriz fatiado**: app.js 3.002 → 249 + 21 módulos |

Pós-deploy, conferir de fora: `curl https://farejador.smarttecsolutions.com.br/admin/painel`
deve mostrar `?v=20260705-obra300` (22 script tags) e os módulos devem responder 200
(ex.: `/admin/painel/app.core.js?v=20260705-obra300`).

## Etapa 0 — fiscal de tamanho estendido (`dd64a35`)

- `scripts/checar-tamanho.cjs` reescrito: vigia TODO código de produção
  (`src/**/*.ts` + `painel/public/*.js` + `parceiro/public/*.js`, 142 arquivos).
- **Arquivo NOVO >300 = FALHA** (nasce fatiado; corte por ASSUNTO).
- **17 herdados** (censo `docs/CENSO_TAMANHO_ARQUIVOS_2026-07-05.md`) com teto
  **CONGELADO** em `scripts/teto-herdado.json` = medida do censo + folga 25 pra
  conserto pontual. Podem encolher, NÃO podem engordar. Quem baixar de 300
  **remove a entrada no mesmo commit** (o fiscal avisa "QUITADO").
- Fora da regra de propósito: tests/, scripts/ (prova é roteiro linear),
  db/migrations (registro histórico), *.html/*.css (fatiar exige técnica própria).
- Provado: verde no estado atual; arquivo plantado de 306 linhas → FALHA com a
  mensagem certa; entrada fantasma no JSON → FALHA.
- Motivo do ratchet: até o portal do entregador (nascido 07-04) já nasceu com
  queries.ts em 376 linhas — sem trava automática a regra não segura nem código novo.

## Obra — painel da matriz fatiado (`a29a163`)

Molde da obra do parceiro (06-10), executado da maneira mais segura possível:
o fatiamento foi **GERADO POR SCRIPT** (zero cópia manual) com faixas de linha
VERBATIM do original, e só materializou depois de 7 travas verdes:

1. **Reconstrução byte a byte**: payload dos 21 módulos + estado do compositor
   == app.js pré-obra, linha a linha (assert no gerador; divergiu = não escreve).
2. `node --check` nos 22 arquivos (sintaxe).
3. **PARIDADE** (`scripts/prova-paridade-matriz.cjs`, molde do parceiro): baseline
   gravado ANTES da obra (`scripts/baseline-paridade-matriz.json`, commit base
   `dd64a35`) — 307 propriedades, impressão digital (nome+tipo) IDÊNTICA depois.
   ⚠️ Se uma frente futura mudar a interface DE PROPÓSITO (método novo etc.),
   regravar: `node scripts/prova-paridade-matriz.cjs --gravar-baseline` no mesmo commit.
4. Fiscal: 22 arquivos ≤300 (maior: app.rede.apply.js 246); `painel/public/app.js`
   **QUITADO** do teto-herdado.json (1º dos 17 a sair da lista; sobraram 16).
5. `npm run typecheck` ✓.
6. 522 unit ✓.
7. **Preview 4222 ao vivo** (env test via pooler): 22 arquivos 200; 8 páginas
   (resumo/vendas/compras/estoque/logistica/financeiro/rede/colaboradores) +
   tela de unidade navegadas com **ZERO erro de console**; APIs carregando
   (colaboradores leu 2 registros, logística listou 9 entregas); estado
   compartilhado reativo (título muda com a página); formatCurrency ok.

### Arquitetura (igual ao parceiro)

- 21 módulos-fábrica em `window.PAINEL_MODULES.*` (`painel/public/app.*.js`),
  cada um devolve um objeto de MÉTODOS; **nenhum módulo tem estado próprio**.
- `app.js` = compositor: ESTADO (197 linhas) + `montarPainelApp()` que faz merge
  via `Object.getOwnPropertyDescriptors` — **NUNCA spread** (congela getter).
  Detalhe do censo: o painelApp não tem NENHUM getter hoje (198 functions) — o
  perigo do spread nem existia aqui, mas o molde blindado fica pro futuro.
- Ordem de merge = ordem do arquivo original (documentada no app.js): duplicata
  hipotética se resolve igual ao objeto literal original (último ganha).
- `index.html`: 22 script tags `?v=20260705-obra300`, módulos ANTES, compositor
  POR ÚLTIMO. `route.ts`: módulos servidos por **lista FIXA** (sem wildcard —
  nada de path traversal); o preview-matriz-server usa a MESMA rota, ganhou junto.
- Cada módulo tem no cabeçalho a faixa de linhas do original (rastreável no git).

### Mapa dos módulos (assunto → arquivo)

nav (menu/título/seleção de unidade) · rede.kpis (derivadas da Rede) ·
unidade.kpis (derivadas da unidade + saúde) · venda.modal (venda manual/walk-in) ·
api (credenciais + apiGet/Post/Put + raio) · format (moeda/data/tempo) ·
varejo (pedidos + resumo 0117) · comissoes (0118) · atacado (venda atacado) ·
compras (fornecedores + fiado 0115 + loads financeiro/despesas) ·
logistica (0121 leitura) · logistica.acoes (rota: abrir/fechar/remarcar/pendurar/IA) ·
colaboradores (0124) · financeiro (visão 3 pernas + despesas 0120) ·
galpao (estoque por medida) · rede.apply (mapeadores applyRede/applyMatrizResumo) ·
pedidos.parceiros (pedido manual + novo parceiro + candidaturas) ·
core (loadRealData/loadRedeData/init/live) · charts.rede · charts.saude · charts.unidade

## Fila da obra 300 (ordem de coragem, decidida com o dono)

1. ~~painel/public/app.js~~ ✅ QUITADO (esta sessão)
2. `src/admin/painel/queries.ts` (3.276) e `src/parceiro/queries.ts` (4.285) —
   fatiar por assunto em obra dedicada (DEPOIS da Fase B do financeiro, ou na
   passada quando já formos mexer); são zona de DINHEIRO → banca antes.
3. `src/parceiro/route.ts` (1.653) / `src/admin/painel/route.ts` (1.388).
4. Bot (`tools.ts` 1.987, `fulfillment.ts` 1.398) — POR ÚLTIMO, com banca e
   provas de integração (prova-geo, prova-matriz-loja etc. já existem).
5. Scripts mortos do censo: 3 da Organizadora (morta) + cargas de maio já
   rodadas — candidatos a APAGAR do git, não refatorar (faxina).

## Avisos operacionais

- Preview **4222** (`matriz-obra300-4222`, env TEST) ficou DE PÉ pro dono ver.
- Os previews 4215-4221 de sessões anteriores não foram tocados.
- Deploy é MANUAL (dono no Coolify). Após o Deploy, conferir `?v=20260705-obra300`
  de fora + navegar o painel em prod (2 min: cada página do menu abre sem erro).
- Rollback da obra inteira = reverter `a29a163` (front puro, zero migration).

— Orquestrador (Claude Fable 5)
