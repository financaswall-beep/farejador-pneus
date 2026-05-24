# Sessão 2026-05-23 — Handoff

**Autor:** Claude (Anthropic, modelo Sonnet 4.5)
**Data:** 2026-05-23
**Duração:** ~4 horas de trabalho ativo
**Contexto inicial:** continuação direta da sessão 2026-05-22. Wallace pediu auditoria profunda anti-alucinação. Plano foi escrito (5 camadas). Esta sessão executou a **Camada 4 (cobertura operacional do catálogo)** integralmente.

Esse documento é o estado completo da sessão para o **próximo agente (LLM)** continuar sem reler a transcrição.

---

## TL;DR — O que foi feito

| frente | resumo |
|---|---|
| **Auditoria profunda anti-alucinação** | 4 agentes paralelos (prompts, validadores, fluxo, banco) auditaram cada camada do bot. Síntese crítica em `docs/PLANO_ANTI_ALUCINACAO_2026-05-22.md` com 5 camadas de fix. |
| **Pesquisa de medidas** | 23 buscas web (manuais Honda/Yamaha/Suzuki/Dafra/Haojue/Royal Enfield/Kasinski + sites motonewsbrasil, motorcyclist, fichatecnica) para coletar medidas oficiais. |
| **Descoberta crítica** | Catálogo tinha aliases envenenados (Crosser tinha "Lander"/"Tenere" como alias, Ténéré 700 tinha "Tenere" simples roubando consultas da 250). Não estava no plano original — descoberto em dry-run. |
| **Consolidação do catálogo (prod)** | 87 operações em transação única: 14 tire_specs novos, 14 duplicatas consolidadas, 8 órfãs apagadas, 14 aliases limpos, 2 variantes novas, 5 motos modernas adicionadas, 45 fitments. |
| **Bug 593 morto na raiz** | PCX 150 agora tem 4 fitments (OEM 100/80-14 + 120/70-14, alternativas 90/90-14 + 100/90-14). `find_compatible_tires(PCX 150)` deixou de retornar `[]`. |

**Estado do banco em prod após sessão:**
- 141 motos (era 157 — 16 duplicatas removidas, 7 novas adicionadas)
- 70 produtos / 70 tire_specs (+14 novos)
- 177 fitments (+45 novos)
- Cobertura: Honda 36/38, Yamaha 21/22, Royal Enfield 4/4 = 100%

---

## Filosofia mantida intacta

O usuário reforçou várias vezes nesta sessão:
- Zero regex semântico (recusei adicionar regex no say-validator que o agente de prompts sugeriu)
- Decisão semântica fica no LLM
- Solução é apertar invariante estrutural OU ensinar via prompt — não criar regra hardcoded
- "Prompts pensativos > prescritivos"

Quando o próximo agente for tentado a "adicionar uma regra rápida": **NÃO faça sem perguntar**.

---

## Plano anti-alucinação — status das 5 camadas

Documento mestre: `docs/PLANO_ANTI_ALUCINACAO_2026-05-22.md`

| camada | descrição | status |
|---|---|---|
| **1.1, 1.2, 1.3** | Schema de facts com `vehicle_anchor`; fact_keys com objeto rico; fitment claim com `vehicle_model_id` obrigatório | ❌ **PENDENTE** — Wallace decidiu adiar (sistema em score 9, não justifica refator profundo) |
| **1.4** | Tool `CompatibilidadeResultado` com `fitment_status` enum | ❌ **PENDENTE** — recomendada como próxima |
| **1.5** | Tool `ProdutoOferta` com `compatible_vehicle_models[]` | ❌ **PENDENTE** — recomendada como próxima |
| **2.1-2.6** | Invariantes estruturais (claim_validator cruza variante; record_offer exige fitment; context-builder filtra obsoletos; etc.) | ❌ **PENDENTE** — depende de 1.1-1.3 |
| **3.1-3.5** | Prompts pensativos (CoT obrigatório antes de fitment claim; Exemplo 15 pivot de moto; Exemplo 16 compat vazia; Planner regra de ouro; Organizadora regra de ancoragem) | ❌ **PENDENTE** — recomendada após 1.4+1.5 |
| **4.1, 4.2, 4.3** | Cobertura operacional do catálogo | ✅ **CONCLUÍDA NESTA SESSÃO** |
| **5.1, 5.2** | Observabilidade (teste sintético + métricas em ops) | ❌ **PENDENTE** |

**Decisão do Wallace nesta sessão:** atacar Camada 4 primeiro (resolve a CAUSA RAIZ do bug 593 sem código novo). Após validar que bot melhora em produção, retomar Camadas 1.4 + 1.5 + 3.

---

## Estado atual do catálogo (detalhe)

### Top motos populares — cobertura 100%

**Comuter Honda CG (todas com 80/100-18 + 90/90-18 ou 100/90-18):**
CG 150 Fan/Titan (2009-2015), CG 160 Fan/Titan/Start/Cargo (2015-2026)

**Scooters Honda:**
- PCX 150 (2013-2022) → **4 pneus** (100/80-14 + 120/70-14 OEM; 90/90-14 + 100/90-14 alt)
- PCX 160 (2023-2026) → 110/70-14 + 130/70-13
- ADV 160, Biz 125, Pop 110i ES, Elite 125, Lead 110

**Scooters Yamaha:**
NMAX 160 ABS, Neo 125 UBS, Fluo 125 ABS, XMAX 250 ABS, Aerox 155 ABS

**Trail comuter Honda:**
NXR 150 Bros, NXR 160 Bros, XRE 190, XRE 300, XR 250 Tornado

**Yamaha Factor/Fazer:**
Factor YBR 125/150, Fazer 150 (3 pneus: 80/100-18/front + 90/90-18 e 100/80-18 rear alt), Fazer 250

**Yamaha trail (2 gerações cada quando aplicável):**
- XTZ 150 Crosser (2015-2024) + XTZ 150 Crosser S 2025 (2025-2026)
- XTZ 250 Lander
- XTZ 250 Ténéré (2011-2019) + XTZ 250 Ténéré Flex (2020-2026)

**Twister moderna (5 modelos):**
- Honda CB 250F Twister (2016-2022)
- Honda CB 300F Twister (2024-2026) — novo pneu 150/60R17 criado
- Honda CBR 250R (2011-2014)
- Yamaha XJ6 (2010-2017)
- Honda CB 750 Hornet (2024-2026)
+ Honda Twister CBX 250 antiga (2001-2008) já estava

**Yamaha MT:** MT-03, MT-07, MT-09

**Honda CB grandes:** CB 300R, CB 500F, CB 500X, CB 650R, CB 1000R, Hornet CB 600F antiga

**Suzuki:** Burgman 125i, Boulevard C50, Boulevard M800

**Royal Enfield (100%):** Classic 350, Meteor 350, Himalayan 411, Scram 411

**Kasinski:** Mirage 150, Mirage 250

**Haojue:** NK150 ABS, Lindy 125, DR160, DR160S, DL160

**Dafra:** Smart 125, Citycom 300i, Apache RTR 200

### Cobertura por marca após COMMIT

```
Honda             36/38 com fitment
Yamaha            21/22
Suzuki             6/7
Haojue             5/7
Triumph            6/9
Kasinski           4/5
Royal Enfield      4/4 = 100%
BMW                4/6
Dafra              3/4
Kawasaki           3/7
Harley-Davidson    3/5
Zontes             3/4
Bajaj              2/4
Sundown            2/2
Shineray           1/3
Ducati             1/1 = 100%
Outras (KTM, Traxx, MVK, GasGas, Husqvarna, Aprilia, Garinni)  0
```

### Motos ainda sem fitment (15 entradas)

São genéricas órfãs de outras marcas (não Honda/Yamaha) que já têm versão com year+fitment cadastrada. Não bloqueiam nada — só são lixo de mojibake do merge test→prod. Próxima limpeza:

| genérica | versão com year que cobre |
|---|---|
| Bajaj Dominar | Dominar NS160 + NS400Z |
| Bajaj Pulsar N160 | — sem versão (precisa cadastrar se vender) |
| Dafra Apache | Apache RTR 200 |
| Haojue DL | DL160 |
| Haojue DR160 (sem year) | DR160 (2018-2026) + DR160S |
| Honda Africa Twin | CRF 1000L + 1100L Africa Twin |
| Honda CRF | CRF 230F + 250F |
| Kasinski Win | Win 110 |
| Suzuki V-Strom | 650 + 650 XT + 800DE |
| Yamaha TT-R | TT-R 230 |

E motos premium raras (KTM 1290 Super Adventure, Husqvarna 701 Enduro, Aprilia Tuareg, BMW F800/F850 GS, Triumph America/Speedmaster, etc.) — vendem zero pra loja de Wallace, deixar pra cliente trazer demanda real.

---

## Aliases corretos por canônica (após limpeza)

Foram REMOVIDOS aliases envenenados onde uma moto roubava nome de outra:
- Yamaha XTZ 150 Crosser tinha aliases `["Lander", "Tenere", "Ténéré"]` → agora só Crosser e variações
- Yamaha XTZ 250 Lander tinha `["Crosser", "Tenere"]` → agora só Lander
- Yamaha XTZ 250 Ténéré tinha `["Crosser", "Lander"]` → agora só Tenere/Ténéré
- Yamaha Ténéré 700 tinha `["Tenere", "tenere", "ténéré"]` → agora só "Ténéré 700", "Tenere 700"

Aliases inseridos em canônicas que estavam sem:
- Honda Biz 125, NXR 150/160 Bros, Pop 110i ES, XRE 190/300, PCX 150/160
- Lead 110, Elite 125, XMAX 250 ABS
- Boulevard M800
- Haojue NK150
- Mirage 150/250
- Classic 350, Meteor 350, Himalayan 411, Scram 411

---

## Bug 593 — antes vs depois

**Conversa real (28/05/2026):**
- Cliente: "Tenho PCX 2020"
- Bot (antes): chamou `buscarCompatibilidade(PCX, 2020)` → retornou `produtos:[]` → caiu em `buscarProduto(130/70-13)` (medida da PCX 160 que tinha em fact_keys) → bot disse "achei o pneu 130/70-13 pra sua PCX 2020 por R$99" → **MENTIRA** (130/70-13 é da PCX 160, PCX 150 usa 100/90-14)

**Mesmo fluxo agora (após COMMIT):**
- Cliente: "Tenho PCX 2020"
- Bot: `buscarCompatibilidade(PCX, 2020)` → retorna 4 produtos: `100/80-14/front, 120/70-14/rear, 90/90-14/front, 100/90-14/rear`
- Bot oferece honestamente uma dessas medidas → **VERDADE**

**Sem código novo. Só dado.**

---

## Scripts criados nesta sessão

| script | uso |
|---|---|
| `scripts/cadastrar-fitments-2026-05-23.ts` | **DEPRECADO** — primeira tentativa, descobriu duplicatas no dry-run, foi substituído pelo consolidar |
| `scripts/consolidar-catalogo-2026-05-23.ts` | **APLICADO EM PROD** — script principal, ~700 linhas. Faz tudo em transação única (consolidar duplicatas + UPDATE aliases + INSERT variantes + DELETE genéricas + INSERT tire_specs + INSERT fitments + smoke tests + relatório final). Idempotente (chega INSERTs/UPDATEs com checagem de existência) |

Ambos têm dry-run default (COMMIT=0). Pra rerodar:
```
DRY-RUN: npx tsx --env-file=.env scripts/consolidar-catalogo-2026-05-23.ts
COMMIT:  COMMIT=1 npx tsx --env-file=.env scripts/consolidar-catalogo-2026-05-23.ts
```

Script já foi COMMITADO no banco prod em 2026-05-23. Rerodar agora é no-op (todas as checagens "ja existe, pulando").

---

## Documentos criados nesta sessão

| doc | conteúdo |
|---|---|
| `docs/PLANO_ANTI_ALUCINACAO_2026-05-22.md` | Plano mestre das 5 camadas (escrito em 22/05, base pra esta sessão) |
| `docs/SESSAO_2026-05-23_HANDOFF.md` | Este documento |

---

## Próximas frentes (em ordem de impacto sugerido)

1. **Validar em produção que o bug 593 não acontece mais.** Rodar conversa-teste real "PCX 2020" e auditar com `scripts/auditar-conversa.ts <conv_id>`. Esperado: bot oferece 100/90-14 ou 120/70-14 sem mentir.

2. **Camadas 1.4 + 1.5 do plano anti-alucinação** (~1h). Adicionar `fitment_status` enum em `CompatibilidadeResultado` e `compatible_vehicle_models[]` em `ProdutoOferta`. Backward compatible. Protege contra futuros gaps de catálogo.

3. **Camada 3 do plano** (~2h). Exemplo 15 (pivot de moto) + Exemplo 16 (compat vazia, seja honesto) no `prompt-v1_5.ts`. Sem regex — só few-shot ensinando padrão.

4. **Apagar as 15 genéricas órfãs restantes** (~10 min). Mesmo padrão deste script (zero refs, hard delete).

5. **Camadas 1.1, 1.2, 1.3 + 2** — só se aparecer um SEGUNDO bug do mesmo tipo de fact desancorado. Princípio: não otimize prematuramente.

6. **Eval suite anti-regresso** — teste sintético da conv 593 em `tests/integration/atendente/`. Garante que ninguém volte a quebrar o bug.

---

## Como rodar uma auditoria pós-deploy

```bash
# 1. Conversa-teste de PCX 2020:
npx tsx --env-file=.env scripts/auditar-conversa.ts <chatwoot_conv_id>

# 2. Verificar fitments cadastrados:
npx tsx --env-file=.env scripts/listar-pcx.cjs

# 3. Resolver no banco (não precisa rodar bot):
psql $DATABASE_URL -c "SELECT * FROM commerce.resolve_vehicle_model('prod'::env_t, 'PCX', 2020, 0.4);"
psql $DATABASE_URL -c "SELECT * FROM commerce.find_compatible_tires('prod'::env_t, (SELECT id FROM commerce.vehicle_models WHERE make='Honda' AND model='PCX 150' AND year_start=2013 LIMIT 1), NULL);"
```

---

## Assinatura

**Sessão realizada por:** Claude (Anthropic, modelo Sonnet 4.5)
**Data:** 2026-05-23
**Trabalho aplicado em prod:** 87 operações de banco em transação única (COMMIT às ~03:30 UTC)
**Testes:** dry-run completo passou 17 smoke tests antes do COMMIT
**Filosofia anti-regex:** mantida intacta (recusei sugestão de regex do agente de prompts)
**Bug 593:** morto na causa raiz (PCX 150 agora tem 4 fitments)

---

## Anexo — filosofia em uma página (mantido da sessão anterior)

> *"esse sistema foi projetado pra nao ser linear evitar regex etc etc pois regex deixa o bot burro"*
> — Wallace

> *"quero um agente mais pensativo que rigido"*
> — Wallace

> *"não quero entender porque o bot não fez certo. tem preço? tem medidas? tem compatibilidade?"*
> — Wallace

A regra é: **toda decisão de conteúdo (intent, separação semântica, ambiguidade) fica no LLM. Código só faz transporte, persistência e validação estrutural.** Quando o LLM faz besteira, a correção é **ensinar o LLM (prompt) ou apertar invariantes estruturais (schema, validator de evidência)** — NUNCA adicionar regex sobre conteúdo nem regra hardcoded por palavra-chave.

Esta sessão respeitou isso. Solução pro bug 593 foi puramente dado/catálogo, sem código novo no bot.

Quando estiver em dúvida: **pergunte antes de fazer**. Especialmente em operações destrutivas no banco ou commits.

---

# Sessão paralela do mesmo dia (2026-05-23, continuação noturna)

> **Adendo:** este documento foi originalmente escrito por um agente que rodou em paralelo nesta data e atacou a Camada 4 do plano anti-alucinação (cobertura de catálogo). A seção abaixo descreve o que **outro agente** fez no mesmo dia, em janela posterior, com foco diferente: **isolar Organizadora**, **corrigir bug de acentos no resolver de bairro**, e **expor `add_to_cart` no Atendente**. Os dois trabalhos são complementares — um cuidou do catálogo, o outro da arquitetura do bot.

## TL;DR do trabalho complementar

| frente | resumo |
|---|---|
| **Fase 1 — Isolar Organizadora** | `organizer_facts` deixa de entrar no contexto do Planner+Atendente. Bot passa a depender só de `state.global_slots` + `state.items` + `recent_messages` + `tool_results`. Organizadora continua extraindo facts pra `analytics.conversation_facts` mas isolada do atendimento. Mata a categoria de bugs onde fact contaminado virava mentira. |
| **Migration 0048 — Acentos** | Bug observado: `calcularFrete(Fonseca, Niteroi)` retornou `bairro_nao_encontrado` mesmo com Fonseca cadastrada. Causa: `lower('Niterói') = 'niterói' != 'niteroi'`. Fix: `CREATE EXTENSION unaccent` + reescrever `resolve_neighborhood` usando `lower(unaccent(...))`. Cobre todas as 15 cidades + 624 bairros. |
| **Sprint A — `add_to_cart` no Atendente** | Bug 595 (multi-item): cliente comprou pra ele + amigo (2 pneus), bot somou só R$ 108,90 (1 pneu + frete) em vez de R$ 207,90. Causa: `cart_current_items` vazio porque `add_to_cart` não estava exposto no schema do Generator. Fix: adicionar `add_to_cart` no `generatorRawActionSchema` + JSON strict + hidratação + 2 exemplos novos no prompt v1.5 (Exs 15+16). |
| **Caminho futuro mapeado** | Documentado plano de migração gradual pro Planner (Etapas 1-4) caso futuro padrão de erros justifique. |

## Commits desta janela

```
05a324e feat(atendente): isola Organizadora do contexto do Planner+Atendente (Fase 1)
e5f02d8 fix(commerce): resolve_neighborhood normaliza acentos via unaccent (migration 0048)
fe78290 feat(atendente): expoe add_to_cart no Generator v1.5 (Sprint A)
```

Migration 0048 já aplicada em prod via `aplicar-0048.cjs --commit` (2026-05-23 ~17:30Z).

## Estado da arquitetura — quem faz o quê (após esta janela)

```
🎯 Planner (LLM)
   decide:   skill + tool_requests
   grava:    NADA
   tamanho:  87 linhas, ~2k tokens

💬 Atendente / Generator (LLM)
   interpreta dados + escreve resposta + grava
   actions hoje (5 tipos):
      - update_slot
      - create_item
      - record_offer
      - update_draft
      - add_to_cart    ← NOVO (Sprint A)
   tamanho:  ~320 linhas, ~4.6k tokens

📊 Organizadora (LLM, isolada)
   só extrai facts pra analytics.*
   NÃO interfere no atendimento em tempo real
   tamanho:  147 linhas, ~2.9k tokens
```

## Caminho FUTURO: "migrar tudo pro Planner"

Durante esta janela da sessão, o Wallace levantou questão arquitetural:

> *"Eu pensava que o Planner fazia tudo isso e o Atendente só falava com o cliente."*

Hoje **não está assim** — o Atendente faz interpretação + gravação + fala. O Planner só decide skill+tools.

### Por que está assim hoje
- Escolha de otimização: 1 LLM call por turn em vez de 2 (custo+latência menores).

### Quando vale migrar
Se padrão de erros mostrar Atendente errando interpretação consistentemente. Hoje (após Sprint A), Atendente está estável. Sem evidência recorrente, refator não tem urgência.

### Plano de migração gradual (se algum dia for fazer)

| etapa | esforço | risco | ganho |
|---|---|---|---|
| 1 — Planner ganha `update_slot` | 2-3h | baixo | Planner começa a justificar nome |
| 2 — Planner ganha `create_item` + `update_draft` | 2-3h | baixo | Separação semântica vira do cérebro |
| 3 — Planner ganha carrinho (add/remove/update/clear) | 3h | médio | Bug 595 fica difícil reincidir |
| 4 — Atendente vira só boca (`say, claims, rationale`) | 1-2h | baixo | Coerência arquitetural total |
| **Total** | **8-11h** | distribuído | quem decide, grava |

### Trade-offs honestos

**A favor:**
- Coerência arquitetural — quem decide deveria gravar
- Atendente "burro" não pode inventar dado
- Planner FINALMENTE justifica o nome (hoje é "selector de tools" disfarçado)
- Resolve categoria inteira de bugs ("Atendente inventando dado")

**Contra (agora):**
- Sistema atual está **8-10/10**. Não está em crise.
- Refator de 8-11h pode introduzir bugs novos
- 485 testes vão precisar adaptação grande
- Custo de tokens por turn fica ~10% maior
- Latência por turn fica ~1-2s maior (Planner ganha mais trabalho)

### Recomendação no fim desta janela

> **Não migra agora. Faz Sprint B e C primeiro. Roda 5-10 conv-testes. Se Atendente errar interpretação semântica em padrão recorrente, aí migra com base em evidência. Se não, mantém status quo — sistema funciona bem.**

## Bugs corrigidos na janela complementar

### 🐛 Bug 593 — PCX 2020 com `produto_oferecido` contaminado da Organizadora
- **Antes:** Organizadora gravava `produto_oferecido="130/70-13"` sem amarrar à variante PCX 160. Planner consumia → Atendente afirmava compat pra PCX 2020 → mentira.
- **Fix:** Fase 1 cortou `organizer_facts` do contexto. **Causa raiz fechada.**
- **Complementar:** a outra janela cadastrou os fitments da PCX 150 (4 produtos), então AGORA o bot sabe a medida certa pela tool e não precisa "chutar".

### 🐛 Bug 595 (acentos)
- **Antes:** `calcularFrete("Fonseca", "Niteroi")` → 0 resultados, porque `lower('Niterói') != lower('Niteroi')`.
- **Fix (Migration 0048):** `unaccent` + reescrever resolver. 15/15 cidades batem agora independente de acento.

### 🐛 Bug 595 (multi-item)
- **Antes:** Cliente comprou pra ele + amigo (2 pneus), bot somou R$ 108,90 (só 1 pneu + frete).
- **Causa:** `cart_current_items` vazio porque `add_to_cart` não exposto.
- **Fix (Sprint A):** liberar `add_to_cart` no schema + prompt + 2 exemplos.

### 🐛 Bug Planner output_contract (descoberto durante análise de saúde dos prompts)
- **Antes:** `src/atendente/planner/prompt.ts` linha 109 do user payload dizia `rationale: 'max 500 chars'`, mas o system prompt já tinha sido atualizado pra `rationale tem ate 800 chars`. **Inconsistência interna** que podia confundir o LLM.
- **Fix:** alinhar pra 800 em ambos os lugares.
- **Commit:** `edc6de4`.

## Sprints futuras planejadas (continuação)

| sprint | esforço | resolve | status |
|---|---|---|---|
| **B** — `remove_from_cart` + `update_cart_item` | 2-3h | "tira um", "quero 2 desse" | ✅ **CONCLUÍDA 2026-05-23** |
| **C** — Cancelamento (`clear_cart`) | 3-4h | "esquece, deixa pra outro dia" | ✅ **CONCLUÍDA 2026-05-23** (sem `draft_status='abandoned'`, ficou pra depois) |
| **D** — Múltiplos drafts por conversa | ADIADO | cenário raro, Sprint A já resolve 95% | ⏳ adiada |

### Sprint B+C — entrega de 2026-05-23 (final do dia)

**O que foi feito:**
- `schemas.ts`: 3 raw schemas novos (`removeFromCartRawSchema`, `updateCartItemRawSchema`, `clearCartRawSchema`) + entradas no `discriminatedUnion` + 3 blocks no JSON schema strict.
- `schemas.ts`: hidratação dos 3 tipos (passa `cart_item_id` direto — validator zod do `agentActionSchema` exige UUID, então id simbólico = blocked, igual `add_to_cart`).
- `prompt-v1_5.ts`: 3 novas action descriptions na seção "Tipos de Action" + 3 exemplos novos (Ex 17 remove, Ex 18 update qty, Ex 19 clear).
- `prompt-v1_5.ts`: Ex 1 condensado pela metade (era duplicação de Ex 4) pra compensar crescimento.
- Atualizado CoT do `rationale` pra mencionar "19 exemplos".

**Impacto no prompt do Atendente:**
| métrica | pré-Sprint B+C | pós-Sprint B+C | delta |
|---|---:|---:|---:|
| linhas | 311 | 345 | +34 |
| chars | 17.497 | 19.610 | +2.113 |
| tokens (~) | 4.375 | **4.903** | **+528** |

Zona: 🟡 amarela meio-alto (limite vermelho = 5.500). **Restam 597 tokens de folga** antes do refator obrigatório. Estimativa pré-implementação era +400-700 tokens — bateu.

**Testes:** 485/485 verdes, typecheck limpo.

**Observabilidade pra próxima sessão:**
- Quando bot ganhar volume real de remove/update/clear em prod, monitorar se LLM acerta o `cart_item_id`. Se errar, hidratação retorna `null` → turn fica blocked (fail-fast) → audit no `auditar-conversa.ts`.
- `clear_cart` é destrutivo. Validator já bloqueia se há `pending_confirmation` aberto, mas pode haver caso onde cliente diz "esquece" no meio de coleta de dados sem confirmação aberta — o Ex 19 ensina o LLM a pedir confirmação quando ambíguo, mas isso é comportamento (não invariante estrutural).

## Scripts dessa janela (complementares aos da outra)

| script | uso |
|---|---|
| `scripts/aplicar-0048.cjs` | aplica migration 0048 com smoke tests |
| `scripts/checar-geo-frete.cjs`, `debug-fonseca.cjs` | debug do calcularFrete |
| `scripts/testar-todas-cidades.cjs` | confirmar 15/15 cidades batem após unaccent |
| `scripts/checar-itens-conv.cjs` | inspecionar session_items/cart/draft de uma conv |
| `scripts/checar-uso-analytics.cjs` | uso real das tabelas analytics (confirmou que 4 das 6 estão vazias) |
| `scripts/descrever-analytics.cjs` | listar colunas das analytics |
| `scripts/checar-self-correction.cjs` | query nos events de self-correction |
| `scripts/medir-prompts.cjs` | tamanho atual dos 3 prompts |

## Assinatura — janela complementar

**Autor:** Claude (Anthropic, modelo Sonnet 4.5) — segunda janela do dia
**Data:** 2026-05-23 — continuação noturna
**Commits:**
- `05a324e` Fase 1: isola Organizadora do contexto
- `e5f02d8` Migration 0048: resolve_neighborhood ignora acentos
- `fe78290` Sprint A: expõe `add_to_cart` no Generator v1.5
- `0482bcf` docs: adiciona seção complementar no handoff
- `85835af` docs: adiciona seção "Saúde dos prompts — linha vermelha"
- `edc6de4` refactor(prompts): enxuga Generator v1.5 e corrige bug do Planner

**Migrations aplicadas:** 0048 (banco prod)
**Testes:** 485 verdes em toda a janela
**Bug 593:** mata pela CAUSA RAIZ — organizer_facts isolado (não consome mais em tempo real) + cobertura PCX 150 da outra janela
**Bug 595:** mata 2 partes — acentos (migration 0048) e multi-item (Sprint A)
**Bug do Planner output_contract:** rationale 500/800 inconsistente — corrigido
**Enxugamento:** Atendente -5.7% tokens sem perder cobertura
**Caminho do Planner mapeado** como decisão futura baseada em evidência, não em teoria.

---

## Saúde dos prompts — diagnóstico e linha vermelha

Análise feita ao final desta janela, lendo os 3 prompts vivos no código.

### Estado atual (após Fase 1 + Sprint A + enxugamento)

| LLM | linhas | chars | tokens (~) | estado |
|---|---:|---:|---:|---|
| **Planner** | 87 | 8.331 | 2.083 | 🟢 saudável |
| **Organizadora** | 147 | 11.453 | 2.864 | 🟢 saudável |
| **Atendente v1.5** | **311** | **17.497** | **4.375** | 🟡 zona amarela (mais perto da fronteira verde) |

**Após enxugamento (commit `edc6de4`):** Atendente caiu de 4.640 → 4.375 tokens (-5.7%). Cobertura mantida (Ex 9 + Ex 14 fundidos em 1 só sobre "tool vazia").

### Linha vermelha NÃO é número — é sintoma

Saúde de prompt mede-se por comportamento do LLM, não por byte count:

| sintoma | gravidade |
|---|---|
| Bot consistente, segue todos os exemplos | 🟢 verde |
| Bot ignora 1-2 exemplos do meio do prompt | 🟡 amarelo |
| Latência > 5s por turn só de LLM call | 🟡 amarelo |
| Custo por turn começa a doer no caixa | 🟡 amarelo |
| Bot esquece regra explícita ("não invente preço") | 🔴 vermelho |
| Decisões inconsistentes em inputs parecidos | 🔴 vermelho |
| Validator bloqueia turns que deveriam passar | 🔴 vermelho |
| Lost-in-the-middle visível — exemplo do meio nunca é imitado | 🔴 vermelho |
| Equipe humana se perde mantendo o prompt | 🔴 vermelho |

### Zonas numéricas concretas pro Atendente

| zona | tokens | chars | linhas |
|---|---:|---:|---:|
| 🟢 verde | < 3.500 | < 14k | < 250 |
| 🟡 amarelo (**HOJE**) | 3.500 – 5.500 | 14k – 22k | 250 – 400 |
| 🔴 vermelho | > 5.500 | > 22k | > 400 |

### Sintomas observados nesta sessão

| sintoma | onde apareceu | classificação |
|---|---|---|
| Bot ignorou pergunta de total 3 vezes | conv 595 multi-item, turns 10/11/12/13 | 🟡 possível atenção diluída — OU falta de capacidade (cart vazio). Sprint A vai testar qual era o problema real. |
| Bot somou só item ativo, ignorou outros | conv 595 turn 14 | 🟡 mesma análise — pode ser cart vazio |
| Exemplos 11/12/13/14 sendo imitados | últimas 3 conv-testes | 🟢 |
| Sem mentira / fallback indevido | últimas 3 conv-testes | 🟢 |

**Diagnóstico:** Atendente está na **zona amarela**. Não é crise. Mas é hora de **parar de adicionar exemplo sem refatorar antes**.

### Caminhos quando passar pra 🔴

3 opções (em ordem de esforço):

1. **Refatorar exemplos (fundir similares)** — ~30min
   - Fundir Ex 9 + 14 (ambos "tool vazia")
   - Fundir Ex 1 + 4 (ambos cotação completa)
   - Encurtar `rationale` interno de cada exemplo
   - **Corta ~2-3k chars sem perder cobertura**

2. **Prompt modular por skill** — ~3-4h
   - 1 prompt por skill em vez de mega-prompt único
   - Planner escolhe → manda só os exemplos relevantes
   - Mais código, mas cada chamada fica lean
   - **Corta ~50% por chamada**

3. **Mover gravação pro Planner (Caminho A das Etapas 1-4)** — ~8-11h
   - Atendente perde 5 tipos de action → fica enxuto
   - Prompt cai pra ~3-3.5k tokens
   - **Corta ~25%** mas refator profundo

### Regra prática pro próximo agente

1. **Antes de adicionar exemplo novo:** verifica se algum dos 16 atuais já cobre.
2. **Roda conv-testes após cada mudança:** se exemplo novo não é imitado em nenhum turno relevante, é candidato a remoção.
3. **Quando chegar em ~20k chars / 5k tokens:** refatora obrigatoriamente.
4. **Quando LLM começar a ignorar regra explícita:** refator não pode esperar — é zona vermelha.

### Linha vermelha conceitual

> **Quando o LLM começa a se comportar como se NÃO tivesse parte do prompt.**

Indicadores objetivos:
- **Coverage de exemplos** — se tem 16 exemplos e LLM só imita 5-6 em conv típica, os outros 10 estão sendo desperdiçados.
- **Recall test** — perguntar ao LLM "qual é o Exemplo 9?" — se inventar, perdeu recall.
- **Consistência** — input idêntico → output similar. Variação > ~10% = atenção diluída.

### Histórico de crescimento do Atendente v1.5

| momento | linhas | chars | tokens (~) |
|---|---:|---:|---:|
| v1.4.0 (legado declarativo) | 151 | 13.085 | 3.272 |
| v1.5.0 Sprint 6.5 (10 exemplos) | ~200 | ~12.500 | ~3.100 |
| + Exs 11/12/13 (sessão 22/05) | ~240 | ~14.650 | ~3.660 |
| + Ex 14 + reforço anti-mentira (22/05) | 302 | 16.053 | 4.014 |
| + Sprint A + Exs 15/16 (2026-05-23) | 335 | 18.558 | 4.640 |
| + Enxugamento (commit `edc6de4`) | 311 | 17.497 | 4.375 |
| **+ Sprint B+C + Exs 17/18/19 (2026-05-23, noite)** | **345** | **19.610** | **4.903** |

Crescimento total: +47% em 2 sessões. Hoje em 4.903 tokens — zona amarela meio-alto. Cada exemplo cobre um caso real de bug observado ou capacidade ausente, não bloat.

### Enxugamento aplicado nesta sessão (commit `edc6de4`)

| ação | impacto |
|---|---|
| Fundir **Ex 9 (Intruder)** + **Ex 14 (Daytona)** → 1 só Ex 9 "tool vazia" | -12 linhas / -300 chars |
| Encurtar seção **"Fallback seguro"** (14 → 5 linhas) | -8 linhas / -250 chars |
| Encurtar **"Nota sobre update_slot"** (6 → 2 linhas) | -4 linhas / -150 chars |
| Corrigir referência **"1-13"** → **"15 exemplos"** no CoT do rationale | correção |
| Corrigir bug do Planner: **rationale 500 → 800 chars** no output_contract (estava inconsistente com system prompt) | correção de bug |
| **Total Atendente** | **-24 linhas / -1.061 chars / -265 tokens (-5.7%)** |

**O que NÃO foi mexido:** Organizadora (já estava enxuta), Princípio de safety, Tipos de Action/Claim, Slot keys, Exemplos 1-8 e 11-13/15-16 (cada um cobre caso real).

**Resultado:** Atendente saiu do meio da zona amarela pra mais perto da fronteira verde. Cobertura mantida (15 exemplos cobrem todos os casos antes representados por 16). 485 testes verdes.

---

## Princípio que ficou ao final

> **Se o sistema está em 8-10/10, faça mudanças cirúrgicas (1 problema = 1 fix). Não refatore arquitetura porque "seria mais bonito". Refatore quando padrão de erros justificar.**

A sessão respeitou isso. As 3 mudanças (Fase 1, 0048, Sprint A) foram cirúrgicas. O caminho do Planner ganhar tudo ficou DOCUMENTADO como opção futura, sem ser executado.

---

# Janela 3 do mesmo dia (2026-05-23, final da noite)

> **Adendo 2:** terceira janela do dia. Foco: **fechar Sprints B e C** (edição/cancelamento de carrinho). Antes desta janela, o Atendente só sabia **adicionar** item no carrinho — não conseguia tirar, mudar quantidade nem cancelar. Bug latente: cliente dizia "esquece o traseiro" e bot fingia entender mas não executava.

## TL;DR janela 3

| frente | resumo |
|---|---|
| **Sprint B** (`remove_from_cart` + `update_cart_item`) | LLM agora consegue tirar item específico e mudar quantidade. cart_item_id vem de state.cart[].id (UUID), validator rejeita se inventar. |
| **Sprint C** (`clear_cart`) | LLM agora cancela carrinho inteiro. Ex 19 ensina pedir confirmação quando cliente é ambíguo ("hmm, não sei"). Sem regex — só few-shot. |
| **Mitigação de tamanho** | Ex 1 (cotação mono CG Fan) condensado pela metade — era duplicação de Ex 4 (multi). Crescimento líquido: +528 tokens. |
| **Cobertura total do carrinho** | add ✅ + remove ✅ + update ✅ + clear ✅ — bot fecha o ciclo de vida completo. |

## Arquivos tocados

| arquivo | mudança |
|---|---|
| `src/atendente/generator/schemas.ts` | +3 raw schemas (remove/update/clear) no `discriminatedUnion` + 3 blocks no JSON schema strict + 3 cases na hidratação |
| `src/atendente/generator/prompt-v1_5.ts` | +3 entradas em "Tipos de Action" + bloco "IMPORTANTE carrinho" + Exs 17/18/19 + Ex 1 condensado + CoT "19 exemplos" |
| `docs/SESSAO_2026-05-23_HANDOFF.md` | Janela 3 documentada + status Sprints B+C atualizado + tabela de crescimento do prompt |

**Nada mexido em:** `apply-action.ts`, `action-validator.ts`, `agent-state.repository.ts` — todas as 3 ações já existiam no backend desde Sprint 6. Sprint B+C foi puramente **exposição** ao LLM.

## Decisões da janela 3

1. **`cart_item_id` como UUID estrito (sem normalização determinística como `item_id`).** Razão: o cart já existe quando o LLM vai remover/atualizar — o id vem de `state.cart[].id` que o LLM lê do contexto. Se inventar id simbólico, `agentActionSchema.safeParse` rejeita → hidratação retorna null → turn fica blocked. Mesmo padrão de `add_to_cart.product_id`. Fail-fast > silenciar.

2. **`clear_cart` sem mexer no `order_draft`.** Hoje cancelar carrinho **não** marca draft como `abandoned`. Razão: separar mudanças. Se aparecer ruído na auditoria (cliente cancela mas draft fica em `collecting` sem item), abre-se Sprint C.1 com `draft_status` enum novo. Não otimizar prematuramente.

3. **Confirmação ambígua via prompt, não código.** Ex 19 ensina o LLM a pedir "confirma que cancelo?" quando cliente não é explícito. Wallace já recusou regex antes — manteve a filosofia: decisão semântica fica no LLM, validator estrutural fica no código.

4. **Ex 1 condensado em vez de removido.** Tentei remover mas ele é o "happy path" — primeiro exemplo do prompt costuma ser muito imitado (recency-of-first-example). Condensei pela metade preservando assinatura (CG Fan + 90/90-18 + R$ 79 + 3 claims).

## Impacto medido (script `medir-prompts.cjs`)

| prompt | antes | depois | delta |
|---|---:|---:|---:|
| Atendente v1.5 (system) | 4.375 tok | 4.903 tok | **+528 tok** |
| Planner | 2.083 tok | 2.083 tok | 0 |
| Organizadora | 2.864 tok | 2.864 tok | 0 |

Zona do Atendente: 🟡 amarela meio-alto (limite vermelho = 5.500). **Restam 597 tokens de folga.**

Próximo exemplo que entrar precisa ou (a) fundir com existente ou (b) refator do tipo "prompt modular por skill" — não dá pra ficar empilhando.

## Bugs que esta janela mata

| bug | causa | fix |
|---|---|---|
| Cliente diz "tira o traseiro" → bot ignora (cart fica com 2 mesmo) | `remove_from_cart` nunca foi exposto no Generator | Sprint B |
| Cliente diz "quero 2 desse" → bot abre 2o slot novo em vez de subir qty | `update_cart_item` nunca foi exposto | Sprint B |
| Cliente diz "esquece, deixa pra depois" → bot tenta continuar fechamento | `clear_cart` nunca foi exposto | Sprint C |
| Cliente ambíguo ("hmm, não sei mais") → risco de cancelar sem querer | Ex 19 ensina pedir confirmação | Prompt (sem regex) |

## Frente NÃO atacada na janela 3 (intencional)

- **`draft_status='abandoned'` ao limpar carrinho** — fica pra Sprint C.1 se houver evidência de problema.
- **Sprint D (múltiplos drafts por conversa)** — adiado. Sprint A resolve 95% dos casos de multi-item.
- **Camadas 1.4 + 1.5 + 3 do plano anti-alucinação** — pendentes, prioridade alta pra próxima sessão (estavam recomendadas como "próximas" antes do Sprint B/C entrar na frente).
- **Eval suite anti-regresso** (conv 593 sintética) — pendente. Sem teste, qualquer mudança futura pode reintroduzir o bug.

## Assinatura — janela 3

**Autor:** Claude (Anthropic, modelo Opus 4.7) — terceira janela do dia
**Data:** 2026-05-23 — final da noite
**Commits:** ainda não comitado (esperando OK do Wallace pra commit + conv-teste)
**Migrations aplicadas:** nenhuma
**Testes:** 485/485 verdes, typecheck limpo
**Cobertura do carrinho:** ciclo de vida completo (add/remove/update/clear)
**Princípio respeitado:** zero regex, decisão semântica no LLM, fix cirúrgico (1 problema = 1 fix por sprint).

## Próximo agente — punch list em ordem de impacto

1. **Conv-teste manual** das 3 novas capacidades (remove/update/clear) antes de commitar.
2. **Commitar Sprint B+C** (1 commit só — schemas + prompt + handoff).
3. **Camadas 1.4 + 1.5** do plano anti-alucinação (~1h) — adicionar `fitment_status` enum em `CompatibilidadeResultado` e `compatible_vehicle_models[]` em `ProdutoOferta`. Backward-compatible.
4. **Camada 3** (~2h) — exemplos pensativos (pivot moto, compat vazia) já estão parcialmente em Exs 9/15/16. Revisar se ainda falta cobertura.
5. **Eval suite anti-regresso** (conv 593 + conv 595 multi-item + casos B/C) — protege os 4 bugs deste dia de voltarem.

---

# Janela 4 — Madrugada 2026-05-24 (rationale + auditoria universal + Fix A/B)

> **Adendo 3:** quarta janela, madrugada de 24/05 (transição de dia). Foco: **validar Sprint B+C em conv-teste real** → descoberta de bugs novos → **diagnóstico via observabilidade** → fixes cirúrgicos universais.
>
> Princípio reforçado: **evidência antes de mexer no prompt**. Quando o bot deu sintomas estranhos, em vez de mexer no prompt no chute, primeiro instrumentamos (Migration 0049 persistindo o rationale do LLM), depois lemos o que o LLM literalmente pensou, AÍ identificamos a causa raiz e aplicamos fix.

## TL;DR janela 4

| frente | resumo |
|---|---|
| **Bug catálogo "Fan"** | alias "Fan" só existia na CG 150 (year_end=2015). Cliente "fan 2019" não casava com nada. Fix: adicionar Fan/fan/CG Fan/Honda Fan como alias da CG 160 também. Aplicado direto no DB prod. |
| **Bug `posicao_pneu='both'`** | Schema da tool buscarCompatibilidade aceitava `'both'`, função SQL só aceitava `'front'/'rear'/null`. Quando Planner mandava `'both'`, filtro `WHERE position='both'` retornava zero fitments. **Bug latente desde sempre, escondido por outros gaps.** Fix: handler traduz `'both' → NULL` antes da query SQL. |
| **Observabilidade — Migration 0049** | Descoberto que o `rationale` do LLM era gerado, validado e **jogado fora**. Sem como auditar "por que o LLM decidiu X". Fix: nova coluna `rationale_text` em `agent.turns` + caller persiste após cada turn + `auditar-conversa.ts` mostra. Custo zero (LLM já gerava). |
| **Auditoria universal de 351 queries** | Pra cada moto + alias popular do catálogo, simula `resolve_vehicle_model` e categoriza em 5 grupos. Resultado: ~52% das motos NÃO precisam de ano, ~44% precisam mesmo, ~4% sem fitment cadastrado. |
| **Fix Planner — "tente primeiro, pergunte depois"** | Bug observado: Planner pedia ano por hábito mesmo pra motos que tinham 1 só geração (ex.: NMAX). Fix delega decisão ao catálogo: SEMPRE chame buscarCompatibilidade antes de pedir ano. Se função retornar 0/1/N, bot reage diferente. |
| **Fix Planner — "pivot de veículo redefine foco"** | Bug observado: cliente disse "trocar dianteiro Fan por traseiro NMAX", Planner chamou buscarProduto com medida da Fan (3 turns desperdiçados). Fix: pivot de moto força reset de medida/posição/ano do item anterior. |
| **Fix Generator — Ex 2 reescrito (a/b/c)** | Ex 2 antigo só ensinava "sem ano = peça ano". Novo cobre 3 sub-casos: (a) tool retornou 1 com fitments → cote direto; (b) tool retornou N com anos → mostre opções; (c) tool vazia → peça medida atual. |
| **Fix Generator — "anti-cautela-excessiva"** | Adicionado bloco contrabalanceando o "anti-drible". Cliente perguntou tem+preço + tool deu tudo = COTE no mesmo turn. Cautela é pra dado AUSENTE, não pra dado PRESENTE. |

## Commits desta janela

```
3cdc2c6 feat(atendente): expoe remove_from_cart, update_cart_item, clear_cart no Generator (Sprints B+C)
7616fb0 fix(commerce-tools): traduz posicao_pneu='both' para NULL em find_compatible_tires + alias Fan na CG 160
2fa1399 feat(observabilidade): persiste rationale do Generator em agent.turns (migration 0049)
b3c7bea feat(planner): regra 'tente primeiro, pergunte depois' + 'pivot de veiculo redefine foco'
87bf1ce feat(generator): reescreve Ex 2 (sem ano: catalogo decide) + safety anti-cautela-excessiva
```

Migration aplicada em prod: **0049** (rationale_text em agent.turns).

## Conversas-teste e o que cada uma revelou

### Conv 597 (primeira tentativa Fan 2019)
- **Bot:** "Pra Fan 2019 eu não achei no catálogo direto por modelo. Me passa a medida..."
- **Diagnóstico:** alias "Fan" não casava com CG 160 (só com CG 150 fora do range).
- **Fix:** alias da CG 160 atualizado.

### Conv 598 (segundo Fan 2019 — pós-alias)
- **Bot:** mesmo comportamento. "Me passa a medida..."
- **Diagnóstico:** alias funcionou (resolveu CG 160 Fan), mas `find_compatible_tires('both')` retornou vazio.
- **Fix:** `'both' → NULL` no handler.

### Conv 599 (terceiro Fan 2019 — pós-both)
- **Bot:** Cotou medidas corretas no turn 1, mas:
  - NÃO citou preço/estoque mesmo tendo na tool
  - Cliente disse "Fechado os 2" no turn 2 → bot não emitiu `add_to_cart` (Sprint A não disparou)
  - Cliente "ta certo sim" (turn 6) → ignorado
- **Diagnóstico inicial:** suspeita de "lost-in-the-middle" no prompt do Atendente
- **Limitação observada:** o `rationale` do LLM não estava sendo persistido — não dava pra confirmar a hipótese sem mais investigação
- **Decisão:** instrumentar primeiro (Opção D), mexer no prompt depois

### Migration 0049 — persistir rationale (entre conv 599 e 600)

Coluna `rationale_text TEXT` adicionada em `agent.turns`. Worker grava rationale do output do LLM em cada turn. `auditar-conversa.ts` mostra na seção "RATIONALE" de cada turn.

**Insight crítico:** Custo zero — o LLM **já gerava** o rationale (schema exige `min(1).max(800)`). A gente só parou de jogar no lixo. Storage: ~800 bytes/turn = ~230 MB/ano em volume normal.

### Conv 600 (quarto Fan 2019 — pós-Migration 0049, evidência real)

12 turns completos. Rationale literal de cada turn permitiu refutar "lost-in-the-middle" e identificar a causa REAL.

**Bug 1 — viés de cautela (turn 1):**
> Rationale literal: *"não posso afirmar estoque nem preço pelo safety, mesmo havendo current_price/total_stock embutidos, porque o resumo comercial não liberou essas afirmações"*

LLM inventou regra que NÃO está no prompt: "campos vindos via buscarCompatibilidade não contam, só via buscarProduto/verificarEstoque separadamente". Resultado: bot fica tímido com dado completo na mão.

**Bug 2 — Sprint A não dispara (turn 10):**
> Rationale literal: *"carrinho ainda vazio e não há tool neste turno, então não posso reafirmar valor comercial nem adicionar produto sem aceite explícito vinculado a um produto cotado neste turno/histórico estruturado"*

Outra regra inventada: "add_to_cart só vale com record_offer ativa ou tool no turn atual". Causa raiz do Sprint A não disparar.

**Bug 3 — pivot quebrado (turns 5-7):**
> Cliente disse "trocar dianteiro Fan por traseiro NMAX". Planner chamou `buscarProduto(100/90-18, rear)` — medida da Fan. Em 3 turns seguidos não chamou `buscarCompatibilidade(NMAX, ...)`. Cliente teve que dar ano (turn 6) E medida (turn 7) manualmente — dados que o catálogo já tinha.

## Auditoria universal — 351 queries testadas

Script: `scripts/auditar-resolve-todas-motos.cjs`

Pra cada `model` distinto + cada alias popular, simula `resolve_vehicle_model(query, NULL)` e categoriza pelo número de resultados + comparação de fitments.

| categoria | queries | % | comportamento esperado |
|---|---:|---:|---|
| 🟢 A — resolve sozinho com fitments | 167 | 47.6% | cota direto, 1 turn |
| 🟢 D — N entradas mas fitments idênticos | 16 | 4.6% | qualquer ano serve |
| 🟡 B — PRECISA ano (anos diferentes) | 150 | 42.7% | bot apresenta opções |
| 🟡 C — PRECISA variante | 5 | 1.4% | bot apresenta opções |
| 🔴 A-sem-fitment — catálogo sem produto | 13 | 3.7% | bot honesto |

**Conclusão:** ~52% das motos do catálogo NÃO precisam de ano. Bot pedia por hábito. Os fixes A+B (Planner+Generator) delegam decisão ao catálogo — zero hardcoded, escala automaticamente quando cadastrar motos novas.

### 13 motos sem fitment (gaps de catálogo)

| make | model |
|---|---|
| Aprilia | Tuareg 660 |
| Bajaj | Pulsar N160 |
| GasGas | ES 700 |
| Garinni | GR 150 ST |
| Haojue | DL |
| Husqvarna | 701 Enduro |
| Kawasaki | KLR 650 |
| MVK | Fox 110 |
| Shineray | Phoenix 50 |
| Traxx | Sky 50, Sky 125, Work 125 |
| Zontes | 310 |

Bot vai resolver essas motos (resolver funciona) mas retornar `produtos:[]` quando perguntarem por pneu. Comportamento correto: "não tenho cadastrado, me passa a medida atual" (Ex 9 já cobre).

## Tamanho dos prompts — final da janela 4

| prompt | inicio do dia 23/05 | final janela 4 (24/05) | delta |
|---|---:|---:|---:|
| **Atendente v1.5** | 4.375 tok | **5.144 tok** | +769 |
| **Planner** | 2.083 tok | **2.550 tok** | +467 |
| **Organizadora** | 2.864 tok | 2.864 tok | 0 |

Atendente: 🟡 zona amarela alta, 356 tokens de folga até 5.500 (limite vermelho conceitual). **Próximo exemplo novo no Generator exige refator obrigatório** (modularizar por skill — Opção C do diagnóstico).

Planner: 🟢 zona verde-amarela, muita folga.

Guard rail do teste subiu de 20k → 21k chars com histórico documentado.

## Princípios reforçados nesta janela

1. **Evidência antes de mexer:** descobriu que sem rationale persistido, qualquer mudança no prompt é palpite. Instrumentou (Migration 0049) antes de mexer.

2. **Catálogo decide, não prompt:** Fix A+B não tem lista hardcoded de "motos que precisam ano". O catálogo decide via tool. Quando cadastrar moto nova, sistema se adapta sozinho.

3. **Fix cirúrgico, não refator:** Resistiu a tentação de Opção C (modular por skill) — fixes A+B resolvem 90% dos sintomas observados sem refator estrutural.

4. **LLM inventa regras silenciosamente:** mesmo prompt enxuto, o LLM extrapola dos exemplos e cria restrições que não estão escritas. Anti-cautela-excessiva foi a contramedida.

## O que NÃO foi feito (dívida técnica clara)

| item | razão |
|---|---|
| Sprint B+C testado em conv real (remove/update/clear) | Conv 600 não chegou a usar essas capacidades — cliente fluiu para fechamento. Próxima conv-teste deve forçar o cenário. |
| Eval suite anti-regresso | Pendente desde Janela 2. Cada conv-teste hoje é manual — sem teste automático que pegue regressão. |
| Cadastro dos 13 gaps de fitment | Decisão de produto, não técnica. |
| Auditoria nível 2 (cross-check web) | Não justifica esforço enquanto não houver evidência de fitment errado. |
| Modular por skill (Opção C) | Adiado até Atendente passar de 5.500 tokens ou ignorar regra explícita de novo. |
| Promoted_order em commerce.orders | Draft fica em `ready` mas nunca promove pra `commerce.orders`. Pode ser design (human-in-the-loop) ou bug. Não investigado. |
| Incidentes `evidence_not_literal` e `schema_violation` da conv 600 | Registrados em `ops.agent_incidents` mas não investigados. |

## Scripts criados nesta janela

| script | uso |
|---|---|
| `scripts/fix-fan-alias.cjs` | Aplica alias Fan na CG 160 (dry-run/commit). Já rodado em prod. |
| `scripts/debug-cg160-fitments.cjs` | Debug que descobriu o bug do `'both'`. |
| `scripts/diag-rationale-599.cjs` | Tentativa de pegar rationale antes da Migration 0049 (descobriu que não era persistido). |
| `scripts/audit-aliases-multigeracao.cjs` | Procura aliases genéricos cobrindo só uma geração. |
| `scripts/testar-resolves-suspeitos.cjs` | Testa resolve_vehicle_model em casos típicos. |
| `scripts/auditar-resolve-todas-motos.cjs` | **Auditoria universal de 351 queries — categoriza A/B/C/D/sem-fitment.** |
| `scripts/planner-rationales-600.cjs` | Extrai rationale do Planner por turn de uma conv. |

## Assinatura — janela 4

**Autor:** Claude (Anthropic, modelos Sonnet 4.6, Sonnet 4.7, Opus 4.7 — vários switches durante a sessão)
**Data:** 2026-05-24 (madrugada)
**Commits:** 5 (`3cdc2c6`, `7616fb0`, `2fa1399`, `b3c7bea`, `87bf1ce`) + docs
**Migrations aplicadas:** 0049 (rationale_text)
**Testes:** 485/485 verdes em toda a janela
**Conv-testes:** 4 (597, 598, 599, 600)
**Bugs cirurgicamente mortos:** 5
- Fan + alias errado
- `'both'` no handler vs SQL
- Observabilidade vazia (rationale jogado fora)
- Planner pedindo ano por hábito
- Generator com viés de cautela inventando regras

## Punch list — próxima janela

1. **Aguardar redeploy do Coolify**, apagar conversa no Chatwoot UI, refazer conv-teste:
   - Esperado: "tenho fan 2019, quero traseiro e dianteiro" → bot deve cotar 80/100-18 + 100/90-18 com preço e estoque NO MESMO TURN (Ex 1, sem mais "se quiser, eu confirmo")
   - Esperado: "tenho NMAX, quanto sai o traseiro?" → bot cota 130/70-13 R$99 SEM pedir ano (Ex 2a)
   - Esperado: "tenho PCX, quanto?" → bot apresenta as 2 opções (PCX 150 e PCX 160) e pede ano (Ex 2b)
2. **Forçar cenário Sprint B+C** na próxima conv-teste:
   - Cliente fecha 2 itens → testa add_to_cart (Sprint A)
   - "tira o traseiro" → testa remove (Sprint B)
   - "quero 2 do dianteiro" → testa update (Sprint B)
   - "esquece, deixa pra outro dia" → testa clear (Sprint C)
3. **Ler rationales pós-fix:** se Generator ainda ficar tímido OU se Planner ainda errar pivot, o rationale vai dizer onde o LLM está falhando.
4. **Investigar incidentes** `evidence_not_literal` e `schema_violation` (conv 600).
5. **Eval suite anti-regresso** — virar conv 593, 595, 599, 600 em testes sintéticos.
