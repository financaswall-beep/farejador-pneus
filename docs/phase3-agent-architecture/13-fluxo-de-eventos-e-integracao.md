# 13 - Fluxo de Eventos e Integracao

## Por que este documento existe

A arquitetura define **o que** cada camada faz: Farejador captura, Organizadora interpreta, Atendente conversa.

Falta documentar **como elas se acionam**:

- quem dispara o que;
- quando enfileirar;
- como evitar loop do proprio bot;
- como tratar cliente novo;
- como humano fecha pedido no v1;
- quem pode escrever em quais tabelas.

Sem isso, o primeiro dia de codigo trava em decisoes informais.

## Principio destacado

**Actions da LLM nunca executam direto. Toda action passa por validator + action handler.**

A LLM Atendente devolve `{ say, actions }`. O codigo:

1. valida o action (schema, permissoes, estado);
2. executa via action handler (funcao TypeScript);
3. grava no banco.

LLM nunca toca banco. Action nunca executa sem validacao.

## Timeline 1 - Mensagem incoming (cliente -> bot)

```text
1. cliente envia mensagem no WhatsApp
2. Chatwoot recebe e dispara webhook message_created
3. Farejador valida HMAC, retorna 200 rapido
4. Farejador grava raw.webhook_events (imutavel)
5. Worker normaliza e grava core.messages, atualiza core.sessions
6. Apos gravar, Farejador faz upsert em ops.enrichment_jobs
   (debounce por conversation_id, last_message_id atualizado)
7. Farejador aciona Atendente passando session_id e message_id
8. Context Builder le banco (cart_current, order_drafts, facts, etc)
9. Atendente recebe prompt, devolve `{ say, actions }`
10. Say/Action Validators validam texto e actions
11. Atendente grava `agent.turns` (idempotente por trigger_message_id)
    - se bloqueado: `say_text=NULL` e candidato preservado em `blocked_say_text`/`blocked_payload`
12. Action handler executa actions aprovadas (grava agent.cart_*, agent.order_drafts, etc)
13. Futuro Sprint 8: Atendente envia mensagem ao Chatwoot somente quando envio estiver habilitado
```

Ordem garantida: o Atendente so e acionado **depois** de `core.messages` ter a mensagem.

Sem race condition. Latencia somada e aceitavel.

Rede de seguranca: se uma mensagem publica de cliente foi gravada em
`core.messages`, mas o job em `ops.atendente_jobs` nao nasceu por falha
operacional transitoria, o reconciliador da Atendente reexecuta apenas o passo
de fila. Ele nao reprocessa `raw.*`, nao altera a mensagem normalizada e usa o
mesmo `ops.enqueue_atendente_job` idempotente do caminho principal.

## Timeline 2 - Mensagem outgoing (bot -> cliente)

```text
1. Atendente envia "Olá Fulano" via Chatwoot API
2. Chatwoot dispara webhook message_created (sender_type = bot)
3. Farejador grava raw.webhook_events e core.messages
4. Farejador NAO aciona Atendente (filtro por sender_type)
5. Farejador NAO cria job de enrichment dedicado para extrair fact
   sobre o cliente a partir desta mensagem isolada
6. Mensagem fica em core.messages para servir de contexto
   quando Organizadora processar o par "agente perguntou + cliente respondeu"
```

Filtro: `sender_type IN ('bot','agent_admin')` nao dispara Atendente.

Outgoing **e** lido pela Organizadora, mas so como contexto. Fato sobre cliente exige evidencia em mensagem do cliente.

## Timeline 3 - Worker da Organizadora

```text
1. Worker faz polling em ops.enrichment_jobs WHERE status='pending'
   AND not_before <= now()
2. Pega job, marca status='processing', lock por checkpoint
3. Le core.messages da conversa ate last_message_id
4. Le agent.pending_confirmations resolvidas para fatos confirmados
5. Chama LLM Organizadora com prompt + schema fechado de fact_keys
6. Valida output Zod (fact_keys whitelisted, evidence obrigatoria)
7. Insere em analytics.conversation_facts (append-only)
8. Insere em analytics.fact_evidence (texto literal + message_id)
9. Atualiza analytics.conversation_classifications (por dimension) e analytics.customer_journey
10. Marca job status='done', registra last_processed_message_id
```

Idempotencia: se nova mensagem chegou durante o processamento, novo job e enfileirado por upsert. Worker antigo nao reprocessa.

## ops.enrichment_jobs - granularidade e disparo

### Um job por conversa, upsert por incoming

```sql
INSERT INTO ops.enrichment_jobs (
  conversation_id, job_type, status, last_message_id, not_before
) VALUES (
  $1, 'organize_conversation', 'pending', $2, now() + interval '90 seconds'
)
ON CONFLICT (conversation_id, job_type) WHERE status IN ('pending','processing')
DO UPDATE SET
  last_message_id = EXCLUDED.last_message_id,
  not_before = now() + interval '90 seconds';
```

Regras:

- nova mensagem reseta o `not_before` (debounce);
- se job ja esta `processing`, upsert cria novo job pending para apos;
- worker so pega quando `not_before <= now()`.

### Quando processar

Worker dispara em **um dos dois eventos**:

```text
- inatividade de 60-120s na conversa
- status Chatwoot virou closed/resolved
```

Nunca por mensagem unica. Nunca em batch noturno (latencia ruim para hint).

## Idempotencia da Organizadora

Ledger e append-only. Nenhum DELETE em `analytics.*`.

Regras:

```text
mesma chave + mesmo valor + mesma evidencia + mesma versao -> no-op
mesma chave + valor diferente -> insert novo + supersede anterior
mesma chave + mesmo valor + versao nova de schema/prompt -> insert novo
reprocesso historico -> append, nunca delete
```

Constraint unica garante:

```sql
unique(session_id, fact_key, fact_value, evidence_message_id, schema_version)
```

## Locking - checkpoint, nao lock

A Organizadora processa sessao **ainda aberta** apos inatividade curta.

Nao trava conversa. Registra `last_processed_message_id` no job.

Se cliente envia nova mensagem durante processamento:

```text
- worker antigo termina com snapshot que pegou
- novo job fica pending para reprocessar daqui a 90s
- Atendente segue respondendo com facts disponiveis + ultima mensagem
```

## Cold start - cliente novo

Context Builder devolve secoes **vazias com label**, nunca crash:

```text
ESTADO DO PEDIDO AGORA
  (vazio - sessao nova)

CONTEXTO DO CLIENTE
  resumo: (cliente novo, sem historico)

FACTS CONFIRMADOS
  (nenhum)
```

Atendente aprende a tratar "sem historico" como sinal natural.

Nao injetar texto vazio sem label. Nao omitir secao (LLM passa a alucinar quando o template oscila).

## Confirmacao implicita - Atendente decide

Cenario: cliente diz "pode mandar" sem que haja `pending_confirmation` aberta.

Fluxo:

```text
Atendente devolve:
{
  "say": "Show, vou deixar separado.",
  "actions": [
    { "type": "confirm_cart_item", "cart_item_id": "abc" }
  ]
}

Validator checa:
- cart_item_id existe e pertence a session?
- status atual permite confirmacao?

Action handler executa:
- INSERT agent.cart_events (event='confirmed')
- UPDATE agent.cart_current_items (status='confirmed')
```

Sem regex de "pode mandar". A LLM percebe a nuance, codigo executa com seguranca.

## Confirmacao explicita - lexicon minimo permitido

So quando existe `agent.pending_confirmations` aberto.

Skill `resolve_pending_confirmation` aceita lexicon whitelisted:

```text
sim, isso, exato, correto, pode ser, isso mesmo, e, claro, fechou
```

Match -> resolve confirmation -> grava `analytics.conversation_facts` com `truth_type='confirmado_cliente'`.

Fora desse escopo, lexicon nao roda. Anti-padrao do doc 02 mantido.

## Correcao explicita de fato

Cliente: "na verdade e Bros 160, nao CG 160".

Atendente devolve:

```json
{
  "actions": [
    {
      "type": "correct_fact",
      "key": "moto_modelo",
      "from": "CG 160",
      "to": "Bros 160",
      "evidence_message_id": "msg-uuid"
    }
  ]
}
```

Validator checa:

- fact_key esta na whitelist do extraction-schema?
- fato antigo `from` existe na sessao?
- mensagem `evidence_message_id` pertence a sessao e e do cliente?
- valor novo passa em `value_constraints`?

Action handler executa:

```text
1. INSERT analytics.conversation_facts (Bros 160, confirmado_cliente)
2. UPDATE fato antigo (superseded_by = novo_fact_id)
3. INSERT agent.cart_events (event='replaced') se item afetado
4. UPDATE agent.cart_current
```

Determinismo total. Sem regex de "na verdade".

## Promocao carrinho -> pedido (v1)

V1 nao cria `commerce.orders` automaticamente.

Quando cliente confirma fechamento, Atendente devolve:

```json
{
  "actions": [
    { "type": "escalate_to_human", "reason": "ready_to_close" }
  ]
}
```

Action handler `escalate_to_human` executa:

```text
1. INSERT agent.escalations (status='aguardando', reason='ready_to_close')
2. Cria nota interna no Chatwoot com resumo estruturado
3. Marca conversation com label "fechamento-pendente"
```

Texto da nota interna:

```text
🛒 CARRINHO PROPOSTO - aguardando fechamento

Cliente: João da Silva
Item: Pirelli 140-70-17 x1 - R$ 180
Endereco: Rua X, Bonsucesso
Pagamento: pix

[link interno: agent.cart_current_items?conversation=...]
```

Humano abre Chatwoot, ve nota, fecha pedido manualmente no sistema da loja.

V2 ativa handler transacional `create_order` sem mudar schema.

## Escopo de leitura por camada

```text
Farejador (worker normalizacao)
  -> le: raw.*, payload do webhook
  -> escreve: core.*, ops.enrichment_jobs

Atendente
  -> le via Context Builder: core.messages, agent.*, analytics.* (consumidor)
  -> escreve: agent.* (apenas via action handler)
  -> nunca escreve: analytics.*, core.*, raw.*, commerce.*

Organizadora (worker)
  -> le: core.messages, agent.pending_confirmations resolvidas
  -> escreve: analytics.*
  -> nao depende de agent.* para interpretar (so confirmacoes para reforco)

Skills/handlers transacionais
  -> escrevem em commerce.* (so v2+)
```

## Filtros importantes

```text
1. webhook outgoing/bot -> nao dispara Atendente
2. enrichment job -> debounce, um por conversa
3. fact sobre cliente -> exige evidence em mensagem do cliente (sender_type='customer')
4. correct_fact action -> evidence_message_id deve ser do cliente
5. escalate_to_human -> nao executa duas vezes para mesma conversa em mesmo estado
```

## Idempotencia do Atendente

`agent.turns` tem unique:

```text
unique(environment, trigger_message_id, agent_version)
```

Webhook duplicado nao gera duas respostas.

Se LLM falha e retry roda, mesmo trigger_message_id retorna o turno ja registrado.

## Resumo das 10 decisoes

```text
1. ops.enrichment_jobs: 1 job por conversa, upsert por incoming
2. Disparo: 60-120s inatividade OR status=closed
3. Idempotencia: append-only, no-op se chave+valor+evidencia iguais
4. Locking: checkpoint last_message_id, sem lock real
5. Confirmacao implicita: Atendente decide via action, action handler executa
6. Confirmacao explicita: lexicon minimo so com pending_confirmation aberto
7. Correcao de fato: Atendente devolve correct_fact, skill superseder
8. Outgoing do bot: entra em core.messages, nao dispara Atendente,
   serve de contexto pra Organizadora interpretar proxima incoming
9. Cold start: Context Builder devolve secoes vazias com label
10. v1: humano fecha pedido via escalacao no Chatwoot com nota estruturada
```

## Anti-padroes

- regex/lexical para detectar correcao ("na verdade...");
- regex livre fora de pending_confirmation;
- LLM Atendente escrevendo direto no banco;
- action executando sem validator;
- delete em `analytics.*`;
- enrichment por mensagem (cria fila gigante);
- batch noturno (latencia mata o hint para conversa logo a seguir);
- tabela `conversation_hints` (resumo e on-demand do Context Builder).
