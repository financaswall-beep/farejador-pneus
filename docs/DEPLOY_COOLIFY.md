# Deploy no Coolify — Chatwoot + Farejador

Este guia explica como subir o **fazer-ai/chatwoot** e o **Farejador** no seu Coolify e conectá-los.

---

## 1. Pré-requisitos

- Coolify v4 instalado e acessível.
- Domínio/subdomínio ou IP público do servidor.
- Para teste sem dominio, use `http://<farejador-host>:3000` para o Farejador.
- Acesso ao painel do Coolify.

---

## 2. Subir o Chatwoot

O repo `fazer-ai/chatwoot` já tem um `docker-compose.coolify.yaml` otimizado para o Coolify.

### Passo a passo

1. No painel do Coolify, clique em **New Project** ou use um projeto existente.
2. Dentro do projeto, clique em **New Resource** → **Docker Compose**.
3. Escolha **Git Repository** e cole a URL:
   ```
   https://github.com/fazer-ai/chatwoot
   ```
4. No campo **Docker Compose Path**, informe:
   ```
   docker-compose.coolify.yaml
   ```
5. O Coolify vai detectar os serviços (`rails`, `sidekiq`, `postgres`, `redis`).
6. Aguarde o build/deploy inicial.

### Variáveis de ambiente obrigatórias no Chatwoot

No painel do serviço `rails` (e `sidekiq`) no Coolify, configure:

| Variável | Valor / Instrução |
|----------|-------------------|
| `FRONTEND_URL` | O Coolify preenche automaticamente via `${SERVICE_URL_RAILS}`. Verifique se ficou com `https://`. |
| `SECRET_KEY_BASE` | O Coolify gera automaticamente `${SERVICE_PASSWORD_64_SECRETKEYBASE}`. |
| `POSTGRES_HOST` | `postgres` (nome do serviço no compose) |
| `REDIS_URL` | `redis://redis:6379` |
| `BAILEYS_PROVIDER_DEFAULT_CLIENT_NAME` | Nome do cliente WhatsApp (se usar Baileys) |
| `BAILEYS_PROVIDER_DEFAULT_URL` | URL do serviço Baileys |
| `BAILEYS_PROVIDER_DEFAULT_API_KEY` | API key do Baileys |
| `MAILER_SENDER_EMAIL` | Email de envio (ex: `noreply@seudominio.com`) |
| `RESEND_API_KEY` | API key do Resend para envio de emails |

> **Dica:** O Coolify gera automaticamente `SERVICE_USER_POSTGRES`, `SERVICE_PASSWORD_POSTGRES` e `SERVICE_PASSWORD_REDIS`.

---

## 3. Preparar o banco de dados para o Farejador

Recomendação atual: use o Supabase/Postgres separado que já foi configurado para o Farejador.
Isso mantém o Chatwoot e o Farejador desacoplados operacionalmente.

### Opção A — Supabase externo recomendado

Use a `DATABASE_URL` do Supabase no serviço do Farejador e mantenha:

```env
DATABASE_SSL=true
```

### Opção B — Mesmo Postgres do Chatwoot, database separado (avançado)

Só use essa opção para economia e teste controlado. Nunca use o database
`chatwoot_production` para o Farejador.

1. No Coolify, acesse o container `postgres` do Chatwoot.
2. Crie um banco separado para o Farejador:
   ```sql
   CREATE DATABASE farejador_prod;
   ```
3. A `DATABASE_URL` do Farejador será:
   ```text
   postgresql://<usuario>:<senha>@postgres:5432/farejador_prod
   ```
4. Nesse caso, configure:
   ```env
   DATABASE_SSL=false
   ```

> **Atenção:** Nunca misture dados do Chatwoot com os dados do Farejador no mesmo `database`. Sempre use databases separados no mesmo servidor Postgres.

---

## 4. Subir o Farejador

1. No Coolify, no **mesmo projeto** do Chatwoot (ou em outro), clique em **New Resource** → **Docker Compose**.
2. Escolha **Git Repository** e cole a URL do repo do Farejador.
3. No campo **Base Directory**, informe:
   ```
   /
   ```
4. No campo **Docker Compose Location**, informe:
   ```
   /docker-compose.farejador.coolify.yaml
   ```
5. O Coolify vai detectar o serviço `farejador`.

### Variáveis de ambiente obrigatórias no Farejador

No painel do serviço `farejador`, configure:

| Variável | Valor / Instrução |
|----------|-------------------|
| `NODE_ENV` | `production` |
| `FAREJADOR_ENV` | `prod` |
| `PORT` | `3000` |
| `LOG_LEVEL` | `info` (ou `debug` para investigar problemas) |
| `DATABASE_URL` | `postgresql://...` (do passo 3 — Supabase ou Postgres local) |
| `DATABASE_POOL_MAX` | `10` |
| `DATABASE_SSL` | `true` (se usar Supabase ou SSL forçado) ou `false` (se for Postgres interno sem SSL) |
| `CHATWOOT_HMAC_SECRET` | **Você deve gerar** — veja abaixo. |
| `CHATWOOT_WEBHOOK_MAX_AGE_SECONDS` | `300` |
| `CHATWOOT_API_BASE_URL` | Para teste sem dominio: `http://<chatwoot-host>/api/v1`. Em producao com dominio, use `https://chatwoot.seudominio.com/api/v1`. |
| `CHATWOOT_API_TOKEN` | Token de acesso da API do Chatwoot — veja abaixo como gerar. |
| `CHATWOOT_ACCOUNT_ID` | ID da conta no Chatwoot (geralmente `1` para a primeira conta). |
| `ADMIN_AUTH_TOKEN` | **Você deve gerar** — veja abaixo. |

#### Como gerar os secrets

Execute no seu terminal local (ou no container do Farejador):

```bash
# HMAC secret (mínimo 32 caracteres, aleatório)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Admin auth token (mínimo 32 caracteres, aleatório)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

#### Como obter o CHATWOOT_API_TOKEN

1. Acesse o painel do Chatwoot como administrador.
2. Vá em **Configurações** → **Conta** → **Tokens de acesso** (ou similar, dependendo da versão).
3. Gere um novo token ou use um existente.
4. Anote o valor — ele vai em `CHATWOOT_API_TOKEN`.

#### Como descobrir o CHATWOOT_ACCOUNT_ID

1. No painel do Chatwoot, olhe a URL ou acesse **Configurações**.
2. O `account_id` aparece nas URLs da API ou nas configurações.
3. Para a primeira conta criada, geralmente é `1`.

---

## 5. Conectar Chatwoot → Farejador (Webhook)

O Farejador precisa receber webhooks do Chatwoot.

Faça esta etapa somente depois de:

- aplicar as migrations da seção 6;
- subir o serviço Farejador no Coolify;
- confirmar que `/healthz` responde 200.

### Passo a passo

1. No painel do Chatwoot, vá em **Configurações** → **Aplicativos** → **Webhooks**.
2. Crie um novo webhook com a URL do Farejador:
   ```
   http://<farejador-host>:3000/webhooks/chatwoot
   ```
3. No campo **Secret**, cole o mesmo valor que você gerou para `CHATWOOT_HMAC_SECRET` no Farejador.
4. Selecione os eventos que o Farejador deve receber. No mínimo:
   - `message_created`
   - `conversation_created`
   - `conversation_status_changed`
   - `contact_created`
   - `contact_updated`
5. Salve.

> **Validação:** Após configurar, envie uma mensagem de teste no Chatwoot. O Farejador deve registrar o webhook em `raw.raw_events`.

---

## 6. Aplicar as migrations do Farejador

Antes de começar a receber webhooks, o schema do Farejador deve existir no banco.

As migrations estão em `db/migrations/` como arquivos `.sql` e devem ser executados na ordem:

1. `0001_init_schemas.sql`
2. `0002_raw_layer.sql`
3. `0003_core_layer.sql`
4. `0004_analytics_layer.sql`
5. `0005_ops_layer.sql`
6. `0006_concurrency_guards.sql`

### Como aplicar

1. Acesse o banco Postgres (via terminal do container `postgres` do Chatwoot, ou via SQL Editor do Supabase).
2. Execute cada arquivo SQL na ordem numérica. Exemplo via `psql`:
   ```bash
   psql $DATABASE_URL -f db/migrations/0001_init_schemas.sql
   psql $DATABASE_URL -f db/migrations/0002_raw_layer.sql
   psql $DATABASE_URL -f db/migrations/0003_core_layer.sql
   psql $DATABASE_URL -f db/migrations/0004_analytics_layer.sql
   psql $DATABASE_URL -f db/migrations/0005_ops_layer.sql
   psql $DATABASE_URL -f db/migrations/0006_concurrency_guards.sql
   ```

3. Verifique se os schemas foram criados:
   ```sql
   \dn
   ```
   Deve listar: `raw`, `core`, `analytics`, `ops`.

> **Importante:** O banco deve ter os schemas criados antes do primeiro webhook. Se estiver usando o mesmo Postgres do Chatwoot com database separado, execute as migrations no database do Farejador.

---

## 7. Testar a integração

### Health check

```bash
curl http://<farejador-host>:3000/healthz
```

Esperado:
```json
{"status":"ok","environment":"prod"}
```

### Webhook (HMAC válido)

Use o script de teste local ou envie uma mensagem real pelo Chatwoot.

### Replay (admin)

```bash
curl -X POST \
  -H "Authorization: Bearer <ADMIN_AUTH_TOKEN>" \
  http://<farejador-host>:3000/admin/replay/1
```

Esperado (se existir o raw_event 1):
```json
{"replayed":true,"raw_event_id":1,"previous_status":"processed"}
```

---

## 8. Checklist final

- [ ] Chatwoot acessível via HTTPS.
- [ ] Farejador acessível via HTTPS.
- [ ] Banco de dados do Farejador criado e migrations aplicadas.
- [ ] Variáveis `CHATWOOT_HMAC_SECRET` iguais nos dois lados (Chatwoot webhook secret e Farejador env).
- [ ] Webhook configurado no Chatwoot apontando para `/webhooks/chatwoot` do Farejador.
- [ ] `CHATWOOT_API_TOKEN` válido para reconcile.
- [ ] `ADMIN_AUTH_TOKEN` gerado e anotado em local seguro.
- [ ] Health check responde 200.
- [ ] Teste de mensagem real chega em `raw.raw_events`.

---

## Problemas comuns

| Sintoma | Causa provável | Solução |
|---------|---------------|---------|
| 401 no webhook | HMAC secret diferente ou timestamp expirado | Verifique se o secret é igual nos dois lados. Verifique se o relógio do servidor está sincronizado. |
| 503 no healthz | Banco inacessível | Verifique `DATABASE_URL` e se o banco está na mesma network ou acessível externamente. |
| Webhook não chega | URL errada ou firewall | Verifique a URL no Chatwoot. Teste com `curl` de fora. |
| Duplicatas em core.* | Replay sem idempotência | O normalizador deve tratar duplicatas. Verifique se o worker está rodando. |

---

## Segurança

- Nunca commite o `.env` com secrets reais.
- Nunca exponha `ADMIN_AUTH_TOKEN`, `CHATWOOT_HMAC_SECRET` ou `CHATWOOT_API_TOKEN` em logs.
- Use HTTPS em produção para o webhook (Chatwoot → Farejador).
- O Coolify já gerencia SSL automaticamente se o domínio estiver configurado.
