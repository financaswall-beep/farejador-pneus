# SESSÃO 2026-06-29 — Matriz como loja (Tijolos 1+3) + fixes do bot + banco zerado

> Handoff focado no que ficou de fato e no que falta. Detalhe vivo nas memórias `project_*`.
> Modelos: Sonnet 4.6 (construção/fixes) → Opus 4.8 (prova de integração + esta destilação).

`main` HEAD = **`036497a`**. Provas: typecheck 0, vitest **497/497**, prova-matriz-loja **6/6**, prova-geo **9/9** (não-regressão).

---

## ✅ Feito (tudo no `main`, deployado e com flags ON no Coolify)

### A) Matriz vira "MAIS UMA LOJA" — a obra principal (Tijolos 1 e 3)
A decisão 06-27 (matriz concorre IGUAL aos parceiros) foi entregue. Flag **`ROUTING_MATRIZ_AS_STORE`** (exige `WHOLESALE_UNIFIED_STOCK` on).

| Peça | Onde | Commit |
|---|---|---|
| **Tijolo 1** — matriz no anel do `decideStoreForItemsGeo` | `fulfillment.ts` + flag `env.ts` | `5181622` |
| `buscar_produto` enxerga a matriz como loja perto | `tools.ts` | `c80027b` |
| `localizacao_loja` retorna a matriz (retirada ≤15 km / `retirada_so_longe` 15-40 km) | `tools.ts` | `9fb8ed2` + `f58927d` |
| **Tijolo 3** — retirada no galpão (`MATRIZ_MAPS_URL`) | `matriz-freight.ts` + `tools.ts` | `5181622` |
| distância + minutos de carro da matriz (Google) | `google-maps.ts` + `geo-cache.ts` + `fulfillment.ts` | `a8e9e87`/`1f578e0`/`5d06d00` |

**Regra do motor (provada):** a matriz só é checada no FIM do `decideStoreForItemsGeo`, quando `selection.pool.length === 0` (nenhum parceiro no anel). Logo **nunca fura a régua** — parceiro perto com estoque sempre ganha. A matriz vence sobre `only_far` quando está dentro do anel (≤40 entrega / ≤15 retirada) E o GALPÃO tem o pneu (`getMatrizWholesaleStockQty`). Galpão vazio → ela não finge → volta ao `only_far`.

### B) Fixes do bot (prompt frouxo do GPT → garantido por CÓDIGO)
- **`productNudge`** (`agent.ts`, `12e8b59`): regex detecta medida de pneu na msg do cliente → injeta ordem forte pro bot chamar `buscar_produto` ANTES de responder. Matou o "Tenho sim" respondido de cabeça. Gêmeo do `pinNudge`/`photoNudge`.
- **Nome só na saudação** (`prompt.ts`, `aa4274e`): repetir o nome a cada turno soava robótico.
- **Anti-eco** (`agent.ts`, `6f44e15`): antes de enviar, compara com o `say_text` do último turno; igual → descarta. Cliente manda 2 msgs seguidas e os turnos convergem → não duplica no WhatsApp.
- **Distância + minutos** no `retirada_so_longe` da matriz: "tamo a uns 21 km, ~X min de carro". O `cachedMatrizRoadInfo` invalida entradas de cache antigas que só tinham `{km}` (sem `durationMinutes`).

### C) Prova de integração que blinda o motor (`036497a`)
`scripts/prova-matriz-loja-test.ts` — roda o código REAL no env test, flags ligadas via `process.env` antes do import, galpão+medida seedados em BEGIN/ROLLBACK. 6 casos: matriz ganha / parceiro perto ganha (régua intacta) / matriz vence o só-longe / galpão vazio volta ao só-longe / retirada colada / determinismo.
**Rodar:** `npx tsx --env-file=.env.pooler scripts/prova-matriz-loja-test.ts`

### D) Banco de teste ZERADO
Conversas + pedidos (PED-* até 0053) + analytics (TRUNCATE no append-only) + contatos LIMPOS. Preservados: cadastros (parceiros/lojas/logins), catálogo, `partner_stock_levels` (reservas zeradas), `wholesale_stock` (galpão). Pronto pra cliente real.

---

## 🔴 O QUE FALTA

### Validação ao vivo (parte do dono)
- **ENTREGA pela matriz** — só testamos RETIRADA. O frete escalonado (≤15 km R$9,90 / ≤25 R$13 / >25 R$19, `matrizFreightForKm`) está no código e cabeado no `calcular_frete`/`criar_pedido`, mas **nunca rodou ao vivo**. Testar: pedir entrega de um ponto longe da matriz e conferir o frete subir.

### 🧹 Faxina do go-live (as 4 bombas — quando entrar cliente REAL)
1. **🔑 Rotacionar a chave do Google** — está EXPOSTA no chat (colada de novo nesta sessão). Risco de custo. Gerar nova no Google Cloud Console, revogar a velha, pôr no Coolify.
2. **Matar as 5 lojas zz-teste** (barra/copacabana/madureira/méier/tijuca — todas `active` em prod hoje). ⚠️ O dono ainda usa pra testar → **só matar no go-live**. Senão cliente real cai em loja fantasma.
3. **Trocar os raios de TESTE pelos reais** (hoje 2/5/12/15 km, postos pra induzir erro). Lojas reais hoje: Rio do Ouro (raio 3) + Anderson Tavares (raio 40).
4. **Cadastrar o estoque REAL do galpão** + ligar `WHOLESALE_STOCK_DECREMENT` (baixa do atacado, ainda off).

---

## 🔧 Flags no Coolify (estado pós-sessão)
| Flag | Liga o quê | Estado |
|---|---|---|
| `ROUTING_MATRIZ_AS_STORE` | matriz concorre como loja | **on** (06-29) |
| `WHOLESALE_UNIFIED_STOCK` | matriz LÊ o galpão | **on** |
| `WHOLESALE_MATRIZ_DECREMENT` | matriz BAIXA o galpão no varejo | **on** |
| `ROUTING_GEO` / `_ROAD_DISTANCE` / `PROXIMITY_FIRST` / `MULTI_CANDIDATE` / `FAIRNESS` | motor por proximidade + Google | **on** |
| `WHOLESALE_STOCK_DECREMENT` | baixa do ATACADO | off (liga no go-live) |

## ⚠️ Lições da sessão
- **Comportamento do GPT se garante por CÓDIGO, não por prompt** (§3): o "Tenho sim de cabeça" só morreu com o `productNudge` determinístico; o prompt sozinho falhava.
- A matriz vive em `core.units` (slug='main'), **não** em `network.partner_units` → não dá pra reusar as queries de candidato; ela entra por código no fim do motor.
- Cache de distância: ao adicionar um campo novo (`durationMinutes`), entradas velhas precisam ser tratadas como MISS, senão servem dado incompleto pra sempre.
- Deploy no Coolify pula o build quando o commit SHA já tem imagem em cache ("Build step skipped") — push novo força build novo.

## Ordem recomendada pra próxima sessão
**Dono valida a entrega pela matriz ao vivo → faxina do go-live (chave Google primeiro) → cliente real.**

— Orquestrador (Claude Opus 4.8), 2026-06-29
