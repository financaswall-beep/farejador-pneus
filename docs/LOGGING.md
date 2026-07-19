# LOGGING — Padrão de logs

## Stack

- **Biblioteca**: `pino` (rápido, JSON nativo, integração Fastify).
- **Formato**: JSON em produção. `pino-pretty` apenas em `NODE_ENV=development`.
- **Transport**: stdout. Coolify/Supabase capturam.

## Níveis

| Nível | Uso |
|-------|-----|
| `trace` | Não usar em prod. Debug profundo só em dev. |
| `debug` | Detalhes de fluxo. Útil ao investigar bug. |
| `info` | Eventos esperados: webhook recebido, job completado, boot. |
| `warn` | Situação inesperada mas recuperável: retry, duplicata detectada, fora-de-ordem. |
| `error` | Falha que impede o fluxo atual. Inclui stack. |
| `fatal` | Aplicação vai cair. Raro. |

## Campos obrigatórios em todo log

Pino já adiciona `level`, `time`, `pid`, `hostname`. Além desses, sempre incluir
quando disponíveis:

- `environment` — `prod` | `test` (vem de `FAREJADOR_ENV`)
- `request_id` — UUID gerado pelo servidor ou `X-Request-ID` externo validado
- `chatwoot_delivery_id` — quando o log é sobre um webhook específico
- `conversation_id` — UUID interno, quando aplicável
- `message_id` — UUID interno, quando aplicável
- `event_type` — tipo do evento Chatwoot, quando aplicável

## Proibições

1. **Nunca logar payload bruto do Chatwoot em nível `info`.** Pode conter PII. Se
   precisa para debug, use `debug` + ativa explicitamente em dev.
2. **Nunca logar conteúdo de mensagem do cliente** (`message.content`) em nível
   diferente de `debug`.
3. **Nunca logar secrets**: `CHATWOOT_HMAC_SECRET`, `ADMIN_AUTH_TOKEN`, `DATABASE_URL`,
   `CHATWOOT_API_TOKEN`. Use redaction do pino (`redact` option).
4. **Nunca logar telefone, email, nome completo** fora do nível `debug`.
5. **Nunca logar erros como string**. Use `log.error({ err }, 'message')` para o pino
   serializar stack trace.

## Redaction configuration

No setup do pino, configurar:

```ts
pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-chatwoot-signature"]',
      '*.phone_number',
      '*.phone_e164',
      '*.email',
      '*.hmac_secret',
    ],
    censor: '[REDACTED]',
  },
});
```

## Correlação HTTP

- Toda resposta HTTP devolve `X-Request-ID`.
- Um `X-Request-ID` recebido só é preservado com 1–128 caracteres seguros
  (`A-Z`, `a-z`, dígitos, `.`, `_`, `:`, `/` e `-`); caso contrário nasce um UUID.
- O contexto assíncrono injeta `request_id` também nos logs de serviços que usam
  o logger global durante a requisição.
- Nunca use telefone, token, e-mail ou outro dado pessoal como correlation ID.

## Exemplo correto

```ts
log.info(
  { chatwoot_delivery_id, event_type, environment },
  'webhook received',
);

log.warn(
  { chatwoot_delivery_id },
  'duplicate delivery skipped',
);

log.error(
  { err, chatwoot_delivery_id, raw_event_id },
  'normalization failed',
);
```

## Exemplo errado (não fazer)

```ts
log.info(`got webhook with payload ${JSON.stringify(payload)}`); // vaza PII
log.error(`error: ${err.message}`); // perde stack
console.log('processing'); // nunca usar console direto
```
