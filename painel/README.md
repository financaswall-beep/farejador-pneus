# Farejador — Painel

Painel operacional da loja. Roda dentro do próprio Farejador, sem repo separado e sem build step.

> **Status:** Mockup visual completo + backend real ligado parcialmente. Resumo, Operação, Pedidos, Rede, Shadow, revisão Shadow e registro manual de venda já existem; telas ligadas ao banco real carregam endpoints quando o painel roda em `/admin/painel`.

---

## Atualizacao operacional 2026-05-20: Rede com dados reais do parceiro

A tela **Rede** do admin agora esta ligada ao banco real do Portal Parceiro.

Fonte principal:

```text
GET /admin/api/dashboard/rede
```

Esse endpoint le:

- `network.partner_unit_summary`
- `network.partners`
- `finance.partner_expenses`
- `commerce.partner_stock_levels`
- `commerce.partner_purchases`
- `commerce.partner_orders`
- `commerce.partner_order_items`

O ponto critico corrigido em 2026-05-20 foi que algumas consultas do admin ainda olhavam para `commerce.orders`, que e a tabela antiga/matriz. Depois da decisao de silo do parceiro, vendas locais do borracheiro entram em `commerce.partner_orders`. Entao a Rede do admin precisa sempre usar `partner_orders` e `partner_order_items` para venda de hoje, ultimos lancamentos, pneus mais vendidos, serie de vendas dos graficos, ranking e relatorio da unidade.

Validacao real em `prod`, unidade `borracharia-rio-do-ouro`:

```text
Vendas mes: R$ 476,00
Pedidos mes: 5
Compras pneus: R$ 50,00
Despesas: R$ 450,00
Resultado estimado: -R$ 24,00
Estoque local: 3 itens
Lancamentos recentes: 7
Top pneus: 90/90-18 e 80/100-18
Serie 7 dias: [0,0,0,0,0,0,476]
```

### Fallback local da Rede

O admin visual ainda usa CDNs externos para Alpine/Tailwind/Lucide/Chart.js. Se o Alpine nao carregar no navegador local, a tela pode ficar parada no HTML inicial.

Para evitar confusao durante teste local, foi criado:

```text
painel/public/rede-fallback.js
```

Esse fallback roda sem Alpine e renderiza a tela Rede usando dados reais de `/admin/api/dashboard/rede`. Ele nao substitui a SPA completa; serve para garantir que Wallace veja dados reais da rede mesmo quando CDN externo falhar.

Arquivos relacionados:

- `src/admin/painel/queries.ts`
- `src/admin/painel/route.ts`
- `painel/public/rede-fallback.js`
- `painel/public/index.html`
- `painel/public/style.css`
- `db/migrations/0041_partner_summary_reads_partner_orders.sql`

Regra: mock visual pode existir como fallback, mas a decisao operacional deve ser baseada na API real e nas tabelas `partner_*`.

---

## Status atual (2026-05-19)

**Mockup pronto e navegável.** O arquivo ainda abre sem servidor para inspeção visual, mas dados reais só carregam quando servido pelo Farejador em `/admin/painel` com `ADMIN_AUTH_TOKEN`.

### O que já está visualmente pronto

| Tela | Status | Componentes |
|---|---|---|
| **Resumo** | ✅ Completo | Saudação personalizada, filtros de tempo, 4 KPIs, lista "Últimas vendas" com avatares e tags, gráfico Performance (Chart.js), card "Complete relatório" com progress bar, card "Insights diários" gradient, card "Status do bot" |
| **Operação** | ✅ Completo | Busca, lista de conversas ativas, slots extraídos como chips, draft do bot destacado, botões "Registrar venda" e "Chatwoot" |
| **Pedidos** | ✅ Completo | 4 totalizadores, filtros, tabela com 7 pedidos, status colorido |
| **Rede** | ✅ Base visual avançada | Painel central do dono. **Atualizada 2026-05-19:** filtro temporal global (Diário/Semanal/Mensal), 2 charts grandes lado a lado (Lucro + Compras de pneus), 3 mini-cards com mini-gráficos (Estoque parado bar laranja, Melhor margem bar verde, Venda hoje donut), "Pneus mais vendidos" como bar chart horizontal verde. |
| **Detalhe da unidade** | ✅ Base visual avançada | Relatório em tela cheia por parceiro, organizado em abas: Visão geral, Estoque e Lançamentos |
| **Bot / Shadow** | ✅ Completo | 4 KPIs agregados, fila real de revisão, auto-refresh, comparação humano × bot lado a lado, botão "Abrir Chatwoot", 5 botões de verdict |
| **Modal Registrar Venda** | ✅ Completo | Form completo: itens, qtd, preço, pagamento, modalidade, endereço, observações, total, audit indicado |
| **Top bar global** | ✅ Completo | Busca, sino de notificações com badge + dropdown (8 notificações mock, filtros, marcar todas), avatar do operador |
| **8 placeholders Fase 2** | ✅ Completo | Financeiro, Estoque, Logística, Colaboradores, Catálogo, Compras, Relatórios, Configurações |

### O que ainda é mockup ou incompleto

- ✅ Resumo/Operação/Pedidos/Shadow fazem `fetch()` nos endpoints reais
- ✅ Botões de verdict gravam em `ops.human_bot_reviews`
- ✅ "Registrar venda" envia `POST /admin/api/orders/register-manual`
- ✅ Bot/Shadow mostra se o worker está ligado ou desligado (`ATENDENTE_SHADOW_ENABLED`)
- ✅ Pares já revisados não voltam na fila (`review_id IS NULL`)
- ✅ Tela Rede criada como painel central do Wallace para parceiros/borracharias
- ✅ Rede tem apanhado geral; clicar no parceiro abre relatório da unidade em tela cheia
- ✅ Detalhe da unidade inclui DRE operacional simples: faturamento, compra de pneus, folha, despesas extras e resultado estimado
- ✅ Detalhe da unidade inclui estoque local por pneu, quantidade, custo, preço de venda e status
- ✅ Detalhe da unidade inclui cadastro completo do parceiro, lançamentos e score de saúde
- ✅ Rede inclui comparativos entre unidades: lucro, estoque parado, margem, sem venda hoje e pneus mais vendidos
- ❌ Tela Rede ainda usa dados mockados; banco `partners/units`, estoque local e vendas locais entram no próximo bloco
- ❌ Avatar/equipe ainda são estáticos
- ❌ Notificações não são reais
- ❌ Filtros de tempo não filtram nada
- ❌ Conversas novas só aparecem no Bot/Shadow se o processo que recebe o webhook estiver com `ATENDENTE_SHADOW_ENABLED=true`

---

## Estrutura

```
painel/
├── README.md              ← este arquivo
└── public/
    ├── index.html         ← HTML da SPA
    ├── app.js             ← Alpine state + fetch real + fallback mock
    └── style.css          ← CSS customizado mínimo
```

No **Dia 1** foram adicionados no backend:

```
src/admin/painel/
├── route.ts               ← rotas HTTP do Fastify
└── queries.ts             ← queries SQL e writes controlados
```

---

## Como abrir o mockup

**Clique duplo** em `painel/public/index.html` — abre no navegador padrão.

Alternativas:
```powershell
start "C:\Farejador agente\painel\public\index.html"
```

Não precisa de servidor. Todos os scripts (Tailwind, Alpine, Lucide, Chart.js) carregam via CDN.

---

## Stack

| Camada | Escolha | Por quê |
|---|---|---|
| Estilo | Tailwind CSS via CDN | Sem build step |
| Interatividade | Alpine.js via CDN | Mais leve que React/Vue para 4 telas |
| Ícones | Lucide via CDN | Conjunto consistente, dark+light ready |
| Gráficos | Chart.js via CDN | Já em uso no `dashboard.html` antigo |
| Tipografia | Inter via Google Fonts | Padrão SaaS moderno |
| Tema | Light mode (Estimade-style) | Decisão de design 2026-05-18 |
| Cor brand | Laranja `#f97316` | Vibe loja de pneu / motociclismo |

**Zero npm install. Zero webpack. Zero build step.**

---

## Decisões de design tomadas

- **Tema light** ao invés de dark (referência Estimade)
- **Saudação personalizada** "Olá Wallace, aqui está seu painel"
- **Filtros de tempo** como tabs ao invés de dropdown (Hoje / Semana / Mês / Ano)
- **KPIs** com badges coloridas pequenas + valor grande + variação % colorida
- **Avatares com gradiente** (laranja-Wallace, azul-funcionário, rosa-funcionário, etc.)
- **Tags de cliente:** Recorrente (verde) / Novo cliente (azul) / VIP (âmbar) / Cancelado (rosa)
- **Sino de notificações global** acessível de qualquer tela
- **Cards laterais** no Resumo: relatório diário, insights diários, status do bot
- **Sidebar com seção "Em operação"** mostrando equipe atual

---

## Decisões pendentes

As decisões bloqueantes do Dia 1 foram resolvidas. Domínio público e ERP futuro continuam pendentes para depois do MVP.

---

## Próximos passos

Ver `docs/PAINEL_PLANO.md` seção **Cronograma 14 dias**.

Resumo:
- **Dia 1:** migrations SQL (`0032_order_manual_capture.sql` + `0033_painel_views_and_audit.sql`) + views read-only no schema `dashboard.*`
- **Dia 2:** endpoints Fastify protegidos por `ADMIN_AUTH_TOKEN`
- **Dia 3-4:** ligar telas Resumo + Shadow no banco real
- **Dia 5-7:** Operação + modal "Registrar venda" funcional
- **Dia 8-9:** ajustes de UX
- **Dia 10-14:** uso real durante shadow

---

## Status backend atualizado

O mockup visual ainda usa dados hardcoded em `painel/public/app.js`, mas a fundação real já existe no backend:

- `GET /admin/painel`, `/admin/painel/app.js`, `/admin/painel/style.css`
- `GET /admin/api/dashboard/resumo`
- `GET /admin/api/dashboard/operacao`
- `GET /admin/api/dashboard/shadow`
- `GET /admin/api/dashboard/pedidos`
- `GET /admin/api/dashboard/produtos`
- `POST /admin/api/orders/register-manual`
- `POST /admin/api/orders/:order_id/cancel`
- `POST /admin/api/shadow/review`

Todos os endpoints JSON usam `ADMIN_AUTH_TOKEN`. Writes passam por function SQL ou inserção controlada; o painel não escreve em `raw.*`, `core.messages` nem `agent.turns`.

Status do banco: `0032`/`0033` aplicadas no banco real em 2026-05-19.

## Correções 2026-05-19 (preparação pro shadow)

Antes de ligar `ATENDENTE_SHADOW_ENABLED=true`, três correções entraram pra evitar furo de cobertura de venda:

1. **Botão "Registrar venda" em toda conversa ativa.** Antes só aparecia se o bot tinha montado draft. Como no shadow quem fecha venda é o humano, isso esconderia o botão na maioria das conversas.
2. **Botão global "Nova venda"** no top-bar. Abre modal sem conversa pra vendas de balcão, telefone ou indicação. Backend cria/reaproveita cliente em `commerce.customers`, sem contaminar `core.contacts`.
3. **Campo "Origem da venda"** no modal:
   - Em conversas Chatwoot: `chatwoot_com_bot` (auto se há draft) ou `chatwoot_sem_bot`.
   - Em walkin: `walkin_balcao` / `walkin_telefone` / `walkin_outro`.
   - Persistido em `commerce.orders.source` (CHECK constraint expandida).

Arquivos tocados:
- `db/migrations/0034_painel_walkin_and_source.sql` (novo)
- `src/admin/painel/queries.ts` (`registerWalkinOrder`, `source_tag` em `RegisterManualOrderInput`)
- `src/admin/painel/route.ts` (`POST /admin/api/orders/register-walkin`)
- `painel/public/index.html` (botão sempre visível, top-bar "Nova venda", modal com dropdown Origem e campos cliente)
- `painel/public/app.js` (`openWalkinModal`, roteamento no submit, `saleForm` estendido)

**Aplicar `0034` no banco antes de subir o deploy** — sem essa migration, o endpoint `register-walkin` falha, o `customer_id` não existe em `commerce.orders` e o `source_tag` novo é rejeitado pelo CHECK antigo.

**Assinatura:** Claude (Opus 4.7), com Wallace, 2026-05-19. Diagnóstico, decisão e implementação documentados em `docs/PAINEL_PLANO.md`.

## Teste local do Bot/Shadow em 2026-05-19

O painel foi testado servido pelo Fastify em:

```text
http://localhost:3000/admin/painel
```

Validações feitas:

- `node --check painel/public/app.js`
- `npm run typecheck`
- `npm run build`
- `GET /admin/api/dashboard/shadow?limit=1` com `ADMIN_AUTH_TOKEN`
- abertura da tela no navegador embutido do Codex

Resultado observado:

- o painel carregou dados reais do ambiente `prod`;
- a fila Bot/Shadow mostrou pares pendentes;
- o botão `Abrir Chatwoot` apareceu quando havia `chatwoot_base_url` e `chatwoot_account_id`;
- o botão `Chatwoot` da tela Operação abre a conversa real usando `chatwoot_conversation_id`;
- a API informou `atendente_shadow_enabled=false` e `generator_llm_enabled=false`;
- o cabeçalho da tela passou a mostrar `Worker Shadow desligado`.

Interpretação operacional:

- o painel lê pares já existentes em `dashboard.shadow_pairs`;
- mensagem nova no Chatwoot não vira par novo no Bot/Shadow se o processo que recebe o webhook estiver com `ATENDENTE_SHADOW_ENABLED=false`;
- para testar conversa nova ponta a ponta, ligar `ATENDENTE_SHADOW_ENABLED=true` no ambiente correto, preferencialmente no deploy/Coolify que recebe o webhook real, mantendo envio ao cliente desligado.

Próximo passo técnico: ligar o worker Shadow no ambiente certo, mandar uma conversa teste no Chatwoot e confirmar se ela entra sozinha na fila Bot/Shadow.

---

## Sessão de continuidade 2026-05-19 (Claude Opus 4.7)

Mudanças visuais e estruturais aplicadas depois dos Fixes #1-#3 (já documentados no `docs/PAINEL_PLANO.md`):

### Padronização de botões

Padrão consolidado em todo o painel:

| Categoria | Estilo Tailwind | Uso |
|---|---|---|
| Primário | `px-4 py-2 bg-gray-900 hover:bg-gray-800 text-white rounded-lg text-sm font-medium transition-colors` | Nova venda, Registrar venda, Confirmar venda |
| Secundário outline | `px-3 py-2 bg-white border border-gray-200 hover:border-gray-300 rounded-lg text-sm transition-colors` | Chatwoot, filtros, navegação |
| Ghost (cancel) | `px-4 py-2 hover:bg-gray-100 rounded-lg text-sm font-medium` | Cancelar no modal |
| Brand laranja | Reservado pra **chips/badges**, não pra CTAs | Status, contadores |

### Filtro temporal global da Rede

- Pill bar "Diário / Semanal / Mensal" (`redeTimeFilter`) abaixo do título da página Rede.
- Chips estáticos "mês"/"7 dias" dos charts viraram reativos ao filtro.
- Aviso honesto à direita quando filtro != Mensal: "Agregação X entra quando dados reais forem plugados" (mock só tem granularidade mensal hoje).

### Gráficos da Rede

Três mini-cards de texto solto viraram mini-gráficos:

- **Estoque parado** → bar chart horizontal, líder em laranja, demais cinza.
- **Melhor margem** → bar chart horizontal por %, líder em verde, demais cinza.
- **Venda hoje** → donut verde/rosa "venderam × sem venda" com métrica X/total grande.

Adicionado o gráfico novo:

- **Compras de pneus por unidade** (`chartRedeComprasChart`) — bar chart horizontal, ranking por `comprasPneus`, líder em laranja brand.

Layout reorganizado pra **2 charts grandes lado a lado** (Lucro estimado + Compras) + **3 mini-cards numa linha de baixo**. Antes era 1 grande + 3 minis numa grid-4, deixando o 4º item órfão na linha 2.

E:

- **"Pneus mais vendidos da rede"** — lista de 5 cards virou bar chart horizontal verde (líder `#059669`, demais `#a7f3d0`), tooltip mostra "X de Y unidades (Z%)".

### Doc completa da sessão

Detalhamento completo de cada mudança, decisões arquiteturais e assinaturas: ver `docs/PAINEL_PLANO.md` seção **"Continuação 2026-05-19 — visual + Rede + portal parceiro + dimensões de pneu"**.

---

## Rede com dados reais em 2026-05-20

Atualizacao posterior: a tela **Rede** nao deve mais exibir controles ou numeros simulados.

Removido da tela:

- filtro "Diario / Semanal / Mensal" que nao filtrava a API;
- botoes "Exportar" e "Credenciar parceiro" sem endpoint real;
- dataset "Meta" do grafico de vendas consolidadas.

Periodos reais exibidos:

- faturamento, custos e resultado: mes atual;
- grafico de vendas: ultimos 7 dias;
- estoque: posicao atual.

Validado em `prod` via `GET /admin/api/dashboard/rede`, unidade `Borracharia Rio do Ouro`:

- vendas do mes: R$ 664,00;
- pedidos do mes: 7;
- compra de pneus: R$ 50,00;
- folha/funcionarios: R$ 450,00;
- despesas extras: R$ 0,00;
- resultado estimado: R$ 164,00;
- origem 2W: R$ 298,00 / 3 pedidos;
- origem porta: R$ 366,00 / 4 pedidos;
- estoque local: 3 itens, 1 alerta baixo/zerado;
- pneus mais vendidos: 90/90-18 (5), 80/100-18 (2).

Fonte de verdade: tabelas do parceiro (`commerce.partner_orders`, `commerce.partner_order_items`, `commerce.partner_stock_levels`, `commerce.partner_purchases`, `finance.partner_expenses`). Venda de parceiro nao deve ser somada a partir de `commerce.orders`.
## Indicadores da Rede em 2026-05-21

A tela Rede recebeu novos indicadores reais para acompanhamento da matriz:

- ticket medio da rede;
- conversao 2W da rede;
- estoque total em quantidade e valor de custo estimado;
- grafico de origem 2W vs porta;
- grafico/ranking de score de saude;
- ranking de dependencia da 2W;
- alertas reais por unidade;
- filtros na lista: Todos, Com alerta, Sem venda hoje, Sem atualizacao, Dependentes 2W e Score baixo;
- serie de pedidos dos ultimos 7 dias via `order_series`.

Score de saude, escala 0-100:

- resultado positivo: 20;
- vendeu hoje: 15;
- estoque atualizado ate 3 dias: 15;
- estoque sem item baixo/zerado: 15;
- margem estimada >= 20%: 15;
- custos/despesas registrados: 10;
- vendas 2W registradas: 10.

Validacao local em `prod`, unidade `Borracharia Rio do Ouro`:

- vendas da rede: R$ 664,00;
- ticket medio: R$ 94,86;
- conversao 2W: 45%;
- estoque total: 15 pneus / R$ 750,00 de custo estimado;
- score de saude: 85 pontos;
- alertas reais: 1 alerta de estoque critico.

## Filtros por periodo e meta da Rede em 2026-05-21

A API da Rede agora aceita filtro real por periodo:

- `period=today`
- `period=7d`
- `period=30d`
- `period=month`

O filtro recalcula no SQL: vendas, pedidos, compras de pneus, despesas/folha, lucro estimado, origem 2W vs porta, pneus mais vendidos e series diarias.

Os botoes de periodo aparecem nos graficos:

- Vendas consolidadas da rede;
- Lucro estimado por unidade;
- Compras de pneus por unidade;
- Pneus mais vendidos da rede.

A meta da matriz fica na propria tela em "Meta do periodo". Ela salva no navegador local (`farejador_rede_sales_goal`) e aparece como linha de meta diaria no grafico de vendas, alem da barra de progresso do periodo.

Validacao local:

- `period=today`: R$ 188,00 / 2 pedidos;
- `period=7d`: R$ 664,00 / 7 pedidos;
- `period=30d`: R$ 664,00 / 7 pedidos;
- `period=month`: R$ 664,00 / 7 pedidos.

## Auditoria Rede vs Portal Parceiro em 2026-05-21

Auditoria completa feita na unidade `borracharia-rio-do-ouro`, ambiente `prod`.

Escopo comparado:

- Portal Parceiro: `GET /parceiro/:slug/api/resumo`, baseado em `network.partner_unit_summary`.
- Admin Rede: `GET /admin/api/dashboard/rede?period=month`.
- Tabelas brutas: `commerce.partner_orders`, `commerce.partner_order_items`, `commerce.partner_stock_levels`, `commerce.partner_purchases`, `finance.partner_expenses`.

Laudo:

- resumo mensal do parceiro bate com as tabelas brutas;
- Rede mensal bate com as tabelas brutas;
- Rede mensal bate com o resumo do parceiro nos campos equivalentes;
- formulas conferidas:
  - lucro = vendas - compras - despesas = 664 - 50 - 450 = 164;
  - ticket medio = 664 / 7 = 94,86;
  - origem = 2W 298 + porta 366 = 664;
  - conversao 2W = 298 / 664 = 45%;
  - estoque total = 15 pneus e R$ 750,00 de custo estimado;
  - score da unidade = 85 pontos.

Valores esperados na Rede com filtro `Mês atual`:

```text
Vendas da rede: R$ 664,00
Ticket medio: R$ 94,86
Conversao 2W: 45%
Estoque total: 15 / R$ 750,00
Venda hoje: 1/1
Ranking de saude: 85 pts
```

Observacao: a tela do parceiro ainda e mensal. Para comparar com o parceiro, usar `Mês atual` na Rede. Os outros filtros da Rede (`Hoje`, `7 dias`, `30 dias`) sao visoes extras da matriz.

Bug corrigido na auditoria: a UI usava indice fixo de serie de 7 dias para "vendeu hoje". Agora usa o ultimo ponto da serie atual, evitando alerta/score incorreto em periodo mensal.
