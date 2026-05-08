# 17 - Mapa Portugues -> Ingles Tecnico

## Por que este documento existe

O doc 16 desenhou as 29 tabelas em portugues, para Wallace entender e aprovar.

Para virar SQL, cada nome de negocio precisa de um nome canonico tecnico em ingles. Sem este mapa, quem implementa pode escolher nomes diferentes do que ficou decidido nos docs 04, 06, 12, 13, 14.

Este documento e a fonte unica de verdade para nomes tecnicos.

## Convencoes

- schema em ingles, sempre snake_case;
- tabela em ingles, plural sempre que coletivo (`products`, `orders`, `vehicle_models`);
- coluna em ingles, snake_case;
- timestamps com sufixo `_at` (`created_at`, `processed_at`);
- IDs externos prefixados (`chatwoot_message_id`, `external_product_code`);
- enums via `TEXT + CHECK` no v1, promove para `ENUM` apos 4-8 semanas (regra do doc 02).

## Mapa de tabelas

| # | Nome de negocio (doc 16) | Schema.Tabela canonico |
|---|--------------------------|------------------------|
| 1  | produtos                          | `commerce.products` |
| 2  | especificacoes do pneu            | `commerce.tire_specs` |
| 3  | veiculos                          | `commerce.vehicle_models` |
| 4  | compatibilidade veiculo-pneu      | `commerce.vehicle_fitments` |
| 5  | midias do produto                 | `commerce.product_media` |
| 6  | estoque                           | `commerce.stock_levels` |
| 7  | precos                            | `commerce.product_prices` |
| 8  | bairros e municipios              | `commerce.geo_resolutions` |
| 9  | areas de entrega                  | `commerce.delivery_zones` |
| 10 | politicas da loja                 | `commerce.store_policies` |
| 11 | importacoes de planilha           | `commerce.import_batches` |
| 12 | erros de importacao               | `commerce.import_errors` |
| 13 | compatibilidades descobertas      | `commerce.fitment_discoveries` |
| 14 | pedidos                           | `commerce.orders` |
| 15 | itens do pedido                   | `commerce.order_items` |
| 16 | sessoes atuais do agente          | `agent.session_current` |
| 17 | eventos da sessao                 | `agent.session_events` |
| 18 | turnos do agente                  | `agent.turns` |
| 19 | confirmacoes pendentes            | `agent.pending_confirmations` |
| 20 | carrinho atual                    | `agent.cart_current` |
| 21 | itens do carrinho atual           | `agent.cart_current_items` |
| 22 | eventos do carrinho               | `agent.cart_events` |
| 23 | rascunhos de pedido               | `agent.order_drafts` |
| 24 | escalacoes                        | `agent.escalations` |
| 25 | fila da Atendente                 | `ops.atendente_jobs` |
| 26 | evidencias dos fatos              | `analytics.fact_evidence` |
| 27 | mensagens sem skill adequada      | `ops.unhandled_messages` |
| 28 | incidentes do agente              | `ops.agent_incidents` |
| 29 | fila da Organizadora              | `ops.enrichment_jobs` |

## Mapa de colunas (campos comuns)

Padrao para todas as tabelas:

| Nome de negocio | Coluna canonica | Tipo |
|-----------------|-----------------|------|
| identificador interno | `id` | `UUID PRIMARY KEY DEFAULT gen_random_uuid()` |
| ambiente | `environment` | `env_t NOT NULL` (ja existente em `core.*`) |
| criado em | `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` |
| atualizado em | `updated_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` |
| apagado em (soft delete) | `deleted_at` | `TIMESTAMPTZ NULL` |

## Mapa de colunas por tabela (campos especificos)

### `commerce.products` (Tabela 1)

| Negocio | Coluna |
|---------|--------|
| codigo do produto | `product_code` |
| nome do produto | `product_name` |
| tipo do produto | `product_type` (`tire`, `tube`, `valve`, `oil`, `accessory`, `service`) |
| marca | `brand` |
| descricao curta | `short_description` |
| observacoes internas | `internal_notes` |

### `commerce.tire_specs` (Tabela 2)

| Negocio | Coluna |
|---------|--------|
| produto vinculado | `product_id` (FK -> products) |
| medida nominal | `tire_size` (ex: `140/70-17`) |
| largura | `width_mm` |
| perfil | `aspect_ratio` |
| aro | `rim_diameter` |
| indice de carga | `load_index` |
| indice de velocidade | `speed_rating` |
| construcao | `construction` (`radial`, `bias`) |
| desenho/banda | `tread_pattern` |
| uso recomendado | `intended_use` (`street`, `offroad`, `mixed`, `track`) |
| posicao recomendada | `position` (`front`, `rear`, `both`) |

### `commerce.vehicle_models` (Tabela 3)

| Negocio | Coluna |
|---------|--------|
| tipo de veiculo | `vehicle_type` (`motorcycle`, `car`, `truck`) |
| marca | `make` |
| modelo | `model` |
| variante | `variant` |
| ano inicial | `year_start` |
| ano final | `year_end` |
| cilindrada | `displacement_cc` |
| segmento | `segment` (`naked`, `sport`, `commuter`, `offroad`, `scooter`) |

### `commerce.vehicle_fitments` (Tabela 4)

| Negocio | Coluna |
|---------|--------|
| veiculo | `vehicle_model_id` (FK) |
| spec do pneu | `tire_spec_id` (FK) |
| posicao | `position` (`front`, `rear`, `both`) |
| original de fabrica | `is_oem` (BOOLEAN) |
| fonte da compatibilidade | `source` (`manufacturer`, `manual`, `discovery_promoted`) |
| confianca | `confidence_level` (NUMERIC 0-1) |

### `commerce.product_media` (Tabela 5)

| Negocio | Coluna |
|---------|--------|
| produto | `product_id` (FK) |
| url | `media_url` |
| tipo | `media_type` (`image`, `video`, `document`) |
| ordem | `display_order` |
| descricao | `caption` |

### `commerce.stock_levels` (Tabela 6)

| Negocio | Coluna |
|---------|--------|
| produto | `product_id` (FK) |
| quantidade disponivel | `quantity_available` |
| quantidade reservada | `quantity_reserved` |
| local | `location` |
| ultimo ajuste | `last_adjusted_at` |

### `commerce.product_prices` (Tabela 7)

| Negocio | Coluna |
|---------|--------|
| produto | `product_id` (FK) |
| preco | `price_amount` (NUMERIC) |
| moeda | `currency` (default `BRL`) |
| valido a partir | `valid_from` |
| valido ate | `valid_until` |
| tipo de preco | `price_type` (`regular`, `promo`, `wholesale`) |

### `commerce.geo_resolutions` (Tabela 8 - bairros e municipios)

| Negocio | Coluna |
|---------|--------|
| bairro mencionado | `neighborhood_name` |
| bairro normalizado | `neighborhood_canonical` |
| municipio | `city_name` |
| estado | `state_code` |
| cep aproximado | `postal_code_prefix` |
| variantes conhecidas | `aliases` (TEXT[]) |

### `commerce.delivery_zones` (Tabela 9)

| Negocio | Coluna |
|---------|--------|
| bairro | `geo_resolution_id` (FK) |
| taxa | `delivery_fee` (NUMERIC) |
| prazo em dias uteis | `delivery_days` |
| disponivel para entrega | `is_available` |
| modalidade | `delivery_mode` (`own_fleet`, `partner`, `pickup_only`) |

### `commerce.store_policies` (Tabela 10)

| Negocio | Coluna |
|---------|--------|
| chave da politica | `policy_key` |
| valor | `policy_value` (JSONB) |
| descricao | `description` |
| ativa | `is_active` |
| versao | `policy_version` |

### `commerce.import_batches` (Tabela 11)

| Negocio | Coluna |
|---------|--------|
| arquivo | `source_file` |
| tipo | `import_type` (`products`, `vehicles`, `fitments`, `prices`, `stock`) |
| total de linhas | `total_rows` |
| linhas processadas | `processed_rows` |
| linhas com erro | `failed_rows` |
| status | `status` (`pending`, `processing`, `completed`, `failed`) |

### `commerce.import_errors` (Tabela 12)

| Negocio | Coluna |
|---------|--------|
| importacao | `import_batch_id` (FK) |
| linha do arquivo | `row_number` |
| coluna | `column_name` |
| valor original | `raw_value` |
| mensagem de erro | `error_message` |
| acao | `action_taken` (`skipped`, `defaulted`, `manual_review`) |

### `commerce.fitment_discoveries` (Tabela 13)

| Negocio | Coluna |
|---------|--------|
| veiculo | `vehicle_model_id` (FK) |
| spec do pneu | `tire_spec_id` (FK) |
| posicao | `position` |
| status | `status` (`pending`, `approved`, `rejected`, `promoted`) |
| descoberto em | `discovered_at` |
| revisado por | `reviewed_by` |
| revisado em | `reviewed_at` |
| evidencia (conversation_id) | `evidence_conversation_id` |
| promovido para fitment_id | `promoted_to_fitment_id` (FK) |

### `commerce.orders` (Tabela 14)

| Negocio | Coluna |
|---------|--------|
| contato | `contact_id` (FK -> core.contacts) |
| conversa origem | `source_conversation_id` (FK -> core.conversations) |
| total | `total_amount` |
| status | `status` (`open`, `paid`, `delivered`, `cancelled`) |
| modalidade | `fulfillment_mode` (`delivery`, `pickup`) |
| forma de pagamento | `payment_method` |
| endereco entrega | `delivery_address` |
| bairro | `geo_resolution_id` (FK) |
| fechado por | `closed_by` |
| fechado em | `closed_at` |

### `commerce.order_items` (Tabela 15)

| Negocio | Coluna |
|---------|--------|
| pedido | `order_id` (FK) |
| produto | `product_id` (FK) |
| quantidade | `quantity` |
| preco unitario | `unit_price` |
| desconto | `discount_amount` |

### `agent.session_current` (Tabela 16)

| Negocio | Coluna |
|---------|--------|
| conversa | `conversation_id` (FK -> core.conversations, UNIQUE) |
| status | `status` (`active`, `paused`, `escalated`, `closed`) |
| skill atual | `current_skill` |
| ultima mensagem cliente | `last_customer_message_id` |
| ultimo turno agente | `last_agent_turn_id` |
| atualizado em | `updated_at` |

### `agent.session_events` (Tabela 17)

| Negocio | Coluna |
|---------|--------|
| conversa | `conversation_id` (FK) |
| tipo evento | `event_type` (`skill_selected`, `confirmation_requested`, `cart_proposed`, `cart_added`, `cart_removed`, `cart_updated`, `cart_cleared`, `draft_updated`, `human_called`, `bot_resumed`) |
| skill | `skill_name` |
| detalhes | `event_payload` (JSONB) |
| ocorrido em | `occurred_at` |

### `agent.turns` (Tabela 18)

| Negocio | Coluna |
|---------|--------|
| conversa | `conversation_id` (FK) |
| mensagem que disparou | `trigger_message_id` (FK -> core.messages) |
| skill selecionada | `selected_skill` |
| versao do agente | `agent_version` |
| hash do contexto | `context_hash` |
| output `say` | `say_text` |
| output `actions` | `actions` (JSONB) |
| candidato bloqueado (texto) | `blocked_say_text` |
| candidato bloqueado (actions) | `blocked_actions` (JSONB) |
| auditoria do bloqueio | `blocked_payload` (JSONB) |
| status | `status` (`generated`, `validated`, `delivered`, `failed`, `blocked`) |
| mensagem enviada | `delivered_message_id` |

UNIQUE: `(environment, trigger_message_id, agent_version)`.

### `agent.pending_confirmations` (Tabela 19)

| Negocio | Coluna |
|---------|--------|
| conversa | `conversation_id` (FK) |
| tipo | `confirmation_type` (`fact_confirmation`, `cart_confirmation`, `order_confirmation`) |
| fatos esperados | `expected_facts` (JSONB) |
| mensagem da pergunta | `question_message_id` (FK -> core.messages) |
| status | `status` (`open`, `resolved`, `expired`, `cancelled`) |
| expira em | `expires_at` |
| mensagem que resolveu | `resolved_by_message_id` |

### `agent.cart_current` (Tabela 20)

| Negocio | Coluna |
|---------|--------|
| conversa | `conversation_id` (FK, UNIQUE) |
| status | `cart_status` (`empty`, `proposed`, `confirmed`, `validated`, `promoted`) |
| total estimado | `estimated_total` |
| atualizado em | `updated_at` |

### `agent.cart_current_items` (Tabela 21)

| Negocio | Coluna |
|---------|--------|
| carrinho | `cart_id` (FK) |
| produto | `product_id` (FK) |
| quantidade | `quantity` |
| preco unitario | `unit_price` |
| status | `item_status` (`proposed`, `confirmed`, `removed`) |

### `agent.cart_events` (Tabela 22)

| Negocio | Coluna |
|---------|--------|
| conversa | `conversation_id` (FK) |
| tipo evento | `event_type` (`proposed`, `confirmed`, `validated`, `promoted`, `removed`, `replaced`, `cleared`) |
| item afetado | `affected_item_id` |
| payload | `event_payload` (JSONB) |
| ocorrido em | `occurred_at` |

### `agent.order_drafts` (Tabela 23)

| Negocio | Coluna |
|---------|--------|
| conversa | `conversation_id` (FK, UNIQUE) |
| nome do cliente | `customer_name` |
| bairro/endereco | `delivery_address` |
| bairro normalizado | `geo_resolution_id` (FK) |
| modalidade | `fulfillment_mode` (`delivery`, `pickup`) |
| forma de pagamento | `payment_method` |
| status | `draft_status` (`collecting`, `ready`, `promoted`, `abandoned`) |
| pedido promovido | `promoted_order_id` (FK -> commerce.orders) |
| promovido por | `promoted_by` |
| promovido em | `promoted_at` |

### `agent.escalations` (Tabela 24)

| Negocio | Coluna |
|---------|--------|
| conversa | `conversation_id` (FK) |
| motivo | `reason` (`ready_to_close`, `customer_requested`, `validator_blocked`, `confidence_low`, `other`) |
| status | `status` (`waiting`, `in_attendance`, `resolved`, `returned_to_bot`) |
| resumo | `summary_text` |
| nota chatwoot | `chatwoot_note_id` |
| escalado em | `escalated_at` |
| resolvido em | `resolved_at` |

### `ops.atendente_jobs` (Tabela 25)

| Negocio | Coluna |
|---------|--------|
| conversa | `conversation_id` (FK) |
| mensagem que disparou | `trigger_message_id` (FK -> core.messages) |
| status | `status` (`pending`, `processing`, `processed`, `failed`) |
| not_before | `not_before` |
| tentativas | `attempts` |
| locked_at | `locked_at` |
| locked_by | `locked_by` |
| erro | `error_message` |
| processado_em | `processed_at` |

UNIQUE: `(environment, trigger_message_id)`.

### `analytics.fact_evidence` (Tabela 26)

| Negocio | Coluna |
|---------|--------|
| fato | `fact_id` (FK -> analytics.conversation_facts) |
| mensagem fonte | `from_message_id` (FK -> core.messages) |
| texto literal | `evidence_text` |
| tipo de evidencia | `evidence_type` (`literal`, `inferred`, `confirmed_by_question`) |
| extrator usado | `extractor_version` |

### `ops.unhandled_messages` (Tabela 27)

| Negocio | Coluna |
|---------|--------|
| conversa | `conversation_id` (FK) |
| mensagem | `message_id` (FK) |
| texto | `message_text` |
| motivo | `fallback_reason` (`router_no_skill`, `policy_missing`, `data_missing`, `other`) |
| skill usada | `skill_used` |
| revisado em | `reviewed_at` |
| promovido para skill | `promoted_to_skill` |
| observacoes | `notes` |

### `ops.agent_incidents` (Tabela 28)

| Negocio | Coluna |
|---------|--------|
| conversa | `conversation_id` (FK) |
| turno | `agent_turn_id` (FK) |
| tipo | `incident_type` (`validator_blocked`, `llm_timeout`, `llm_api_error`, `pending_confirmation_expired`, `transaction_rollback`, `router_no_skill_matched`, `evidence_not_literal`, `schema_violation`) |
| severidade | `severity` (`low`, `medium`, `high`, `critical`) |
| detalhes | `details` (JSONB) |
| resolvido em | `resolved_at` |

### `ops.enrichment_jobs` (Tabela 29)

| Negocio | Coluna |
|---------|--------|
| conversa | `conversation_id` (FK) |
| tipo | `job_type` (`organize_conversation`, `reenrich_conversation`, `backfill`) |
| status | `status` (`pending`, `processing`, `processed`, `failed`, `skipped`) |
| ate qual mensagem | `last_message_id` (FK -> core.messages) |
| ate qual processou | `last_processed_message_id` (FK) |
| not_before | `not_before` |
| tentativas | `attempts` |
| locked_at | `locked_at` |
| locked_by | `locked_by` |
| erro | `error_message` |

UNIQUE parcial: `(environment, conversation_id, job_type) WHERE status IN ('pending','processing')`.

## Schemas em uso

```text
raw         (existente)  imutavel
core        (existente)  Chatwoot normalizado
analytics   (existente)  + fact_evidence (nova na Fase 3)
agent       (NOVO Fase 3)  estado operacional do Atendente
commerce    (NOVO Fase 3)  catalogo, fitments, pedidos
ops         (existente)  + atendente_jobs, enrichment_jobs upgrade
```

## Convencoes finais

- nada de portugues no banco;
- nomes em ingles claros, sem abreviacao misteriosa (`current_skill`, nao `cur_skl`);
- chaves estrangeiras nomeadas como `<entidade>_id`;
- todas as tabelas tem `id UUID PK`, `environment env_t`, `created_at`, `updated_at` (exceto append-only que usa `occurred_at`);
- enums via TEXT+CHECK no v1, promove apos taxonomia estavel.

Este mapa e a fonte unica de verdade. Se Kimi (ou qualquer outro implementador) divergir, abrir issue antes de mergear.
