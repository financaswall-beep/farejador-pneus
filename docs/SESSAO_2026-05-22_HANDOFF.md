# Sessão 2026-05-22 — Handoff

**Autor:** Claude (Anthropic, modelo Sonnet 4.5)
**Data:** 2026-05-22
**Duração:** ~6 horas de trabalho ativo
**Contexto inicial:** usuário pediu auditoria de uma conversa (Chatwoot contact id `1561`, conversation id `589`) que tinha falhado em produção, e usar essa auditoria pra destravar uma cadeia de fixes no bot.

Este documento é o estado completo da sessão para o **próximo agente (LLM)** continuar sem reler a transcrição inteira.

---

## TL;DR — O que foi feito

| frente | resumo |
|---|---|
| **Catálogo** | Merge `test → prod`, cadastro de 20 motos populares (CG/Factor/Fazer/MT/CB/Hornet/Twister), preço uniforme R$ 99 e frete uniforme R$ 9,90 em todas as 624 regiões, soft-delete dos genéricos via regra na função SQL (migration 0047). |
| **Prompts pensativos** | Exemplos 11/12/13/14 no Generator v1.5, CoT estruturado obrigatório no rationale do Planner + Generator (500→800 chars), nova seção "QUEM DISSE O PRECO" na Organizadora, reforço anti-mentira soft ("tem sim opções" sem evidência). |
| **Self-correction** | Worker.ts agora chama `generateTurnWithSelfCorrection` que re-executa 1× quando `blocked OR say===SAFE_FALLBACK_SAY`. Injeta retry context com motivo da falha anterior. |
| **Validator relaxado** | `say-validator` aceita aritmética simples sobre `tool_results_history` (somas/múltiplos até 3 valores). Destrava "quanto deu tudo?" depois de cotação. |
| **Migration 0047** | `resolve_vehicle_model` reordenado para preferir candidatos úteis (com fitment, com variant, com ano, anos cobrindo p_year) em vez de retornar a entrada "genérica" sem dado. |
| **Fact_keys novos** | `preco_cotado` e `taxa_frete_cotada` adicionados ao Zod + prompt da Organizadora. Distingue cotação da loja de orçamento do cliente. |

**5 commits no `pneus/main` e `origin/main`:**
- `a615832` — feat(atendente): prompts mais pensativos + fact_keys de cotação
- `ecc9220` — feat(atendente): self-correction + anti-mentira + extracao frete confirmado
- `bae915a` — fix(say-validator): aceita aritmetica sobre valores cotados em turns anteriores
- `8f2bafd` — feat(commerce): resolve_vehicle_model prefere candidatos uteis (migration 0047)

**Migration 0047 já aplicada no banco Supabase de produção** via `node --env-file=.env scripts/aplicar-0047.cjs --commit` em 2026-05-22 23:30Z.

---

## Filosofia adotada (não-negociável pelo próximo agente)

O usuário foi explícito: o sistema é projetado pra **não ser linear, sem regex, sem regras semânticas no código**. As decisões dele:

1. **Toda decisão semântica (intent, contexto, separação semântica) fica no LLM**. Código só faz transporte, persistência, validação estrutural.
2. **Zero regex sobre conteúdo de mensagem do cliente**.
3. **Zero if-then-else por palavra-chave** na orquestração.
4. **Prompts pensativos > prompts prescritivos**: agente deve articular CoT (a/b/c/d) antes de decidir.
5. **Tools determinísticas SQL, prompts soft**. Schema strict OK; validator regex OK como rede (mas não amplificar).
6. **Modelo "menos rígido, mais pensativo"**: tokens a mais são aceitáveis se gerar decisão mais robusta.

Quando o próximo agente for tentado a "adicionar uma regra rápida" pra fechar um caso, **NÃO faça isso sem perguntar**. A preferência é estender prompt ou função SQL, não criar mais regex.

---

## Estado atual em detalhes

### Catálogo

```
commerce.products             56 (50 herdados de test + 6 medidas novas)
commerce.tire_specs           56
commerce.vehicle_models      158 (138 herdados + 20 novos populares)
commerce.vehicle_fitments    136
commerce.product_prices       56 (todos R$ 99)
commerce.stock_levels         56 (todos 10 unidades)
commerce.delivery_zones      624 (todas R$ 9,90, 1 dia, own_fleet)
commerce.store_policies       14
```

**Cobertura de fitments:** ~50% dos modelos têm pelo menos 1 fitment cadastrado.

**Motos populares cadastradas nesta sessão:**
- Honda CG 150 Fan/Titan, CG 160 Fan/Titan/Start/Cargo
- Yamaha Factor YBR 125/150, Fazer 150/250, MT-03/07/09
- Honda CB 300R, CB 500F/X, CB 650R, CB 1000R, Hornet (CB 600F), Twister (CBX 250)

**Motos faltando fitment (gaps conhecidos):**
- Honda PCX 150 (a 160 tem, a 150 não)
- Honda Pop 110i ES
- Honda NXR 150 Bros, NXR 160 Bros (tem entrada, sem fitment)
- Honda Lead 110, Elite 125
- Yamaha Aerox, Fluo, TT-R, XMAX
- Várias outras de marcas menos populares

### Prompts ativos

```
Planner            planner_v1.2.8  (~80 linhas system, ~2k tokens)
                   CoT estruturado (a/b/c/d) no rationale, max 800 chars
                   Cotação direta sem repedir ano quando produto identificado

Generator v1.5     generator_v1.5.0  (~302 linhas system, ~4k tokens)
                   14 exemplos few-shot, princípio anti-drible "tem sim opções"
                   rationale max 800 chars com instrução de CoT
                   Exemplo 11: fechamento sem tools
                   Exemplo 12: despedida pós-fechamento
                   Exemplo 13: nome+endereço separados no update_draft
                   Exemplo 14: tool retornou [] = seja honesto

Organizadora       moto-pneus-hybrid-v3-4
                   Seção QUEM DISSE O PRECO (CLIENTE vs ATENDENTE)
                   Confirmação conta como cotação ("isso, 9,90 de frete")
                   30 fact_keys + 2 novos (preco_cotado, taxa_frete_cotada)
```

### Self-correction

Implementada em `src/atendente/worker.ts → generateTurnWithSelfCorrection`. Funciona assim:

1. Chama `generateTurn()` normalmente.
2. Se `result.blocked OR result.say_text === SAFE_FALLBACK_SAY` → constrói `GeneratorRetryContext`.
3. Chama `generateTurn()` de novo passando o retryContext.
4. Cap em 1 retry — não loop infinito.
5. O 2º resultado carrega `self_correction_round: 2` e `self_correction_previous_reason`.
6. Audit em `agent.session_events.event_payload` (não precisou migration — só campos novos no payload).

**Comprovação em produção (conv 592):** turn 5 foi salvo (delivery_fee bloqueado → 2ª tentativa pediu bairro honestamente). Turn 8 tentou self-correction mas o validator regex bloqueou de novo — esse é o bug "money_mentioned_without_tool_result" que destravei depois com bae915a.

### Validator say-validator

Hoje aceita:
- Money citado no turn atual ou em `tool_results_history` (turns anteriores)
- Soma de 2-3 valores conhecidos
- Múltiplo inteiro 1..10 (ex.: 2 pneus iguais)
- Fórmula `k*v1 + v2` (ex.: 2 pneus + 1 frete)

Continua bloqueando:
- Valor que não bate nem com cotado nem com soma de cotados
- Compatibility claims ("serve em X") sem buscarCompatibilidade
- Stock claims sem verificarEstoque
- Delivery claims sem calcularFrete
- Brand/policy claims sem buscarPoliticaComercial

**Mas TEM UM BURACO** — ver "Bugs conhecidos" abaixo.

### Migration 0047 — resolve_vehicle_model

A função agora **acumula todos os candidatos** dos 4 níveis (exact_full, exact_model, alias, fuzzy) e **ordena por utilidade**:
1. tem fitment (TRUE primeiro)
2. anos cobrem p_year (TRUE primeiro)
3. tem variant (TRUE primeiro)
4. tem year_start (TRUE primeiro)
5. match_rank (exact > alias > fuzzy)
6. similarity DESC
7. year_end DESC (mais recente)
8. determinismo (model, variant)

**Resolve o caso PCX 2025** que estava retornando a entrada genérica e ignorando PCX 160.

---

## Bugs conhecidos e pendentes

### 🔴 Bug crítico — Bot afirma compatibilidade sem evidência (conv 593)

**Sintoma:** Cliente disse "PCX 2020", bot disse "achei o pneu 130/70-13 pra PCX 2020 por R$ 99". O 130/70-13 é da PCX 160 (2023+), NÃO da PCX 150 (2013-2022). O bot mentiu.

**Causa raiz:**
1. Turn 1 (sem ano): `buscarCompatibilidade(PCX, rear)` retornou PCX 160 com 130/70-13. Bot disse honestamente "achei pra PCX 160".
2. **Organizadora extraiu `produto_oferecido="130/70-13"`** sem amarrar à PCX 160. Virou fact global.
3. Turn 2 (ano 2020): Planner usou esse fact e chamou `buscarProduto(medida=130/70-13)` que achou o produto. Mas `buscarCompatibilidade(PCX, 2020)` retornou PCX 150 com `produtos=[]`.
4. Generator viu sinais conflitantes (produto existe vs compatibilidade vazia) e **escolheu o primeiro**. Driblou o `mentionsCompatibilityClaim` do say-validator porque usou linguagem natural ("achei o pneu pra X") sem palavras-trigger ("serve", "compatível").

**Status:** **NÃO RESOLVIDO**. Cabe ao próximo agente atacar.

**Sugestões de fix (em ordem de impacto):**

1. **Fix do claim_validator**: hoje verifica que existe `buscarCompatibilidade` ok. Mudar pra exigir que o `product_id` do `fitment` claim emitido apareça **dentro dos `produtos[]`** de algum `buscarCompatibilidade` deste turn.
2. **Ampliar `mentionsCompatibilityClaim`** em `src/atendente/validators/say-validator.ts` pra pegar afirmações implícitas: "achei o pneu pra X", "o pneu da sua X é Y", "pra X o pneu é Y". **Cuidado**: o usuário não quer mais regex hardcoded. Talvez exigir que o Generator emita `fitment` claim quando o produto é citado por nome, e bloquear se faltar — uma regra estrutural em vez de regex semântico.
3. **Exemplo 15 no prompt v1.5**: "quando `buscarCompatibilidade(moto+ano)` retornou produtos vazios mas `buscarProduto(medida)` achou algo, NÃO afirme que serve pra moto do cliente. Pergunte ou peça medida".
4. **Cadastrar fitments dos modelos populares vazios** — elimina o gap onde a alucinação nasce.

### 🟡 Bug médio — Organizadora não extraiu taxa_frete_cotada na conv 592

**Sintoma:** Humano disse "isso o pneu custa 198 mais 9,90 de frete". Organizadora extraiu `preco_cotado=99` mas NÃO `taxa_frete_cotada=9.90`. Pode ter sido o job que falhou com `unsupported Unicode escape sequence` (vimos no log).

**Status:** **MITIGADO MAS NÃO RESOLVIDO**. O prompt da Organizadora foi reforçado com "CONFIRMACAO CONTA COMO COTACAO", mas precisa de mais dados pra confirmar se funcionou.

**Sugestões:** Próximo agente deve verificar uma nova conv de teste pra ver se `taxa_frete_cotada` é extraído agora.

### 🟡 Bug médio — 5 schema_violation em conv 589

A auditoria de 2026-05-14 (`docs/AUDITORIA_ATENDENTE_2026-05-14.md`) apontou 3 sub-bugs no `generatorOutputJsonSchema`. Conv 589 teve 5 `evidence_not_literal` em `ops.agent_incidents` — possível sequela.

**Status:** **NÃO INVESTIGADO** nesta sessão. Próximo agente deve revisitar.

### 🟢 Cobertura — ~70 motos sem fitment

Trabalho de digitação. PCX 150, Pop 110, NXR Bros 150/160, XRE 190/300, Lead 110, etc.

**Atalho útil:** o usuário (Wallace) sabe as medidas reais das motos populares — perguntar antes de pesquisar.

---

## Conversas-teste relevantes

| conv id | contexto | resultado |
|---|---|---|
| 587 | Conv original Codex (anterior à sessão) | Atendente: 6.5/10. Anderson Tavares, 90/90-18, NMAX, R$ 99, R$ 19 frete |
| 589 | Conv com nome+endereço grudados | Mostrou bugs do schema separado (na verdade não era schema — era prompt mal-feito) |
| 590 | Primeira pós-merge de catálogo | Saltou nota Atendente 5→9, mas prompts AINDA NÃO estavam deployados em Coolify |
| 591 | Pós-deploy dos prompts pensativos | CoT estruturado funcionando, Exemplo 11/13 funcionou, mas Exemplo 14 ainda não rodava |
| 592 | Pós-Exemplo 14 + self-correction | Self-correction ativou 2× (turn 5 OK, turn 8 ainda blocked) — destravou Bug 1 |
| 593 | Pós-fix do say-validator + migration 0047 | **Bot mentiu sobre compatibilidade da PCX 150** — bug crítico ainda aberto |

Pra auditar qualquer uma: `npx tsx --env-file=.env scripts/auditar-conversa.ts <chatwoot_conv_id>`

---

## Scripts criados (todos em `/scripts`)

| script | uso |
|---|---|
| `auditar-conversa.ts` | Audit turn-a-turn de uma conversa (aceita conv_id ou contact_id). Reusar sempre. |
| `aplicar-merge-catalogo.ts` | Promove test→prod, cadastra preços/estoque/frete uniformes. Já rodado, COMMIT=1 default off |
| `limpar-banco-apenas.cjs` | TRUNCATE em raw/core/analytics/ops/agent, preservando commerce. Não toca em Chatwoot (não tem API key local) |
| `cadastrar-motos-populares.ts` | Adiciona 20 motos novas (CG/Factor/Fazer/MT/CB/Hornet/Twister). Já rodado, COMMIT=1 off por default |
| `aplicar-0047.cjs` | Aplica migration 0047 com smoke tests. Idempotente (CREATE OR REPLACE). Já rodado |
| `ultima-conversa.cjs` | Mostra última conversa + jobs do Atendente e Organizadora |
| `checar-self-correction.cjs` | Query nos `generator_produced` events pra ver `self_correction_round` |
| `listar-pcx.cjs` | Lista variantes + fitments + simulações da PCX |
| `checar-pcx.cjs`, `checar-fan.cjs`, `checar-nmax.cjs`, `checar-envs.ts`, `checar-genericos.cjs`, `listar-motos.cjs`, `contar-pneus.cjs` | helpers de discovery descartáveis |
| `descoberta-pre-merge.ts`, `descoberta-extra.ts`, `checar-nmax-2.ts` | discovery descartáveis |
| `teste-organizadora-modelo.ts` | A/B test que ficou inacabado (precisa OPENAI_API_KEY local). |
| `medir-prompts.cjs` | Mede char count e tokens estimados de cada prompt. Útil pra audit |

---

## Como o próximo agente deve continuar

1. **Ler este documento + `docs/HANDOFF.md` + `docs/NEXT_CHAT_HANDOFF.md` (versão anterior)**. Pode pular a auditoria de 14/05 num primeiro momento.

2. **Verificar estado atual com `scripts/auditar-conversa.ts`** se houver nova conversa de teste.

3. **NÃO mexer em arquivos do dashboard** (`dashboard.html`), nem nos docs em mojibake (`docs/EXECUCAO_AUDITORIA_2026-05-21.md`, `docs/RUNBOOK_ETAPA5_RLS_2026-05-21.md`, `painel/README.md`, `parceiro/README.md`). Encoding está corrompido mas não fui eu — deixa o usuário decidir restaurar via `git checkout --`.

4. **Filosofia non-negociável** (ver acima). Toda decisão semântica fica no LLM.

5. **Bug crítico aberto**: bot mentindo sobre compatibilidade na conv 593. **Priorizar isso.** Sugestões de fix listadas acima.

6. **Próximas frentes naturais** (em ordem de impacto sugerido):
   - Fix do bug de compatibilidade implícita (claim_validator + Exemplo 15)
   - Cadastrar fitments dos ~70 modelos faltando
   - Investigar `schema_violation` da auditoria de 14/05
   - Migração para `gpt-5.4` full na Organizadora (A/B test pendente)
   - Avaliar splitting do prompt v1.5 em prompts por skill

7. **Sempre** rodar `npx tsc --noEmit && npx vitest run` antes de commit. Manter os 485 testes verdes.

8. **Build do Docker** no Coolify usa multi-stage (`COPY . . && npm run build` na builder stage). Push pra `pneus/main` no GitHub aciona o redeploy. Migrations precisam ser aplicadas manualmente — verificar com o usuário se ele quer rodar via script ou via MCP.

---

## Estado dos commits

```
8f2bafd feat(commerce): resolve_vehicle_model prefere candidatos uteis (migration 0047)
bae915a fix(say-validator): aceita aritmetica sobre valores cotados em turns anteriores
ecc9220 feat(atendente): self-correction + anti-mentira + extracao frete confirmado
a615832 feat(atendente): prompts mais pensativos + fact_keys de cotação
da2f406 feat: add partner finance accounts                       ← último commit pré-sessão
```

Remotes:
- `pneus` → `https://github.com/financaswall-beep/farejador-pneus.git` (Coolify segue este)
- `origin` → `https://github.com/financaswall-beep/FarejaorV1.git`

Push sempre pra ambos pra consistência.

---

## Glossário rápido pro próximo agente

| termo | significa |
|---|---|
| `genérico` | entrada em `vehicle_models` sem `year_start`, `year_end`, `variant` e sem fitments — lixo do merge de test |
| `família` | conjunto de variantes da mesma moto popular (PCX 150 + PCX 160 + PCX genérico) |
| `fitment` | par (moto, pneu, posição) — a tabela `commerce.vehicle_fitments` |
| `claim` | afirmação estruturada do Generator (price, stock_availability, fitment, delivery_fee) validada contra tool_results |
| `tool_results_history` | tool results de turns anteriores no contexto. Validator agora também considera |
| `self_correction_round` | 1 = primeira tentativa do Generator. 2 = retry após blocked/fallback |
| `SAFE_FALLBACK_SAY` | constante em `src/atendente/generator/schemas.ts` — "Desculpe, não consigo confirmar essa informação agora. Um atendente poderá te ajudar em breve." |
| `Exemplo N` | numerado de 1 a 14 dentro do prompt few-shot v1.5 |
| `CoT estruturado` | rationale em formato (a) o que cliente faz (b) skills candidatas (c) dado disponível (d) risco |

---

## Assinatura

**Sessão realizada por:** Claude (Anthropic, modelo Sonnet 4.5)
**Data/hora final:** 2026-05-23 ~02:00 UTC
**Linhas adicionadas:** ~600 nos 4 commits (mais ~750 linhas em scripts e docs)
**Testes:** 485 verdes, typecheck limpo, build OK
**Migrations aplicadas no banco prod:** 0047 (via script, fora do fluxo Coolify)
**Estado do bot:** funcional em shadow, com bug crítico aberto na inferência de compatibilidade

---

## Anexo — Filosofia em uma página (pro próximo agente assimilar rápido)

> *"esse sistema foi projetado pra nao ser linear evitar regex etc etc pois regex deixa o bot burro"*
> — usuário

> *"quero um agente mais pensativo que rigido"*
> — usuário

> *"não quero entender porque o bot não fez certo. tem preço? tem medidas? tem compatibilidade?"*
> — usuário

A regra é: **toda decisão de conteúdo (intent, separação semântica, ambiguidade) fica no LLM. Código só faz transporte, persistência e validação estrutural.** Quando o LLM faz besteira, a correção é **ensinar o LLM (prompt) ou apertar invariantes estruturais (schema, validator de evidência)** — NUNCA adicionar regex sobre conteúdo nem regra hardcoded por palavra-chave.

O usuário valoriza:
- Crítica direta sobre concordância
- Honestidade sobre incerteza ("não sei" > "deve ser")
- Soluções estruturais sobre fixes pontuais
- Comparações lado a lado entre IAs
- Pensar antes de fazer

Quando estiver em dúvida: **pergunte antes de fazer**. Especialmente em operações destrutivas no banco ou commits.
