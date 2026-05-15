# Arquitetura F2a - Enrichment deterministico

Atualizado: 2026-05-10. Fase 2a permanece valida e implementada; Fase 2b (Organizadora LLM) ja roda em producao desde 2026-04-29 escrevendo em `analytics.conversation_facts` + `fact_evidence`.

## Leitura rapida

A Fase 2a e o primeiro andar de inteligencia do Farejador. Ela nao conversa com
cliente e nao usa LLM. Ela mede, detecta e classifica sinais simples a partir das
tabelas `core.*`.

O resultado fica apenas em `analytics.*`.

## Separacao entre base e segmento

O nucleo base deve responder perguntas genericas:

- quantas mensagens teve;
- quem respondeu;
- quanto demorou;
- houve reclamacao de preco;
- houve urgencia;
- houve abandono;
- houve pedido de produto;
- houve cotacao;
- houve sinal de fechamento.

O segmento responde o vocabulario especifico:

- em pneus: medidas, marcas, montagem, balanceamento, aro;
- em imobiliaria: bairro, financiamento, visita, aluguel, documentacao;
- em material de construcao: cimento, areia, bloco, entrega, obra.

Regra de ouro:

```text
src/enrichment/* = motor generico
segments/*       = vocabulario e regras do negocio
```

## Termo generico vs termo de segmento

Um termo pode ficar no nucleo generico se aparece em pelo menos 3 verticais sem
mudar de sentido.

Exemplos genericos:

- preco;
- entrega;
- garantia;
- instalacao;
- agendamento;
- urgencia;
- concorrente;
- compra;
- fechamento.

Exemplos de segmento:

- medida de pneu;
- aro;
- financiamento imobiliario;
- cimento CP-II;
- consulta medica de retorno.

## Selecao de segmento

O motor nao deve adivinhar segmento pelo texto.

Segmento e uma decisao operacional via:

```text
segments/routing.json
```

Formato:

```json
{
  "defaultSegment": "generic",
  "routes": [
    {
      "environment": "prod",
      "chatwoot_account_id": 1,
      "chatwoot_inbox_id": null,
      "segment": "generic"
    }
  ]
}
```

Regras:

- lookup por `environment + chatwoot_account_id`;
- `chatwoot_inbox_id` e opcional; quando preenchido, a rota fica especifica para
  uma inbox dentro da conta;
- fallback para `defaultSegment`;
- validar com Zod;
- `locale` vem do segmento carregado, nao do roteamento;
- na F2A-05, depois da tag base, a rota da conta real pode apontar para `tires`.

### Localizacao do diretorio segments/

`src/enrichment/rules.loader.ts` resolve `segments/` via `import.meta.url` (relativo
ao proprio modulo), nao via `process.cwd()`. Isso garante que o CLI funcione mesmo
quando executado de fora da raiz do repositorio.

Override opcional para testes/deploy:

```text
SEGMENTS_DIR=/caminho/customizado/segments
```

Lido direto de `process.env` para nao acoplar `rules.loader` ao schema validado de
`env.ts` (rules.loader e usado em testes que nao precisam de DATABASE_URL etc.).

## Estrutura de segmento

Todo segmento deve ter quatro arquivos:

```text
segments/<segment>/
  rules.json
  lexicon.json
  scenarios.json
  README.md
```

F2A-02 deve criar:

```text
segments/generic/
segments/_template/
segments/routing.json
```

`generic` deve conter regras neutras e executaveis. `_template` deve conter
estrutura minima validada, sem regra de negocio real.

## Hash do ruleset

F2A-02 deve calcular um hash deterministico do pacote de regras carregado:

```text
ruleset_hash = sha256(bytes(rules.json) + "\n" + bytes(lexicon.json))
```

Uso:

- gravar em `analytics.linguistic_hints`;
- gravar em `analytics.conversation_facts`;
- gravar em `analytics.conversation_classifications` quando a classificacao usar
  hints/facts derivados de regras;
- incluir na chave de idempotencia quando a migration permitir;
- permitir auditoria: mesmo `extractor_version` com arquivo de regra alterado fica
  rastreavel.

`extractor_version` identifica a familia/versao logica do extrator. `ruleset_hash`
identifica o conteudo exato das regras em disco.

Definicao exata:

- ler os bytes brutos de `rules.json`;
- adicionar um byte newline (`\n`);
- ler os bytes brutos de `lexicon.json`;
- calcular SHA-256 desse buffer;
- nao reserializar JSON antes de hashear.

`scenarios.json` nao entra no hash porque e fixture/documentacao de validacao do
segmento, nao entrada do motor de inferencia. Se algum dia o engine consumir
`scenarios.json`, essa decisao deve mudar antes do uso em producao.

## Modulos propostos

### `src/enrichment/signals.service.ts`

Calcula `analytics.conversation_signals` com SQL ou queries simples.

Nao entende texto. So mede estrutura.

### `src/enrichment/signals.repository.ts`

Faz upsert em `analytics.conversation_signals`.

Timezone para `started_hour_local` e `started_dow_local` vem por parametro
(`SIGNAL_TIMEZONE` em `env.ts`, default `America/Sao_Paulo`). Nada hardcoded em
SQL para manter a base portavel para outras regioes.

### `src/enrichment/rules.loader.ts`

Carrega `segments/routing.json` e os arquivos de `segments/<segment>/`.

### `src/enrichment/rules.engine.ts`

Aplica regras declarativas sobre mensagens.

Entrada:

- conversa;
- mensagens;
- segmento validado.

Saida:

- hints;
- facts;
- sinais intermediarios para classificacoes.

### `src/enrichment/classification.service.ts`

Gera classificacoes genericas em `analytics.conversation_classifications`.

Nao deve conhecer pneus.

### `src/enrichment/repositories/*.repository.ts`

Escreve em `analytics.*`.

Regras:

- idempotente;
- nunca escreve em `raw.*`;
- nunca escreve em `core.*`;
- sempre inclui provenance.

### `src/enrichment/cli.ts`

Entrypoint minimo para validacao manual.

Comando esperado:

```text
npm run enrich -- --conversation-id=<uuid> --segment=generic
```

Em F2A-01, pode executar apenas signals. Em F2A-02, passa a carregar segmento e
regras. Em F2A-03, passa a executar classificacoes genericas.

## Schema existente que deve ser reaproveitado

### `analytics.conversation_signals`

Para metricas estruturais.

Fonte esperada:

```text
source = sql_aggregation_v1
truth_type = observed
confidence_level = 1.00
extractor_version = f2a_signals_v1
```

Importante: `conversation_signals` tem `conversation_id` como primary key. Portanto,
essa tabela representa o snapshot atual dos sinais estruturais. Ela usa upsert e
pode sobrescrever valores anteriores. Historico por versao nao cabe aqui sem
migration futura.

### `analytics.linguistic_hints`

Para pistas textuais por mensagem.

Exemplos genericos (vivem em `segments/generic`):

- price_complaint;
- urgency_marker;
- abandonment_marker;
- positive_marker;
- competitor_mention.

`hint_type` e TEXT livre (sem CHECK fechado a partir de migration 0011). Convencao
para extensibilidade por segmento:

- hints genericos vivem em `segments/generic/rules.json`;
- hints especificos de segmento podem usar prefixo namespaced quando o termo so
  faz sentido naquele vertical (ex.: `tire_size_mentioned`, `mortgage_request`).

Auditoria contra termos de segmento no nucleo continua via grep no diretorio
`src/enrichment/*` no checklist de fork.

Fonte esperada:

```text
source = deterministic_rules_v1
truth_type = observed
extractor_version = f2a_rules_v1
ruleset_hash = <sha256>
```

F2A-02 deve criar migration nova com UNIQUE para idempotencia. Nao usar delete+insert
como solucao principal.

### `analytics.conversation_facts`

Para fatos extraidos.

Exemplos genericos:

- product_asked;
- price_quoted;
- shipping_quoted;
- payment_method.

Fatos especificos, como `tire_size`, entram apenas no pacote de segmento.

Fatos gerados por regras devem carregar `ruleset_hash`. Backfill de linhas antigas
deve usar sentinela explicita:

```text
ruleset_hash = pre_audit_v1
```

### `analytics.conversation_classifications`

Para classificacoes derivadas.

F2A-03 deve preencher classificacoes genericas:

- stage_reached;
- buyer_intent;
- urgency;
- final_outcome;
- loss_reason.

Nao usar valor quando nao houver evidencia clara.

Classificacoes geradas a partir de hints/facts de regras devem carregar o
`ruleset_hash` usado como entrada. Se uma classificacao combinar varios hashes,
usar hash deterministico da lista ordenada de hashes de entrada.

Observacao: classificacoes genericas tem cobertura limitada. `loss_reason=delivery`
e `loss_reason=stock`, por exemplo, ficam mais fortes quando um pacote de segmento
adiciona vocabulario especifico. Antes disso, gravar apenas quando houver evidencia
generica clara.

### `analytics.customer_journey`

Pode ficar para uma entrega posterior da F2a. Ela depende de agregacao por contato,
nao de linguagem.

## Versionamento dos extratores

Cada familia de regra deve ter versao explicita:

```text
f2a_signals_v1
f2a_rules_v1
f2a_classification_v1
f2a_tires_v1
```

Politica:

- `conversation_signals`: snapshot atual, upsert por `conversation_id`.
- `conversation_facts`: historico por `extractor_version` e `ruleset_hash`.
- `conversation_classifications`: historico por `extractor_version` e `ruleset_hash` quando derivada de regras.
- `linguistic_hints`: historico por `extractor_version` e `ruleset_hash`, com UNIQUE novo na F2A-02.

Retencao:

- manter versoes antigas durante auditoria e comparacao;
- antes de cada novo bump grande, documentar se a versao antiga sera preservada,
  arquivada ou removida por script operacional;
- nunca apagar resultado antigo sem tarefa explicita.

## Idempotencia

Rodar o enrichment duas vezes nao pode duplicar linhas.

Padroes:

- `conversation_signals`: upsert por `conversation_id`.
- `conversation_facts`: usar chave existente `(environment, conversation_id, fact_key, source, extractor_version)`.
- `conversation_classifications`: em F2A-03, adicionar `ruleset_hash` e usar chave
  `(environment, conversation_id, dimension, source, extractor_version, ruleset_hash)`.
- `linguistic_hints`: criar UNIQUE em migration nova na F2A-02. Chave sugerida:
  `(environment, conversation_id, message_id, hint_type, pattern_id, source, extractor_version, ruleset_hash)`.

## Fronteira de fork

Quando F2A-03 terminar, avisar Wallace:

```text
Chegamos na fronteira do fork. Agora o nucleo generico tem signals, regras e
classificacoes sem regra de pneu. Este e o ponto para criar a tag
farejador-base-v1, se o checklist operacional estiver verde.
```

Nao criar `segments/tires` antes desse aviso.
