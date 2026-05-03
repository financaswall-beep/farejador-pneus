# Relatorio operacional - Chatwoot conectado ao Farejador

Atualizado: 25/04/2026

> Nota de manutencao 2026-05-03: este relatorio e historico da entrada em
> shadow mode da Fase 1. Alguns itens citados aqui como pendentes ja foram
> resolvidos ou substituidos. Para o estado vivo, use `docs/PROJECT.md`,
> `docs/NEXT_CHAT_HANDOFF.md` e
> `docs/phase3-agent-architecture/00-estado-de-implementacao.md`.

## Resumo executivo

O Farejador foi publicado no Coolify, conectado ao Supabase e recebeu webhooks reais
do Chatwoot. A integracao basica esta funcionando:

- `GET /healthz` responde `{"status":"ok","environment":"prod"}`.
- O endpoint `POST /webhooks/chatwoot` aceita assinatura HMAC oficial do Chatwoot.
- Eventos reais foram persistidos em `raw.raw_events`.
- O worker de normalizacao esta processando a fila para `core.*`.
- `SKIP_EVENT_TYPES=message_updated` esta ativo para reduzir ruido no shadow mode.
- O teste final com payload real do Chatwoot validou `core.contacts`,
  `core.conversations` e `core.messages` vinculados corretamente.

Fase 1 tecnica concluida. Ainda nao estamos em producao plena: estamos em
**shadow mode controlado** para observacao operacional e rotacao de secrets.

## Onde estamos no projeto

Fase atual: Fase 1 tecnica concluida; F1.5 hardening publicado; shadow mode real em acompanhamento.

Concluido:

- F1-01 webhook ingestion.
- F1-02 normalizacao deterministica.
- F1-03 admin endpoints e reconcile.
- Deploy Coolify do Farejador.
- Conexao com Supabase via Supabase Connection Pooler.
- Teste real de webhook Chatwoot -> Farejador.

Pendente antes de considerar producao plena:

- Rodar shadow mode por periodo combinado com o webhook ligado.
- Rotacionar secrets antes de producao plena. Dispensado para o repo base
  arquivado; fork operacional usa secrets proprios.
- `DATABASE_CA_CERT` foi removido: o pooler do Supabase usado aqui nao suporta
  validacao de cadeia como planejado; SSL permanece ativo via
  `rejectUnauthorized:false`.
- Criar harness de integracao automatizado com Postgres real.

## Acesso e endpoints

Chatwoot:

```text
http://<chatwoot-host>/app/accounts/1/dashboard
```

Account ID:

```text
1
```

API base URL:

```text
http://<chatwoot-host>/api/v1
```

Farejador:

```text
http://<farejador-host>:3000
```

Health:

```text
http://<farejador-host>:3000/healthz
```

Webhook:

```text
http://<farejador-host>:3000/webhooks/chatwoot
```

Repositorio:

```text
https://github.com/financaswall-beep/FarejaorV1
```

Ultimos commits relevantes:

```text
57c7b6f fix: make auxiliary event inserts conflict-safe
3e27464 docs: record F1.5 hardening — checklist e handoff atualizados
66b9537 fix: F1.5 hardening — imutabilidade raw, constraints idempotência, reconcile-v2, SSL, first_seen_at
e8007be docs: record worker concurrency validation
48623d2 docs: record real replay and reconcile validation
f1e29ca fix: dedupe messages across timestamp precision
c0769f8 fix: support Chatwoot top-level payload pages
3538252 fix: reconcile filters Chatwoot conversations locally
b7284f3 fix: keep raw webhook body without wrapping admin JSON
0e10878 fix: link conversations to nested Chatwoot contacts
f6ad7ff fix: upsert contacts from nested Chatwoot payloads
186f891 fix: map nested Chatwoot sender metadata
96da157 fix: map nested Chatwoot message fields
67efb1d fix: skip noisy Chatwoot events in shadow mode
c83b398 fix: validate official Chatwoot webhook signature
f110ed0 fix: install build dependencies in Docker builder
935f323 chore: add Coolify deploy config
```

## Variaveis importantes no Coolify/Farejador

Nao registrar valores secretos em logs ou docs.

Configuracao esperada:

```env
NODE_ENV=production
FAREJADOR_ENV=prod
PORT=3000
LOG_LEVEL=info
DATABASE_URL=<Supabase Connection Pooler Session Mode>
DATABASE_POOL_MAX=10
DATABASE_SSL=true
CHATWOOT_HMAC_SECRET=<secret da inbox/webhook Chatwoot>
CHATWOOT_WEBHOOK_MAX_AGE_SECONDS=300
CHATWOOT_API_BASE_URL=http://<chatwoot-host>/api/v1
CHATWOOT_API_TOKEN=<token de acesso Chatwoot>
CHATWOOT_ACCOUNT_ID=1
ADMIN_AUTH_TOKEN=<token admin Farejador>
SKIP_EVENT_TYPES=message_updated
```

Observacao: usar Connection Pooler do Supabase. A URL direta
`db.<project>.supabase.co:5432` falhou no Coolify por conectividade IPv4/IPv6.

## O que aconteceu no teste real

1. Farejador subiu no Coolify.
2. `/healthz` inicialmente retornou `database_unavailable`.
3. Causa: `DATABASE_URL` direta do Supabase.
4. Correcao: trocar para Supabase Connection Pooler Session Mode.
5. `/healthz` passou a responder `ok`.
6. Criada inbox API no Chatwoot:

```text
Farejador Teste
```

7. Configurada URL de webhook da inbox:

```text
http://<farejador-host>:3000/webhooks/chatwoot
```

8. Primeiro teste real nao caiu no raw porque havia divergencia de HMAC:
   o Farejador validava `raw_body`, mas o Chatwoot assina `timestamp.raw_body`.
9. Correcao aplicada no commit `c83b398`.
10. Depois do redeploy, webhook real entrou em `raw.raw_events`.
11. O payload real mostrou campos aninhados diferentes dos fixtures iniciais.
12. Foram corrigidos os mappers/dispatcher para:
    - ler `conversation.id` quando `conversation_id` nao vem direto;
    - ler `sender.type` e metadata aninhada;
    - criar/upsertar contato a partir de `payload.meta.sender`;
    - vincular conversa ao contato aninhado.
13. O ruido de `message_updated` foi controlado por `SKIP_EVENT_TYPES=message_updated`.

Mensagem real enviada para teste:

```text
Teste Farejador webhook real apos fix HMAC 2026-04-24 21:31:08
```

Evento confirmado em `raw.raw_events`:

```text
event_type: message_created
payload_id: 4
processing_status: pending
```

## Teste final validado

Apos as correcoes de payload aninhado e o redeploy final, foi feito um teste controlado
com criacao de contato, conversa e mensagem pela API publica do Chatwoot.

Resultado observado no Supabase:

```text
raw.raw_events:
- processed: 2
- conversation_created: processed
- message_created: processed

core.contacts:
- chatwoot_contact_id: 7
- contato criado corretamente

core.conversations:
- chatwoot_conversation_id: 7
- has_contact: true
- linked_contact_id: 7
- current_status: open

core.messages:
- chatwoot_message_id: 15
- chatwoot_conversation_id: 7
- sender_type: contact
- sender_id: 7
```

Conclusao: o fluxo real Chatwoot -> Farejador -> Supabase esta funcionando para
contato, conversa e mensagem, com vinculo entre as tabelas normalizadas.

## Replay e reconcile reais

Replay real validado:

```text
POST /admin/replay/111
previous_status: processed
resultado final: raw_event voltou para processed
duplicatas em core.messages: 0
```

Reconcile real validado em janela pequena contra Chatwoot:

```text
primeira execucao:
inserted: 10
skipped_duplicate: 2
errors: []
pages_fetched: 1
aborted: false

segunda execucao:
inserted: 0
skipped_duplicate: 12
errors: []
pages_fetched: 1
aborted: false
```

Bug encontrado durante reconcile:

- O Chatwoot retornou mensagens com `created_at` em segundos, enquanto o webhook
  real havia gravado `sent_at` com milissegundos.
- Isso criou duplicatas em `core.messages` antes da correcao.

Correcao:

- `upsertMessage` passou a deduplicar por `environment + chatwoot_message_id` antes
  de considerar `sent_at`.
- Duplicatas geradas nas conversas de teste 7/8 foram removidas mantendo a linha
  com timestamp mais preciso.
- Reprocessar os eventos sinteticos de reconcile depois da correcao nao recriou duplicatas.

## Concorrencia de worker

Teste executado contra Supabase real com `environment=test`:

```text
raw_events sinteticos: 80
workers paralelos: 2
raw.raw_events processed: 80
raw.raw_events failed: 0
duplicatas em core.messages: 0
```

Conclusao: `FOR UPDATE SKIP LOCKED` funcionou no teste real de concorrencia; dois
workers nao processaram o mesmo raw_event de forma duplicada.

## Problema encontrado: enxurrada de message_updated

A inbox API do Chatwoot reenviou muitos eventos `message_updated` da mensagem de teste
antiga. Como a inbox API nao mostrou selecao granular de eventos na tela, ela enviou
eventos demais para o shadow mode inicial.

Contagem observada:

```text
antes de apagar webhook da inbox:
pending: 1318
processed: 84

depois de apagar webhook da inbox:
pending: 1094
processed: 308

20 segundos depois:
pending: 1069
processed: 333
```

Conclusao:

- A enxurrada parou quando a URL do webhook foi removida da inbox.
- O worker esta drenando a fila.
- O problema nao e conexao; e volume/ruido operacional de `message_updated`.
- A mitigacao foi implementada e ativada com `SKIP_EVENT_TYPES=message_updated`.

## Estado atual do webhook no Chatwoot

Webhook da inbox API:

```text
http://<farejador-host>:3000/webhooks/chatwoot
```

Status: ligado para shadow mode controlado.

Protecao ativa no Farejador:

```text
SKIP_EVENT_TYPES=message_updated
```

Com isso, `message_updated` continua sendo gravado em `raw.raw_events`, mas o worker
marca como `skipped` e nao tenta normalizar esse evento ruidoso.

## Recomendacao para o proximo passo

Filtro implementado no codigo:

- Nova env var `SKIP_EVENT_TYPES` (lista CSV).
- Dispatcher (`src/normalization/dispatcher.ts`) verifica antes do switch e lanca `SkipEventError`.
- Worker ja trata `SkipEventError` marcando `processing_status='skipped'`.
- `raw.raw_events` continua sendo gravado; nada se perde da auditoria.

Proximos passos operacionais:

1. Manter o webhook ligado por um periodo curto e monitorado.
2. Acompanhar `raw.raw_events` por `pending`, `failed` e `skipped`.
3. Confirmar SSL via pooler Supabase; `DATABASE_CA_CERT` foi removido do runtime.
4. Rotacionar secrets se este relatorio for usado fora do ambiente local/controlado.
5. Criar harness de integracao automatizado com Postgres real.
6. Quando o projeto sair do shadow mode, decidir entre:
   - manter skip de `message_updated`;
   - ou trocar por dedup semantica por `(environment, message_id, content hash)`.

## Prompt para Kimi

Leia e obedeca `docs/KIMI_RULES.md`.

Leia tambem:

- `docs/PROJECT.md`
- `docs/HANDOFF.md`
- `docs/CHATWOOT_SHADOW_MODE_REPORT.md`
- `docs/tasks/F1-03-admin.md`

Tarefa proposta:

```text
Auditar o shadow mode atual do Farejador e preparar checklist operacional para
producao plena. Nao implementar sem aprovacao.

Escopo:
- Ler `docs/CHATWOOT_SHADOW_MODE_REPORT.md`, `docs/HANDOFF.md`,
  `docs/CHECKLIST.md` e `docs/phases/PHASE_01.md`.
- Considerar que replay real, reconcile real e concorrencia de worker ja foram validados.
- Confirmar apenas as ressalvas restantes: periodo de shadow mode, rotacao de
  secrets, `DATABASE_CA_CERT`, harness de integracao real, Zod permissivo e limpeza
  do caminho legado de body.
- Nao alterar migrations.
- Nao alterar contratos em `src/shared/types/chatwoot.ts`.
- Nao adicionar dependencias.
- Nao tocar em secrets.

Entrega:
- Relatorio curto do que falta para producao plena.
- Riscos operacionais.
- Ordem recomendada de validacao.
```

## Pedido para Opus

Auditar o estado antes de declarar producao plena:

```text
Contexto: Farejador ja recebe webhooks reais do Chatwoot. O HMAC oficial foi corrigido
para `timestamp.raw_body`. `SKIP_EVENT_TYPES=message_updated` esta ativo. O teste
final validou contato, conversa e mensagem normalizados e vinculados em core.*.

Pergunta: quais validacoes operacionais faltam antes de declarar producao plena?

Favor avaliar periodo de shadow mode, rotacao de secrets, `DATABASE_CA_CERT` e harness de integracao real.
```

## Riscos atuais

- Secrets foram manipulados durante configuracao manual. Antes de producao plena,
  rotacionar `CHATWOOT_API_TOKEN`, `CHATWOOT_HMAC_SECRET`, `ADMIN_AUTH_TOKEN` e senha
  do banco se necessario.
- `message_updated` esta filtrado no worker, mas ainda deve ser monitorado em volume.
- A inbox API pode nao permitir selecao granular de eventos no painel.
- Rotacao de secrets deve ser reavaliada no fork operacional.
- `DATABASE_CA_CERT` nao e mais pendencia deste runtime.

## Veredito

O projeto concluiu a Fase 1 tecnica e esta em shadow mode real e controlado. A
conexao Chatwoot -> Farejador -> Supabase esta comprovada, incluindo normalizacao
de contato, conversa e mensagem; replay, reconcile e concorrencia de worker tambem
foram validados. A Fase 2a pode comecar sem LLM, em paralelo ao monitoramento
operacional e as ressalvas de producao plena.
