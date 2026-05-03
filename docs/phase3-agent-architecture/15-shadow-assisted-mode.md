# 15 - Shadow Assistido por 5 Semanas

## Decisao

Antes de ligar a LLM Atendente, Wallace vai atender manualmente por aproximadamente 5 semanas.

Durante esse periodo, o sistema fica em modo:

```text
Wallace + Farejador + LLM Organizadora
```

A LLM Atendente fica projetada, mas desligada.

## Por que isso existe

Com uma media de 100 chamadas novas por dia, 5 semanas devem gerar cerca de:

```text
100 conversas/dia x 35 dias = aproximadamente 3.500 conversas
```

Esse volume e suficiente para observar dados reais antes de automatizar o atendimento.

## O que roda nesse modo

### Roda

- Chatwoot;
- Farejador API;
- normalizacao em `raw.*` e `core.*`;
- `commerce.*` para catalogo, estoque, preco e politicas;
- LLM Organizadora;
- `analytics.*` com facts, evidencias, classificacoes e sinais;
- relatorios/consultas para aprender com as conversas.

### Nao roda

- LLM Atendente respondendo cliente;
- Atendente Worker postando mensagem no Chatwoot;
- action handlers de venda automatica;
- pedido automatico;
- fechamento automatico.

## Feature flags sugeridas

```text
ORGANIZADORA_ENABLED=true
ATENDENTE_SHADOW_ENABLED=false
PLANNER_LLM_ENABLED=false
SUPERVISORA_ENABLED=false
```

Quando chegar a hora de testar a Atendente em log-only:

```text
ATENDENTE_SHADOW_ENABLED=true
```

Mesmo com `ATENDENTE_SHADOW_ENABLED=true`, o sistema nao envia mensagem para o
Chatwoot: o Worker Shadow apenas monta contexto, planeja, executa tools e grava
auditoria. Envio Chatwoot so entra em fase posterior e com autorizacao
explicita.

## O que a Organizadora deve aprender nesse periodo

- motos mais pedidas;
- medidas mais pedidas;
- bairros e municipios mais fortes;
- horarios de pico;
- marcas preferidas;
- marcas recusadas;
- objecoes reais;
- motivos de perda;
- demanda sem estoque;
- concorrentes citados;
- perguntas frequentes;
- respostas humanas que funcionam;
- casos que precisam humano imediatamente.

## Como isso melhora a Atendente

A LLM Atendente nao "aprende" sozinha como modelo.

O que fica mais inteligente e o sistema ao redor dela:

- fact_keys mais corretas;
- prompts melhores;
- skills baseadas em conversas reais;
- catalogo mais completo;
- regras de seguranca calibradas;
- contexto mais rico;
- melhores dashboards;
- melhores criterios de escalacao.

Quando a Atendente for ligada, ela vai conversar usando dados reais da loja, nao suposicoes.

## O que muda na arquitetura

Nada estrutural muda.

O que muda e a ordem de ativacao:

```text
Antes:
criar estrutura -> ligar Organizadora -> ligar Atendente

Agora:
criar estrutura -> ligar Organizadora -> Shadow Assistido por 5 semanas -> ligar Atendente
```

Portanto:

- `agent.*` continua projetado e a fundacao reentrante do Sprint 1 ja existe localmente;
- Planner constrained, skills e validadores completos continuam projetados;
- Atendente Worker continua nao implementado;
- qualquer runtime da Atendente permanece desligado no primeiro periodo.

## Como Wallace trabalha nesse periodo

Wallace responde normalmente no Chatwoot.

O sistema observa:

- o que o cliente pediu;
- como Wallace respondeu;
- se fechou ou perdeu;
- quais dados faltaram;
- quais perguntas apareceram muito.

Depois, isso vira:

- ajustes em `segments/tires`;
- ajustes nas skills;
- novas perguntas no Context Builder;
- novos dashboards;
- possiveis automacoes.

## Criterios para ligar a LLM Atendente

Antes de ligar a Atendente, revisar:

- pelo menos algumas centenas de conversas organizadas;
- top perguntas em `ops.unhandled_messages` ou analise manual equivalente;
- top medidas/motos/bairros;
- motivos de perda mais comuns;
- dados de estoque/preco minimamente confiaveis;
- politicas da loja preenchidas;
- exemplos de respostas humanas boas;
- regras de escalacao aprovadas.

## LLM Supervisora como possibilidade futura

Uma terceira LLM pode existir no futuro:

```text
LLM Supervisora = auditora/gerente de qualidade
```

Ela nao entra no v1.

Uso possivel:

- auditar conversas perdidas;
- revisar respostas da Atendente;
- sugerir nova skill;
- detectar atendimento ruim;
- apontar oportunidade perdida;
- revisar `ops.unhandled_messages`;
- sugerir melhoria de prompt ou politica.

Ela deve rodar em batch, seletiva, fora do tempo real.

Recomendacao:

```text
Fase 3A: Organizadora
Fase 3B: Atendente
Fase 3C: Supervisora opcional
```

Nao colocar a Supervisora em toda mensagem no caminho de resposta inicial.
