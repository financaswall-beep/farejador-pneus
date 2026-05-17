# Guia das Tabelas do Farejador

Atualizado: 2026-05-15. Tabelas novas ou colunas adicionadas desde 25/04: `analytics.fact_evidence` (migration 0018), `agent.session_items`/`session_slots` (0024 estado reentrante), `agent.turns.blocked_say_text`/`blocked_actions`/`blocked_payload` (0028 PR1), `agent.cart_events.event_type='updated'` (0029 PR3), `analytics_marts.*` schema completo (0023). Migrations 0022-0030 estao aplicadas no banco mas o historico Supabase CLI registra ate 0021 — divida operacional a reconciliar (ver ADR-008).

**Adicoes 2026-05-15 (sem migration, mudancas no payload JSON):**
- `agent.session_events.event_payload` (event_type=`generator_produced`) agora carrega:
  - `claims` (array de objetos, Etapa 2 do ADR-009): cada item tem `type`
    (`price` | `stock_availability` | `fitment` | `delivery_fee`) + campos
    especificos (amount, product_id, vehicle_hint conforme o tipo).
  - `claims_count` (int, denormalizado pra query rapida).
  - `claim_types` (array de strings, ex.: `[price, stock_availability]`).
  - `prompt_version` agora vem do `parsed.data.prompt_version` real
    (`generator_v1.4.0` ou `generator_v1.5.0` quando flag ligada), nao mais da
    constante fixa (fix commit `6f7e7c5`).
- `agent.turns.blocked_payload` carrega `claims` no mesmo formato para
  auditar o que o Generator tentou afirmar mesmo quando o turno foi bloqueado.
- `agent.escalations` passou a receber linhas reais quando `Planner.skill=escalar_humano`
  (B5, commit `9888bd7`). Antes ficava sempre vazia (audit 1.1); em 2026-05-15
  ja tem 5 linhas em prod com `reason` derivado de `risk_flags`/confidence.

Este documento foi escrito para estudar o sistema sem precisar entender SQL.

A ideia e simples: cada tabela e como uma planilha organizada. Cada linha guarda
um acontecimento, uma pessoa, uma conversa, uma mensagem ou uma analise futura.

## Como pensar no banco

O Farejador separa os dados em quatro "andares":

| Andar | Nome tecnico | Explicacao simples |
| --- | --- | --- |
| Entrada bruta | `raw` | Guarda exatamente o que chegou do Chatwoot, sem mexer. |
| Dados organizados | `core` | Transforma o bruto em contatos, conversas, mensagens, anexos etc. |
| Relatorios inteligentes | `analytics` | Vai guardar metricas, classificacoes e sinais de negocio. |
| Controle do sistema | `ops` | Guarda filas, logs, snapshots e tarefas operacionais. |

Pense assim:

```text
Chatwoot manda evento
        |
        v
raw guarda o evento bruto
        |
        v
core organiza em tabelas de negocio
        |
        v
analytics gera relatorios e inteligencia
        |
        v
ops controla jobs, replay, LGPD e operacao
```

## Campo comum: `environment`

Quase toda tabela tem o campo `environment`.

Ele diz se o dado e:

- `prod`: dado real de producao;
- `test`: dado de teste.

Isso existe para impedir uma besteira perigosa: misturar conversa real de cliente
com conversa de teste.

---

# 1. Tabelas de entrada bruta (`raw`)

Estas tabelas sao a memoria original do sistema.

Elas respondem:

- "O Chatwoot mandou esse evento mesmo?"
- "Quando chegou?"
- "Ja recebemos esse webhook antes?"
- "Da para reprocessar esse evento?"

## `raw.delivery_seen`

### Em portugues simples

Essa tabela e o porteiro anti-duplicata.

Antes de aceitar um webhook, o Farejador pergunta:

> "Esse ID de entrega do Chatwoot ja passou por aqui?"

Se ja passou, o sistema nao grava tudo de novo.

### Por que ela existe

O Chatwoot pode reenviar o mesmo webhook quando acha que houve falha, timeout ou
retry. Sem essa tabela, o banco poderia receber mensagens duplicadas.

### Campos principais

| Campo | O que significa |
| --- | --- |
| `environment` | Se o evento e de producao ou teste. |
| `chatwoot_delivery_id` | O ID unico da entrega do webhook. E a chave para saber se e duplicado. |
| `first_seen_at` | Quando esse webhook apareceu pela primeira vez. |
| `raw_event_id` | Link informativo para o evento bruto gravado em `raw.raw_events`. |

### Que relatorios/controles ela permite

- Quantos webhooks duplicados o Chatwoot reenviou.
- Se o sistema esta protegendo bem contra retry.
- Auditoria de "esse evento ja tinha chegado antes?".

## `raw.raw_events`

### Em portugues simples

Essa e a caixa-preta do Farejador.

Ela guarda o evento bruto que veio do Chatwoot, praticamente como chegou.

Se um dia algo der errado na normalizacao, podemos voltar aqui e dizer:

> "Vamos reprocessar esse evento original."

### Por que ela existe

Porque o dado bruto e a fonte da verdade. Mesmo que um mapper tenha bug ou uma
tabela `core` fique errada, o evento original continua guardado.

### Campos principais

| Campo | O que significa |
| --- | --- |
| `id` | Numero interno do evento bruto. |
| `environment` | Producao ou teste. |
| `chatwoot_delivery_id` | ID de entrega enviado pelo Chatwoot. |
| `chatwoot_signature` | Assinatura HMAC recebida. Serve para auditoria. |
| `chatwoot_timestamp` | Hora em que o Chatwoot disse que enviou o evento. |
| `received_at` | Hora em que o Farejador recebeu o evento. |
| `event_type` | Tipo do evento: mensagem criada, conversa atualizada, contato criado etc. |
| `account_id` | ID da conta Chatwoot. |
| `payload` | O JSON bruto do Chatwoot. Aqui esta o corpo original. |
| `processing_status` | Estado da normalizacao: pendente, processado, falhou ou ignorado. |
| `processed_at` | Quando o worker tentou/processou o evento. |
| `processing_error` | Erro registrado se a normalizacao falhou. |

### Estados de processamento

| Status | Explicacao simples |
| --- | --- |
| `pending` | Chegou, mas ainda nao foi transformado em tabelas organizadas. |
| `processed` | Foi transformado com sucesso em `core.*`. |
| `failed` | Deu erro ao processar. Pode ser reprocessado depois. |
| `skipped` | O sistema decidiu ignorar, normalmente por evento desconhecido. |

### Que relatorios/controles ela permite

- Quantos webhooks chegaram por dia.
- Quais tipos de eventos mais aparecem.
- Quantos eventos falharam.
- Quanto tempo demora entre chegada e processamento.
- Replay/reprocessamento de eventos com erro.

---

# 2. Tabelas organizadas do negocio (`core`)

Estas tabelas sao o coracao operacional.

Elas transformam o JSON bruto em coisas que uma pessoa entende:

- contato;
- conversa;
- mensagem;
- anexo;
- etiqueta;
- mudanca de status;
- atribuicao de agente.

Regra importante: `core` nao interpreta. Ele nao decide se vendeu, se perdeu, se o
cliente esta bravo, se e oportunidade boa. Ele so organiza o que aconteceu.

## `core.contacts`

### Em portugues simples

Essa tabela guarda os clientes/contatos que aparecem no Chatwoot.

Cada linha e uma pessoa ou contato.

### Exemplo

Um cliente chama no WhatsApp. O Chatwoot tem um ID para esse contato. O Farejador
cria/atualiza uma linha aqui.

### Campos principais

| Campo | O que significa |
| --- | --- |
| `id` | ID interno do contato dentro do Farejador. |
| `environment` | Producao ou teste. |
| `chatwoot_contact_id` | ID do contato no Chatwoot. |
| `name` | Nome do cliente, se existir. |
| `phone_e164` | Telefone do cliente em formato padrao. |
| `email` | Email do cliente. |
| `identifier` | Identificador externo/customizado. |
| `channel_type` | Canal relacionado: WhatsApp, Instagram, Facebook, web etc. |
| `country` | Pais do contato, se vier. |
| `city` | Cidade do contato, se vier. |
| `custom_attributes` | Campos customizados do Chatwoot. |
| `first_seen_at` | Primeira vez em que vimos esse contato. |
| `last_seen_at` | Ultima vez em que vimos esse contato. |
| `created_at` | Quando a linha foi criada no Farejador. |
| `updated_at` | Quando a linha foi atualizada. |
| `deleted_at` | Quando o contato foi apagado/anonimizado por LGPD. |
| `last_event_at` | Hora do ultimo evento que atualizou esse contato. Protege contra evento velho sobrescrever novo. |

### Que relatorios isso permite

Agora ou futuramente:

- Quantos contatos novos chegaram por dia.
- Quantos clientes voltam mais de uma vez.
- Quais canais trazem mais contatos.
- Quais cidades aparecem mais.
- Base para jornada do cliente.
- Base para LGPD/anonimizacao.

## `core.conversations`

### Em portugues simples

Essa tabela guarda as conversas do Chatwoot.

Cada linha e uma conversa, nao uma mensagem.

Uma conversa pode ter varias mensagens, tags, status e agentes envolvidos.

### Exemplo

Cliente pergunta "tem pneu 100/80-18?". Isso abre uma conversa. Toda a conversa
fica representada aqui, e as mensagens ficam em `core.messages`.

### Campos principais

| Campo | O que significa |
| --- | --- |
| `id` | ID interno da conversa no Farejador. |
| `environment` | Producao ou teste. |
| `chatwoot_conversation_id` | ID da conversa no Chatwoot. |
| `chatwoot_account_id` | ID da conta Chatwoot. |
| `chatwoot_inbox_id` | ID da inbox/canal no Chatwoot. |
| `channel_type` | Canal: WhatsApp, Instagram, Facebook, web etc. |
| `contact_id` | Link para o contato em `core.contacts`. |
| `current_status` | Status atual: aberta, resolvida, pendente ou snoozed. |
| `current_assignee_id` | Agente atual responsavel. |
| `current_team_id` | Time atual responsavel. |
| `priority` | Prioridade da conversa. |
| `started_at` | Quando a conversa comecou. |
| `first_reply_at` | Quando houve a primeira resposta do agente. |
| `last_activity_at` | Ultima atividade da conversa. |
| `resolved_at` | Quando a conversa foi resolvida. |
| `waiting_since` | Desde quando esta aguardando. |
| `message_count_cache` | Contador de mensagens para acelerar consulta. |
| `additional_attributes` | Dados extras do Chatwoot. |
| `custom_attributes` | Campos customizados do Chatwoot. |
| `created_at` | Quando a linha foi criada. |
| `updated_at` | Quando foi atualizada. |
| `deleted_at` | Soft-delete. |
| `last_event_at` | Ultimo evento que atualizou a conversa. |

### Que relatorios isso permite

Agora ou futuramente:

- Quantas conversas entram por dia.
- Quantas estao abertas, pendentes ou resolvidas.
- Tempo medio ate resolver.
- Tempo ate primeira resposta.
- Conversas por canal.
- Conversas por agente/time.
- Conversas com prioridade alta.
- Base para funil comercial.

## `core.messages`

### Em portugues simples

Essa tabela guarda cada mensagem enviada ou recebida.

Cada linha e uma mensagem.

Essa tende a ser uma das tabelas mais importantes do sistema, porque e nela que
esta o texto que depois pode gerar analises.

### Exemplo

Cliente: "Bom dia, tem pneu 90/90-18?"

Essa frase vira uma linha em `core.messages`.

### Campos principais

| Campo | O que significa |
| --- | --- |
| `id` | ID interno da mensagem. |
| `environment` | Producao ou teste. |
| `chatwoot_message_id` | ID da mensagem no Chatwoot. |
| `conversation_id` | Link para a conversa no Farejador. |
| `chatwoot_conversation_id` | ID da conversa no Chatwoot. |
| `sender_type` | Quem enviou: contato, usuario/agente, bot ou sistema. |
| `sender_id` | ID de quem enviou, se conhecido. |
| `message_type` | Codigo do tipo da mensagem no Chatwoot. |
| `message_type_name` | Nome legivel do tipo: incoming, outgoing, activity, template. |
| `content` | Texto da mensagem. |
| `content_type` | Tipo de conteudo: texto, card, formulario etc. |
| `content_attributes` | Metadados extras da mensagem. |
| `is_private` | Se e nota interna. Importante: nao usar em dataset de treino. |
| `status` | Status da mensagem: enviada, entregue, lida, falha etc. |
| `external_source_ids` | IDs externos, como IDs do WhatsApp/Meta. |
| `echo_id` | Campo usado pelo Chatwoot para dedup em alguns casos. |
| `sent_at` | Quando a mensagem foi enviada/criada. |
| `created_at` | Quando entrou no Farejador. |
| `deleted_at` | Soft-delete da mensagem. |
| `last_event_at` | Ultimo evento que atualizou essa mensagem. |

### Que relatorios isso permite

Agora ou futuramente:

- Quantidade de mensagens por conversa.
- Quantas mensagens o cliente mandou antes de comprar/desistir.
- Tempo medio de resposta.
- Palavras mais frequentes.
- Perguntas mais comuns.
- Produtos mais pedidos.
- Deteccao futura de intencao de compra.
- Deteccao futura de reclamacao de preco.
- Base para classificacao por LLM na Fase 2b.

### Cuidado

`content` pode conter dados pessoais. Deve ser tratado como sensivel.

## `core.message_attachments`

### Em portugues simples

Essa tabela guarda anexos das mensagens.

Ela nao guarda o arquivo em si. Guarda metadados e URLs de referencia.

### Exemplo

Cliente manda foto do pneu, audio ou localizacao. O anexo aparece aqui.

### Campos principais

| Campo | O que significa |
| --- | --- |
| `id` | ID interno do anexo. |
| `environment` | Producao ou teste. |
| `chatwoot_attachment_id` | ID do anexo no Chatwoot. |
| `message_id` | Mensagem a qual o anexo pertence. |
| `conversation_id` | Conversa a qual o anexo pertence. |
| `file_type` | Tipo: imagem, audio, video, arquivo, localizacao etc. |
| `mime_type` | Tipo tecnico do arquivo, como `image/jpeg` ou `audio/ogg`. |
| `file_size_bytes` | Tamanho do arquivo. |
| `duration_ms` | Duracao, para audio/video. |
| `width` | Largura, para imagem/video. |
| `height` | Altura, para imagem/video. |
| `data_url` | URL original do arquivo no Chatwoot. Pode expirar. |
| `thumb_url` | URL da miniatura. |
| `coordinates_lat` | Latitude, se for localizacao. |
| `coordinates_lng` | Longitude, se for localizacao. |
| `transcription_available` | Se ja existe transcricao futura disponivel. |
| `created_at` | Quando a linha foi criada. |

### Que relatorios isso permite

Agora ou futuramente:

- Quantas conversas usam audio.
- Quantos clientes mandam foto.
- Quais canais tem mais midia.
- Separar conversas que precisam de transcricao.
- Futuramente medir impacto de audio em conversao.
- Futuramente ligar transcricao em `analytics.*`.

## `core.conversation_tags`

### Em portugues simples

Essa tabela guarda etiquetas/labels aplicadas nas conversas.

Tags sao como marcadores.

### Exemplo

Uma conversa pode receber tags como:

- `orcamento`
- `pedido_cancelado`
- `oferta_enviada`
- `suporte`

### Campos principais

| Campo | O que significa |
| --- | --- |
| `environment` | Producao ou teste. |
| `conversation_id` | Conversa marcada. |
| `label` | Nome da etiqueta. |
| `added_at` | Quando a etiqueta foi observada. |
| `added_by_type` | Quem adicionou: usuario, sistema, automacao etc. |

### Que relatorios isso permite

Agora ou futuramente:

- Conversas por etiqueta.
- Quantas conversas chegaram a "oferta enviada".
- Quantas conversas viraram "pedido cancelado".
- Funil baseado em tags.
- Comparar tags manuais com classificacoes futuras.

## `core.conversation_status_events`

### Em portugues simples

Essa tabela guarda o historico das mudancas importantes da conversa.

Enquanto `core.conversations` mostra o status atual, esta tabela mostra o caminho.

### Exemplo

Uma conversa pode passar por:

```text
open -> pending -> resolved
```

Cada mudanca pode virar uma linha aqui.

### Campos principais

| Campo | O que significa |
| --- | --- |
| `id` | ID interno do evento. |
| `environment` | Producao ou teste. |
| `conversation_id` | Conversa afetada. |
| `chatwoot_conversation_id` | ID da conversa no Chatwoot. |
| `event_type` | Tipo de mudanca: status, label, atribuicao, time, prioridade. |
| `from_value` | Valor antigo. |
| `to_value` | Valor novo. |
| `changed_by_id` | Quem mudou, se conhecido. |
| `changed_by_type` | Tipo de autor: usuario, automacao, API etc. |
| `occurred_at` | Quando aconteceu. |
| `raw_event_id` | Evento bruto que originou essa linha. |
| `created_at` | Quando foi gravado no Farejador. |

### Que relatorios isso permite

Agora ou futuramente:

- Quanto tempo a conversa ficou aberta.
- Quantas vezes mudou de status.
- Quantas conversas foram resolvidas.
- Gargalos de atendimento.
- Funil por transicao.
- Auditoria de quem mudou status ou prioridade.

## `core.conversation_assignments`

### Em portugues simples

Essa tabela guarda quem pegou a conversa e quando.

Ela ajuda a medir handoff: quando uma conversa passa de bot para humano, de um
agente para outro, ou de um time para outro.

### Campos principais

| Campo | O que significa |
| --- | --- |
| `id` | ID interno da atribuicao. |
| `environment` | Producao ou teste. |
| `conversation_id` | Conversa atribuida. |
| `agent_id` | Agente que recebeu a conversa. |
| `team_id` | Time responsavel. |
| `assigned_at` | Quando foi atribuida. |
| `unassigned_at` | Quando deixou de estar atribuida. |
| `duration_seconds` | Tempo de duracao da atribuicao, calculado automaticamente. |
| `handoff_number` | Numero do handoff: primeiro, segundo, terceiro etc. |

### Que relatorios isso permite

Agora ou futuramente:

- Quantas conversas cada agente pegou.
- Tempo medio com cada agente.
- Quantos handoffs acontecem antes de resolver.
- Se muitas transferencias atrapalham conversao.
- Carga por time.

## `core.message_reactions`

### Em portugues simples

Essa tabela guarda reacoes/emojis em mensagens.

Hoje ela existe no schema, mas na F1-02 o mapper ainda e placeholder porque os
fixtures principais nao tinham reaction real.

### Campos principais

| Campo | O que significa |
| --- | --- |
| `id` | ID interno da reacao. |
| `environment` | Producao ou teste. |
| `message_id` | Mensagem reagida. |
| `reactor_type` | Quem reagiu: contato ou agente. |
| `reactor_id` | ID de quem reagiu. |
| `emoji` | Emoji/reacao. |
| `reacted_at` | Quando reagiu. |
| `removed_at` | Quando removeu a reacao. |

### Que relatorios isso permite

Futuramente:

- Reacoes positivas/negativas em mensagens.
- Engajamento do cliente.
- Sinais de satisfacao.
- Mensagens que geram mais resposta/reacao.

---

# 3. Tabelas de relatorios inteligentes (`analytics`)

Essas tabelas comecam a ser usadas na Fase 2a.

Aqui entram os dados que nao vieram diretamente do Chatwoot, mas foram calculados,
extraidos ou interpretados.

Exemplos:

- "O cliente pediu pneu 90/90-18."
- "A conversa chegou ate a etapa de orcamento."
- "O motivo de perda foi preco."
- "O cliente demonstrou urgencia."

## `analytics.conversation_facts`

### Em portugues simples

Essa tabela guarda fatos extraidos da conversa.

Um fato e uma informacao importante encontrada no texto ou em algum campo.

### Exemplos de fatos

| Fato | Exemplo |
| --- | --- |
| Produto pedido | pneu 100/80-18 |
| Marca citada | Maggion |
| Preco cotado | R$ 450 |
| Forma de pagamento | Pix |
| Bairro citado | Bras de Pina |
| Motivo mencionado | "achei caro" |

### Campos principais

| Campo | O que significa |
| --- | --- |
| `id` | ID interno do fato. |
| `environment` | Producao ou teste. |
| `conversation_id` | Conversa onde o fato apareceu. |
| `fact_key` | Nome do fato, como `product_asked` ou `price_quoted`. |
| `fact_value` | Valor do fato em JSON. |
| `observed_at` | Quando o fato apareceu. |
| `message_id` | Mensagem onde o fato apareceu. |
| `truth_type` | Se foi observado, inferido, previsto ou corrigido. |
| `source` | Quem gerou: regex, LLM, humano, atributo Chatwoot etc. |
| `confidence_level` | Confianca de 0 a 1. |
| `extractor_version` | Versao da regra, prompt ou extrator. |
| `superseded_by` | Se esse fato foi corrigido por outro. |
| `created_at` | Quando foi criado. |

### Que relatorios isso vai permitir

Futuramente:

- Produtos mais pedidos.
- Medidas de pneu mais procuradas.
- Marcas mais citadas.
- Precos mais cotados.
- Regioes/bairros com mais demanda.
- Formas de pagamento mais mencionadas.
- Motivos mais comuns de duvida ou objecao.

## `analytics.conversation_signals`

### Em portugues simples

Essa tabela guarda metricas calculadas da conversa.

Ela nao tenta "entender" o texto. Ela mede numeros.

### Exemplos de sinais

- Quantas mensagens teve.
- Quanto tempo demorou para responder.
- Quanto tempo a conversa durou.
- Quantas vezes mudou de agente.
- Se teve muita midia.

### Campos principais

| Campo | O que significa |
| --- | --- |
| `conversation_id` | Conversa analisada. |
| `environment` | Producao ou teste. |
| `total_messages` | Total de mensagens. |
| `contact_messages` | Mensagens do cliente. |
| `agent_messages` | Mensagens do agente. |
| `bot_messages` | Mensagens do bot. |
| `media_message_count` | Quantidade de mensagens com midia. |
| `media_text_ratio` | Proporcao entre midia e texto. |
| `first_response_seconds` | Tempo ate primeira resposta. |
| `avg_agent_response_sec` | Tempo medio de resposta do agente. |
| `max_gap_seconds` | Maior intervalo parado na conversa. |
| `total_duration_seconds` | Duracao total da conversa. |
| `handoff_count` | Quantidade de handoffs. |
| `started_hour_local` | Hora local em que comecou. |
| `started_dow_local` | Dia da semana local. |
| `computed_at` | Quando foi calculado. |
| `extractor_version` | Versao do calculo. |
| `source` | Origem, normalmente SQL. |
| `truth_type` | Tipo de verdade, normalmente observado. |
| `confidence_level` | Confianca, normalmente 1.00. |

### Que relatorios isso vai permitir

Futuramente:

- Tempo medio de resposta.
- Conversas mais longas.
- Conversas com maior abandono.
- Horarios de maior volume.
- Dias da semana com mais demanda.
- Quantidade de mensagens antes de resolver.
- Relacao entre demora e perda de venda.

## `analytics.conversation_classifications`

### Em portugues simples

Essa tabela guarda classificacoes de negocio da conversa.

Aqui entra o tipo de coisa que exige interpretacao.

### Exemplos

| Dimensao | Possiveis valores futuros |
| --- | --- |
| `stage_reached` | perguntou preco, recebeu oferta, negociou, fechou |
| `final_outcome` | venda, perda, sem resposta, suporte |
| `loss_reason` | preco, falta de estoque, prazo, concorrente |
| `buyer_intent` | baixo, medio, alto |
| `customer_type` | novo, recorrente, curioso |
| `urgency` | baixa, media, alta |

### Campos principais

| Campo | O que significa |
| --- | --- |
| `id` | ID interno da classificacao. |
| `environment` | Producao ou teste. |
| `conversation_id` | Conversa classificada. |
| `dimension` | Qual aspecto esta sendo classificado. |
| `value` | Valor escolhido para essa classificacao. |
| `truth_type` | Observado, inferido, previsto ou corrigido. |
| `source` | Quem classificou: regra, LLM, humano etc. |
| `confidence_level` | Confianca de 0 a 1. |
| `extractor_version` | Versao do classificador. |
| `notes` | Observacoes. |
| `created_at` | Quando foi criada. |

### Que relatorios isso vai permitir

Futuramente:

- Taxa de conversao por etapa.
- Principais motivos de perda.
- Conversas com alta intencao de compra.
- Quantas vendas foram perdidas por preco.
- Quantas foram perdidas por falta de estoque.
- Comparar desempenho por canal, agente ou horario.

## `analytics.customer_journey`

### Em portugues simples

Essa tabela resume a jornada de cada cliente.

Em vez de olhar conversa por conversa, ela olha o contato ao longo do tempo.

### Campos principais

| Campo | O que significa |
| --- | --- |
| `contact_id` | Cliente/contato analisado. |
| `environment` | Producao ou teste. |
| `total_conversations` | Quantas conversas esse contato teve. |
| `first_conversation_at` | Primeira conversa registrada. |
| `last_conversation_at` | Ultima conversa registrada. |
| `is_returning` | Se e cliente recorrente. |
| `days_since_first` | Dias desde a primeira conversa. |
| `purchase_count` | Quantidade futura de compras via ERP. |
| `partial_ltv_brl` | Valor financeiro acumulado futuro. |
| `last_channel` | Ultimo canal usado. |
| `channel_migration_count` | Quantas vezes mudou de canal. |
| `computed_at` | Quando foi calculado. |
| `extractor_version` | Versao do calculo. |
| `source` | Origem. |
| `truth_type` | Normalmente inferido. |
| `confidence_level` | Confianca. |

### Que relatorios isso vai permitir

Futuramente:

- Clientes recorrentes.
- Clientes que voltaram depois de muitos dias.
- Valor aproximado por cliente.
- Canal preferido do cliente.
- Clientes que migram de Instagram para WhatsApp.
- Base para segmentacao e campanhas.

## `analytics.linguistic_hints`

### Em portugues simples

Essa tabela guarda pistas de linguagem encontradas nas mensagens.

Nao e uma classificacao completa. E um sinal.

### Exemplos de pistas

- "ta caro" -> reclamacao de preco.
- "preciso hoje" -> urgencia.
- "vi mais barato em outro lugar" -> concorrente/preco.
- "???" ou repeticao -> possivel abandono ou ansiedade.

### Campos principais

| Campo | O que significa |
| --- | --- |
| `id` | ID interno da pista. |
| `environment` | Producao ou teste. |
| `conversation_id` | Conversa onde apareceu. |
| `message_id` | Mensagem especifica. |
| `hint_type` | Tipo da pista: preco, urgencia, abandono, concorrente etc. |
| `matched_text` | Texto que bateu na regra. |
| `pattern_id` | Regra que encontrou a pista. |
| `truth_type` | Normalmente observado. |
| `source` | Regex ou heuristica usada. |
| `confidence_level` | Confianca. |
| `extractor_version` | Versao da regra. |
| `created_at` | Quando foi criada. |

### Que relatorios isso vai permitir

Futuramente:

- Quantas conversas reclamam de preco.
- Quantas mostram urgencia.
- Concorrentes mais citados.
- Palavras/frases que aparecem antes de perda.
- Sinais textuais que indicam maior chance de compra.

---

# 4. Tabelas operacionais (`ops`)

Estas tabelas ajudam o sistema a operar.

Algumas ja sao uteis na Fase 1. Outras ficam preparadas para fases futuras.

## `ops.stock_snapshots`

### Em portugues simples

Essa tabela vai guardar uma foto do estoque/preco no momento em que o cliente
perguntou.

Ela ainda e futura.

### Exemplo

Cliente perguntou hoje:

> "Quanto esta o pneu X?"

O sistema consulta o ERP e grava:

- preco naquele momento;
- estoque naquele momento;
- promocao naquele momento.

Meses depois, mesmo que o preco mude, ainda sabemos qual era o preco na hora da conversa.

### Campos principais

| Campo | O que significa |
| --- | --- |
| `id` | ID interno do snapshot. |
| `environment` | Producao ou teste. |
| `conversation_id` | Conversa relacionada. |
| `message_id` | Mensagem da pergunta. |
| `sku` | Codigo do produto. |
| `product_name` | Nome do produto. |
| `tire_size` | Medida do pneu. |
| `brand` | Marca. |
| `stock_qty` | Quantidade em estoque. |
| `price_brl` | Preco normal. |
| `promo_price_brl` | Preco promocional. |
| `snapshot_at` | Quando o ERP foi consultado. |
| `erp_source` | Qual sistema informou o dado. |
| `raw_payload` | Resposta bruta do ERP. |

### Que relatorios isso vai permitir

Futuramente:

- Vendas perdidas por falta de estoque.
- Produtos mais perguntados.
- Precos cotados no momento da conversa.
- Impacto de promocao na conversao.
- Historico de preco por conversa.

## `ops.enrichment_jobs`

### Em portugues simples

Essa tabela e uma fila de tarefas para trabalhadores de fundo.

Ela responde:

> "O que o sistema ainda precisa processar depois?"

Na Fase 1 ela nao deve ser populada.

### Exemplos de tarefas futuras

- Transcrever audio.
- Fazer OCR de imagem.
- Classificar conversa com LLM.
- Extrair fatos da conversa.
- Buscar preco no ERP.

### Campos principais

| Campo | O que significa |
| --- | --- |
| `id` | ID interno do job. |
| `environment` | Producao ou teste. |
| `job_type` | Tipo do trabalho. |
| `target_type` | O que sera processado: mensagem, conversa ou anexo. |
| `target_id` | ID do alvo. |
| `status` | Estado: na fila, rodando, concluido, falhou ou ignorado. |
| `priority` | Prioridade do job. |
| `attempts` | Quantas vezes tentou rodar. |
| `last_error` | Ultimo erro. |
| `scheduled_at` | Quando pode rodar. |
| `started_at` | Quando comecou. |
| `completed_at` | Quando terminou. |
| `result_ref` | Onde ficou o resultado. |
| `worker_id` | Worker que pegou o job. |
| `created_at` | Quando o job foi criado. |

### Que relatorios/controles isso vai permitir

Futuramente:

- Quantos jobs estao pendentes.
- Quantas transcricoes falharam.
- Custo/volume de chamadas LLM.
- Tempo medio de processamento.
- Backlog por tipo de tarefa.

## `ops.bot_events`

### Em portugues simples

Essa tabela vai guardar eventos do futuro agente conversacional.

Na Fase 1 ela fica vazia.

### Exemplos

- O agente chamou uma ferramenta.
- O agente recebeu resultado de uma ferramenta.
- O agente falhou.
- O agente chamou um humano.

### Campos principais

| Campo | O que significa |
| --- | --- |
| `id` | ID interno do evento. |
| `environment` | Producao ou teste. |
| `conversation_id` | Conversa relacionada. |
| `message_id` | Mensagem relacionada. |
| `event_type` | Tipo: chamada de ferramenta, erro, fallback, handoff etc. |
| `tool_name` | Nome da ferramenta chamada. |
| `tool_input` | Entrada enviada para a ferramenta. |
| `tool_output` | Resultado da ferramenta. |
| `latency_ms` | Tempo gasto. |
| `error_message` | Erro, se houver. |
| `occurred_at` | Quando aconteceu. |
| `created_at` | Quando foi gravado. |

### Que relatorios isso vai permitir

Futuramente:

- Quantas vezes o bot errou.
- Ferramentas mais usadas.
- Tempo medio das ferramentas.
- Motivos de handoff para humano.
- Qualidade operacional do agente.

## `ops.erasure_log`

### Em portugues simples

Essa tabela guarda o historico de apagamento/anonimizacao LGPD.

Quando um cliente pede para apagar dados pessoais, o sistema precisa registrar:

- quem pediu;
- o que foi apagado;
- quando foi feito;
- quem executou.

### Campos principais

| Campo | O que significa |
| --- | --- |
| `id` | ID interno do log. |
| `environment` | Producao ou teste. |
| `contact_id` | Contato afetado. |
| `chatwoot_contact_id` | ID do contato no Chatwoot. |
| `requested_by` | Quem solicitou. |
| `reason` | Motivo. |
| `fields_anonymized` | Campos anonimizados. |
| `executed_at` | Quando foi executado. |
| `executed_by` | Quem executou. |
| `notes` | Observacoes. |

### Que relatorios/controles isso permite

- Auditoria LGPD.
- Quantas solicitacoes de apagamento aconteceram.
- Quem executou cada acao.
- Quais campos foram anonimizados.

---

# Funcoes importantes

## `ops.anonymize_contact`

### Em portugues simples

Funcao que anonimiza um contato.

Ela limpa dados pessoais em `core.contacts` e registra o ato em `ops.erasure_log`.

### O que ela apaga

- nome;
- telefone;
- email;
- identificador;
- atributos customizados.

## `ops.ensure_monthly_partitions`

### Em portugues simples

Funcao que cria novas "gavetas mensais" para tabelas grandes.

Hoje isso vale para:

- `raw.raw_events`;
- `core.messages`.

Essas tabelas crescem muito, entao sao separadas por mes.

---

# Relatorios futuros que esse banco prepara

## Relatorios operacionais

- Webhooks recebidos por dia.
- Eventos com erro.
- Tempo entre receber webhook e processar.
- Conversas abertas, pendentes e resolvidas.
- Tempo medio de primeira resposta.
- Tempo medio de resolucao.
- Conversas por canal.
- Conversas por agente.

## Relatorios comerciais

- Produtos mais perguntados.
- Medidas de pneu mais procuradas.
- Marcas mais citadas.
- Cotacoes por periodo.
- Conversas que chegaram ate oferta.
- Motivos de perda.
- Conversas com maior intencao de compra.
- Impacto de demora na conversao.

## Relatorios de atendimento

- Volume por agente.
- Handoffs por conversa.
- Tempo com cada agente.
- Mensagens antes de resolver.
- Conversas com reclamacao de preco.
- Conversas com urgencia.
- Clientes que mandam audio/foto.

## Relatorios de cliente

- Clientes recorrentes.
- Clientes novos por canal.
- Jornada do cliente.
- Mudanca de canal, por exemplo Instagram -> WhatsApp.
- Futuro valor por cliente via ERP.

## Relatorios de qualidade e IA

- Quantidade de jobs LLM/transcricao.
- Falhas de jobs.
- Classificacoes corrigidas.
- Confianca das classificacoes.
- Comparacao entre regra deterministica e LLM.

---

# Ordem recomendada para estudar

1. `raw.delivery_seen`
2. `raw.raw_events`
3. `core.contacts`
4. `core.conversations`
5. `core.messages`
6. `core.message_attachments`
7. `core.conversation_tags`
8. `core.conversation_status_events`
9. `core.conversation_assignments`
10. `analytics.conversation_signals`
11. `analytics.conversation_facts`
12. `analytics.conversation_classifications`
13. `ops.enrichment_jobs`
14. `ops.erasure_log`

Se voce entender estas tres frases, entendeu a espinha dorsal:

```text
raw guarda o que chegou.
core organiza o que aconteceu.
analytics explica o que isso significa.
```

---

# Adicoes da Fase 3 (Agente Conversacional)

Atualizado: 27/04/2026

A Fase 3 adiciona dois novos andares ao banco:

| Andar | Schema | Explicacao simples |
| --- | --- | --- |
| Estado vivo do agente | `agent` | Carrinho atual, rascunho do pedido, pergunta pendente. Tudo que o agente esta fazendo agora. |
| Catalogo da loja | `commerce` | Produtos, fitments, estoque, precos, pedidos confirmados. |

E acrescenta uma nova tabela em `analytics.*`:

- `analytics.fact_evidence` - guarda o texto literal que justifica cada fato extraido pela LLM.

E acrescenta uma nova fila em `ops.*`:

- `ops.atendente_jobs` - fila do worker da Atendente.

## Por que `agent.*` e separado de `commerce.*`

Pensa em duas planilhas diferentes:

- `agent.*` e o **rascunho** do pedido. O cliente pode trocar pneu, mudar endereco, voltar atras.
- `commerce.*` e o **pedido confirmado**. So nasce quando o humano fechou.

Misturar os dois polui o relatorio fiscal com rascunho que pode ter mudado 5 vezes.

## Tabelas novas em `agent.*`

### `agent.session_current`

Foto atual da sessao do agente: ativa, pausada, escalada ou fechada. Qual skill esta ativa.

Uma linha por conversa.

### `agent.session_events`

Historico imutavel do que o agente decidiu na sessao. Append-only. Skill
ativada, confirmacao pedida, mudanca de carrinho, rascunho de pedido, humano
chamado.

Eventos de carrinho/draft atuais:

- `cart_added` - item entrou no carrinho.
- `cart_removed` - item foi removido.
- `cart_updated` - quantidade do item mudou.
- `cart_cleared` - carrinho foi limpo.
- `draft_updated` - rascunho de checkout mudou.

O tipo legado `cart_proposed` continua aceito no banco para historico antigo,
mas novas actions de carrinho usam os tipos especificos acima.

### `agent.turns`

Cada resposta da LLM Atendente. Guarda mensagem que disparou, skill escolhida, output `{ say, actions, claims, rationale, prompt_version }` (claims adicionados em 2026-05-15 via Etapa 2 ADR-009) e, no futuro, mensagem enviada no Chatwoot.

Quando `status='blocked'`, `say_text` fica `NULL` por seguranca, mas o candidato bloqueado fica auditavel em `blocked_say_text`, `blocked_actions` e `blocked_payload` (este ultimo agora tambem carrega `claims` para auditoria de Etapa 2). Isso permite ver o que o Generator tentou dizer sem expor a frase ao cliente.

Idempotente: mesmo `trigger_message_id` + `agent_version` nao gera dois turnos.

### `agent.pending_confirmations`

Perguntas que o agente fez e ainda nao foram respondidas. Ex: "e Bros 160 traseira?". Tem expiracao.

### `agent.cart_current` + `agent.cart_current_items`

Carrinho atual da conversa. So itens (pneu, medida, quantidade). Endereco e pagamento ficam em `agent.order_drafts`.

### `agent.cart_events`

Historico imutavel do carrinho. Eventos: proposed, confirmed, validated,
promoted, removed, replaced, updated, cleared.

`updated` significa mudanca de quantidade no mesmo item. `replaced` fica
reservado para uma troca real de produto quando essa action existir.

### `agent.order_drafts`

Rascunho do checkout: nome do cliente, endereco, modalidade (entrega/retirada), forma de pagamento.

Uma linha por conversa.

Quando o humano confirma e fecha, o draft e promovido: `draft_status` vira `promoted` e `promoted_order_id` aponta para `commerce.orders`.

### `agent.escalations`

Quando o agente passa pra humano. Status: aguardando, em_atendimento, resolvida, devolvida_bot.

## Tabelas novas em `commerce.*`

Status operacional do catalogo em 2026-05-14: o ambiente `FAREJADOR_ENV=test`
auditado tem 50 pneus em `commerce.products`/`commerce.tire_specs`, 138
modelos/variacoes em `commerce.vehicle_models`, 96 compatibilidades oficiais em
`commerce.vehicle_fitments` e 84 pendencias em `commerce.fitment_discoveries`.
Preco e estoque real ainda nao foram carregados nesse ambiente. Ver
`docs/COMMERCE_CATALOG_STATUS.md`.

### `commerce.products`

Cabecalho de cada item vendavel. Nome, marca, tipo (pneu, camara, oleo, servico). Nao guarda preco nem estoque - esses ficam separados.

### `commerce.tire_specs`

Especificacao tecnica do pneu: medida, largura, perfil, aro, indice de carga, posicao recomendada.

Um produto pode ter um spec.

### `commerce.vehicle_models`

Modelos de veiculo: Honda CG 160, Yamaha Fazer 250, etc. Tem ano, cilindrada, segmento.

### `commerce.vehicle_fitments`

Compatibilidade entre veiculo e pneu. "Esse pneu serve nessa moto, na posicao traseira."

### `commerce.fitment_discoveries`

Quando o agente descobre uma compatibilidade nova durante a conversa. Status: pending, approved, rejected, promoted.

So vira `vehicle_fitments` oficial depois que humano aprovou.

### `commerce.product_media`

Fotos e videos do produto.

### `commerce.stock_levels`

Quanto tem disponivel agora.

### `commerce.product_prices`

Preco com periodo de validade (valid_from / valid_until). Permite promocao.

### `commerce.geo_resolutions`

Bairros e municipios normalizados. "Bonsucesso" e "Bonsuceso" viram a mesma linha. Util para entrega.

### `commerce.delivery_zones`

Areas de entrega: bairro + taxa + prazo + modalidade.

### `commerce.store_policies`

Politicas da loja em formato chave/valor. Ex: `prazo_garantia_pneus`, `forma_pagamento_aceita`.

### `commerce.import_batches` + `commerce.import_errors`

Controle de importacao por planilha. Toda importacao gera batch. Linhas com erro ficam em `import_errors`.

### `commerce.orders` + `commerce.order_items`

Pedido confirmado. So nasce quando humano fechou (v1) ou transacao automatica fechou (v2 futuro).

## Tabelas novas em `analytics.*`

### `analytics.fact_evidence`

Guarda o texto literal que justifica cada fato extraido pela LLM Organizadora.

```text
fact: moto_modelo = "CG 160"
evidence_text: "tenho uma CG 160 2022"
from_message_id: <id da mensagem>
evidence_type: literal
```

Sem evidence, fact da LLM e rejeitado.

### Nova coluna em `analytics.conversation_facts`

`superseded_by_id` - aponta pro novo fato quando algo mudou. Ex: cliente disse CG 160, depois corrigiu pra Bros 160. O CG 160 nao apaga, ganha `superseded_by_id` apontando para o novo Bros 160.

Auditoria total. Nada se perde.

## Tabelas novas em `ops.*`

### `ops.atendente_jobs`

Fila do worker da Atendente. Cada mensagem do cliente vira um job. Worker pega em milissegundos.

Status: pending, processing, processed, failed.

Hardening operacional: o caminho principal continua sendo o `dispatcher` criar
o job na normalizacao do `message_created`. Como rede de seguranca,
`src/atendente/reconcile-jobs.ts` procura mensagens publicas de cliente em
`core.messages` sem job correspondente e chama `ops.enqueue_atendente_job` de
forma idempotente. Isso cobre janelas de redeploy, queda de worker ou falha
transitoria sem misturar `raw.*`, `core.*` e `agent.*`.

### `ops.unhandled_messages`

Mensagens que cairam em `responder_geral` (skill de fallback). Sao insumo para criar skill nova.

### `ops.agent_incidents`

Bloqueios e falhas do agente. Tipos:

- validator_blocked: Say ou Action Validator barrou
- llm_timeout: LLM nao respondeu
- llm_api_error: erro na API
- pending_confirmation_expired: pergunta nao foi respondida
- transaction_rollback: transacao falhou
- router_no_skill_matched: nenhuma skill bateu
- evidence_not_literal: LLM extraiu fato sem evidence valida
- schema_violation: LLM tentou usar fact_key fora do extraction-schema

### `ops.enrichment_jobs` (atualizada)

Ja existia. Ganha campos novos:

- `last_message_id` - ate qual mensagem deve processar
- `last_processed_message_id` - ate qual processou
- `not_before` - debounce de 60-120s
- `job_type` - organize_conversation, reenrich_conversation, backfill

Um job por conversa, com upsert. Mensagem nova reseta o debounce.

## Como tudo se conecta

```text
core.messages
   |
   +-> ops.atendente_jobs   (mensagem do cliente vira job)
   +-> ops.enrichment_jobs  (upsert por conversa)
   +-> agent.turns          (cada resposta da Atendente)
   +-> analytics.fact_evidence  (texto literal de cada fato)

agent.order_drafts
   |
   +-> commerce.orders      (quando promove via promoted_order_id)
   +-> commerce.geo_resolutions  (bairro normalizado)

agent.cart_current_items
   |
   +-> commerce.products    (qual produto esta no carrinho)

commerce.fitment_discoveries
   |
   +-> commerce.vehicle_fitments  (quando promove via promoted_to_fitment_id)
   +-> core.conversations         (em qual conversa foi descoberto)
```

## Tres frases que resumem a Fase 3

```text
agent guarda o que esta acontecendo agora.
commerce guarda o que e venda real.
analytics guarda o que entendemos depois.
```

## Onde aprofundar

- Doc 04 (`docs/phase3-agent-architecture/04-blocos-do-banco.md`) - lista de tabelas por bloco
- Doc 16 (`docs/phase3-agent-architecture/16-planejamento-tabelas-em-portugues.md`) - cada tabela em portugues, campo a campo
- Doc 17 (`docs/phase3-agent-architecture/17-mapa-portugues-ingles.md`) - mapa de nomes pt -> en tecnico
- Doc 18 (`docs/phase3-agent-architecture/18-diagrama-er.md`) - relacoes entre tabelas
- ADR-004 (`docs/adr/ADR-004-fase-3-arquitetura-agente.md`) - decisoes arquiteturais
