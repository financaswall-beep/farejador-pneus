# Sessão 2026-07-06b — TELA DO BOT no painel da matriz (campainha + mapa da demanda + radar)

> **Contexto raro desta sessão:** a obra começou numa conta do Claude que ESGOTOU os créditos no meio
> da prova de integração. Outra instância (esta) pegou o fio da meada lendo o estado em disco + git,
> terminou a prova, achou e consertou 1 furo real (registro no route-static), e fechou o rito completo.
> Lição de continuidade: tudo que importa estava nos ARQUIVOS — nada se perdeu.

## O que é (decisão do dono 07-06: "vai vamos montar a tela do bot")
Aba **Bot** no painel da matriz — a tela que responde três perguntas na ordem da dor:
1. **AGORA:** quem está esperando resposta do bot / quem pediu humano? (campainha)
2. **ONDE:** de onde vem a demanda, o que virou pedido, o que entregou, onde FALTOU pneu? (mapa por município)
3. **O QUÊ:** que medida pediram e a Rede não tinha — lista de compra do galpão? (radar)

**Tudo SÓ-LEITURA. Sem flag. Sem migration.** Nenhuma tabela nova — a tela DERIVA do que os
sensores já gravam (analytics por trigger SQL, pedidos, galpão). Zero risco de dinheiro/estoque.

## Backend (`src/admin/painel/`)
- **`queries-bot.ts` (234 linhas)** — 2 agregadores:
  - `getBotCampainha()` — leve (roda no boot + refresh 15s):
    - **mudas**: última msg do CLIENTE mais nova que o gatilho da última resposta ENTREGUE
      (`agent.turns status='delivered'` → `trigger_message_id`) — é a régua da trava anti-requentado
      (stale-trigger) INVERTIDA: lá descarta o já-respondido, aqui acende o não-respondido.
      Janela 24h, grace de 5 min (conversa em andamento não alarma), por `sent_at` (hora real,
      chave da partição), nunca `created_at` (hora de ingestão — replay atrasado inventaria espera).
    - **escalados**: fact `escalou` nas últimas 48h + motivo (fact `motivo_escalacao`).
  - `getBotVisao(period)` — ao entrar na aba; janelas today/7d/30d/month (SQL constante por id,
    sem input do usuário na string). Blocos DEFENSIVOS (try/catch por bloco, padrão getMatrizResumo):
    - **cards**: `analytics.v_daily_metrics` (conversas/fecharam/escalaram/abandonaram/custo_bot/
      faixas de horário);
    - **mapa**: facts por conversa (`municipio_entrega` canônico do dicionário = mesmo nome IBGE;
      `pedido_criado`; `faltou_estoque`) × `commerce.orders`/`partner_orders` (efetivou = delivered;
      cancelado fora) agregados por município → chamou/pediu/efetivou/faltou;
    - **sem_regiao**: conversas com facts mas sem município (ficam fora do mapa, contadas);
    - **radar**: `faltou_estoque` por medida (motivo fora_de_catalogo × sem_estoque_perto) ×
      `commerce.wholesale_stock` (galpao_qty; null = medida nem cadastrada).
- **`route-bot.ts` (36 linhas)** — `GET /admin/api/bot/campainha` + `GET /admin/api/bot/visao?period=`,
  ambas `requireAdminAuth` (conversa de cliente é dado sensível — **zero grant pro parceiro**,
  mesma régua do sino). Registrada em `route.ts`; export no barrel `queries.ts`.
- **`route-static.ts`** — ⚠️ **A LIÇÃO DA SESSÃO**: os módulos do painel são servidos por LISTA FIXA
  (anti path-traversal). Módulo novo TEM que entrar na lista — o esquecimento deu 404 nos 3 arquivos
  novos e o Alpine inteiro não montava (painel BRANCO). Pego na verificação de preview; consertado
  (+3 entradas) e baseline de rotas regravado (90 → **93**, as 3 estáticas novas).

## Front (`painel/public/`)
- **`mapa-rm-dados.js` (58 linhas)** — asset: malha IBGE simplificada dos **24 municípios da RM**
  (`window.MAPA_RM = { W, H, munis: [{ n: nome, d: path }] }`). Estado inteiro fica pro dia da expansão.
- **`app.bot.js` (105 linhas)** — módulo-fábrica `PAINEL_MODULES.bot`: estado/carregadores/getters
  (botCampainha, botVisao, botMudas, botEscalados, botCards, botRadar, botHorarios…) + deep-link
  Chatwoot (`chatwootConvUrl` usa base/account que o core já carrega). Badge da aba = mudas+escalados.
- **`app.bot.mapa.js` (120 linhas)** — `PAINEL_MODULES.botMapa`: o DESENHO. Paleta combinada com o
  dono 07-06: **cinza = sem dado; UMA cor por assunto** (azul chamou / verde pediu / teal efetivou /
  vermelho faltou); **mais escuro = mais forte** (rampa de 5); nomes INVISÍVEIS — hover/clique
  respondem (title + painel lateral); seleção = contorno, não pintura. Re-render burro do SVG a cada
  pintura (24 paths, custo desprezível, zero estado pendurado no DOM).
- **`app.js`** — item de menu `bot` (com badge), 6 estados novos, 2 fábricas registradas
  (getOwnPropertyDescriptors, NUNCA spread). **`app.core.js`** — campainha no boot + no refresh 15s
  (qualquer página); visão no `$watch` de `currentPage === 'bot'`.
- **`index.html`** — tela completa (campainha 2 cards / cards do período / mapa com camadas+legenda+
  painel do município / radar) + 3 script tags novas + **`?v=20260706-bot1`** (cache-bust).

## Provas (todas verdes)
| Prova | Resultado |
|---|---|
| `npx tsx --env-file=.env.pooler scripts/prova-bot-tela-test.ts` | **14/14 ×2 runs** (campainha acende/grace/cala/reacende/escalou; mapa por DELTA chamou/pediu/faltou; janela 30d exclui 35d; sem_regiao; radar medida+motivo+galpão; today) |
| `npm run typecheck` | ✓ |
| `npm test` | **522/522** |
| `npm run checar-tamanho` | ✓ (novos: 234/36/105/120/58 — folga no teto 300) |
| `node scripts/prova-paridade-matriz.cjs` | **341 propriedades** = baseline (regravado DE PROPÓSITO: +estados/getters/métodos do bot) |
| `npx tsx --env-file=.env.pooler scripts/prova-rotas-matriz.ts` | **93 rotas** = baseline (regravado: +2 API AUTH + 3 estáticas) |
| `prova-sino-galpao-test.ts` | ✓ não-regressão (artéria compartilhada route/queries) |
| Preview **4224** (`matriz-bot-4224` no launch.json local) | ponta a ponta: app monta, aba carrega, mapa 24 paths, clique seleciona município, troca de camada re-pinta e limpa seleção, troca de período recarrega, APIs 401 sem token, estáticos 200, zero erro de console |

Seeds da prova descartáveis (acc 93939, medida '93/93-93', source 'prova_bot'), pré-limpeza +
limpeza no finally, checks do mapa por DELTA (imunes a dado pré-existente no env test).

## O que NÃO entrou (de propósito — fatias futuras da tela suprema)
- Funil do dia com perdas por motivo (bloco 2 da conversa original) e camadas extras do mapa
  (medida campeã por região, ticket médio, rota se pagou por destino, fiado por região, comissão
  por região, nota da pesquisa por loja, candidaturas no mapa).
- Estado inteiro do RJ no mapa (asset atual = RM; expansão quando a Rede crescer).
- O mapa "batizado" de apresentação segue em `assets/mapa-rj-wallace-batizado.svg` (uso marketing).

## Pós-deploy (checklist)
1. Conferir de fora: `?v=20260706-bot1` no HTML do painel em prod.
2. Abrir a aba Bot com dado REAL de prod (campainha deve refletir conversas de verdade).
3. Fila combinada segue: **Fase B fiado parcial (banca de 4 ANTES) → frente de caixa do vendedor →
   relatórios/export contador** — a tela do Bot furou a fila com o "vai" do dono 07-06.
