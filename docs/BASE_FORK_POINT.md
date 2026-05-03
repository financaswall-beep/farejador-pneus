# Ponto de bifurcacao do Farejador Base

Atualizado: 03/05/2026

## Objetivo

Este documento define quando o Farejador pode ser salvo como **projeto base** para
ser reaproveitado em outros segmentos, como:

- pneus;
- imobiliaria;
- material de construcao;
- autopecas;
- clinicas;
- servicos locais.

## Veredito curto

Nota de 03/05/2026: este documento virou referencia historica da fronteira
da base generica. O fork operacional de pneus ja evoluiu com Organizadora LLM
e Worker Shadow da Atendente. Para o estado vivo, use `docs/PROJECT.md`,
`docs/NEXT_CHAT_HANDOFF.md` e
`docs/phase3-agent-architecture/00-estado-de-implementacao.md`.

Codigo pronto para tag `farejador-base-v1`. Tag aguardando checklist operacional.

Esqueleto generico da Fase 2a esta completo (F2A-01/02/03). Regras especificas de pneus
ainda nao foram criadas — `segments/tires` so depois da tag (F2A-05).

Pendencias antes de criar a tag:

1. Shadow mode real rodado por periodo combinado sem fila travada.
2. ~~Secrets rotacionados antes de producao plena.~~ **Dispensado em 26/04/2026:** o repo base (`farejador-base-v1`) sera arquivado como template e nao operara em producao plena. O fork operacional (ex.: `segments/tires`) sera criado em repo novo com secrets novos por construcao.
3. ~~`DATABASE_CA_CERT` configurado no Coolify.~~ **Resolvido em 26/04/2026:** Supabase connection pooler nao suporta validacao de cadeia de cert. SSL permanece ativo via `rejectUnauthorized:false` — conexao criptografada. Codigo simplificado em `src/persistence/db.ts`, variavel removida de `env.ts`.
4. Harness de integracao automatizado com Postgres real (ou decisao documentada).

Nome sugerido para a tag/base:

```text
farejador-base-v1
```

## O que precisa estar pronto antes de bifurcar

### Obrigatorio

- [x] Fase 1 tecnica concluida.
- [x] Replay real testado sem duplicar `core.*`.
- [x] Reconcile real testado em janela pequena.
- [x] Dois workers concorrentes validados com Postgres real.
- [ ] Shadow mode real rodado por periodo combinado sem fila travada.
- [x] ~~Secrets rotacionados antes de producao plena.~~ Dispensado: repo base sera arquivado como template; fork operacional usara secrets novos.
- [x] ~~`DATABASE_CA_CERT` configurado no Coolify.~~ Resolvido: pooler nao suporta validacao; SSL ativo sem validacao de cadeia.
- [ ] Harness de integracao automatizado com Postgres real.
- [ ] Documentacao de deploy atualizada.
- [x] Checklist e handoff atualizados.

### Esqueleto minimo da Fase 2a

- [x] Arquitetura F2a documentada.
- [x] Prompt F2A-01 criado para Kimi.
- [x] Worker/servico generico de enrichment deterministico (F2A-01 + CLI `npm run enrich`).
- [x] Estrutura de regras declarativas por segmento (`segments/generic`, `segments/_template`).
- [x] Roteamento de segmento por `environment + chatwoot_account_id` (`segments/routing.json`).
- [x] Classificacoes deterministicas genericas (F2A-03, dimensoes urgency/buyer_intent/stage_reached/loss_reason/final_outcome).
- [x] Escrita somente em `analytics.*` (signals, hints, facts, classifications).
- [x] Nenhuma regra de pneu hardcoded no nucleo (verificado por grep em `src/enrichment` em 26/04/2026).
- [x] Teste provando que um segmento pode ser trocado sem mexer em `raw.*` ou `core.*` (`segments/_template` carregavel via `loadSegment`).

## O que deve ficar no nucleo base

O nucleo base deve ser reutilizavel para qualquer negocio que use Chatwoot.

Fica no base:

- ingestion de webhook;
- validacao HMAC;
- dedup por delivery id;
- persistencia em `raw.raw_events`;
- worker de normalizacao;
- tabelas `core.contacts`, `core.conversations`, `core.messages`;
- attachments;
- status events;
- assignments;
- replay;
- reconcile;
- healthcheck;
- motor generico de sinais da Fase 2a;
- contratos de origem, auditoria e idempotencia.

## O que nao deve ficar hardcoded no nucleo

Nao colocar direto no codigo base:

- regra especifica de pneu;
- lista de marcas de pneu;
- medidas de pneu como unica gramatica aceita;
- funil exclusivo de pneus;
- motivos de perda exclusivos de pneus;
- relatorios especificos de pneus;
- termos como "frete de pneu", "montagem", "alinhamento" dentro do motor generico.

Essas coisas devem ir para um pacote de segmento.

## Estrutura sugerida para segmentos

Quando a Fase 2a comecar, usar algo nesta linha:

```text
segments/
  tires/
    rules.json
    lexicon.json
    scenarios.json
    README.md

  real-estate/
    rules.json
    lexicon.json
    scenarios.json
    README.md

  construction-materials/
    rules.json
    lexicon.json
    scenarios.json
    README.md
```

O codigo base le esses arquivos e aplica regras. O segmento muda o vocabulario e o
funil, nao a arquitetura.

## Exemplo de separacao

### Base generica

```text
Cliente perguntou produto?
Atendente informou preco?
Cliente mostrou intencao de compra?
Cliente abandonou apos orcamento?
Cliente reclamou de preco?
```

### Segmento pneus

```text
Produto = pneu 100/80-18
Marca = Pirelli / Goodyear / Maggion
Servico = montagem / alinhamento / balanceamento
Motivo de perda = falta de estoque / preco / prazo / frete
```

### Segmento imobiliaria

```text
Produto = casa / apartamento / terreno
Sinal = bairro / valor / financiamento / visita
Motivo de perda = preco / localizacao / documentacao / financiamento recusado
```

### Segmento material de construcao

```text
Produto = cimento / areia / bloco / tinta
Sinal = quantidade / entrega / obra / urgencia
Motivo de perda = frete / prazo / estoque / preco
```

## Quando criar a tag `farejador-base-v1`

Momento exato: depois de concluir F2A-03 e antes de criar `segments/tires`.

Criar a tag quando estes comandos estiverem verdes:

```text
npm run typecheck
npm test
npm run build
```

E quando estes testes operacionais estiverem documentados:

```text
Chatwoot real -> webhook -> raw -> core
Replay real sem duplicacao
Reconcile real em janela pequena
Worker concorrente com Postgres real
Shadow mode sem fila travada
Secrets rotacionados
DATABASE_CA_CERT configurado
```

Comando sugerido:

```text
git tag farejador-base-v1
git push origin farejador-base-v1
```

## Aviso para o Codex

Quando o usuario perguntar se ja pode bifurcar, responder:

```text
Ainda nao, se algum item obrigatorio deste documento estiver pendente.
Sim, se a Fase 1 tecnica estiver concluida, as ressalvas de producao plena estiverem
controladas e a Fase 2a generica estiver criada sem regras de segmento hardcoded no nucleo.
```

## Decisao registrada

O primeiro pacote de segmento sera `segments/tires`, mas somente depois da tag/base
`farejador-base-v1`. Antes dessa fronteira, pneus pode aparecer em fixtures e docs
de referencia, mas nao em `src/enrichment/*` nem em `segments/tires`.
