# Runbook operacional — Etapa 5 RLS

**Data:** 2026-05-21
**Tipo:** Runbook manual (executado uma vez por humano, fora do Git)
**Documentos relacionados:**
- [`PLANO_ETAPA5_RLS_2026-05-21_V2.md`](PLANO_ETAPA5_RLS_2026-05-21_V2.md) — V2 do plano
- [`REVISAO_CODEX_PLANO_ETAPA5_RLS_2026-05-21.md`](REVISAO_CODEX_PLANO_ETAPA5_RLS_2026-05-21.md) — Revisão V1

**Importante:** este runbook NÃO contém segredos reais. Toda senha é gerada localmente pelo operador e guardada fora do Git.

---

## Pré-requisitos

- Acesso ao Supabase Dashboard do projeto Farejador (admin SQL)
- Acesso ao Coolify Application do Farejador (`farejador-pneus:main`)
- Gerenciador de senha local (1Password, Bitwarden, KeePass ou similar)
- Migration `db/migrations/0044_partner_rls_policies.sql` aplicada no repo via commit
- Código TS da Etapa 5 já no repo via commit (mas ainda não deployado)
- Testes locais com Postgres fresh **passando verdes** (gate obrigatório)

---

## Ordem das operações

Ordem crítica — não inverter:

```
1. Gerar senha (local)
2. Criar role no Supabase
3. Aplicar migration 0044 no Supabase
4. Validar SQL pós-migration
5. Construir PARTNER_DATABASE_URL
6. Adicionar PARTNER_DATABASE_URL no Coolify
7. Redeploy no Coolify
8. Smoke tests pós-deploy
```

Se inverter (ex: redeploy antes de criar role), a aplicação tenta conectar com credencial inexistente → portal cai.

---

## Passo 1 — Gerar senha forte (local)

No terminal local (Windows PowerShell ou bash):

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

Saída esperada: string base64url de ~32 caracteres, tipo `xY9z-AbC...QwErTy_-`.

**Procedimento:**
1. Copiar o output
2. Guardar no gerenciador de senha com o label "Farejador — farejador_partner_app prod 2026-05-21"
3. **Não colar em chat, e-mail ou repositório**

---

## Passo 2 — Criar role no Supabase

Supabase Dashboard → SQL Editor → **New query**:

```sql
-- Substituir <SENHA_DO_PASSO_1> pelo valor copiado do gerenciador.
-- NÃO commitar este SQL com a senha real — é execução manual única.

CREATE ROLE farejador_partner_app
  LOGIN
  PASSWORD '<SENHA_DO_PASSO_1>'
  NOSUPERUSER
  NOBYPASSRLS
  NOINHERIT;

-- Garantia (no-op se já criou com flags certos):
ALTER ROLE farejador_partner_app NOSUPERUSER NOBYPASSRLS NOINHERIT;
```

Executar. Esperado: `CREATE ROLE` e depois `ALTER ROLE`.

**Confirmação:**

```sql
SELECT rolname, rolbypassrls, rolsuper, rolcanlogin
FROM pg_roles
WHERE rolname = 'farejador_partner_app';
```

Esperado: 1 linha com `rolbypassrls=false`, `rolsuper=false`, `rolcanlogin=true`.

---

## Passo 3 — Aplicar migration 0044 no Supabase

Supabase Dashboard → SQL Editor → **New query** → colar o conteúdo de:

```
db/migrations/0044_partner_rls_policies.sql
```

Executar. Esperado:

- Várias mensagens `CREATE FUNCTION`, `ALTER TABLE`, `CREATE POLICY`, `ALTER VIEW`, `GRANT`
- Nenhuma exceção do bloco `DO` final

Se o `DO` final levantar:
- `0044 falhou: role farejador_partner_app nao existe ou tem BYPASSRLS` → voltar ao passo 2
- `0044 falhou: esperado RLS em 9 tabelas` → algum `ENABLE RLS` não pegou; investigar
- `0044 falhou: esperado 9 policies` → policy não criada; verificar erros acima na execução

---

## Passo 3.5 — Checagens de segurança adicionais (Codex)

Antes de prosseguir, validar 2 invariantes de segurança que o Codex pediu:

### 3.5.1 Confirmar que PUBLIC não consegue criar em `public`

Apesar da `validate_partner_token` não usar mais `public` no `search_path`
(foi removida na V2 final), vale auditar a invariante geral:

```sql
SELECT has_schema_privilege('public', 'public', 'CREATE') AS public_pode_criar_em_public;
```

**Esperado:** `false`. Se vier `true`, qualquer role login pode criar function/operator
em `public`, o que vira surface de ataque pra qualquer `SECURITY DEFINER` com
`public` no `search_path` no projeto. Investigar antes de prosseguir.

### 3.5.2 Confirmar onde está a `digest()` da pgcrypto

```sql
SELECT n.nspname AS schema, p.proname AS function, pg_get_function_identity_arguments(p.oid) AS args
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.proname = 'digest';
```

**Esperado:** `schema = extensions` no Supabase prod (ou `public` em Postgres vanilla).
Documentar onde está pra futura referência.

**Importante:** a V2 final da Etapa 5 **não depende mais** de `digest()` da pgcrypto.
A `validate_partner_token` usa `sha256()` nativo do `pg_catalog`. Mas a function
`network.hash_partner_token` (criada na 0035) continua usando `digest()` — isso
não afeta a Etapa 5 porque ninguém chama `hash_partner_token` de dentro de
SECURITY DEFINER restrita. Validado por testes de integração.

---

## Passo 4 — Validar SQL pós-migration

Rodar no Supabase SQL Editor:

```sql
-- A) Role tem flags certos
SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname = 'farejador_partner_app';
-- Esperado: rolbypassrls = false

-- B) 9 tabelas com RLS habilitada
SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relrowsecurity = true
  AND (
    (n.nspname = 'commerce' AND c.relname IN ('partner_orders','partner_order_items',
      'partner_purchases','partner_purchase_items','partner_stock_levels'))
    OR (n.nspname = 'finance' AND c.relname = 'partner_expenses')
    OR (n.nspname = 'network' AND c.relname IN ('partner_units','partners','partner_access_tokens'))
  );
-- Esperado: 9

-- C) 9 policies estritas (nenhuma com IS NULL OR)
SELECT tablename, policyname, qual
FROM pg_policies
WHERE schemaname IN ('commerce','finance','network')
  AND tablename IN ('partner_orders','partner_order_items','partner_purchases',
    'partner_purchase_items','partner_stock_levels','partner_expenses',
    'partner_units','partners','partner_access_tokens');
-- Esperado: 9 linhas, todas com 'IS NOT NULL AND' no qual

-- D) Views com security_invoker
SELECT relname, reloptions FROM pg_class
WHERE relkind = 'v'
  AND relname IN ('partner_unit_summary','partner_orders_full');
-- Esperado: reloptions contendo 'security_invoker=true' em ambas

-- E) Function validate_partner_token tem search_path restrito
SELECT proname, prosrc, proconfig
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'network' AND proname = 'validate_partner_token';
-- Esperado: proconfig contém '{search_path=pg_catalog, network}'

-- F) Function tem PUBLIC revogado
SELECT proacl FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'network' AND proname = 'validate_partner_token';
-- Esperado: proacl NÃO contém entry pra 'PUBLIC'/'='
```

Se qualquer um dos 6 checks falhar, **NÃO prosseguir** — investigar antes.

---

## Passo 4.5 — Trade-offs de segurança aceitos (registro explícito)

Esta seção existe pra Wallace e Codex assinarem ciência dos trade-offs
deliberados da Etapa 5 V2. Não é checklist — é registro pra auditoria
futura saber que foram decisões conscientes, não omissões.

### Trade-off 1 — `GRANT SELECT ON core.units` à role restrita

A role `farejador_partner_app` ganha SELECT em **toda** a tabela `core.units`.
Significa que parceiro com token válido pode descobrir, das **outras** unidades
da rede (matriz + outros parceiros):

- `id, environment, slug, name` (esperado — não é segredo)
- **`address`** (endereço completo da unidade)
- **`phone`** (telefone da unidade)
- `is_active, created_at, updated_at`

**O que parceiro NÃO consegue:** dados financeiros (vendas, compras, estoque,
despesas) — esses estão em `commerce.partner_*` e `finance.partner_expenses`,
protegidos por RLS estrita.

**Por que aceitamos:**
- Os triggers `env_match_partner_*_unit` (das migrations 0035 e 0043) precisam
  ler `core.units.environment` pra impedir mistura entre `prod` e `test`. Essa
  invariante é mais crítica que ocultar endereço/telefone.
- Solução alternativa (view `security_invoker` filtrando colunas + reescrever
  triggers pra usar a view) é refator grande, fora do escopo da auditoria
  2026-05-21.
- Parceiro não tem rota direta pra fazer SELECT arbitrário em `core.units`
  pelo portal — só consegue via comprometimento de credencial ou SQL injection
  (que seria bug mais grave em outro lugar).

**Quando revisitar:** quando rede passar de 20 parceiros ou se algum parceiro
mostrar preocupação concreta com privacidade de contato.

### Trade-off 2 — `GRANT SELECT ON commerce.products` à role restrita

A role pode ler todo o catálogo de produtos da matriz (modelos, marcas,
códigos). **Não inclui preço nem estoque** (esses estão em tabelas separadas
sem GRANT).

**Por que aceitamos:** parceiros operam vendendo pneus que vêm da matriz —
conhecem o catálogo pela rotina. Não é segredo competitivo.

### Trade-off 3 — search_path da `validate_partner_token`

Final ficou:

```sql
SET search_path = pg_catalog, network
```

Sem `public`, sem `extensions`. **Custo:** tive que substituir
`network.hash_partner_token(...)` por `encode(sha256(p_token::bytea), 'hex')`
inline dentro da function, porque `hash_partner_token` chama `digest()` da
pgcrypto (que ficaria fora do search_path).

**Equivalência matematicamente confirmada:**
`encode(sha256(text::bytea), 'hex') = encode(digest(text, 'sha256'), 'hex')`.
Tokens já existentes em prod continuam válidos.

---

## Passo 5 — Construir PARTNER_DATABASE_URL

Pegar a `DATABASE_URL` atual do Coolify. Formato:

```
postgresql://postgres.<projid>:<senha_postgres>@<host>:<porta>/postgres
```

Construir `PARTNER_DATABASE_URL` substituindo:
- Usuário `postgres.<projid>` por `farejador_partner_app`
- Senha do `postgres` pela senha gerada no passo 1

```
postgresql://farejador_partner_app:<SENHA_PASSO_1>@<host>:<porta>/postgres
```

**Testar a conexão antes de usar no Coolify:**

```bash
# Substituir <CONN_STR> pela connection string acima
psql "<CONN_STR>" -c "SELECT current_user, current_database();"
```

Esperado: `current_user = farejador_partner_app`.

Se falhar com `password authentication failed`: senha errada — voltar ao passo 1 ou conferir o que foi colado no passo 2.

---

## Passo 6 — Adicionar PARTNER_DATABASE_URL no Coolify

Coolify → Application `farejador-pneus:main` → **Environment Variables** → Add:

- **Name:** `PARTNER_DATABASE_URL`
- **Value:** connection string completa do passo 5
- **Available at Buildtime:** **desmarcado** (Runtime only — segue padrão do `DATABASE_URL`)
- Salvar

**Confirmação visual:**
- A variável aparece na lista com valor mascarado
- `DATABASE_URL` original continua **intocada** (não confundir)

---

## Passo 7 — Redeploy no Coolify

Pré-condições:
- Código TS da Etapa 5 já está no `main` (commit + push concluídos)
- Migration 0044 aplicada com sucesso (passo 3-4)
- `PARTNER_DATABASE_URL` configurada (passo 6)

Procedimento:
1. Coolify → Application `farejador-pneus:main` → botão **Redeploy** (canto superior direito)
2. Acompanhar log da aba **Deployments**
3. Aguardar `Rolling update completed.`
4. Bolinha de status fica verde

Tempo esperado: 3-5 minutos.

Se falhar:
- Build error → cola log pra investigar
- Runtime error (`PARTNER_DATABASE_URL` inválida) → confirma passo 5+6
- `permission denied` em alguma tabela → falta GRANT, voltar ao passo 3 com ajuste

---

## Passo 8 — Smoke tests pós-deploy

### 8.1 Portal Parceiro continua acessível

```bash
curl -I http://sgicmrjkuah6hhcykbrrn1ar.76.13.164.152.sslip.io/parceiro/borracharia-rio-do-ouro/
# Esperado: HTTP 200
```

Abrir no navegador, colar token, confirmar Resumo carrega.

### 8.2 Bot continua respondendo Chatwoot

- Mandar 1 mensagem teste no Chatwoot
- Confirmar que `raw.raw_events` ganha linha (via SQL no Supabase)

### 8.3 Painel admin continua mostrando Rede

```bash
curl -I -H "Authorization: Bearer <ADMIN_TOKEN>" \
  http://sgicmrjkuah6hhcykbrrn1ar.76.13.164.152.sslip.io/admin/api/dashboard/rede?period=month
# Esperado: HTTP 200
```

Abrir `/admin/painel` no navegador, ver aba **Rede** carregando Rio do Ouro.

### 8.4 Isolamento real (teste manual)

Criar unidade B temporária:

```sql
-- Cria unidade B teste no Supabase (manual)
INSERT INTO core.units (environment, slug, name) VALUES ('prod', 'teste-isolamento-b', 'Teste B Isolamento');
INSERT INTO network.partners (environment, legal_name, trade_name, status, commercial_model)
  VALUES ('prod', 'Teste B', 'Teste B', 'active', 'commission');
INSERT INTO network.partner_units (environment, partner_id, unit_id, slug, display_name, status)
  SELECT 'prod', p.id, u.id, 'teste-isolamento-b', 'Teste B Isolamento', 'active'
  FROM network.partners p, core.units u
  WHERE p.legal_name = 'Teste B' AND u.slug = 'teste-isolamento-b';
```

Tentar acessar `/parceiro/teste-isolamento-b/` com o token de Rio do Ouro:
- Esperado: 401 (token não pertence a essa unidade)

Limpar depois:

```sql
DELETE FROM network.partner_units WHERE slug = 'teste-isolamento-b';
DELETE FROM network.partners WHERE legal_name = 'Teste B';
DELETE FROM core.units WHERE slug = 'teste-isolamento-b';
```

### 8.5 Performance

Medir tempo de resposta de 3 endpoints (rodar 5x cada, pegar mediana):

```bash
curl -w "%{time_total}\n" -o /dev/null -s \
  -H "Authorization: Bearer <TOKEN_PARCEIRO>" \
  http://sgicmrjkuah6hhcykbrrn1ar.76.13.164.152.sslip.io/parceiro/borracharia-rio-do-ouro/api/resumo
```

Esperado: < 100ms. Aceitável até 150ms.

---

## Rollback (se algo der ruim)

### Rollback rápido — sem mexer no banco

Coolify → Application → Environment Variables → **remover** `PARTNER_DATABASE_URL` → Redeploy.

Código volta a usar `DATABASE_URL` original (role `postgres` com BYPASSRLS). RLS continua aplicada no banco mas inerte porque ninguém usa a role restrita.

Tempo: 1-2 min.

### Rollback do código (commit anterior)

Coolify → aba **Deployments** → encontrar deploy anterior → **Rollback**.

### Rollback completo da migration

Ver seção 9.3 do `PLANO_ETAPA5_RLS_2026-05-21_V2.md`. Não é necessário em 95% dos casos — basta o rollback rápido.

---

## Pós-execução

Depois que tudo estiver OK:

1. Atualizar `docs/EXECUCAO_AUDITORIA_2026-05-21.md` com seção "Etapa 5 concluída"
2. Marcar C1, C2, C3 da auditoria como ✅ resolvidos
3. Score do módulo sobe de 7,8 para ~8,8

---

*Runbook criado em 2026-05-21 por Claude Opus 4.7, em resposta ao ponto 2 da revisão Codex da V2. Sem segredos reais. Documento operacional pra execução manual única.*
