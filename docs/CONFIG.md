# CONFIG - Variaveis de Ambiente

Inventario das variaveis de ambiente usadas pelo Farejador.

Todo codigo que le env var deve ler via `src/shared/config/env.ts`
com validacao Zod, exceto overrides explicitamente documentados como
`SEGMENTS_DIR`.

## Variaveis

| Nome | Obrigatoria | Proposito | Exemplo |
| --- | :-: | --- | --- |
| `NODE_ENV` | nao | `development`, `production` ou `test`. Default `development`. | `production` |
| `FAREJADOR_ENV` | sim | Ambiente logico de dados. Vai em toda linha gravada. `prod` ou `test`. | `prod` |
| `PORT` | nao | Porta HTTP do Fastify. Default `3000`. | `3000` |
| `DATABASE_URL` | sim | Connection string do Supabase Postgres, normalmente via pooler em prod. | `postgresql://postgres:...@...:6543/postgres` |
| `DATABASE_POOL_MAX` | nao | Tamanho maximo do pool `pg`. Default `10`. | `10` |
| `DATABASE_SSL` | nao | Forca SSL no pool `pg`. Default `false`; URLs Supabase ativam SSL automaticamente. | `true` |
| `CHATWOOT_HMAC_SECRET` | sim | Segredo para validar `X-Chatwoot-Signature`. | `<secret>` |
| `CHATWOOT_WEBHOOK_MAX_AGE_SECONDS` | nao | Rejeita webhooks com `X-Chatwoot-Timestamp` mais antigo que isso. Default `300`. | `300` |
| `CHATWOOT_API_BASE_URL` | sim para admin | URL base da API do Chatwoot para reconcile. | `https://chatwoot.example.com/api/v1` |
| `CHATWOOT_API_TOKEN` | sim para admin | Token de acesso para reconcile. | `<token>` |
| `CHATWOOT_ACCOUNT_ID` | sim para admin | Conta Chatwoot para reconcile. | `1` |
| `ADMIN_AUTH_TOKEN` | sim | Bearer simples para proteger `/admin/*`. | `<long-random>` |
| `LOG_LEVEL` | nao | `trace`, `debug`, `info`, `warn` ou `error`. Default `info`. | `info` |
| `SKIP_EVENT_TYPES` | nao | Lista CSV de `event_type` a marcar como `skipped` na normalizacao. `raw.raw_events` continua gravado. | `message_updated` |
| `SIGNAL_TIMEZONE` | nao | Timezone IANA usado por sinais deterministicos. Default `America/Sao_Paulo`. | `America/Sao_Paulo` |
| `ORGANIZADORA_ENABLED` | nao | Liga a Organizadora LLM em background. Default `false`. | `true` |
| `OPENAI_API_KEY` | se Organizadora ligada | Chave OpenAI usada pela Organizadora. | `sk-...` |
| `OPENAI_MODEL` | nao | Modelo da Organizadora. Default `gpt-4o-mini`; prod pode sobrescrever. | `gpt-5.4` |
| `OPENAI_TIMEOUT_MS` | nao | Timeout da chamada OpenAI da Organizadora. Default `30000`. | `30000` |
| `ORGANIZADORA_DEBOUNCE_SECONDS` | nao | Espera apos a ultima mensagem antes de organizar. Default `90`. | `90` |
| `ORGANIZADORA_POLL_INTERVAL_MS` | nao | Intervalo de polling do worker da Organizadora. Default `5000`. | `5000` |
| `PLANNER_LLM_ENABLED` | nao | Liga Planner LLM da Atendente. Default `false`. | `false` |
| `PLANNER_OPENAI_API_KEY` | se Planner LLM ligado | Chave OpenAI especifica do Planner. | `sk-...` |
| `PLANNER_MODEL` | nao | Modelo do Planner. Default `gpt-4o-mini`. | `gpt-4o-mini` |
| `ATENDENTE_SHADOW_ENABLED` | nao | Liga Worker Shadow log-only da Atendente. Default `false`. | `true` |
| `ATENDENTE_SHADOW_POLL_INTERVAL_MS` | nao | Intervalo de polling do Worker Shadow. Default `5000`. | `5000` |
| `SEGMENTS_DIR` | nao | Override do diretorio `segments/`. Lido direto de `process.env` pelo loader de regras. | `/opt/farejador/segments` |

## Variaveis Removidas

- `DATABASE_CA_CERT`: removida. O pooler do Supabase usado no projeto nao
  suporta validacao de cadeia como estava planejado; SSL permanece ativo via
  `rejectUnauthorized:false`.
- `ATENDENTE_ENABLED`: nao existe no runtime atual. O controle disponivel hoje
  e `ATENDENTE_SHADOW_ENABLED`, que roda log-only e nao envia Chatwoot.

## Regras

1. Nunca commitar `.env`, `.env.codex` ou qualquer token real.
2. Nunca logar segredo: `DATABASE_URL`, `CHATWOOT_HMAC_SECRET`,
   `ADMIN_AUTH_TOKEN`, `CHATWOOT_API_TOKEN` ou chaves OpenAI.
3. Em Coolify, usar o gerenciador de secrets.
4. Env var nova exige atualizar no mesmo commit:
   `src/shared/config/env.ts`, `.env.example` e este arquivo.
5. Defaults silenciosos sao aceitaveis para flags e intervalos; segredos devem
   falhar no boot quando a funcionalidade correspondente estiver ligada.

## Validacao

No boot da aplicacao (`src/app/server.ts`), o parser Zod de
`src/shared/config/env.ts` valida o ambiente. Se faltar variavel obrigatoria,
o processo deve falhar com mensagem clara.
