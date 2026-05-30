# Plano — Chat unificado no Portal Parceiro (Chatwoot ↔ banco ↔ portal)

> Documento de implementação. Escrito em 2026-05-29 por Claude (Opus 4.8), em conversa
> com Wallace. **Autossuficiente de propósito**: outra LLM deve conseguir continuar a
> implementação a partir daqui sem ter visto a conversa. Todos os arquivos, funções e
> convenções citados foram verificados no código real do projeto nesta data.

---

## 0. TL;DR

A tela do Bate-papo (aba F7 do portal do parceiro) **já está pronta visualmente** e
rodando com dados de exemplo no front. Falta o backend que liga ela ao Chatwoot e ao
banco. Este plano descreve esse backend em **4 fatias** entregáveis, sendo a Fatia 1
(parceiro vê conversas reais chegarem, sem responder) o primeiro passo, em ~3-4 dias.

Nada aqui é risco técnico ou pesquisa. É encanamento conhecido sobre infra que já existe.

---

## 0.1 HANDOFF — ONDE PARAMOS (2026-05-29, fim do dia)

> **Para a próxima LLM/sessão:** leia isto primeiro. Resume o estado exato e o que fazer
> a seguir. Detalhes completos nas seções 4-13.

### Estado atual
- **Fatia 1.1 (tabelas) — FEITA e aplicada em prod.** Migration `0070_partner_chat.sql`
  criou `commerce.partner_conversations` e `commerce.partner_messages` (RLS por unidade).
  Verificada em prod.
- **Fatia 1.2 (fan-out do webhook) — CÓDIGO FEITO + BUG DE RUNTIME CORRIGIDO; AGUARDA REDEPLOY+VALIDAÇÃO.**
  - Commit base `b782080` na branch `main`, **pushado pro remote `pneus`**
    (`github.com/financaswall-beep/farejador-pneus`), que é de onde o Coolify deploya o
    Farejador.
  - Arquivos: `src/normalization/partner-chat.fanout.ts` (novo),
    `src/normalization/dispatcher.ts` (hook em `message_created`),
    `src/shared/config/env.ts` (flag nova), teste novo. 240 testes verdes.
  - **Flag `PARTNER_CHAT_FANOUT_ENABLED=true` setada no Coolify** (serviço `farejador`).
  - **BUG ACHADO E CORRIGIDO em 2026-05-30 (commit `df05382`, pushado pro `pneus`):**
    no primeiro teste o fan-out RODOU (flag ok, env ok), mas falhou em runtime com
    Postgres `42P10 "no unique or exclusion constraint matching the ON CONFLICT
    specification"`. Causa: o INSERT em `partner_messages` usava
    `ON CONFLICT (environment, chatwoot_message_id) DO NOTHING`, mas o índice
    `partner_messages_cw_uniq` é **PARCIAL** (`WHERE chatwoot_message_id IS NOT NULL`).
    Postgres não infere índice parcial sem repetir o predicado. Como o SAVEPOINT
    desfazia tudo, conversa+mensagem sumiam (tabelas vazias apesar da flag). Fix:
    `ON CONFLICT (environment, chatwoot_message_id) WHERE chatwoot_message_id IS NOT NULL
    DO NOTHING`. (O `ON CONFLICT` da conversa já estava certo — índice cheio.)
  - **VALIDADO EM PROD em 2026-05-30** (redeploy do `df05382` às 02:23): msg de teste na conv
    #624 caiu certinho — unidade `borracharia-rio-do-ouro`, canal `whatsapp`, cliente Wallace
    `+5521976674264`, unread=1, inbound/customer + outbound/partner. **Fatia 1.2 CONCLUÍDA.**

### O QUE FALTA AGORA (próxima ação concreta)
**Fatia 1.2, 1.3 e 1.4 FEITAS (commits `df05382` e `11c519f`).** A aba Bate-papo já lê as
conversas reais e faz polling 5s; verificado no preview com a conv #624.
**Próximo passo = Fatia 1.5 (validar em prod):**
1. Redeploy do `11c519f` no Coolify (serviço `farejador`).
2. Gerar token do parceiro: `node scripts/gerar-token-parceiro.cjs --slug=borracharia-rio-do-ouro --env=prod`
   (token aparece 1x no stdout; cola no login de `/parceiro/borracharia-rio-do-ouro/`).
3. Abrir o portal, aba Bate-papo, e ver a conversa do WhatsApp aparecer e atualizar sozinha.

Depois disso, **Fatia 2** (responder pelo portal): `sendMessage()` no
`chatwoot-api.client.ts` + `POST .../chat/:id/send` + tratamento do eco (§7 Fatia 2).

Ponto em aberto p/ a tela: respostas do Agent V2 entram como `sender='partner'` (o bot envia
ao Chatwoot como agente normal, `sender_type='user'`, não `agent_bot`); distinguir bot vs
humano exige detectar pela conta/autor no Chatwoot.

#### (Histórico) SQL de verificação usado na validação da 1.2:
1. Manda **uma mensagem de texto de teste** de um WhatsApp real pro número da loja.
2. Conferir no Supabase (projeto **Farejador**, ref `aoqtgwzeyznycuakrdhp`) se a conversa e a
   mensagem caíram. SQL de verificação:
   ```sql
   SELECT id, unit_id, chatwoot_conversation_id, channel, customer_name,
          customer_identifier, last_message_at, unread_count
   FROM commerce.partner_conversations
   ORDER BY created_at DESC LIMIT 5;

   SELECT id, conversation_id, chatwoot_message_id, direction, sender, content, created_at
   FROM commerce.partner_messages
   ORDER BY created_at DESC LIMIT 10;
   ```
   **Esperado:** 1 conversa na unidade `borracharia-rio-do-ouro`
   (unit_id `36203e18-c3fb-4201-bca1-b15c605faa37`), canal `whatsapp`, com o nome/telefone
   do cliente; e a mensagem de texto com `direction='inbound'`, `sender='customer'`.
3. Se NÃO aparecer, depurar nesta ordem: (a) a mensagem chegou em `raw.raw_events`? (b) foi
   normalizada (`core.messages`)? (c) logs do serviço `farejador` têm
   "partner chat fanout failed"? (d) a flag está mesmo `true` no container? (e) existe
   exatamente 1 `network.partner_units` ativa? (se 0 ou >1, o fan-out pula de propósito).

### DEPOIS da validação — seguir para:
- **Fatia 1.3** — endpoints de leitura no portal (`src/parceiro/route.ts` + `queries.ts`),
  sob `withPartnerContext`. Ver §7.
- **Fatia 1.4** — ligar o front: trocar o array `chatConversations` (mock) em
  `parceiro/public/app.js` por `fetch` + polling 5s. A tela (aba Bate-papo F7) já existe.

### Fatos que a próxima LLM precisa (não re-derivar)
- Supabase prod: projeto **Farejador**, ref `aoqtgwzeyznycuakrdhp`. (Há também `betaAgente`,
  ref `vyxdquwxmgibpkoswxut` — NÃO é o de prod do chat.)
- Deploy do Farejador: remote **`pneus`**, branch `main`. Coolify (Docker Compose).
- Worker de normalização roda em prod (`src/app/server.ts` → `startWorker()`), então o
  fan-out dispara sozinho ao processar `raw.events`.
- Variáveis do Chatwoot (todas já no Coolify): ver §10.1.
- Única unidade de parceiro ativa hoje: `borracharia-rio-do-ouro`.
- Convenção de RLS/identidade do portal: §3.3. Padrão de migration de parceiro:
  `db/migrations/0060_partner_customers.sql`.

---

## 1. Objetivo

O cliente fala com a loja pelo WhatsApp / Instagram / Facebook. O Chatwoot já recebe e
unifica os três canais (motor de mensageria). Queremos que o **parceiro/atendente
converse com o cliente dentro do próprio portal** (a aba Bate-papo), sem nunca abrir o
Chatwoot, com:

- Histórico próprio no nosso banco (sobrevive a queda do Chatwoot).
- Isolamento por parceiro via RLS (parceiro A não vê conversa do parceiro B).
- Integração com o PDV ("criar venda direto da conversa" — a joia que justifica não usar
  embed do Chatwoot).

**Decisão de produto já fechada (sessão 2026-05-28):** Opção B — UI custom + sincronia
bidirecional via API do Chatwoot. **NÃO** embutir o Chatwoot via iframe. Referência:
[PLANO_EXPANSAO_REDE_2026-05-28.md](PLANO_EXPANSAO_REDE_2026-05-28.md), seção
"Atendimento multi-canal unificado".

---

## 2. Princípio central: tudo passa pelo banco, nas duas direções

```
ENTRADA (cliente → portal)
  Cliente → Meta → Chatwoot → webhook → BANCO (commerce.partner_messages) → tela do parceiro

SAÍDA (portal → cliente)
  Parceiro digita → BANCO (grava primeiro) → API Chatwoot → API Meta → cliente
```

O banco é a fonte de verdade. O Chatwoot é o carteiro (motor de canais), não o dono do
histórico. Isso mantém a "regra de ouro" já estabelecida no
[PAINEL_PLANO.md](PAINEL_PLANO.md): **bot/admin ESCREVE, portal LÊ** (com a exceção
controlada de o portal escrever as mensagens de saída via endpoint próprio).

---

## 3. Estado atual REAL do código (verificado em 2026-05-29)

### 3.1 O que JÁ EXISTE e será reaproveitado

| Peça | Arquivo | O que faz hoje |
|---|---|---|
| Recepção de webhook | [src/webhooks/chatwoot.handler.ts](../src/webhooks/chatwoot.handler.ts) | Valida HMAC, deduplica por `x-chatwoot-delivery`, grava em `raw.events` numa transação. **Já roda em produção.** |
| HMAC/timestamp | [src/webhooks/chatwoot.hmac.ts](../src/webhooks/chatwoot.hmac.ts) | Validação de assinatura. |
| Normalização raw→core | [src/normalization/](../src/normalization/) (`worker.ts`, `message.mapper.ts`, `conversation.mapper.ts`) | Transforma `raw.events` em `core.messages` / `core.conversations`. |
| Cliente API Chatwoot | [src/admin/chatwoot-api.client.ts](../src/admin/chatwoot-api.client.ts) | `listConversations`, `listMessages`, `createNote` (privada). **Tem retry/backoff e timeout prontos.** |
| Reconciliação | [src/admin/reconcile.service.ts](../src/admin/reconcile.service.ts) | Repuxa do Chatwoot via API quando webhook falha. Padrão reaproveitável. |
| Portal parceiro (backend) | [src/parceiro/](../src/parceiro/) (`route.ts`, `queries.ts`, `auth.ts`, `db.ts`) | Fastify, mesmo processo. Auth por token, pool com RLS. |
| Portal parceiro (front) | [parceiro/public/](../parceiro/public/) (`index.html`, `app.js`, `style.css`) | App Alpine. **A aba Bate-papo (F7) já existe** com dados de exemplo. |
| Servidor de preview | [src/app/preview-parceiro-server.ts](../src/app/preview-parceiro-server.ts) | Sobe só o portal, sem workers. Rodar: `npx tsx --env-file=.env src/app/preview-parceiro-server.ts`. |

### 3.2 O que FALTA construir (os buracos)

1. **A "boca"** — método pra enviar mensagem PÚBLICA pro cliente. Hoje
   `chatwoot-api.client.ts` só tem `createNote(... private:true)` (nota interna que o
   cliente não vê). Falta um `sendMessage()` com `message_type:'outgoing', private:false`.
   Trabalho pequeno, mas hoje **não existe**.
2. **Tabelas de conversa/mensagem** do parceiro (`commerce.partner_conversations`,
   `commerce.partner_messages`) — migration nova.
3. **Fan-out do webhook** — gravar uma cópia da mensagem nas tabelas acima quando a
   conversa pertence a um parceiro.
4. **Endpoints de leitura e envio** no `src/parceiro/route.ts`.
5. **Ligar o front** — trocar o array `chatConversations` de exemplo por `fetch`.

### 3.3 Arquitetura de identidade/RLS do parceiro (CRÍTICO entender)

Verificado em [src/parceiro/auth.ts](../src/parceiro/auth.ts) e
[src/parceiro/db.ts](../src/parceiro/db.ts):

- Token do parceiro é validado por `network.validate_partner_token(env, slug, token)`
  (function `SECURITY DEFINER`). Retorna `partner_unit_id`, `unit_id`, `partner_id`, etc.
- O portal usa um **pool isolado** (`partnerPool`) com role `farejador_partner_app`
  **sem BYPASSRLS** — RLS é efetivamente aplicada.
- **Toda** query do portal roda dentro de `withPartnerContext(partnerUnitId, cb)`, que
  abre transação e seta o GUC `app.partner_unit_id` via `set_config(..., true)` (SET LOCAL).
- As policies RLS das tabelas do parceiro filtram por
  `network.current_partner_core_unit()`, que resolve o GUC → `core.units.id`.
- O bot/admin escreve por um pool diferente ([src/persistence/db.ts](../src/persistence/db.ts),
  role `postgres`), que **bypassa** RLS. É por aí que o fan-out do webhook vai gravar.

**Consequência de design:** as tabelas novas seguem o padrão exato de
`commerce.partner_customers` (migration 0060): coluna `unit_id UUID NOT NULL REFERENCES
core.units(id)`, RLS via `current_partner_core_unit()`. **Escrita** pelo pool do bot
(bypassa RLS, grava o `unit_id` certo); **leitura** pelo pool do parceiro (RLS filtra).

### 3.4 Correção ao plano de 28/05

O [PLANO_EXPANSAO_REDE_2026-05-28.md](PLANO_EXPANSAO_REDE_2026-05-28.md) propôs
`network.partner_conversations` com uma policy usando `network.current_partner_core_unit()`
direto sobre `partner_unit_id`. **Não seguir isso ao pé da letra.** A convenção real e
testada do projeto é:

- Tabelas operacionais do parceiro vivem em `commerce.partner_*` (não `network.*`;
  `network.*` é a camada de tenancy: `partner_units`, `validate_partner_token`,
  `current_partner_core_unit`, `set_updated_at`).
- A coluna de isolamento é `unit_id` (= `core.units.id`), e a policy compara
  `unit_id = network.current_partner_core_unit()`.

Este plano usa `commerce.partner_conversations` / `commerce.partner_messages` por isso.

---

## 4. Modelo de dados (migration 0070 — última atual é 0069)

> Estilo copiado de [db/migrations/0060_partner_customers.sql](../db/migrations/0060_partner_customers.sql).
> Triggers `network.set_updated_at()` e `ops.validate_env_match(...)` já existem no banco.

```sql
-- ============================================================
-- 0070_partner_chat.sql
-- Chat unificado: conversas e mensagens do Chatwoot espelhadas
-- no banco, isoladas por unidade parceira (RLS).
-- ============================================================

-- ---------- CONVERSAS ----------
CREATE TABLE IF NOT EXISTS commerce.partner_conversations (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment              env_t NOT NULL,
  unit_id                  UUID NOT NULL REFERENCES core.units(id),
  chatwoot_conversation_id BIGINT NOT NULL,
  channel                  TEXT NOT NULL DEFAULT 'whatsapp'
                             CHECK (channel IN ('whatsapp','instagram','facebook','other')),
  customer_name            TEXT,
  customer_identifier      TEXT,             -- telefone E.164 ou @handle
  -- contexto captado pelo bot (slots), pra pré-preencher o painel de detalhes
  customer_location        TEXT,
  initial_intent           TEXT,
  status                   TEXT NOT NULL DEFAULT 'open'
                             CHECK (status IN ('bot','open','in_progress','resolved','transferred')),
  last_message_at          TIMESTAMPTZ,
  unread_count             INTEGER NOT NULL DEFAULT 0,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at              TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS partner_conversations_cw_uniq
  ON commerce.partner_conversations(environment, chatwoot_conversation_id);

CREATE INDEX IF NOT EXISTS partner_conversations_unit_idx
  ON commerce.partner_conversations(environment, unit_id, last_message_at DESC);

-- ---------- MENSAGENS ----------
CREATE TABLE IF NOT EXISTS commerce.partner_messages (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment         env_t NOT NULL,
  unit_id             UUID NOT NULL REFERENCES core.units(id),
  conversation_id     UUID NOT NULL REFERENCES commerce.partner_conversations(id),
  chatwoot_message_id BIGINT,               -- nulo só durante a janela otimista de envio
  direction           TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  sender              TEXT NOT NULL CHECK (sender IN ('customer','bot','partner')),
  content             TEXT,
  attachments         JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- chave do lado do portal pra casar o eco do Chatwoot e evitar duplicata
  client_token        TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dedup do ECO: a mesma mensagem do Chatwoot nunca entra duas vezes.
CREATE UNIQUE INDEX IF NOT EXISTS partner_messages_cw_uniq
  ON commerce.partner_messages(environment, chatwoot_message_id)
  WHERE chatwoot_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS partner_messages_conv_idx
  ON commerce.partner_messages(conversation_id, created_at);

-- ---------- updated_at + env match ----------
DROP TRIGGER IF EXISTS partner_conversations_set_updated_at ON commerce.partner_conversations;
CREATE TRIGGER partner_conversations_set_updated_at
  BEFORE UPDATE ON commerce.partner_conversations
  FOR EACH ROW EXECUTE FUNCTION network.set_updated_at();

DROP TRIGGER IF EXISTS env_match_partner_conversations_unit ON commerce.partner_conversations;
CREATE TRIGGER env_match_partner_conversations_unit
  BEFORE INSERT OR UPDATE OF environment, unit_id ON commerce.partner_conversations
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('core', 'units', 'unit_id');

DROP TRIGGER IF EXISTS env_match_partner_messages_unit ON commerce.partner_messages;
CREATE TRIGGER env_match_partner_messages_unit
  BEFORE INSERT OR UPDATE OF environment, unit_id ON commerce.partner_messages
  FOR EACH ROW EXECUTE FUNCTION ops.validate_env_match('core', 'units', 'unit_id');

-- ---------- RLS ----------
ALTER TABLE commerce.partner_conversations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS partner_conversations_isolation ON commerce.partner_conversations;
CREATE POLICY partner_conversations_isolation ON commerce.partner_conversations
  FOR ALL
  USING (network.current_partner_core_unit() IS NOT NULL
         AND unit_id = network.current_partner_core_unit())
  WITH CHECK (network.current_partner_core_unit() IS NOT NULL
         AND unit_id = network.current_partner_core_unit());

ALTER TABLE commerce.partner_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS partner_messages_isolation ON commerce.partner_messages;
CREATE POLICY partner_messages_isolation ON commerce.partner_messages
  FOR ALL
  USING (network.current_partner_core_unit() IS NOT NULL
         AND unit_id = network.current_partner_core_unit())
  WITH CHECK (network.current_partner_core_unit() IS NOT NULL
         AND unit_id = network.current_partner_core_unit());

-- O portal só LÊ conversas e LÊ/INSERE mensagens (envio de saída).
GRANT SELECT          ON commerce.partner_conversations TO farejador_partner_app;
GRANT SELECT, INSERT  ON commerce.partner_messages      TO farejador_partner_app;
```

**Notas de modelagem:**
- `unread_count` e `last_message_at` denormalizados na conversa pra a lista não precisar
  agregar mensagem a cada poll.
- `client_token`: o front gera um id ao enviar; grava na mensagem otimista; quando o eco
  do Chatwoot chega no webhook com `chatwoot_message_id`, casa-se pela conversa + conteúdo
  ou pelo `client_token` ecoado (ver §6.2) e faz `UPDATE` em vez de `INSERT`.
- A escrita do fan-out (webhook) usa o pool do bot e seta `unit_id` explicitamente. O
  portal nunca insere conversa; só insere mensagem `outbound` da própria unidade (RLS
  garante via `WITH CHECK`).

---

## 5. Como uma conversa do Chatwoot vira "de um parceiro" (atribuição)

Esse é o ponto que o roteamento (geofencing) resolverá no futuro. **Para a Fatia 1, não
precisamos do algoritmo.** Estratégia incremental:

- **Fatia 1 (agora):** existe um único parceiro ativo. Toda conversa nova é atribuída à
  `unit_id` desse parceiro. Implementar como: lookup da única `core.units` ativa de
  parceiro, ou uma constante de config (`DEFAULT_PARTNER_UNIT_ID`). Documentar como
  provisório.
- **Futuro:** o bot-triagem decide o parceiro (Sprint de geofencing do plano de expansão)
  e grava `unit_id` na conversa. O resto do cano não muda.

---

## 6. Fluxos detalhados

### 6.1 Entrada (já 80% pronta)

1. `chatwoot.handler.ts` recebe o webhook e grava `raw.events` (como hoje).
2. **NOVO:** após o `COMMIT` do raw, despachar um *fan-out* (idealmente no worker de
   normalização, não no caminho síncrono do webhook, pra não atrasar o 200):
   - Se evento é `message_created` e a conversa está atribuída a uma unidade parceira:
     - `INSERT ... ON CONFLICT (environment, chatwoot_conversation_id) DO UPDATE` em
       `partner_conversations` (upsert).
     - `INSERT ... ON CONFLICT (environment, chatwoot_message_id) DO NOTHING` em
       `partner_messages`.
     - `UPDATE` de `last_message_at`/`unread_count` na conversa.

> Onde plugar: o handler hoje só persiste raw. A normalização (`src/normalization/worker.ts`)
> já varre `raw.events` → `core.*`. O fan-out de chat deve ser **mais um consumidor** do
> mesmo evento, no worker, reusando o mapeamento de `message.mapper.ts`.

### 6.2 Saída (a construir) e o tratamento do ECO

1. Parceiro digita e o front faz `POST /parceiro/:slug/api/chat/:conversationId/send`
   com `{ content, client_token }`.
2. Endpoint (sob `withPartnerContext`):
   - `INSERT` em `partner_messages` (`direction:'outbound', sender:'partner',
     chatwoot_message_id NULL, client_token`).
   - Chama `chatwootApi.sendMessage(chatwoot_conversation_id, content)` (método NOVO).
   - Quando a API responde, faz `UPDATE` da mensagem com o `chatwoot_message_id` retornado.
3. **O ECO:** o Chatwoot dispara um webhook `message_created` com a mensagem que ACABAMOS
   de mandar. O fan-out tenta inserir, mas:
   - O `UNIQUE (environment, chatwoot_message_id)` já existe (passo 2.3) → `DO NOTHING`.
   - Se o eco chegar **antes** do `UPDATE` do passo 2.3 (corrida), casar por
     `client_token` (se o Chatwoot ecoar `echo_id`/source) ou por
     `(conversation_id, content, direction)` na janela de poucos segundos, e fazer `UPDATE`
     em vez de inserir duplicado.

> Resumo: a etiqueta única (`chatwoot_message_id` + `client_token`) é o que impede a
> mensagem aparecer duas vezes. É a pegadinha clássica desse tipo de integração.

---

## 7. Fatiamento da implementação

> Cada fatia é entregável e testável sozinha. Ordem pensada pra validar o risco mais cedo.

### Fatia 1 — "Só ver" (read-only) — PRIMEIRO PASSO — ~3-4 dias
**Objetivo:** parceiro vê conversa real do WhatsApp aparecer na aba Bate-papo,
atualizando sozinha. Ainda não responde.

- [x] **1.1** Migration `0070_partner_chat.sql` (§4). **Escrita E APLICADA em prod em 2026-05-29** (ver §13). Verificada: RLS on, 2 policies, índice do eco, grants e triggers OK.
- [x] **1.2** Fan-out no worker de normalização: webhook → `partner_conversations` +
      `partner_messages` (§6.1). Atribuição fixa ao parceiro único (§5).
      **Implementado e testado em 2026-05-29** (ver §13). Atrás da flag
      `PARTNER_CHAT_FANOUT_ENABLED` (default false). Falta ligar a flag em prod + teste real.
- [x] **1.3** Endpoints `GET /parceiro/:slug/api/chat/conversations` e
      `GET /parceiro/:slug/api/chat/conversations/:conversationId/messages` em
      [src/parceiro/route.ts](../src/parceiro/route.ts) + queries
      `getPartnerChatConversations`/`getPartnerChatMessages` em `queries.ts`, sob
      `withPartnerContext`. **FEITO 2026-05-30 (commit `11c519f`).** A lista traz o preview
      da última mensagem (subquery); messages retorna `null`→404 p/ conversa de outra unidade.
      Verificado direto contra prod (retornou a conv #624).
- [x] **1.4** Front: [parceiro/public/app.js](../parceiro/public/app.js) — mock
      `chatConversations` trocado por `fetch` aos endpoints + polling 5s ligado só enquanto a
      aba Bate-papo está aberta (`goToSection`). Mapeia banco→tela (canal, iniciais, hora BRT,
      preview, direção inbound/outbound→them/me). `sendChat` avisa que envio é Fatia 2.
      **FEITO 2026-05-30 (commit `11c519f`).** Verificado no preview: conversa #624 renderiza
      (lista + fio + detalhes).
- [x] **1.5** Validado em prod 2026-05-30: portal aberto com token real, conversa do WhatsApp
      aparece e atualiza via polling 5s. Token gerado p/ `borracharia-rio-do-ouro`.
- [x] **1.6 Reconciliador (rede de segurança) — commit `3d59802`.** Descoberto que a resposta
      do **bot** às vezes não era espelhada: o fan-out roda na normalização e, sob carga (banco
      lento logo após o Agent V2 responder), a cópia da msg de saída estourava e o SAVEPOINT a
      descartava (msg intacta em raw/core, fora de `partner_messages`). O fan-out está correto
      (reproduzido com payload real → insere ok). Correção: `src/normalization/partner-chat.reconcile.ts`
      roda a cada 30s, acha `message_created` processados sem cópia (LEFT JOIN, janela 15min) e
      reprocessa pelo MESMO fan-out (idempotente). Ligado no `server.ts`. Também: INSERT do
      fan-out agora grava `created_at = message.sentAt` (horário real), senão msgs reconciliadas
      entram com a hora do backfill e bagunçam a ordem. Backfill manual já recuperou as perdidas
      em prod. **Falta: redeploy do `3d59802` p/ o reconciliador rodar sozinho em prod.**
- [x] **Bug de assets corrigido (`08bc86c`):** ícones de canal (whatsapp/instagram/facebook) e
      fundo davam 404; rota de assets agora é genérica e segura.

**Pronto quando:** mando mensagem no WhatsApp de teste e ela aparece na aba Bate-papo do
parceiro em ≤5s, com selo do canal certo, isolada por RLS (outro parceiro não vê).

### Fatia 2 — "Responder" — CONCLUÍDA e VALIDADA em prod 2026-05-30
**Objetivo:** chat completo (parceiro responde, cliente recebe no WhatsApp/IG/FB).
> Handoff detalhado desta fatia: [SESSAO_2026-05-30_FATIA2_HANDOFF.md](SESSAO_2026-05-30_FATIA2_HANDOFF.md).
> Commits no `pneus`: `a693157` (feature), `4624aa0`, `b0132b1`, `7bb8c18` (fixes).

- [x] **2.1** `sendMessage(convId, content, echoId?)` em
      [src/admin/chatwoot-api.client.ts](../src/admin/chatwoot-api.client.ts)
      (`message_type:'outgoing', private:false`). `requestPost` agora **retorna o JSON** p/ pegar o id.
- [x] **2.2** Endpoint `POST /parceiro/:slug/api/chat/conversations/:conversationId/send` (zod, 200/400/404/502).
- [x] **2.3** Tratamento do eco. **DESCOBERTA:** este Chatwoot **NÃO ecoa `echo_id`** (vem null).
      O casamento por `client_token=echo_id` nunca funcionava → msg duplicava. Fix `7bb8c18`:
      fallback que casa a otimista por **conteúdo** (mesma conv, outbound, sem id, mesmo content,
      janela 10min); `UNIQUE(env, chatwoot_message_id)` = rede final.
- [x] **2.4** Front `sendChat()` async (otimista + rollback). Fix `4624aa0`: o body precisava de
      `JSON.stringify` (o helper `api()` não serializa).
- [x] **Bônus — canal IG/FB (`b0132b1`):** IG/FB entram por inbox tipo API (`Channel::Api`) que não
      rotula origem; `deriveChannel` agora lê também `payload.inbox.name`. WhatsApp e Instagram são
      canais nativos (`Channel::Whatsapp`/`Channel::Instagram`); Facebook só pelo nome do inbox.

**Pendência (não bloqueia):** apagar 4 linhas órfãs duplicadas geradas ANTES do fix `7bb8c18`
(conteúdo preservado na gêmea) — aguarda OK pra `DELETE` em prod. Ver handoff.

**Pronto quando:** respondo pelo portal e o cliente recebe ✅; a mensagem não duplica ✅;
o canal de origem aparece certo ✅. **Tudo confirmado em prod.**

**Polish pós-Fatia 2 (commits `9e82a0c` + `7b05964`):** "marcar como lido" no servidor
(endpoint `.../chat/conversations/:id/read` zera `unread_count` — antes o badge voltava no poll)
e **foto do contato** (migration `0072` + `meta.sender.thumbnail` no fan-out + `<img>` no avatar
com fallback pras iniciais). Detalhes e pendências (backfill de foto, delete das 4 órfãs) no
[handoff da Fatia 2](SESSAO_2026-05-30_FATIA2_HANDOFF.md).

### Fatia 3 — "Tempo real" (trocar polling por push) — ~1 dia
**Objetivo:** instantâneo, sem polling.

- [ ] **3.1** `LISTEN/NOTIFY` no Postgres: o fan-out faz `pg_notify('partner_chat', payload)`.
- [ ] **3.2** Endpoint SSE `GET /parceiro/:slug/api/chat/stream` que escuta o NOTIFY e
      empurra eventos pro front. (SSE, não WebSocket: é unidirecional servidor→cliente, que
      é o que precisamos; o cliente→servidor continua sendo o POST da Fatia 2.)
- [ ] **3.3** Front: `EventSource` substitui o `setInterval` do poll.

> **Decisão de arquitetura (importante):** NÃO usar Supabase Realtime. O app conecta no
> Postgres via `pg` Pool e a auth do portal é token próprio (não Supabase Auth). Supabase
> Realtime exigiria supabase-js + anon key + RLS via Supabase Auth — corpo estranho ao
> stack. SSE + `LISTEN/NOTIFY` encaixa no que já existe.

### Fatia 4 — "A joia" + mídia — ~2-3 dias
**Objetivo:** o diferencial que justifica todo o projeto.

- [ ] **4.1** Botão "Criar pedido" da conversa abre o PDV pré-preenchido com nome/telefone/
      intent captados (liga no fluxo de venda que já existe no portal).
- [ ] **4.2** Exibição de mídia: foto via URL do Chatwoot; áudio (o Chatwoot já converte
      WebM→OGG). Anexos já têm coluna (`attachments JSONB`).
- [ ] **4.3** Botões "Transferir" / "Voltar pro bot" / SLA (opcionais, conforme o plano de
      expansão).

---

## 8. Decisão de produto em ABERTO (afeta Fatia 2+)

**O parceiro digita a resposta, ou o bot pré-escreve e o parceiro só confirma/edita?**

- **Opção 1 — parceiro digita (recomendada pra começar):** mais simples, menor risco, é o
  que a tela atual já assume. O bot só faz triagem (capta nome/local/intent) e passa o
  bastão. Fecha a Fatia 2 sem nada extra.
- **Opção 2 — bot pré-escreve (rascunho assistido):** o bot gera a resposta sugerida, o
  humano aprova/edita. Exige uma camada a mais (gerar sugestão por turno, UI de
  aceitar/editar). Reaproveita o `agent`/SayValidator existente, mas é mais trabalho.

**Recomendação:** começar com a Opção 1. Adicionar sugestão do bot como melhoria depois,
medindo se o atendente realmente quer.

---

## 9. Riscos e mitigações

| Risco | Mitigação |
|---|---|
| Eco do Chatwoot duplica mensagem | `UNIQUE (environment, chatwoot_message_id)` + `client_token` (§6.2). |
| Webhook cai → dessincroniza | Reusar [reconcile.service.ts](../src/admin/reconcile.service.ts): job periódico que repuxa `listMessages` e preenche buracos. |
| Fan-out atrasa o 200 do webhook | Fan-out roda no worker de normalização (assíncrono), não no caminho síncrono do webhook. |
| Atribuição errada de parceiro | Fatia 1 usa parceiro único fixo; roteamento real é sprint futuro (geofencing). |
| RLS esquecida vaza dados | `withPartnerContext` é obrigatório; sem GUC = zero linhas (falha fechada). Já é o padrão do portal. |
| SSE/conexões penduradas | Heartbeat no SSE + limpeza no `close`. Começar com polling (Fatia 1) tira esse risco do caminho crítico. |

---

## 10. Questões abertas pra decidir antes de codar

1. **Decisão §8** (parceiro digita vs bot pré-escreve) — recomendo Opção 1.
2. **Atribuição na Fatia 1:** lookup automático da única unidade de parceiro, ou constante
   `DEFAULT_PARTNER_UNIT_ID` no `.env`?
3. **Mídia (Fatia 4):** link direto do Chatwoot (mais simples) ou cópia no Supabase Storage
   (mais robusto)? Plano de expansão sugere começar com link direto.
4. **SLA / "voltar pro bot":** entram agora ou ficam pra depois?

---

## 10.1 Variáveis de ambiente (CONFIRMADAS em prod/Coolify, 2026-05-29)

Todas já setadas no Coolify — **nenhuma fatia precisa de variável nova**:

| Variável | Valor / estado | Usada em |
|---|---|---|
| `CHATWOOT_HMAC_SECRET` | setada (locked) | Entrada — webhook. Já roda em prod. |
| `CHATWOOT_WEBHOOK_MAX_AGE_SECONDS` | `300` | Validação de timestamp. |
| `CHATWOOT_API_BASE_URL` | `https://chatwoot.smarttecsolutions.com.br/api/v1` | Saída — `chatwoot-api.client.ts`. |
| `CHATWOOT_API_TOKEN` | setada (locked) | Saída — envio/reconcile. |
| `CHATWOOT_ACCOUNT_ID` | `2` | Saída — monta a URL `/accounts/2/...`. |
| `PARTNER_CHAT_FANOUT_ENABLED` | **a ligar** (`true`) | Fan-out do chat (1.2). Default `false`. Ligar em prod pra começar a espelhar. |

**Único ponto a validar na Fatia 2:** se o `CHATWOOT_API_TOKEN` tem acesso à inbox onde
caem as conversas (senão envio dá 401). Confirma-se no primeiro envio de teste; não é
bloqueio prévio.

## 11. Glossário de arquivos-chave (pra navegar rápido)

| Quero mexer em... | Vá para |
|---|---|
| Recepção do webhook Chatwoot | `src/webhooks/chatwoot.handler.ts` |
| Normalização / fan-out | `src/normalization/worker.ts`, `*.mapper.ts` |
| Enviar pro Chatwoot | `src/admin/chatwoot-api.client.ts` |
| Reconciliação | `src/admin/reconcile.service.ts` |
| Endpoints do portal | `src/parceiro/route.ts` |
| Queries do portal (RLS) | `src/parceiro/queries.ts` + `withPartnerContext` em `src/parceiro/db.ts` |
| Auth do parceiro | `src/parceiro/auth.ts` (`network.validate_partner_token`) |
| Tela do Bate-papo | `parceiro/public/index.html` (seção `currentSection === 'batepapo'`) |
| Lógica do Bate-papo (front) | `parceiro/public/app.js` (`chatConversations`, `selectChat`, `sendChat`) |
| Estilos do Bate-papo | `parceiro/public/style.css` (`.pos-chat*`) |
| Migrations | `db/migrations/` (última: `0069`; próxima: `0070`) |
| Padrão de tabela+RLS de parceiro | `db/migrations/0060_partner_customers.sql` |

---

## 12. O que já foi feito (estética — sessão 2026-05-29)

- Aba **Bate-papo (F7)** criada no portal real (não é demo separada): `index.html`,
  `app.js`, `style.css`. Layout de 3 colunas (lista / thread / detalhes), tema claro/escuro,
  faixa de 4 KPIs.
- Envio testado pela interface (otimista, dados de exemplo no front).
- Fundo "rabisco" do cliente na área de mensagens (`assets/chat-bg.jpg`).
- Selos de canal (WhatsApp/Instagram/Facebook) na foto do contato
  (`assets/whatsapp.png`, `instagram.webp`, `facebook.png`), escolhidos por `data-channel`.

Tudo isso é **front-end com dados de exemplo**. Este plano é o backend que torna real.

---

## 13. Log de execução

### 2026-05-29 — Fatia 1.2: deploy + flag ligada (validação pendente)
- Commit `b782080` (fan-out + migration + plano) pushado pro remote `pneus` (fast-forward
  limpo, `fea954b..b782080`).
- Wallace fez redeploy no Coolify e setou `PARTNER_CHAT_FANOUT_ENABLED=true` no serviço
  `farejador`. **Redeploy em andamento.**
- **PENDENTE:** mandar mensagem de teste no WhatsApp e validar as tabelas em prod (SQL e
  passos no §0.1 HANDOFF). Enquanto não validar, considerar 1.2 "no ar mas não confirmado".
- Front-end da aba Bate-papo (UI mock: `parceiro/public/index.html|app.js|style.css` +
  assets de fundo/ícones) está MODIFICADO localmente mas **ainda NÃO commitado** — fica
  pra Fatia 1.4 ou um commit de UI à parte.

### 2026-05-29 — Fatia 1, passo 1.1: migration `0070_partner_chat.sql` escrita
- Criadas `commerce.partner_conversations` e `commerce.partner_messages` no estilo de
  `0060_partner_customers.sql` (env_t, unit_id→core.units, RLS via
  `current_partner_core_unit()`, triggers `set_updated_at`/`validate_env_match`).
- Dedup do eco: `UNIQUE(environment, chatwoot_message_id)` + índice por `client_token`.
- Grants mínimos pro portal: `SELECT` em conversas, `SELECT, INSERT` em mensagens.
  UPDATE (backfill de `chatwoot_message_id`, "marcar lida") fica no lado do bot/Fatia 2.
- **Pendente:** validar com `BEGIN; \i 0070...; ROLLBACK;` e aplicar em prod (aguardando
  aprovação do Wallace antes de tocar o banco).

**Próximo passo após aplicar a 0070:** passo 1.2 (fan-out do webhook → tabelas novas).

### 2026-05-29 — Procedimento de aplicação da 0070 (autorizado por Wallace)

Aplicação no Supabase de produção (projeto Farejador) via MCP, nesta ordem:

1. **Pré-flight (read-only)** — confirmar que as dependências da migration existem em
   prod antes de criar qualquer coisa:
   - tipo `env_t`, tabela `core.units`
   - funções `network.set_updated_at()`, `ops.validate_env_match(...)`,
     `network.current_partner_core_unit()`
   - role `farejador_partner_app`
2. **Aplicar** `0070_partner_chat.sql` (DDL aditivo: 2 tabelas + índices + triggers +
   RLS + grants). Não altera nada existente.
3. **Verificar pós-aplicação** — `partner_conversations` e `partner_messages` existem,
   RLS habilitada, grants corretos, índice único do eco presente.

**Plano de rollback** (se algo sair errado): as tabelas são novas e vazias, então
reverter é seguro e isolado:
```sql
DROP TABLE IF EXISTS commerce.partner_messages;
DROP TABLE IF EXISTS commerce.partner_conversations;
```
Nenhuma tabela/dado pré-existente é tocado pela 0070, então o DROP não tem efeito colateral.

### 2026-05-29 — Fatia 1, passo 1.2: fan-out do webhook implementado
- Novo módulo `src/normalization/partner-chat.fanout.ts` — `fanOutMessageToPartnerChat()`.
  Roda na transação da normalização (pool do bot, BYPASSRLS), atrás da flag
  `PARTNER_CHAT_FANOUT_ENABLED` (nova em `env.ts`, default false).
- Ligado no `src/normalization/dispatcher.ts`, só em `message_created`, após `upsertMessage`.
- **Defensivo:** SAVEPOINT próprio + try/catch — falha do fan-out NUNCA aborta a ingestão
  core. Verificado por teste.
- Regras: ignora nota interna (`private`), atividade (`messageType=2`), texto vazio e
  sender `system`. inbound→`customer`, outgoing bot→`bot`, outgoing humano→`partner`.
  unread só sobe em inbound e só quando a mensagem é nova (dedup por
  `chatwoot_message_id`). Eco da Fatia 2 já tratado (claim por `client_token = echo_id`).
- Atribuição (Fatia 1): única unidade de parceiro ativa do ambiente
  (`borracharia-rio-do-ouro` em prod). Se houver 0 ou >1, pula e loga.
- Teste novo `tests/unit/normalization/partner-chat.fanout.test.ts` (8 casos).
  Suíte: **240 testes verdes** (era 232). typecheck + build limpos.
- **Pendente pra ativar:** setar `PARTNER_CHAT_FANOUT_ENABLED=true` no Coolify + teste real.

### 2026-05-29 — RESULTADO: 0070 aplicada em prod (projeto Farejador, ref `aoqtgwzeyznycuakrdhp`)
- Pré-flight: todas as dependências confirmadas (`env_t`, `core.units`,
  `network.set_updated_at`, `network.current_partner_core_unit`, `ops.validate_env_match`,
  role `farejador_partner_app`). Tabelas ainda não existiam.
- `apply_migration` → `{"success": true}`.
- Verificação pós: RLS habilitada nas 2 tabelas, 2 policies de isolamento, índice único do
  eco presente, grants corretos (portal lê conversa, lê/insere mensagem, NÃO insere
  conversa), 3 triggers (1 updated_at + 2 env_match).
- **Etapa 1.1 CONCLUÍDA.** Próximo: passo 1.2 (fan-out do webhook).

---

Assinatura: Claude (Opus 4.8), em conversa com Wallace, 2026-05-29.
