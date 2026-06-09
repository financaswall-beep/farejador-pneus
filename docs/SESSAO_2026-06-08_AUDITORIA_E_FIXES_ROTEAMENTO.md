# Auditoria + Fixes do Motor de Roteamento do Bot — 2026-06-08

> Estado: **4 fixes commitados em `feat/pickup-to-partner`, NÃO deployados** (prod = `3c7c7ff`).
> Banco de teste **resetado** (clean slate). Round-trip da memória de produto a exercitar ao vivo.

---

## 0. TL;DR
O motor de roteamento (qual loja atende cada cliente) tinha furos onde **o que o bot DIZ divergia do que o pedido FAZ**, porque a "fala" dependia do LLM lembrar de passar parâmetros. Auditoria com 3 especialistas mapeou os furos; 4 fixes resolveram os de maior impacto. Tudo determinístico (lógica + dados estruturados, **zero regex** em texto do cliente).

---

## 1. Como o bot decide a loja (pipeline)
Para cada cliente, o motor (`decideStoreForItemsGeo` em `fulfillment.ts`) aplica, nesta ordem:
1. **Quer atender?** — `service_mode` da loja (entrega/retirada/ambos, editável no painel) + cobertura do bairro.
2. **Tem o produto?** — `commerce.partner_stock_levels` com `deleted_at IS NULL` AND `is_tracked` AND `(on_hand − reservado) > 0`. (É a **tabela do parceiro**; o bot lê ao vivo a cada consulta.)
3. **Está perto?** — distância de **RUA (Google Distance Matrix)** em anéis crescentes:
   - **Entrega:** `GEO_RING_KM = [10,20,30,40]` km.
   - **Retirada:** `GEO_PICKUP_RING_KM = [5,10,15]` km (faixas).
   - A loja numa **faixa mais perto ganha**; acima do maior anel → **matriz** (backstop).
4. **Justiça (régua)** — `rankUnitsByFairnessFromDb`: entre as lojas da **mesma faixa**, quem recebeu **menos lead** em 7 dias ganha. Lead = `partner_orders` `source_tag='2w'` não-cancelado, contado por `created_at` (oportunidade, anti-trapaça).

A **busca** ("tem o pneu?") e a **localização da loja** usam o MESMO motor → a fala bate com o pedido.

---

## 2. Os 4 fixes (lógica de cada)

### Fix #7 — Retirada em faixas (`c31e436`)
- **Era:** retirada usava anel único de 15 km → a régua escolhia entre TODAS as lojas ≤15 km, podendo mandar o cliente 14 km "por justiça" tendo loja a 2 km.
- **Virou:** anéis `[5,10,15]`. Loja numa faixa mais perto ganha direto; só revezam lojas na **mesma faixa** (~5 km).
- **Caso:** Cachambi (Méier 2 km, Tijuca 9 km) → **Méier ganha**. Dois "Méier" na mesma esquina → revezam. Penha (ambos ~9 km) → revezam.
- Arquivos: `ring.ts`, `geo-routing.ts`, `fulfillment.ts`.

### Fix raiz #1/#2/#4/#6 — Memória de produto server-side (`c0ceae6`)
- **Era:** as tools de fala (`localizacao_loja`, `calcular_frete`) só decidiam a loja certa SE o LLM passasse o `product_id` — e ele esquece. Sem ele, caíam num atalho sem régua/anel → fala divergia do pedido (caso Cachambi).
- **Virou:** o produto é lido do que o **próprio bot já gravou** em `agent.turns.actions` (JSON do bot, não texto do cliente). `conversation-products.ts`:
  - `extractRecentProductIds` (PURO, 7 testes): precedência = produto ESCOLHIDO (criar_pedido/calcular_frete/localizacao_loja anterior) > TOP da última busca.
  - `getRecentProductIds` = mesma query do `history.ts` (prod-proven).
  - `localizacao_loja`/`calcular_frete`: quando o LLM não passa o produto, usam o helper → caem no MESMO `decideStoreForItemsGeo` do pedido.
- **Resultado:** a loja que o bot DIZ = a loja onde o pedido CAI. Sempre. Acabou o "depende do humor do modelo".

### Fix #3 — Entrega sem `geo_resolution_id` (`38b9960`)
- **Era:** `criar_pedido` de entrega só tentava o parceiro com `geo_resolution_id` presente; sem ele → 100% matriz, mesmo havendo parceiro com estoque na cidade. Parceiro perdia a venda E a régua não contava o lead.
- **Virou:** deriva o município do **bairro** quando falta `geo_resolution_id` e tenta o parceiro (igual a retirada já fazia).
- Arquivo: `tools.ts`.

### Fix #4 — Pede a localização antes de cravar "tenho" (`a360dc0`)
- **Era:** cliente "tem 90/90-18?" sem bairro → bot "Tenho sim" (estoque da matriz, genérico).
- **Virou:** busca sem bairro marca `precisa_localizacao=true`; o prompt manda o bot **cumprimentar + pedir o bairro/localização** ("pra ver a loja mais perto de ti") antes de prometer estoque. Pode dizer o preço (igual em toda loja). Determinístico (código + prompt).
- **Caso:** "olá, tem 90/90-18?" → "Opa, bom dia! 👋 Pra eu ver se a loja mais perto de ti tem, me manda tua localização 📍 ou o bairro." → cliente diz Cachambi → confirma a loja real (Méier).
- Arquivos: `tools.ts`, `prompt.ts`.

---

## 3. O que ficou DE FORA (com motivo)
- **#5 (getUnitMapsUrl sem teto de km):** virou **inalcançável** após o fix raiz — a retirada cai sempre no motor com anel; o caminho antigo só roda sem coordenada, onde já responde "pergunta o bairro".
- **BAIXO (estoque da matriz sem `deleted_at`):** **não existe** — `commerce.stock_levels` não tem coluna `deleted_at` (só o estoque do parceiro tem soft-delete).
- **#6 (número da busca pode ser de loja vizinha):** aceitável — é número de disponibilidade, não nome de loja; ambas têm o pneu.
- **#8 (`calcular_frete` assume entrega):** aceitável — frete só existe na entrega; documentado como invariante.

---

## 4. O bot consulta o banco do PARCEIRO? SIM.
O bot lê `commerce.partner_stock_levels` (a **tabela do parceiro**) ao vivo em 4 funções (`fulfillment.ts`: `mapProductToPartnerStock`, `getPartnerStockMap`, `resolveProductAvailabilityByProximity`, `getUnitMapsUrl`). Todas respeitam `deleted_at` (apagado) + reserva. Provado por `scripts/checar-estoque-9018.cjs` (coluna `bot_ve`): Madureira apagada → bot vê 0; Méier com reserva → bot vê on_hand − reservado. É **o mesmo que o painel do parceiro mostra**.

---

## 5. Como testar (clean slate)
1. **Subir os 4 fixes** (senão testa o código velho `3c7c7ff`).
2. Apagar a conversa de teste no Chatwoot (UI) entre testes.
3. Casos:
   - "tem 90/90-18?" **sem bairro** → bot **pede a localização**, não diz "tenho".
   - Cachambi + retirar → **Méier** (faixa mais perto), confiável (memória de produto).
   - Penha + retirar → **revezamento** Méier/Tijuca (mesma faixa); feche um pedido e veja virar pro outro.
   - Apagar o pneu da loja perto pelo painel → bot anda pra a próxima que tem (respeita `deleted_at`).
- Conferir estado: `node --env-file=.env scripts/checar-estoque-9018.cjs`.

---

## 6. Commits (em `feat/pickup-to-partner`, sobre `3c7c7ff`)
| Commit | Furo |
|---|---|
| `c31e436` | #7 faixas de retirada [5,10,15] |
| `c0ceae6` | raiz: memória de produto server-side |
| `38b9960` | #3 entrega tenta o parceiro |
| `a360dc0` | #4 pede localização antes de "tenho" |

Provado: typecheck + 322 testes + `scripts/prova-busca-proximidade-test.ts` (12 checks) verdes.

— Sessão 2026-06-08, orquestrador (Claude Opus 4.8) + especialistas bot/matriz/coletor.
