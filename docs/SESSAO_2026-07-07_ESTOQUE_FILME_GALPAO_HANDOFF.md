# Sessão 2026-07-07 — Auditoria da aba ESTOQUE + FILME DO GALPÃO (0128) + baixa com motivo

> Continuação da auditoria aba a aba (pedido do dono 07-06). A aba Estoque foi auditada
> (⭐⭐⭐⭐½, zero bug) e o dono mandou resolver as 4 lacunas na hora ("resolve isso ai").
> Tudo shipado no mesmo dia. **0128 APLICADA test+prod. Pushado, aguarda Deploy.**
> Conferir pós-deploy: `?v=20260707-estoque1` no painel da matriz.

## 1. A auditoria (antes dos consertos)

Rito padrão: código lido (app.galpao.js · queries-galpao.ts · route-galpao.ts ·
wholesale-stock.ts · migrations 0111/0113/0126), provas re-rodadas
(prova-sino-galpao 12/12, prova-fase4-galpao em prod com ROLLBACK), preview 4226
ponta a ponta com seeds descartáveis (marcador AUDIT-ESTOQUE, limpos no fim).

**8 funcionalidades verdes:** autocomplete por dígitos ("90 90 18"→"90/90-18") ·
Definir (upsert) · +Entrada com custo médio ponderado EXATO (10@20+10@40→20@30,
mínimo preservado) · badge REPOR (qty≤min) · badge ZEROU · catálogo recusa fantasma
e lixo grudado com erro amigável · editar · remover com confirm.

**As 4 lacunas (o que segurava o 0,5):** sem histórico de movimentação (galpão era
FOTO, não filme) · baixa sem motivo (quebra virava "Definir" silencioso) · resumo
R$ parado só existia na aba Financeiro · sem busca/ordenação repor-primeiro.

## 2. O que foi construído

### 0128 — Trilha de movimentação por TRIGGER (o "filme")
- `commerce.wholesale_stock_movements` (append-only): environment, measure, op
  (insert/update/delete), qty_before/after, **qty_delta GERADO**, cost_before/after,
  source, reason, ref (TEXT — sem cast que exploda), created_at. 2 índices.
- Trigger `wholesale_stock_log_movement` (AFTER I/U/D em `wholesale_stock`) →
  `log_wholesale_stock_movement()` SECURITY DEFINER + search_path fixo.
  UPDATE só loga se mudou qty OU custo (notes/min_quantity ficam fora).
- **Rótulo** via `set_config` LOCAL da transação (`app.galpao_source/reason/ref`);
  sem rótulo = `'sem_rotulo'` (DELETE sem rótulo = `'remocao'`). **A trilha nunca
  fura** — o pior caso é linha sem rótulo, nunca linha faltando.
- **SMOKE dentro da migration**: insert/update/update-de-notes/delete numa medida
  descartável + confere 3 movimentos e os valores — se o trigger quebrar, a
  migration ABORTA (é caminho de venda; não pode subir mina). Zero grant parceiro
  (validado, regra de ouro 0111).
- ⚠️ **NÃO é o livro-razão da Fase B**: a fonte da verdade continua sendo o saldo
  (`quantity_on_hand`); NENHUMA baixa mudou de comportamento; clamp assimétrico do
  0116 continua documentado (agora o filme REGISTRA quando o clamp atua). Fase B
  (saldo derivado do livro + pagamento parcial) segue na fila com banca de 4.

### Rótulos plantados (quem escreve o quê no filme)
| Caminho | source | ref | onde |
|---|---|---|---|
| Definir (tela) | `definir` | — | wrapper `setWholesaleStockComRotulo` |
| + Entrada (tela) | `entrada` | — | wrapper `addWholesaleStockEntryComRotulo` |
| Remover (tela) | `remocao` | — | wrapper `deleteWholesaleStockComRotulo` |
| Compra de fornecedor | `compra` (reason=nome) | purchase_id | `registerWholesalePurchase` |
| Cancelar compra | `cancelamento_compra` | purchase_id | `cancelWholesalePurchase` |
| Venda de atacado | `venda_atacado` | order_id | `applyWholesaleStockDecrement` (+`ref?`) |
| Cancelar venda atacado | `cancelamento_venda` | order_id | `applyWholesaleStockReturn` (+`ref?`) |
| Varejo matriz (bot+balcão) | `varejo` | order_id | `applyMatrizGalpaoDecrement` (dentro) |
| Cancelar varejo | `cancelamento_varejo` | order_id | `applyMatrizGalpaoReturn` (dentro) |
| Baixa manual (nova) | `baixa_manual` (reason=motivo) | — | `applyGalpaoBaixaManual` |

- `wholesale-stock-read.ts`: 367→377 linhas, DENTRO do teto congelado 392 (folga de
  conserto pontual). **`tools.ts` do bot INTOCADO** — o rótulo mora nas funções que
  o bot já chama.
- Módulo novo `src/admin/painel/queries-galpao-movimentos.ts` (nasce ≤300):
  `setGalpaoMovContext` + wrappers transacionais do painel + `applyGalpaoBaixaManual`
  + `listGalpaoMovements`. Barrel `queries.ts` reexporta.

### Baixa manual com motivo
`POST /admin/api/wholesale/stock/baixa` {measure, quantity, reason} → decrementa
**RECUSANDO acima do saldo** (`baixa_maior_que_estoque:<tem>` → HTTP 409; aqui não é
venda — a régua é a verdade do galpão). Motivo obrigatório; NÃO mexe no custo médio.
Front: form âmbar (qtd + tipo quebra/perda/uso interno/outro + detalhe livre), abre
pelo botão "baixar" da linha; erro amigável mostra o saldo real e aponta o Definir.

### UI da aba (bump `?v=20260707-estoque1` em app.galpao.js/app.core.js/app.js)
- **4 cards no topo**: pneus no galpão · parado em R$ (Σ qty×custo — a MESMA conta do
  `capital_parado` do Financeiro, calculada da lista que a tabela renderiza) · pra
  repor · zeradas.
- **Busca** por texto/dígitos + **ordenação zerou→repor→normal** (`stockRowsView`).
- **Seção Movimentação**: últimos 50 (`GET /admin/api/wholesale/stock/movimentos`,
  `?measure=&limit=` cap 200), botão "filme" na linha filtra a medida (chip + "ver
  todas"), colunas Quando/Medida/Movimento(+/−)/Saldo(a→b)/Custo(só quando mudou)/
  Origem em pt-BR (`movRotulo`).

## 3. Consertos de percurso (achados no próprio preview)
1. `mapWriteError` não conhecia os erros novos → baixa recusada virava
   `internal_server_error` 500. Mapeados: `measure_not_found`, `reason_required`,
   `baixa_maior_que_estoque:*` (→409) e **`min_invalid` do 0126 que TAMBÉM caía em
   500 desde sempre** (o front já traduzia o código, a rota é que não devolvia).
2. **Corrida no filme**: o load geral (watch da aba) e o clique "filme" podiam estar
   em voo juntos — a resposta velha atropelava o filtro. Guarda de request
   (`galpaoFilme.req`): só a resposta MAIS RECENTE pinta a tela. Reproduzido e
   provado no preview.
3. Teste unit `wholesale-stock.test.ts` atualizado pro contrato novo (1ª query =
   rótulo `set_config`, travado no teste).

## 4. Provas (todas verdes)
- **prova-estoque-movimentos-test.ts (NOVA, 18/18 ×2 runs)**: M1-M17 — toda boca
  rotulada (definir insert/update · entrada com custo no filme · venda/cancelamento
  atacado com ref · compra/cancelamento com ref+fornecedor · varejo/cancelamento
  bot+balcão · baixa manual com motivo) + M3 notes/min NÃO loga + M12 baixa acima
  do saldo recusa SEM rastro + M14 fail-safe `sem_rotulo` + **M15 prova de ouro:
  Σ deltas do filme == saldo do galpão** + M16 delete + M17 filtro/limit.
- Não-regressão: prova-sino-galpao 12/12 · prova-compras-cancel 18/18 (ambas
  ganharam limpeza do filme no finally — rodadas ANTES disso deixaram órfãos no
  test, limpos manualmente 94/94-94 + 99/99-99) · 522 unit · typecheck · fiscal
  de tamanho OK.
- Baselines regravados DE PROPÓSITO: paridade matriz 348→**363** (15 props novas),
  rotas 95→**97** (2 novas, AMBAS com AUTH).
- Preview 4226 ponta a ponta: Definir→Entrada(média exata)→baixa com motivo→recusa
  honesta ("só tem 17")→busca por dígitos→ordenação→cards exatos (19 pneus,
  R$540)→filme filtrado por clique. Seeds AUDIT-ESTOQUE limpos (test: stock=0,
  movimentos=0).

## 5. O que NÃO entrou (de propósito)
- Livro-razão/Camada 2 (saldo derivado do livro, pagamento parcial, clamp simétrico)
  = **Fase B**, banca de 4 ANTES (planta `docs/PLANO_FINANCEIRO_MATRIZ_ROBUSTO_2026-07-02.md`).
- Export/relatório do filme; retenção/particionamento da tabela de movimentos
  (volume baixo hoje; se crescer, vira obra).
- O mesmo erro de qtd em inglês na VENDA (anotado desde 07-06c, escopo mínimo).

## 6. Estado pro próximo encontro
- **Aguarda Deploy** (Wallace aperta no Coolify) → conferir de fora
  `?v=20260707-estoque1` + abrir a aba Estoque e ver a Movimentação viva.
- Em prod o galpão tem 2 medidas e NENHUM mínimo definido (0126 é opt-in) —
  sugerir ao dono definir mínimos quando o Deploy subir.
- Fila da auditoria de abas (o dono chama): Resumo · Logística · Financeiro ·
  Rede · Colaboradores. Fila de obras: Fase B fiado parcial (banca antes) →
  frente de caixa do vendedor → Relatórios/export contador.

— Orquestrador (Claude Fable 5) — domínios `matriz`+`banco`, 2026-07-07
