# Sessão 2026-06-16 — Primeira venda real do bot + 3 fixes no atendente (HANDOFF)

> Orquestrador (Claude Opus 4.8) — domínio `bot`. Sessão disparada pelo dono: "o bot fechou uma venda do Vitor Fernando".
> Resultado: **primeira venda REAL conduzida pelo bot ponta-a-ponta** + **3 consertos no atendente** (todos pushados em `origin/main`, aguardando/feito Deploy).

---

## 0. TL;DR
1. 🎉 **1ª venda real do bot** — Vitor Fernando (lead do Instagram). Bot conduziu sozinho: par Titan 160 equivalente, entrega Irajá, R$ 207,90, dinheiro.
2. 🔴 **Pedido duplicado** (PED-0045 + PED-0046) → **consertado** (chave idempotente no caminho matriz). Dado limpo em prod.
3. 🔁 **Bot repetia mensagem** (~1 min depois) → **trava anti-requentado** no worker. Confirmada ao vivo pós-deploy (pegou 3 requentadas, 0 repetições).
4. 🟠 **Bot regride na localização-em-texto** (recita o pneu em vez de avançar) → **empurrão de localização** (gêmeo do pino).
5. ⏳ **Aberto:** *por que* algumas mensagens entram na fila ~1 min atrasadas (glitch do enqueue). Banco esgotado; prova final está nos **logs do Coolify** (inacessíveis do ambiente do Claude).

Commits em `origin/main` (fast-forward a partir de d781c24):
- `bdb7cdd` — pedido na matriz com chave idempotente.
- `338a2e6` — trava anti-requentado no worker.
- `fe602c2` — empurrão de localização-em-texto.

Provas finais: `typecheck` limpo + **455/455 vitest** (59 arquivos) + 1 teste de integração escrito (roda só com Docker/CI).

---

## 1. A venda do Vitor (conv 664, env prod)
Lead do Instagram ("Shared post"). Bot do zero: identificou Titan 160 → sem Pirelli/Michelin → ofereceu par equivalente (80/100-18 + 100/90-18) R$ 198 → tentou retirada (sem estoque perto) → entrega → frete Irajá R$ 9,90 → **R$ 207,90**, dinheiro. Caiu na **matriz** (`unit slug=main`, Wallace) porque nenhum parceiro perto de Irajá tinha o par (backstop funcionando como desenhado).

### Limpeza de dado feita em prod (com OK do dono)
- **PED-0046 cancelado** (`status='cancelled'`) — era duplicata exata do PED-0045 (mesma conversa, itens, endereço). Estoque reservado=0 nos dois → cancelar não soltou nada.
- **Telefone do Vitor salvo**: `core.contacts.phone_e164 = +5521920052492` (o cliente deu o número na conversa, mas o caminho matriz não o gravava em lugar nenhum).

### Pendência NÃO feita (decisão consciente)
Persistir o telefone no caminho matriz **por código** (hoje a próxima venda matriz/Insta volta a perder o número). Não fiz junto porque é um write em `core.contacts` no hot-path da venda e há risco de constraint unique a checar antes. Flag pro próximo ciclo.

---

## 2. Fix #1 — Pedido duplicado (commit `bdb7cdd`)
**Causa raiz:** `criarPedido` (`src/atendente-v2/tools.ts`) tem dois caminhos. O do **parceiro** gravava `commerce.orders` com `idempotency_key` estável; o da **MATRIZ** gravava com `idempotency_key=NULL` de propósito → o índice parcial `orders_idempotency_key_uniq` (que só dedup quando a chave é não-nula) nunca pegava. O cliente disse "Ok" depois do PED-0045 e o LLM re-chamou `criar_pedido` → nasceu o PED-0046.

**Fix:** extraí `buildOrderIdempotencyKey(conversa, loja, itens, modalidade)` em `src/atendente-v2/order-idempotency.ts`, usada nos DOIS caminhos. A matriz agora manda chave estável; em dupla-chamada o `ON CONFLICT DO NOTHING` (+ re-SELECT já existente) devolve o pedido existente em vez de criar outro.

**Provas:** `tests/unit/atendente/order-idempotency.test.ts` (6, com golden de formato).

---

## 3. Fix #2 — Bot repetia a mensagem (commit `338a2e6`)
**Sintoma (conv 664):** bot mandou "qual pneu" 2× e "só faltou o WhatsApp" 2×, ~1 min de intervalo, sem o cliente falar no meio.

**Mecânica da fila:** webhook → `raw.raw_events` (dedup por delivery_id) → normalization worker → `ops.enqueue_atendente_job` (1 job por `trigger_message_id`, sem coalescing por conversa) → agent-v2 worker (`src/atendente-v2/worker.ts`): `pickAtendenteJob` (FOR UPDATE SKIP LOCKED) + debounce de 3s (`AGENT_V2_DEBOUNCE_SECONDS`) + supersede de job mais novo (`hasNewerPendingJob`).

**Causa raiz provada no banco:** ~5 de 17 mensagens tiveram o job criado **40–57s ATRASADO**, pela rede de segurança `reconcile` (60s, `src/atendente/reconcile-jobs.ts`), não na hora pelo dispatcher. O atraso fura a janela de debounce de 3s → o bot respondeu a mensagem velha DE NOVO.

**Fix (cinto):** `src/atendente-v2/stale-trigger.ts` `isStaleTrigger(triggerCreatedAt, latestOutgoingAt)` + repo `loadStaleTriggerCheck` (2 SELECTs simples em `core.messages`). No worker, logo após `hasNewerPendingJob`: se já há `outgoing` DEPOIS do gatilho, marca `superseded:already_replied_after_trigger` e NÃO responde. Neutraliza o repeat venha de onde vier. Decisão do dono: **prefere atrasar a repetir** (resposta lenta é menos vexame que resposta repetida).

**Provas:** `tests/unit/atendente/stale-trigger.test.ts` (5) + `tests/integration/stale-trigger.integration.test.ts` (roda só com Docker/CI; Docker não estava de pé na máquina).

**VALIDADO AO VIVO pós-deploy (conv 668):** a trava pegou 3 jobs requentados (`superseded:already_replied_after_trigger`: "Tenho interesse" 21s, "É a fan" 37s, "Conhece?") → **0 repetições**.

---

## 4. Fix #3 — Bot regride na localização-em-texto (commit `fe602c2`)
**Furo (conv 668):** o cliente respondeu a localização em TEXTO ("Irajá próximo ao mercado Guanabara"). Pelos `agent.turns`: o bot ATÉ extraiu "Irajá" e chamou `buscar_compatibilidade` com `bairro="Irajá"` (estoque confirmou na loja que atende Irajá). Mas na FALA **regrediu** — recitou a medida do pneu de novo ("o jogo certo é Dianteiro 80/100-18… esse serve?") e não reconheceu a loja nem avançou pra entrega/retirada. Pareceu (pro dono e pro cliente) que ignorou a localização.

**Causa raiz:** o **pino GPS** tem empurrão por código (`pinNudge` em `agent.ts`) que vence o LLM; a **localização em texto** não tinha → o LLM, sem trilho, regrediu. (Princípio do projeto: comportamento crítico se garante por código, não por prompt.)

**Fix:** `src/atendente-v2/location-nudge.ts`. Gatilho por ESTADO do próprio bot — `botAskedForLocation(lastAssistantText)` (regex nas frases reais de pedido de localização; evita falsos como "te passo a localização da LOJA"), **sem adivinhar o bairro no texto do cliente** (seria frágil). Quando dispara e NÃO há pino, anexa `LOCATION_REPLY_NUDGE`.

**Anti-engessamento (preocupação explícita do dono "trilho quebra o bot se o cliente voltar pro topo"):** o empurrão é PERMISSIVO, não roteiro. Proíbe só as burrices (re-pedir a localização, recitar o pneu já cotado) e manda **SEGUIR o cliente se ele mudou de assunto**. Só anexa quando dispara → fora disso o prompt fica byte a byte (caching preservado). Mesma fórmula do `pinNudge`, que já roda há semanas sem engessar.

**Provas:** `tests/unit/atendente/location-nudge.test.ts` (7: pega os pedidos reais, ignora falsos e o envio-da-loja, e confirma que o texto manda seguir o cliente + não recitar). **Pendente:** validar ao vivo o pulo de funil (cliente dá bairro e depois troca de moto/pergunta preço) — é comportamento de LLM, não dá pra unit-testar; segurança é pela redação permissiva.

---

## 5. Aberto — por que a mensagem entra na fila atrasada (o "suspensório")
A trava (#2) é o cinto e já resolve o que o cliente vê. Falta a causa raiz do atraso: as mensagens atrasadas tiveram `message_created` ÚNICO, `processed`, sem erro, sem reprocesso (raw_events conferido) — o dispatcher (`src/normalization/dispatcher.ts`, enfileira SEMPRE p/ contact message_created, mesma transação do upsert) rodou na hora mas NÃO criou o job. Contradiz o código (o INSERT deveria ter criado). **O banco está esgotado**; a prova final (ramo `"atendente job enqueued"` vs `"skipped — sender_type is not contact"`) só existe nos **logs da app no Coolify**, inacessíveis do ambiente do Claude. Hipóteses a confirmar: classificação de sender nas 1ªs mensagens do Insta OU miss transitório do enqueue. Caminhos: (A) puxar logs do Coolify, (B) diagnóstico visível no banco, (C) injetar rajada no Chatwoot pós-deploy e ler o padrão (ideia do dono).

---

## 6. Estado do deploy / próximos passos
- `origin/main` em `fe602c2` (3 fixes). Deploy é MANUAL (dono aperta no Coolify). O dono já fez Redeploy e validou a trava ao vivo (conv 668). Falta confirmar que o `fe602c2` (empurrão) também subiu.
- **Teste pra induzir o erro (roteiro):** conversa nova, responder PICADO (3-4 mensagens em <3s a cada pergunta do bot) — é a rajada que provoca o atraso. Antes do deploy = vê o bug; depois = vê a trava segurando.
- **Próximos (ordem):** (1) validar o empurrão ao vivo (localização em texto → bot reconhece a loja e avança, e o pulo de funil não engessa); (2) cravar o glitch do enqueue; (3) persistir telefone no caminho matriz por código; (4) landmines de go-live em [[project_roadmap_bot_entrega_proximo_encontro]] (raios reais, matar zz-teste, rotacionar chave Google, partição de julho).

## 7. Arquivos tocados nesta sessão
- `src/atendente-v2/order-idempotency.ts` (novo) + `src/atendente-v2/tools.ts` (2 caminhos usam a chave).
- `src/atendente-v2/stale-trigger.ts` (novo) + `src/atendente-v2/worker.ts` + `src/shared/repositories/ops-atendente.repository.ts`.
- `src/atendente-v2/location-nudge.ts` (novo) + `src/atendente-v2/agent.ts`.
- Testes: `tests/unit/atendente/{order-idempotency,stale-trigger,location-nudge}.test.ts` + `tests/integration/stale-trigger.integration.test.ts`.
