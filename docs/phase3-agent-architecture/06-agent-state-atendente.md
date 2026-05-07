# 06 - Estado da LLM Atendente

## Papel do schema agent

`agent.*` guarda a memoria de trabalho do atendimento.

Nao e a verdade bruta da conversa.

Nao e catalogo.

Nao e interpretacao historica.

E o estado operacional do agente.

## Nota v1 reentrante

Este documento descreve o desenho base criado em `0016_agent_layer.sql`.

Para a Atendente v1, o Sprint 1 **estende** este desenho sem substituir as
tabelas existentes. A extensao aprovada esta em
[21 - Atendente v1: State Design](21-atendente-v1-state-design.md):

- `agent.session_current` ganha `version` e `turn_index`;
- `agent.session_events` ganha `action_id`, `turn_index` e versao resultante;
- `agent.session_items` registra interesses em discussao antes do carrinho;
- `agent.session_slots` registra slots com procedencia e stale flags;
- `ConversationState` e montado pelo repositorio a partir das tabelas, nao salvo
  como um `state jsonb` monolitico.

Assim, `agent.*` continua relacional e auditavel, mas passa a suportar
slot-filling reentrante: o cliente pode ir e voltar no funil sem prender a
Atendente em uma maquina de estados linear.

## Tabelas

### `agent.session_events`

Historico imutavel de eventos da sessao.

Exemplos:

- skill selecionada;
- confirmacao solicitada;
- carrinho proposto;
- humano chamado;
- bot retomou.

### `agent.session_current`

Fotografia atual da sessao.

Campos conceituais:

- conversa;
- status: active, paused, escalated, closed;
- skill atual;
- ultima mensagem do cliente;
- ultimo turno do agente;
- atualizado em.

Snapshot e cache operacional. Deve ser regeneravel a partir dos eventos.

### `agent.turns`

Cada resposta da LLM Atendente.

Guarda:

- mensagem que disparou;
- skill selecionada;
- versao do agente;
- hash do contexto;
- output `{ say, actions }`;
- candidato bloqueado (`blocked_say_text`, `blocked_actions`, `blocked_payload`), quando o validator barra a resposta;
- status;
- mensagem enviada no Chatwoot, se houver.

Idempotencia:

```text
unique(environment, trigger_message_id, agent_version)
```

### `agent.pending_confirmations`

Perguntas que o agente fez e espera resposta.

Exemplo:

```text
"e Bros 160 traseira, certo?"
```

Guarda:

- tipo de confirmacao;
- fatos esperados;
- mensagem da pergunta;
- status;
- expiracao;
- mensagem que resolveu.

### `agent.cart_events`

Historico imutavel do carrinho.

Eventos:

- proposed;
- confirmed;
- validated;
- promoted;
- removed;
- replaced;
- cleared.

### `agent.cart_current`

Fotografia atual do carrinho.

So itens (medida, marca, quantidade). Checkout fica em `agent.order_drafts`.

### `agent.cart_current_items`

Itens atuais do carrinho.

### `agent.order_drafts`

Slots de checkout em tempo real.

Campos conceituais:

- conversa;
- nome do cliente;
- bairro/endereco de entrega;
- modalidade (entrega ou retirada);
- forma de pagamento;
- atualizado em.

Por que separar de `cart_current`:

- carrinho muda toda hora (cliente troca pneu, troca quantidade);
- checkout e mais estavel (endereco e um, pagamento e um).

Por que fica em `agent.*` e nao em `commerce.*`:

- rascunho nao e venda;
- `commerce.orders` so nasce quando confirmado.

Detalhes de slot filling, Context Builder e regra "persiste o que doi perder" estao em [12 - Context Builder e Slot Filling](12-context-builder-e-slot-filling.md).

### `agent.escalations`

Escalacoes para humano.

Status:

- aguardando;
- em_atendimento;
- resolvida;
- devolvida_bot.

## v1 sem pedido automatico

No v1, a Atendente pode montar proposta de pedido, mas nao cria pedido automaticamente.

Acao `create_order` vira escalacao para humano fechar.

Em v2, o handler transacional pode ser ativado sem mudar o schema.
