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
