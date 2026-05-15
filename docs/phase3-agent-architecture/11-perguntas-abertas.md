# 11 - Perguntas Abertas

Estas decisoes nao bloqueiam o desenho do banco, mas precisam ser fechadas antes de implementar a integracao completa.

## LLM usada

**Decidido em 2026-04-29:** OpenAI gpt-5.4 / gpt-5.4-mini, em producao via Organizadora e Generator (shadow).

Arquitetura permanece agnostica para troca futura, mas variaveis de ambiente atuais (`OPENAI_API_KEY`, `GENERATOR_OPENAI_API_KEY`, `OPENAI_MODEL`, `GENERATOR_MODEL`) assumem provider OpenAI.

## Modo Shadow Assistido

Decisao registrada:

- Wallace atende manualmente por aproximadamente 5 semanas;
- LLM Organizadora roda;
- LLM Atendente fica desligada;
- os dados reais calibram a automacao futura.

Ainda decidir:

- quais relatorios revisar semanalmente;
- quais criterios liberam piloto da Atendente;
- quais conversas viram exemplos de prompt.

## PII no prompt

Decidir depois:

- mandar nome, telefone e endereco;
- anonimizar parcialmente;
- anonimizar totalmente.

Impacta custo de codigo e LGPD.

## Horario comercial

Decidir depois:

- bot responde 24/7;
- bot responde diferente fora do horario;
- bot coleta dados e promete retorno humano.

Nao muda o schema principal.

## Falha da LLM/API

Decidir depois:

- retry;
- fallback;
- escalacao;
- mensagem padrao.

Recomendacao inicial:

```text
retry curto -> fallback educado -> registrar incidente
```

## Deployment

**Decidido em 2026-04-29:** servico unico no Coolify. Atendente, Organizadora e Farejador rodam no mesmo container/processo, controlados por feature flags (`ATENDENTE_SHADOW_ENABLED`, `ORGANIZADORA_ENABLED`).

Separacao em multiplos containers fica como possibilidade futura, nao prioridade.

## analytics marts

**Implementado em 2026-04-29:** schema `analytics_marts` ativo em prod via migration `0023_analytics_marts_v1.sql`. Views disponiveis: `organizadora_quality_daily`, `daily_demand_by_tire`, `daily_demand_by_neighborhood`, `daily_customer_intent`, etc.

Materializacao das views mais usadas e dashboard (Metabase ou similar) ainda pendentes.

## Pedido automatico

Schema pode nascer preparado.

Execucao automatica fica desligada no v1.

## LLM Supervisora

**Decisao 2026-05-10 (ADR-006):** adiada para Fase G original (depois de Sprint 8 maduro). NAO e proximo passo.

Respostas as 4 perguntas:

- vale criar? Sim, mas calibracao depende de dataset humano (Fase D estendida) + envio em producao.
- todas as conversas ou apenas perdas/fallbacks? Comecar por todos os turnos `status='generated'` nao bloqueados.
- quais tabelas? `ops.supervisor_reviews` + `ops.supervisor_reason_codes` (vocabulario evolutivo).
- modelo? `gpt-5.4-mini` configuravel via env.

NOTA: Critic em tempo real (Sprint 7 original) foi DESCARTADO em 2026-05-10 (ADR-005). NAO sera implementado. SayValidator + ActionValidator sao o gate sincrono pre-envio (ADR-007).
