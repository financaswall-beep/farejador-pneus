# 19 - Guia de teste Chatwoot + Organizadora

Este documento ensina como usar o simulador local de Chatwoot para testar uma conversa real e auditar se a LLM Organizadora gravou os fatos corretos.

Objetivo simples:

> Simular um cliente no Chatwoot, atender manualmente, deixar o Farejador capturar tudo e depois conferir se a Organizadora entendeu os dados importantes.

## Estado atual

Hoje existem dois arquivos locais na raiz do projeto:

- `chatwoot-chat.bat`
- `chatwoot-chat.cjs`

Eles sao ferramentas locais de teste. Estao no `.gitignore` porque podem conter token, IP e configuracao sensivel do Chatwoot.

Regra:

- pode usar na maquina local;
- nao commitar;
- nao copiar token para documentacao;
- se um dia virar ferramenta oficial, precisa ler configuracao via `.env`.

## O que esse teste valida

Esse teste valida o fluxo real:

```text
voce digita como cliente
  -> Chatwoot recebe mensagem incoming
  -> webhook dispara
  -> Farejador grava raw.* e core.*
  -> ops.enrichment_jobs recebe/atualiza job
  -> Organizadora processa a conversa
  -> analytics.conversation_facts recebe fatos
  -> analytics.fact_evidence recebe a prova literal
```

Ele nao testa a LLM Atendente. Em 03/05/2026, existe apenas o Worker Shadow
log-only da Atendente; Generator e envio Chatwoot continuam fora deste teste.

No Shadow Assistido, quem responde e voce, manualmente, pelo Chatwoot.

## Como abrir

No Windows, dentro da pasta do projeto:

```powershell
cd "C:\Farejador agente"
.\chatwoot-chat.bat
```

Ou direto pelo Node:

```powershell
node .\chatwoot-chat.cjs
```

O terminal vai criar um contato e uma conversa no Chatwoot.

Depois:

1. Abra o Chatwoot no navegador.
2. Procure a conversa criada pelo numero mostrado no terminal.
3. Digite no terminal como se fosse o cliente.
4. Responda no Chatwoot como atendente humano.
5. Espere a Organizadora processar.
6. Confira os fatos salvos no banco.

## Como conversar no teste

Use conversas naturais. Nao precisa parecer formulario.

Exemplo bom:

```text
bom dia
meu nome e Joao
queria ver pneu traseiro pra Bros 160
a medida e 140/70-17
sou de Bonsucesso
tem entrega amanha?
quanto fica no pix?
achei meio caro, ali perto me falaram 180
```

Isso deve gerar fatos como:

- `nome_cliente`
- `moto_modelo`
- `posicao_pneu`
- `medida_pneu`
- `bairro_mencionado`
- `perguntou_entrega_hoje`
- `forma_pagamento`
- `achou_caro`
- `preco_concorrente`

## Cenarios recomendados

### Cenario 1 - Busca basica

Cliente:

```text
bom dia
tem pneu traseiro pra cg 160?
acho que e 100/80-18
```

Esperado:

- `moto_modelo = CG 160`
- `posicao_pneu = traseiro`
- `medida_pneu = 100/80-18`
- `intencao_cliente = consultar_estoque` ou `comprar_pneu`

### Cenario 2 - Localizacao e entrega

Cliente:

```text
sou de campo grande
voces entregam hoje?
se entregar eu fecho no pix
```

Esperado:

- `bairro_mencionado = Campo Grande`
- `perguntou_entrega_hoje = true`
- `forma_pagamento = pix`
- `modalidade_entrega = entrega`

### Cenario 3 - Negociacao

Cliente:

```text
achei caro
tem desconto?
o concorrente me fez por 180
```

Esperado:

- `achou_caro = true`
- `pediu_desconto = true`
- `preco_concorrente = 180`
- possivelmente `concorrente_citado`, se ele disser o nome

### Cenario 4 - Preferencia de marca

Cliente:

```text
quero pirelli ou michelin
nao quero maggion
se tiver outra marca boa pode mandar tambem
```

Esperado:

- `marca_pneu_preferida = Pirelli` ou `Michelin`
- `marca_pneu_recusada = Maggion`
- `aceita_alternativa = true`
- `preferencia_principal = marca_conhecida` ou `qualidade`

### Cenario 5 - Correcao no meio da conversa

Cliente:

```text
e pra bros 160
na verdade errei, e pra cg 160
```

Esperado:

- duas linhas no ledger podem existir;
- o fato antigo fica supersedido;
- o fato atual deve ser `moto_modelo = CG 160`.

Esse cenario e importante para auditar se a supersedencia esta funcionando.

## Como auditar no Supabase

Depois da conversa, espere alguns segundos/minutos para a Organizadora processar.

No Supabase SQL Editor, use consultas parecidas com estas.

### 1. Ver ultimas conversas

```sql
select
  id,
  environment,
  chatwoot_conversation_id,
  contact_id,
  created_at,
  updated_at
from core.conversations
order by created_at desc
limit 10;
```

Pegue o `id` da conversa que voce acabou de testar.

### 2. Ver mensagens da conversa

```sql
select
  id,
  sender_type,
  content,
  created_at
from core.messages
where conversation_id = 'COLE_AQUI_O_ID_DA_CONVERSA'
order by created_at asc;
```

Isso confirma que o Farejador gravou a conversa em `core.messages`.

### 3. Ver job da Organizadora

```sql
select
  id,
  conversation_id,
  status,
  attempts,
  locked_at,
  processed_at,
  last_error,
  last_processed_message_id,
  updated_at
from ops.enrichment_jobs
where conversation_id = 'COLE_AQUI_O_ID_DA_CONVERSA'
order by updated_at desc;
```

Status esperado:

- `pending`: ainda nao processou;
- `running`: processando agora;
- `completed`: processou;
- `failed`: falhou, olhar `last_error` e `ops.agent_incidents`.

### 4. Ver fatos extraidos

```sql
select
  id,
  fact_key,
  fact_value,
  truth_type,
  confidence_level,
  message_id,
  superseded_by,
  created_at
from analytics.conversation_facts
where conversation_id = 'COLE_AQUI_O_ID_DA_CONVERSA'
order by fact_key, created_at asc;
```

O que conferir:

- fatos importantes apareceram?
- valores fazem sentido?
- `confidence_level` nao esta muito baixo?
- se houve correcao, o fato antigo tem `superseded_by`?

### 5. Ver fatos atuais

```sql
select
  fact_key,
  fact_value,
  truth_type,
  confidence_level,
  created_at
from analytics.current_facts
where conversation_id = 'COLE_AQUI_O_ID_DA_CONVERSA'
order by fact_key;
```

Essa view mostra a "verdade atual" da conversa, sem os fatos supersedidos.

### 6. Ver evidencias literais

```sql
select
  f.fact_key,
  f.fact_value,
  e.from_message_id,
  e.evidence_text,
  e.evidence_type,
  e.created_at
from analytics.fact_evidence e
join analytics.conversation_facts f
  on f.id = e.fact_id
where f.conversation_id = 'COLE_AQUI_O_ID_DA_CONVERSA'
order by f.fact_key, e.created_at;
```

O que conferir:

- `evidence_text` precisa ser trecho literal da mensagem;
- se a LLM parafrasear, o worker deve rejeitar;
- se inventar `from_message_id`, o worker deve rejeitar.

### 7. Ver incidentes

```sql
select
  incident_type,
  severity,
  details,
  created_at
from ops.agent_incidents
where conversation_id = 'COLE_AQUI_O_ID_DA_CONVERSA'
order by created_at desc;
```

Se aparecer incidente, olhar principalmente:

- `schema_violation`
- `evidence_not_literal`
- `llm_timeout`
- `llm_api_error`
- `validator_blocked`

## Como saber se o teste foi bom

Um teste bom tem:

- conversa completa em `core.messages`;
- job em `ops.enrichment_jobs` como `completed`;
- fatos importantes em `analytics.conversation_facts`;
- evidencias em `analytics.fact_evidence`;
- zero incidente grave em `ops.agent_incidents`;
- se houve correcao de dado, supersedencia correta.

## Checklist rapido por conversa

Use esta lista depois de cada teste:

```text
[ ] A conversa apareceu no Chatwoot.
[ ] As mensagens chegaram em core.messages.
[ ] O job da Organizadora foi criado.
[ ] O job terminou como completed.
[ ] Os fatos principais foram extraidos.
[ ] Cada fato tem evidencia literal.
[ ] Nao houve incidente grave.
[ ] Se o cliente corrigiu algo, o fato antigo foi supersedido.
```

## Melhorias planejadas para a ferramenta

Hoje o `chatwoot-chat.cjs` e util, mas ainda e manual.

Melhorias recomendadas:

1. Ler configuracao via `.env`, nao hardcoded.
2. Criar comandos internos:
   - `/cenario bros`
   - `/cenario entrega`
   - `/cenario desconto`
   - `/cenario concorrente`
   - `/cenario completo`
   - `/auditar`
   - `/status`
3. Fazer `/auditar` consultar Supabase e comparar fatos esperados vs extraidos.
4. Salvar relatorio em `tmp/audits/chatwoot-conversation-<id>.json`.
5. Transformar cenarios em suite de calibracao para as 5 semanas de Shadow Assistido.

## Regra de ouro

O teste nao e para "enganar" a Organizadora com frase perfeita.

O teste bom e conversa real:

- cliente fala torto;
- muda de ideia;
- pergunta preco;
- pergunta entrega;
- pede desconto;
- some e volta;
- corrige informacao.

Se a Organizadora entender isso com evidencia literal, o sistema esta ficando forte.
