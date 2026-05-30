# Handoff — Sessão 2026-05-30 (Fatia 2: responder pelo portal + canais IG/FB)

> Registro honesto do que foi feito, do que está **confirmado em prod** e do que
> ficou **pendente**. Escrito por Claude (Opus 4.8) com Wallace. Continuação de
> [PLANO_CHAT_UNIFICADO_PARCEIRO_2026-05-29.md](PLANO_CHAT_UNIFICADO_PARCEIRO_2026-05-29.md)
> e do [handoff anterior](SESSAO_2026-05-30_HANDOFF.md) (que fechou a Fatia 1).

## Objetivo da sessão
Fechar a **Fatia 2**: o parceiro responder o cliente direto do portal (banco → Chatwoot →
WhatsApp/Instagram/Facebook), sem abrir o Chatwoot. E corrigir a identificação do **canal**
de origem (WhatsApp/Instagram/Facebook) na tela.

## Commits desta sessão (remote `pneus`, branch `main`)
| Commit | O que faz | Estado |
|---|---|---|
| `a693157` | **Fatia 2** — responder pelo portal: `sendMessage()` no client Chatwoot + endpoint POST + `sendPartnerChatMessage()` + `sendChat()` async no front | ✅ deployado e validado |
| `4624aa0` | Fix: front mandava o body como objeto cru (`[object Object]` → 400); faltava `JSON.stringify` | ✅ deployado e validado |
| `b0132b1` | Fix: detectar canal **Instagram/Facebook** pelo **nome do inbox** (`Channel::Api` não rotula) | ✅ deployado e validado |
| `7bb8c18` | Fix: chat **não duplica** a msg enviada (Chatwoot **não ecoa `echo_id`**); casa a otimista por conteúdo | ✅ deployado e validado |

## ✅ Confirmado funcionando em prod
- **Responder pelo portal:** o parceiro digita, a mensagem sai pro cliente (WhatsApp/IG/FB) e
  aparece no fio. Validado por Wallace ("funcionou caralhooo").
- **Sem duplicar:** provado pela conv #628 (Instagram), msg "oi seu corno" → **uma linha só**,
  com `client_token` E `chatwoot_message_id` na mesma linha (a otimista foi casada, não reinserida).
- **Canais:** WhatsApp ✓, Instagram ✓, Facebook ✓ (ver detalhe de cada um abaixo).

---

## Como cada peça da Fatia 2 ficou (arquivos)
1. **`src/admin/chatwoot-api.client.ts`** — novo `sendMessage(convId, content, echoId?)`
   (`message_type:'outgoing', private:false`). O `requestPost` passou a **retornar o JSON** da
   resposta (antes era `void`) pra capturar o `chatwoot_message_id` criado.
2. **`src/parceiro/queries.ts`** — `sendPartnerChatMessage(ctx, convId, content, clientToken)`:
   insere a msg **otimista** pelo **pool do parceiro** (RLS; grant `SELECT/INSERT`), busca o
   `chatwoot_conversation_id`, manda pro Chatwoot. Se o envio **falha**, limpa a órfã pelo **pool
   do bot** (parceiro não tem `DELETE`). Retorna `ok` / `not_found` / `send_failed`.
3. **`src/parceiro/route.ts`** — `POST /parceiro/:slug/api/chat/conversations/:conversationId/send`
   (zod no body: `content` 1..4096, `client_token` 1..128; respostas 200/400/404/502).
4. **`parceiro/public/app.js`** — `sendChat()` async: bolha **otimista** na hora → POST →
   `loadChatMessages` no sucesso; **rollback** + aviso no erro; `chatSending` trava duplo-clique.
   **Body com `JSON.stringify`** (o helper `api()` NÃO serializa — todos os outros POST já passam
   string pronta).

---

## 🔑 Descobertas importantes (NÃO re-derivar — custaram investigação no banco de prod)

### 1. Este Chatwoot NÃO ecoa `echo_id`
O dedup original da Fatia 2 dependia de o Chatwoot devolver o `echo_id` no webhook
(`client_token = echo_id`). **Verificado em prod: `payload.echo_id` vem `null` em TODOS os
outgoing.** Resultado: o casamento nunca acontecia e cada msg enviada pelo portal entrava 2×
(a otimista com `chatwoot_message_id` NULL + o eco do webhook).
**Fix (`7bb8c18`):** o fan-out agora casa a otimista por **conteúdo** — mesma conversa, `outbound`,
`chatwoot_message_id IS NULL`, mesmo `content`, janela de 10 min — como fallback ao `echo_id`.
O `UNIQUE(environment, chatwoot_message_id)` continua sendo a rede final contra reentrega.
**Lição: não confiar em `echo_id` neste Chatwoot.**

### 2. Instagram/Facebook entram por inbox tipo API (`Channel::Api`)
O Chatwoot de prod (account 2, `chatwoot.smarttecsolutions.com.br`) entrega:
- **WhatsApp:** inbox 30, `conversation.channel = "Channel::Whatsapp"` (nativo) → sempre detectou.
- **Instagram:** inbox 21, `conversation.channel = "Channel::Instagram"` (nativo) → detecta pelo
  canal. (O inbox está nomeado "**Instagran**", com erro de digitação, mas não importa — o canal
  nativo já diz.)
- **Facebook:** inbox 22, `conversation.channel = "Channel::Api"` (integração externa) → o Chatwoot
  **NÃO rotula** a origem. **Só `payload.inbox.name` ("Facebook") revela.**

**Fix (`b0132b1`):** `deriveChannel` agora junta num "palheiro" e procura a palavra-chave:
`conversation.channel` + `additional_attributes.channel_type` + `inbox.channel_type` +
**`inbox.name`** + top `channel`. Ordem: whatsapp → instagram → facebook → other.

**Onde está o nome do inbox:** topo do payload de `message_created`, chave `inbox` → `{id, name}`.

---

## Backfills em prod (feitos / pendentes)
- ✅ **FEITO:** conv #627 (Facebook) estava `channel='other'` (linha velha, de antes do deploy) →
  atualizada pra `'facebook'`. (O upsert só reavalia canal em msg nova; por isso a linha velha
  ficou pra trás. `CASE WHEN channel='other' THEN novo ELSE atual` — nunca regride canal já bom.)
- ⏳ **PENDENTE (aguarda OK do Wallace):** apagar **4 linhas órfãs duplicadas** (a otimista sem
  `chatwoot_message_id`, que tem gêmea com o id real — conteúdo preservado na gêmea):
  - #624 "Ola"; #627 "oi"; #627 "vc ainda está ai ?"; #627 "Olá".
  - Query de seleção (dry-run validado): `partner_messages` com `chatwoot_message_id IS NULL` E
    `EXISTS` gêmea (mesma conv, direction, content) com `chatwoot_message_id IS NOT NULL`.
  - São de **antes** do fix `7bb8c18`; daqui pra frente não duplica mais.

---

## Pontos em aberto / próximos passos
- **Cosmético:** respostas do **bot** (Agent V2) entram como `sender='partner'`, não `'bot'`
  (o bot envia ao Chatwoot como agente normal, `sender_type='user'`). Distinguir bot vs humano
  exige detectar pela conta/autor no Chatwoot. (Herdado da Fatia 1.)
- **Fatia 3 — tempo real:** trocar polling 5s por SSE + `LISTEN/NOTIFY` (NÃO Supabase Realtime).
- **Fatia 4 — a joia:** botão "Criar pedido" da conversa abre o PDV pré-preenchido; exibir mídia
  (foto/áudio; coluna `attachments JSONB` já existe).

## Fatos úteis (não re-derivar)
- Supabase prod: projeto Farejador, ref `aoqtgwzeyznycuakrdhp`. Deploy: remote `pneus`, branch
  `main`, Coolify (serviço `farejador`).
- Inboxes do Chatwoot (account 2): **30** = WhatsApp API Oficial; **22** = Facebook; **21** =
  "Instagran" (Instagram nativo).
- Conversas de teste: #624 (WhatsApp), #627 (Facebook), #628 (Instagram). Unidade única ativa:
  `borracharia-rio-do-ouro` (`36203e18-c3fb-4201-bca1-b15c605faa37`).
- Rodar script de inspeção no prod: `node --env-file=.env scripts/<x>.cjs` (o `.env` local tem o
  `DATABASE_URL` de prod; mas `CHATWOOT_*` local aponta pro ambiente de dev — account 1/IP — então
  pra API do Chatwoot de prod use account 2 / smarttec, não o `.env` local).
- O helper `api()` do front (`app.js`) **não** faz `JSON.stringify` no body — sempre passar string.

---

## Adendo 2026-05-30 (continuação) — "marcar como lido" + foto do contato

Dois ajustes pedidos pelo Wallace depois da Fatia 2 validada. Commits no `pneus`:
`9e82a0c` (feature) + `7b05964` (fix de CSS da foto).

### Bug: badge "não lido" não sumia
- **Causa:** o fan-out incrementa `unread_count` no banco, mas **não havia "marcar como
  lido" no servidor** — o front só zerava localmente. A cada polling (5s) o servidor devolvia
  `unread_count > 0` de novo, prendendo o badge da navegação e o card "Conversas hoje".
- **Fix:** novo endpoint `POST /parceiro/:slug/api/chat/conversations/:conversationId/read` →
  `markPartnerChatRead()` zera `unread_count` pelo **pool do bot** (parceiro só tem SELECT na
  conversa, sem UPDATE), com `unit_id`/`environment` explícitos. Distingue 404 (conversa de
  outra unidade) de "já lido". Front (`app.js`) chama em `selectChat` e quando uma msg nova
  chega na conversa **aberta** (em `loadChat`).
- **Efeito:** os badges hoje presos limpam quando o parceiro **abrir** cada conversa.

### Feature: importar a foto do contato do Chatwoot
- **Origem da foto:** `payload.conversation.meta.sender.thumbnail` (é o CONTATO; o sender do
  topo, em outgoing, é o agente — por isso lemos de `meta.sender`). Fallback `avatar_url`.
- **Migration `0072_partner_chat_avatar.sql`:** add `customer_avatar_url TEXT` (nullable).
  **JÁ APLICADA em prod** via `ADD COLUMN IF NOT EXISTS` (idempotente). `GRANT SELECT` na tabela
  já cobre coluna nova — sem mudança de grant.
- **Fan-out:** `deriveCustomer` agora retorna `avatarUrl`; upsert grava `customer_avatar_url`
  (`COALESCE(EXCLUDED, existing)` — pega a foto mais recente não-nula).
- **Front:** `mapChatConversation` expõe `avatar`; `index.html` mostra `<img>` redonda no
  `.pos-chat-avatar` (3 lugares: lista, header do fio, painel de detalhes) com **fallback pras
  iniciais** (`x-show` + `@error` que zera o avatar se a imagem falhar). CSS `.pos-chat-avatar img`
  (100%, `border-radius:999px`, `object-fit:cover`); o selo de canal (`::after`) segue no canto.
- **ORDEM CRÍTICA:** a migration TEM que estar aplicada **antes** do deploy do fan-out novo —
  senão o INSERT da conversa estoura (coluna inexistente) e o SAVEPOINT descarta a msg. Como a
  0072 já foi aplicada, o redeploy é seguro.

### Pendências (precisam de OK / ação do Wallace)
1. **Redeploy no Coolify** do `7b05964` — sem ele, nem o "lido" nem a foto entram.
2. **Foto das conversas que já existem** (#624/#627/#628): só aparece quando chegar msg nova
   (o fan-out grava no próximo evento). Backfill possível: puxar o último `thumbnail` de cada
   conversa em `raw.raw_events` (`payload->'conversation'->'meta'->'sender'->>'thumbnail'`) e
   gravar em `customer_avatar_url`. **Aguarda OK.**
3. **4 linhas órfãs duplicadas** (de antes do fix `7bb8c18`): `DELETE` em prod, **aguarda OK**.

### Observação de verificação
As duas mudanças **não foram verificadas ao vivo** ainda: o "lido" precisa do endpoint
deployado e a foto precisa de dado novo (a coluna está vazia até o fan-out gravar). typecheck
limpo + 245 testes verdes. Validar no portal após o redeploy.

---

Assinatura: Claude (Opus 4.8), em conversa com Wallace, 2026-05-30.
