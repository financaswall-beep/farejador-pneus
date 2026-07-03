# SESSÃO 2026-07-03b — Logística da Matriz (0121): entregas + rota do entregador + IA lê comprovante

> Handoff. O durável destilado vai pro `CLAUDE.md` (§7/§11) e pra memória privada `project_logistica_matriz`.

## TL;DR
- A matriz ganhou a aba **Logística** nos moldes da do parceiro, com o extra que o dono pediu: o **diário de rota do entregador** (km inicial/final, gasolina, comprovantes) e a **IA lendo o comprovante e lançando a despesa sozinha** no Financeiro (0120).
- **Pedido do dono (07-03):** "logística igual à do parceiro, mas o entregador registra gasolina/km/comprovante e a IA cadastra no financeiro automático." Duas decisões dele via pergunta fechada: **acesso só-rota pro entregador** (fatia C, futura) e **diário por SAÍDA/rota** (não por entrega).
- Commit **`7022462`** PUSHADO — **DORMENTE** (flags `MATRIZ_LOGISTICS` + `MATRIZ_RECEIPT_AI` default OFF). **Banca de 4 rodou ANTES do push** (obra de dinheiro): 3× SHIP + 1 FIX-ANTES → P1 consertado + re-provado. Aguarda Deploy + ligar flags.

## O que entrou

### Migration 0121 (APLICADA no Supabase)
- `commerce.orders` ganha o termômetro de entrega (espelho do 0068 do parceiro): `delivery_status` (pending|dispatched|delivered|failed), `delivery_courier`, `dispatched_at`, `delivered_at`, `trip_id`. Backfill honesto (status='delivered' → delivery_status='delivered'). Índice parcial pra fila.
- `commerce.matriz_delivery_trips` — a ROTA/saída (courier, km_start/km_end, fuel_spent, fuel_expense_id→0120, status open|closed, CHECKs km_end≥km_start etc.).
- `commerce.matriz_trip_receipts` (meta: mime, size, ai_status pending|parsed|unreadable|skipped, ai_expense_id→0120, ai_summary) + `matriz_trip_receipt_blobs` (BYTEA 1:1, molde 0094 — lista nunca arrasta blob).
- **Zero grant pro parceiro** nas 3 tabelas (DO-block prova no apply; seguranca confirmou em prod que commerce.orders também é zero-grant — colunas novas não herdam nada).

### Backend (`src/admin/painel/`)
- **Flags** (env.ts): `MATRIZ_LOGISTICS` (a obra) + `MATRIZ_RECEIPT_AI` (só a leitura por IA) — ambas default OFF.
- **queries.ts** (seção 0121 no fim): `getMatrizLogistica` (a tela num GET: abertas/finalizadas/rotas), `setMatrizDeliveryStatus` (saiu/entregue — entregue fecha o pedido: status delivered+closed_*; NÃO mexe na régua de faturamento 0117, que conta não-cancelado), `failMatrizDelivery` (**não entregue = failed + CANCELA no caminho atômico** `cancel_manual_order`+`applyMatrizGalpaoReturn` — galpão volta pela trilha fdd9148), `openMatrizTrip` (rota + pendura entregas → dispatched), `closeMatrizTrip` (km final + gasolina → **lança despesa 'combustivel' no 0120**, created_by `logistica-fechamento`), `addMatrizTripReceipt` (cap 50/rota), `getMatrizTripReceiptImage`, `recordReceiptAiResult` (lançamento da IA, created_by `ia-comprovante`, idempotente).
- **Guard de ouro:** `MAIN_DELIVERY_GUARD` em TODA leitura e escrita — só pedido de ENTREGA da unit **main**; pedido de parceiro é inalcançável (banca `parceiro` confirmou; provas L1/L2).
- **ANTI-DUPLA-CONTAGEM nas duas ordens** (P1 da banca, consertado): a despesa da gasolina nasce por UM caminho — comprovante lido OU fechamento. Se o fechamento lançou primeiro e o comprovante é lido DEPOIS, a leitura **COLA na despesa existente** (vira lastro, `linked_existing`) em vez de criar a 2ª. `FOR UPDATE` na trip serializa leitura×fechamento (fecha a race apontada pelo `banco`).
- **receipt-ai.ts** — visão OpenAI (fetch cru, padrão agent.ts): JSON estrito {category, amount, merchant, date, confidence}; **nunca inventa** — confiança <0.7, valor ilegível/fora do teto (R$10k) → `unreadable` (lançar na mão); erro de transporte → fica `pending` com "ler de novo". Categoria fora do enum → outros.
- **route.ts** — 7 rotas `/admin/api/logistica/*`, todas `requireAdminAuth`; upload = bytes crus (funil blindado `reencodePhoto` do parceiro: magic bytes, re-encode, EXIF fora, 8MB, 30MP); IA inline no upload (falha não derruba o upload).

### Front (`painel/public/`, `?v=20260703-logistica`)
- Aba **Logística** no menu vivo (entre Estoque e Financeiro). Dormente → aviso com o nome das chaves.
- Blocos: **Rota na rua** (comprovantes com miniatura + status da leitura + "ler de novo" + anexar + fechar com km/gasolina/obs) · **Abrir rota** (entregador, km inicial, checkbox das entregas) · **Entregas em aberto** (cards: cliente/fone/endereço/itens/status; Saiu → Entregue com forma de pagamento / Não entregue com motivo — avisa que cancela e o galpão volta) · **Finalizadas** · **Rotas recentes** (km rodados, gasolina, "no Financeiro ✓").
- **Miniatura AUTENTICADA** (P2 da banca `seguranca`): `<img src>` puro levava 401 (prova de que o endpoint não vaza) → `loadReceiptThumbs` busca com o Bearer e rende via blob URL (revoga as que saem de cena).

## Banca de 4 (ANTES do push — regra do dono em obra de dinheiro)
- **matriz: FIX-ANTES** → P1 dupla-contagem na ordem "fecha manual→lê depois" (CONSERTADO, prova L14a/b/c); validou régua de faturamento intocada, conciliação do failed→cancelled, competência da despesa, guard-rails da IA.
- **banco: SHIP com ressalva** → P2 prova não-determinística (CONSERTADO: pré-limpeza por marcador + rodada 2× verde); P3 race close×IA (FECHADO junto com o P1 via FOR UPDATE na trip); P3 ROLLBACK cosmético (virou COMMIT). Validou atomicidade do failMatrizDelivery, 42P08 sem risco, migration íntegra contra o schema real.
- **parceiro: SHIP** → guard tranca tudo; colunas novas invisíveis pro bot/parceiro (nenhum SELECT *; o bot lê entrega de parceiro de partner_orders); import photo-upload sem ciclo; `parceiro/public` byte a byte intocado. P3 opcional: backfill sem filtro de unit (inofensivo — coluna invisível fora da main; arquivo reflete o que rodou, não mexer).
- **seguranca: SHIP** → zero grant provado em prod (incl. commerce.orders — zero grant de tabela E coluna); todas as rotas com auth; XSS não (x-text); PII não viaja (só a imagem); prompt-injection contido (IA só propõe; código grava com teto/confiança; pior caso = despesa inflada, visível e reversível). P2 thumbnail (CONSERTADO); P3 cap 50 (FEITO); rate-limit dispensado (token único do dono — defensável).

## Provas (tudo verde)
| Prova | Resultado |
|---|---|
| `scripts/prova-logistica-matriz-test.ts` | **20/20 × 2 runs seguidos** (determinismo exigido pelo banco) — fila main-only, guard de escrita, termômetro, galpão volta no não-entregue, rota, anti-dupla NAS DUAS ORDENS, leitura idempotente, unreadable não lança, blob byte a byte, cap 50 |
| `npm test` | 522/522 |
| `npm run typecheck` | ✓ |
| Preview 4217 (`matriz-logistica-4217`) | fluxo completo pela UI: rota aberta → comprovante (funil re-encode ok) → fechada com R$174,86 → **despesa apareceu no Financeiro** → entrega finalizada; miniatura autenticada renderizando (blob) |

## Adendo (mesma sessão, pós-banca): card com contato do entregador (`9e3fd56`)
Pedido do dono ao revisar: o card da entrega da matriz não tinha os botões do card do parceiro. Portados VERBATIM de `parceiro/public/app.format.js` os deep-links custo zero — **WhatsApp** (wa.me com mensagem pronta "sou o entregador, estou a caminho 🛵", fora da API Meta), **Waze** e **Maps** (navegação no endereço, sem chave/cota). WhatsApp só aparece com telefone (pedido do bot tem, via `core.contacts`; walk-in sem contato esconde — `x-show`); Waze/Maps só com endereço. Ícones lucide re-renderizam no `$nextTick` do `loadLogistica` (já existia). `?v=` bumpado pra **`20260703-logistica2`**. Prova: preview **4218** (`matriz-logistica-card-4218`, env test) — venda de entrega criada pelo `register-walkin`, os 3 botões visíveis com href certos (conferidos por inspeção DOM), console zero erro; limpeza pelo próprio "Não entregue" (200 → `failed`, abertas 0 — re-validou o caminho do cancelamento). Detalhe descoberto no teste: o guard `validate_env_match` barrou contact de prod em pedido de test (trigger de ambiente vivo ✓).

## Adendo 2 (07-03c): "A ROTA SE PAGOU?" — resumo financeiro da rota fechada
Pedido do dono ao revisar o roadmap da Logística (escolheu SÓ esta fatia; foto de entrega e rota-no-Maps ele descartou): a rota fechada dizer se **sobrou ou faltou dinheiro** — e com a sacada dele dentro: o lucro do PNEU entra na conta (custo médio congelado da 0117), não só o frete.
- **Backend** (`getMatrizLogistica`, `queries.ts`): tripSelect ganha `resumo` (jsonb por rota: entregues, frete_total, faturamento_pneus, lucro_pneus, itens_sem_custo) + `despesas_total`. Regras: **só entrega `delivered`** conta (failed/cancelada FORA); **frete = total_amount − Σitens** (o bot embute o frete no total; walk-in/manual sem frete → `GREATEST(...,0)` = 0, nunca negativo); **lucro = régua 0117 byte-idêntica** ao card do varejo (item sem `matriz_unit_cost` fica FORA do lucro e é CONTADO pro aviso — nunca chuta); **despesas = fechamento ∪ comprovantes IA sem dobrar** (pertinência por linha; caso linked = mesma despesa soma 1×); `deleted_at IS NULL` → dono apaga a despesa no Financeiro e a rota reflete na hora.
- **Front**: `rotaResumo(t)` (app.js) só soma/formata o que o servidor manda; linha na tabela Rotas recentes — `sobrou R$ 14,90` verde / `faltou` vermelho + decomposição `frete + pneus − rota` + aviso âmbar "N item(ns) sem custo congelado — lucro parcial". `?v=` **`20260703-logistica3`**.
- **Banca de 2** (matriz+banco — 2 e não 4 porque é obra SÓ-LEITURA reusando régua já aprovada): **2×SHIP, zero P1**. `banco` provou no banco vivo o dedup do `OR`+`IN` (50, não 100) e deixou 1 P2 = índice em `orders(trip_id)` → **migration `0122` (parcial `environment,trip_id WHERE trip_id IS NOT NULL`) APLICADA via pooler** + 1 P3 cobertura → caso **L14d** (despesas_total do linked não dobra: 120, não 240). `matriz` re-rodou typecheck+prova do zero e conferiu o frete derivado nos 3 caminhos que criam pedido (bot embute / manual sem frete / walk-in nunca ganha trip_id).
- **Provas**: prova-logistica **25/25 × 2 runs** (20 originais + L16a-d + L14d), 522 unit, typecheck ✓, validação visual no preview (rota demo com "sobrou R$ 14,90" verde, console limpo, cenário apagado depois).
- Nota operacional: a sessão caiu (créditos) DEPOIS dos consertos da banca e ANTES do push; a retomada recuperou os vereditos pelos transcripts dos agentes, re-rodou todas as provas, aplicou a 0122 e pushou — por isso o adendo saiu em commit separado do `7022462`.

## Estado / o que falta
- **PUSHADO `7022462` + `9e3fd56` (card de contato) + adendo 07-03c (rota se pagou), aguarda Deploy.** Pós-deploy conferir `?v=20260703-logistica3` de fora. **Flags pra ligar no Coolify quando o dono quiser operar:** `MATRIZ_LOGISTICS=true` (a aba) e `MATRIZ_RECEIPT_AI=true` (a leitura por IA — precisa da `OPENAI_API_KEY` que já vive lá).
- **Validar ao vivo (a IA não roda local — chave só no Coolify):** subir um comprovante REAL de posto e ver a despesa nascer; conferir miniatura; rota completa com entrega do bot.
- **Fatia C (sessão própria, decisão do dono 07-03): acesso SÓ-ROTA pro entregador** — login próprio que abre só a tela de entregas (sem financeiro). Fundação = porta única/pessoas (0095/0100). Zona de auth → `seguranca` revisa antes.
- P3s registrados (não urgentes): volume de despesas de rota na lista do Financeiro (produto decidir agrupamento); `getMatrizLogistica` 4 queries paralelas (aceitável em prod).
- Preview 4217 de pé (não derrubar 4213/4214/4215/4216 — outras frentes).

— Orquestrador (Claude Fable 5) — domínios `matriz` + `banco` + `seguranca` + `front`; banca: matriz/banco/parceiro/seguranca (Opus)
