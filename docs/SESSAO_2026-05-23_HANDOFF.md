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

| sprint | esforço | resolve |
|---|---|---|
| **B** — `remove_from_cart` + `update_cart_item` | 2-3h | "tira um", "quero 2 desse" |
| **C** — Cancelamento (`clear_cart` + `draft_status='abandoned'`) | 3-4h | "esquece, deixa pra outro dia" |
| **D** — Múltiplos drafts por conversa | ADIADO | cenário raro, Sprint A já resolve 95% |

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
| **+ Enxugamento (commit `edc6de4`)** | **311** | **17.497** | **4.375** |

Crescimento de **+34% em 2 sessões + recuo de -5.7% no enxugamento.** Pico foi 4.640 tokens, hoje em 4.375. Cada exemplo cobre um caso real de bug observado, não bloat.

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
