# Sessão 2026-07-10 — Auditoria de abas: REDE (pente fino) + conserto do gráfico dos 7 dias

> Pedido do dono (literal): "vamos ver o painel da rede se tudo esta funcionando cada cards cada funcionalidade
> se realmente extrai tudo dos parceiros e se comunica com o sistema dos parceiros e ao final me diga se vc
> sente falta de alguma funcionalidade quero que vc faca um pente fino de verdade vai".
> Antes do pente: Deploy do dia CONFERIDO DE FORA (prod == main byte a byte; etiquetas `?v=20260708-despesas1` + `logistica6` no ar).

## Veredito: ⭐⭐⭐⭐ — a aba EXTRAI DOS PARCEIROS DE VERDADE; 1 bug consertado na hora; 2 bombas dormentes reportadas

## O que foi PROVADO funcionando (extração real do sistema do parceiro)

| Funcionalidade | Prova |
|---|---|
| Estoque por loja | código real (`getPainelRede`) rodado contra PROD read-only == SQL direto, loja a loja (2/2/2/1/2/3/2 itens, 14 total) |
| Venda realizada (régua 0077/0090) | seed em test: 2W pickup R$300 + porta R$100 CONTAM; delivery em curso R$50 NÃO conta e aparece no feed como "Pedido · Em separação" (1 pendente) |
| 2W × porta | 300/100, 75% de dependência 2W — extraído de `source_tag` |
| Comissão (0118) | sweep no GET criou SOZINHO R$30 (10% × 300, SÓ do 2W realizado; porta e pendente de fora); Recebi quitou (30→0); alarme COBRAR disparou (limiar 10); prova-comissao-rede 18/18 re-rodada (estorno pós-pago com trilha, editor de termos com audit) |
| Raio de entrega (Fase 2) | `PUT /admin/api/partners/:id/delivery-radius` pelo handler real do front: null→25 no banco→restaurado; MESMA fonte (`network.partner_units`) do painel do parceiro e do motor |
| Candidaturas | POST público `/api/seja-parceiro` 201 → fila pending → rejeitar 200 → some; honeypot (website preenchido) FINGE 201 e não grava |
| Funil da Rede | `getRedeFunnel` FILTRA environment ✓; prod real: Maricá tentou=1 |
| Filtros/score/drill-down | 42 unidades de test; filtros sem_venda/risco cortam certo; saúde 90 (7 checks); página unidade completa (screenshot no chat) |
| KPIs | Vendas R$400, ticket R$200, conversão 2W 75%, estoque total 410 — todos baixados do banco do parceiro |

Contagem view × tela: 42 == 42 (um "43" no meio da sessão foi erro de soma do auditor, não do sistema).

## 🔴→✅ CONSERTADO na hora (pushado): gráfico "últimos 7 dias" mentia fora do período 7d
`redeSalesSeries`/`redeOrderSeries` (app.rede.kpis.js) somavam os **7 PRIMEIROS** pontos da série
do período — mas o servidor manda o período INTEIRO (mês = até 31 pontos, hoje por último) e os
rótulos assumem que o último é "Hoje". FLAGRANTE com dado vivo: venda de R$400 de HOJE no índice 9
→ gráfico `[0,0,0,0,0,0,0]` com o KPI ao lado dizendo R$400 — as duas metades da MESMA tela discordavam.
Conserto: soma os **ÚLTIMOS 7** alinhados pelo FIM (period 'today' vira 1 ponto honesto `['Hoje']`).
Validado no preview 4228 (mês: `[0,...,400]` no Hoje; today: `[400]`). Paridade 373 IDÊNTICA (só corpo
de função), fiscal de tamanho ok, `?v=20260710-rede1`.

## 🟠 Achados REPORTADOS (decisão do dono / sessão própria — NÃO consertados aqui)
1. **5 lojas zz-teste ATIVAS em prod** (com estoque, status active): poluem os KPIs ("7 parceiros
   ativos" quando os reais são 2 — Anderson Tavares 5%/40km e Rio do Ouro 8%/3km) e seguem
   elegíveis no roteamento do bot. Landmine conhecida do go-live, segue armada.
2. **Views do cockpit sem environment**: `analytics.v_daily_metrics` e `v_clientes_pra_recuperar`
   NÃO filtram environment (expõem a coluna; `getMatrizResumo` e a tela do Bot não filtram).
   Hoje não vaza POR SORTE (test zerado desde 06-29 — 1 conversa, prod, R$112). Quando o ambiente
   de teste voltar a conversar, o faturamento/custo do bot e os leads do dono MISTURAM teste.
   Conserto barato: `WHERE environment = $1` nas queries TS (a coluna já vem na view). Abas
   afetadas: Resumo e Bot (fora do escopo do pente da Rede).
3. **Régua do "Resultado" divergente matriz × parceiro**: a Rede calcula CAIXA (vendas − COMPRAS −
   despesas, recomputado no `getPainelRede`); o painel do parceiro mostra COMPETÊNCIA (vendas −
   CUSTO da mercadoria − despesas, coluna `estimated_result_month` da view `partner_unit_summary`
   que o `getPartnerResumo` lê com `SELECT *`). Parceiro que estocar pesado num mês vira "Resultado
   negativo" (alerta!) na matriz enquanto o painel dele mostra lucro. Decisão de régua = dono;
   recomendação: unificar na COMPETÊNCIA (a view já entrega) e/ou rotular "caixa do mês".
4. **Funil por município órfão**: município com `tentou` mas sem pedido → `unit_id` null → o merge
   descarta (prod REAL: Maricá tentou=1 invisível na tela). O dado existe, a tela engole. V1
   documentado; ligar em `network.unit_coverage` quando houver volume.
5. Menores: "Sem atualização" muda com o período selecionado (events da janela); estimativa legada
   de comissão (flag OFF) inclui frete na base — inofensivo com o livro ON em prod.

## Funcionalidades que FALTAM (resposta direta ao pedido do dono, em ordem de dor)
1. **Mensalidade como lançamento** — o card soma "mensalidade devida" como estimativa eterna (não
   tem livro, não quita, não tem histórico). Já no roadmap com aviso da banca 07-02 (sair ANTES de
   ativar monthly/hybrid pra parceiro real). É a maior lacuna de COBRANÇA da Rede.
2. **Recebi parcial + recibo do acerto de comissão** — o Recebi quita TUDO de uma vez; não existe
   "recebi R$100 dos R$150" nem comprovante wa.me do acerto pro parceiro (o atacado já tem recibo).
   Casa com a Fase B (pagamento parcial).
3. **Nota do cliente no score de saúde** — a pesquisa de satisfação (0105) está PRONTA e dormente;
   o score é 100% operacional. A régua antifraude do roadmap previa exatamente esse sinal (cliente
   não falsifica).
4. **Sino cego pra Rede** — comissão ≥ alarme só pisca DENTRO da aba (localStorage); candidatura
   nova não notifica NADA (borracheiro se candidata e o dono só descobre abrindo a tela).
   Barato: 2 agregados no `GET /notificacoes`.
5. **Export contador** (CSV/planilha da Rede) — já na fila combinada ("Relatórios/export").
6. Landmines antigas que a auditoria RECONFIRMOU: horário das lojas vazio (afeta o gatilho de
   imediatismo do bot); raios de teste dos 5 zz (2/5/12/15/5 km).

## Limpeza
Seeds AUDIT-REDE 100% removidos (3 partner_orders + 1 commission_entry + 1 candidatura, test);
raio da fake-rede-a restaurado (null); localStorage do preview com alarme=10 (inofensivo).
Preview **4228** ficou DE PÉ (porta 4228, matriz-despesas-4228 — regra: não derrubo).
O one-off que executava o painel contra produção era somente leitura e foi aposentado no Portão 7; os resultados desta seção permanecem como evidência histórica.

## Fila da auditoria (o dono chama a próxima)
**Resumo · Colaboradores** (Vendas/Compras/Estoque/Logística/Financeiro/Rede fechadas).
Sugestão: na do RESUMO, já consertar o environment das views (achado 2).

— Orquestrador (Claude Fable 5) — domínio `matriz`, 2026-07-10
