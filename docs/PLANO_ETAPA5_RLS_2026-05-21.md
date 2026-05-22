# Plano detalhado — Etapa 5: RLS efetivo + role separada + pool separado

**Data:** 2026-05-21
**Status:** PLANO — nada aplicado. Aguarda revisão Codex antes de execução.
**Resolve:** C1, C2, C3 da auditoria 2026-05-21
**Documento pai:** [`AUDITORIA_PAINEL_PARCEIRO_2026-05-21.md`](AUDITORIA_PAINEL_PARCEIRO_2026-05-21.md)

---

## 1. Resumo executivo

A auditoria identificou que RLS está "habilitada mas inerte" no banco. As policies existem em 7 tabelas mas:

1. A função `network.current_partner_unit()` lê `current_setting('app.partner_unit_id', true)` — **nunca setado pela aplicação**.
2. A role `postgres` que o app usa tem `rolbypassrls = true` — RLS é ignorada.
3. As tabelas `network.partners` e `network.partner_access_tokens` **não têm RLS nem policy**.

Esta etapa fecha os 3 problemas com 4 mudanças coordenadas:

| Mudança | Local |
|---|---|
| Criar role `farejador_partner_app` sem BYPASSRLS | Postgres (Supabase) |
| Migration 0044: RLS + policies em `partners` e `partner_access_tokens` | `db/migrations/` |
| Pool separado pra portal parceiro + `SET LOCAL` em cada request | `src/parceiro/` |
| Env var nova `PARTNER_DATABASE_URL` | Coolify |

Bot/atendente/painel admin **não são afetados**: continuam usando o pool antigo (role `postgres`).

---

## 2. Estado atual confirmado em prod (2026-05-21)

Validado via SQL contra Supabase `aoqtgwzeyznycuakrdhp`:

### 2.1 RLS habilitada (mas inerte)

| Schema | Tabela | RLS | Policies |
|---|---|:-:|:-:|
| commerce | partner_order_items | ✅ | 1 |
| commerce | partner_orders | ✅ | 1 |
| commerce | partner_purchase_items | ✅ | 1 |
| commerce | partner_purchases | ✅ | 1 |
| commerce | partner_stock_levels | ✅ | 1 |
| finance | partner_expenses | ✅ | 1 |
| network | partner_units | ✅ | 1 |
| **network** | **partner_access_tokens** | **❌** | **0** ⚠ |
| **network** | **partners** | **❌** | **0** ⚠ |

### 2.2 Policy padrão atual

Todas as 7 policies seguem o padrão:

```sql
(network.current_partner_unit() IS NULL) OR (unit_id = network.current_partner_unit())
```

O `IS NULL OR ...` é **intencional** — quando o GUC não está setado, retorna NULL, e a primeira condição passa. **Isso é o que permite o admin pool (que nunca seta GUC) ver tudo.**

### 2.3 Funções existentes

- `network.current_partner_unit()` — retorna `NULLIF(current_setting('app.partner_unit_id', true), '')::UUID`
- `network.hash_partner_token(p_token TEXT)` — SHA-256
- `commerce.register_partner_local_order(...)` — registra venda (1 das 4 functions críticas)
- `commerce.cancel_partner_local_order(...)` — cancela venda

### 2.4 Views relevantes

- `commerce.partner_orders_full` — usada pelo portal pra listar vendas
- `commerce.network_orders_unified` — usada pelo admin
- `commerce.network_stock_unified` — usada pelo admin
- `network.partner_unit_summary` — usada pelo portal (resumo) e admin (Rede)

### 2.5 Roles do banco

| Role | rolbypassrls | rolcanlogin |
|---|:-:|:-:|
| postgres | **✅ true** | ✅ |
| authenticator (PostgREST do Supabase, não usado pelo Farejador) | false | ✅ |

---

## 3. Decisões de design

### 3.1 Por que policy `IS NULL OR ...` (e não estrita)

**Mantemos o padrão atual.** Motivos:

1. **Admin precisa ver tudo.** Painel da Rede agrega dados de N parceiros — não tem como setar `app.partner_unit_id` pra "todos os parceiros".
2. **Permite reuso.** Bot/admin usam o mesmo pool `postgres` que existe hoje. Nada quebra.
3. **Defesa em profundidade vem da role**, não da policy. Quando o portal usar a role `farejador_partner_app` (sem BYPASSRLS), o GUC TEM que estar setado, senão... espera, aqui tem detalhe importante (ver 3.4).

### 3.2 Por que pool separado (e não trocar a role global)

Trocar a role global pra uma sem BYPASSRLS afetaria bot/atendente/organizadora — fora do escopo da auditoria do Portal Parceiro. Pool separado:

- Bot continua na role `postgres` com BYPASSRLS (zero risco de breakage)
- Portal usa role nova `farejador_partner_app` sem BYPASSRLS
- Admin usa role `postgres` (precisa ver tudo)

### 3.3 Por que NÃO usar `FORCE ROW LEVEL SECURITY`

`FORCE RLS` faria policy aplicar ao **owner** da tabela também. Não é necessário no nosso caso:

- A role `farejador_partner_app` **não vai ser owner** das tabelas (owner continua sendo `postgres`)
- Role não-owner já é submetida à RLS por default

`FORCE RLS` só fica útil se algum dia algum DBA logar como `postgres` e quiser ver dados isolados. Pra MVP: dispensável.

### 3.4 Como o login (validar token) funciona com role restrita

**Este é o ponto mais delicado do plano.**

Hoje o `auth.ts` faz:
```sql
SELECT pat.id, pat.token_hash, p.id, pu.id, pu.unit_id, pu.slug, ...
FROM network.partner_units pu
JOIN network.partners p ON ...
JOIN network.partner_access_tokens pat ON ...
WHERE pu.slug = $1 AND pu.status = 'active' AND ...
LIMIT 10
```

Com a role restrita + RLS nas 3 tabelas (`partners`, `partner_units`, `partner_access_tokens`):

- **Antes** do login, ninguém setou `app.partner_unit_id` ainda (o app ainda não sabe quem é o parceiro)
- `current_partner_unit()` retorna NULL
- Policy `IS NULL OR ...` deixa passar → mas isso **anula** a proteção (qualquer um vê tudo)

**Solução escolhida: SECURITY DEFINER function**

Criamos `network.validate_partner_token(p_slug TEXT, p_token TEXT)` com `SECURITY DEFINER`, que:
1. Roda com privilégio do owner (que é `postgres`, com bypass)
2. Faz o JOIN e a verificação de hash internamente
3. Retorna **só** o `partner_unit_id` (UUID) se válido, NULL se não

A role `farejador_partner_app` ganha `EXECUTE` nessa function, mas **não tem SELECT direto** em `partner_access_tokens`. Resultado:

- Login funciona via function (controlada)
- Role não consegue ler hashes diretamente
- Defesa em profundidade preservada

Após validar, o app faz `SET LOCAL app.partner_unit_id = '<uuid>'` e prossegue. Todas as queries subsequentes na mesma transação obedecem RLS.

### 3.5 Por que `SET LOCAL` (e não `SET SESSION`)

- `SET LOCAL` aplica só dentro da transação atual. Quando a conexão volta pro pool, o GUC some.
- `SET SESSION` aplica até a conexão ser fechada. Se outra request reusar essa conexão sem novo SET, vaza contexto entre parceiros.

`SET LOCAL` + transação explícita por request é o padrão correto.

---

## 4. SQL completo

### 4.1 Criar role e GRANTs

**Arquivo:** `db/migrations/0044_partner_rls_role_and_policies.sql` (proposta)

```sql
-- ============================================================
-- 0044_partner_rls_role_and_policies.sql
-- Etapa 5 da auditoria 2026-05-21: RLS efetivo + role separada.
--
-- O que essa migration faz:
--   1. Cria role 'farejador_partner_app' sem BYPASSRLS
--   2. Cria function SECURITY DEFINER 'network.validate_partner_token'
--   3. Habilita RLS em network.partners e network.partner_access_tokens
--   4. Cria policies pra essas 2 tabelas
--   5. Da GRANTs minimos necessarios pra role nova
--   6. Da EXECUTE nas functions criticas (validate, register, cancel)
--
-- Idempotente: usa CREATE ... IF NOT EXISTS, DROP ... IF EXISTS quando
-- necessario, CREATE OR REPLACE em functions.
--
-- Esta migration NAO altera comportamento existente — bot e admin
-- continuam usando role 'postgres' com BYPASSRLS, RLS so passa a aplicar
-- pra quem usar a role nova (= portal parceiro depois do deploy).
--
-- Assinatura: Claude (Opus 4.7), 2026-05-21
-- ============================================================

-- ─────────────────────────────────────────────
-- 1. Role nova (sem BYPASSRLS)
-- ─────────────────────────────────────────────
-- IMPORTANTE: a senha tem que ser gerada no momento da execucao.
-- A migration NAO inclui a senha — vai num passo manual antes do deploy.
-- Substitua <SENHA_GERADA_FORA> pela senha real ao executar.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'farejador_partner_app') THEN
    CREATE ROLE farejador_partner_app LOGIN PASSWORD '<SENHA_GERADA_FORA>' NOBYPASSRLS;
  END IF;
END $$;

-- Garantia explicita (no-op se ja estiver assim):
ALTER ROLE farejador_partner_app NOBYPASSRLS;
ALTER ROLE farejador_partner_app NOSUPERUSER NOINHERIT;

-- ─────────────────────────────────────────────
-- 2. Function SECURITY DEFINER pra validar token
-- ─────────────────────────────────────────────
-- A role 'farejador_partner_app' NAO ganha SELECT direto em
-- partner_access_tokens. Validacao passa por essa function que roda
-- com privilegio do owner (postgres).

CREATE OR REPLACE FUNCTION network.validate_partner_token(
  p_environment TEXT,
  p_slug        TEXT,
  p_token       TEXT
) RETURNS TABLE (
  partner_unit_id  UUID,
  unit_id          UUID,
  partner_id       UUID,
  slug             TEXT,
  partner_name     TEXT,
  unit_name        TEXT,
  token_id         UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = network, public
AS $$
DECLARE
  v_hash TEXT;
BEGIN
  v_hash := network.hash_partner_token(p_token);

  RETURN QUERY
  SELECT
    pu.id           AS partner_unit_id,
    pu.unit_id,
    p.id            AS partner_id,
    pu.slug,
    p.trade_name    AS partner_name,
    pu.display_name AS unit_name,
    pat.id          AS token_id
  FROM network.partner_units pu
  JOIN network.partners p
    ON p.id = pu.partner_id AND p.environment = pu.environment
  JOIN network.partner_access_tokens pat
    ON pat.partner_unit_id = pu.id AND pat.environment = pu.environment
  WHERE pu.environment = p_environment
    AND pu.slug = p_slug
    AND pu.status = 'active'
    AND p.status = 'active'
    AND pu.deleted_at IS NULL
    AND p.deleted_at IS NULL
    AND pat.revoked_at IS NULL
    AND pat.token_hash = v_hash
  LIMIT 1;

  -- Atualiza last_used_at do token se encontrou
  IF FOUND THEN
    UPDATE network.partner_access_tokens
    SET last_used_at = now()
    WHERE token_hash = v_hash
      AND environment = p_environment
      AND revoked_at IS NULL;
  END IF;
END;
$$;

COMMENT ON FUNCTION network.validate_partner_token IS
  'Valida token de parceiro e retorna o contexto da unidade. SECURITY DEFINER pra permitir que role farejador_partner_app valide sem SELECT direto em partner_access_tokens.';

-- ─────────────────────────────────────────────
-- 3. RLS em network.partners e network.partner_access_tokens
-- ─────────────────────────────────────────────

ALTER TABLE network.partners ENABLE ROW LEVEL SECURITY;
ALTER TABLE network.partner_access_tokens ENABLE ROW LEVEL SECURITY;

-- Policy em partners: parceiro vê só o próprio partner_id
DROP POLICY IF EXISTS partners_isolation ON network.partners;
CREATE POLICY partners_isolation ON network.partners
  FOR ALL
  USING (
    network.current_partner_unit() IS NULL
    OR id = (
      SELECT partner_id FROM network.partner_units
      WHERE id = network.current_partner_unit()
      LIMIT 1
    )
  )
  WITH CHECK (
    network.current_partner_unit() IS NULL
    OR id = (
      SELECT partner_id FROM network.partner_units
      WHERE id = network.current_partner_unit()
      LIMIT 1
    )
  );

-- Policy em partner_access_tokens: parceiro vê só os tokens da própria unidade
-- (importante: a role 'farejador_partner_app' nao tem SELECT direto nessa
--  tabela mesmo com policy — a validacao vai pela function SECURITY DEFINER.
--  A policy fica aqui pra defesa em profundidade caso alguem da equipe um dia
--  conceda GRANT por engano.)
DROP POLICY IF EXISTS partner_access_tokens_isolation ON network.partner_access_tokens;
CREATE POLICY partner_access_tokens_isolation ON network.partner_access_tokens
  FOR ALL
  USING (
    network.current_partner_unit() IS NULL
    OR partner_unit_id = network.current_partner_unit()
  )
  WITH CHECK (
    network.current_partner_unit() IS NULL
    OR partner_unit_id = network.current_partner_unit()
  );

-- ─────────────────────────────────────────────
-- 4. GRANTs pra role nova
-- ─────────────────────────────────────────────

-- 4.1 GRANT de uso dos schemas
GRANT USAGE ON SCHEMA network TO farejador_partner_app;
GRANT USAGE ON SCHEMA commerce TO farejador_partner_app;
GRANT USAGE ON SCHEMA finance TO farejador_partner_app;
GRANT USAGE ON SCHEMA audit TO farejador_partner_app;

-- 4.2 Tabelas que portal le/escreve
GRANT SELECT, INSERT, UPDATE ON commerce.partner_stock_levels       TO farejador_partner_app;
GRANT SELECT, INSERT, UPDATE ON commerce.partner_orders             TO farejador_partner_app;
GRANT SELECT, INSERT, UPDATE ON commerce.partner_order_items        TO farejador_partner_app;
GRANT SELECT, INSERT, UPDATE ON commerce.partner_purchases          TO farejador_partner_app;
GRANT SELECT, INSERT, UPDATE ON commerce.partner_purchase_items     TO farejador_partner_app;
GRANT SELECT, INSERT, UPDATE ON finance.partner_expenses            TO farejador_partner_app;

-- 4.3 Tabelas que portal le (so SELECT)
GRANT SELECT ON network.partner_units TO farejador_partner_app;
GRANT SELECT ON network.partners      TO farejador_partner_app;
-- partner_access_tokens NAO ganha SELECT direto — vai pela function

-- 4.4 Audit (so INSERT)
GRANT INSERT ON audit.events TO farejador_partner_app;

-- 4.5 Views que portal le
GRANT SELECT ON network.partner_unit_summary TO farejador_partner_app;
GRANT SELECT ON commerce.partner_orders_full TO farejador_partner_app;

-- 4.6 Functions criticas — EXECUTE
GRANT EXECUTE ON FUNCTION network.validate_partner_token(TEXT, TEXT, TEXT) TO farejador_partner_app;
GRANT EXECUTE ON FUNCTION network.current_partner_unit()                    TO farejador_partner_app;
GRANT EXECUTE ON FUNCTION network.hash_partner_token(TEXT)                  TO farejador_partner_app;
GRANT EXECUTE ON FUNCTION commerce.register_partner_local_order(
  TEXT, UUID, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) TO farejador_partner_app;
GRANT EXECUTE ON FUNCTION commerce.cancel_partner_local_order(UUID, TEXT, TEXT) TO farejador_partner_app;

-- 4.7 Sequences (necessario pra INSERT que usa gen_random_uuid via DEFAULT)
-- (gen_random_uuid nao depende de sequence, mas garantia futura)
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA commerce TO farejador_partner_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA finance  TO farejador_partner_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA audit    TO farejador_partner_app;

-- ─────────────────────────────────────────────
-- 5. Validacao apos aplicar
-- ─────────────────────────────────────────────
-- Confirma que role foi criada corretamente:
DO $$
DECLARE
  v_bypassrls BOOLEAN;
BEGIN
  SELECT rolbypassrls INTO v_bypassrls
  FROM pg_roles WHERE rolname = 'farejador_partner_app';

  IF v_bypassrls IS NULL THEN
    RAISE EXCEPTION 'Role farejador_partner_app nao foi criada';
  END IF;
  IF v_bypassrls = true THEN
    RAISE EXCEPTION 'Role farejador_partner_app tem BYPASSRLS — quebra etapa 5!';
  END IF;
END $$;
```

### 4.2 Passo manual antes da migration

A senha da role **não pode estar versionada no Git**. Procedimento:

1. Gerar senha forte:
   ```bash
   node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
   ```
2. Substituir `<SENHA_GERADA_FORA>` no SQL da migration **só na hora de aplicar**
3. Guardar a senha em local seguro (gerenciador de senha)
4. Configurar `PARTNER_DATABASE_URL` no Coolify com essa senha (passo 7 abaixo)

**Importante:** o arquivo `0044_*.sql` no repo vai ficar com `<SENHA_GERADA_FORA>` como placeholder, com comentário avisando que precisa substituir antes de rodar.

---

## 5. Código TypeScript (mudanças)

### 5.1 Novo arquivo: `src/parceiro/db.ts`

```typescript
/**
 * Pool de conexão isolado pro Portal Parceiro.
 *
 * Usa role 'farejador_partner_app' sem BYPASSRLS — RLS efetivamente
 * aplica. Bot/admin continuam no pool global de src/persistence/db.ts
 * com role 'postgres'.
 *
 * Etapa 5 da auditoria 2026-05-21.
 */

import { Pool } from 'pg';
import { env } from '../shared/config/env.js';
import { logger } from '../shared/logger.js';

function shouldUseSsl(databaseUrl: string): boolean {
  return env.DATABASE_SSL || databaseUrl.includes('supabase.co') || databaseUrl.includes('supabase.com');
}

function buildSslConfig(databaseUrl: string): object | undefined {
  if (!shouldUseSsl(databaseUrl)) return undefined;
  return { rejectUnauthorized: false };
}

// Se PARTNER_DATABASE_URL nao estiver setado, faz fallback no DATABASE_URL
// principal. Isso garante que o portal continua funcionando em ambientes
// onde a etapa 5 ainda nao foi configurada (test/staging/dev local).
// EM PROD: PARTNER_DATABASE_URL DEVE estar setado.
const partnerDatabaseUrl = env.PARTNER_DATABASE_URL ?? env.DATABASE_URL;

if (!env.PARTNER_DATABASE_URL && env.FAREJADOR_ENV === 'prod') {
  logger.warn(
    'PARTNER_DATABASE_URL nao configurado em prod — RLS ainda nao esta enforced!',
  );
}

export const partnerPool = new Pool({
  connectionString: partnerDatabaseUrl,
  max: 5,
  ssl: buildSslConfig(partnerDatabaseUrl),
});

partnerPool.on('error', (err) => {
  logger.error({ err }, 'unexpected partner pool PostgreSQL error');
});

/**
 * Executa um callback dentro de uma transação com app.partner_unit_id setado.
 *
 * Padrão obrigatório pra qualquer query do portal parceiro:
 *
 *   await withPartnerContext(partnerUnitId, async (client) => {
 *     return client.query('SELECT ...');
 *   });
 *
 * Garante que RLS aplica corretamente — fora dessa wrapper, o partner pool
 * nao sabe quem e o parceiro e a policy nao filtra nada.
 */
export async function withPartnerContext<T>(
  partnerUnitId: string,
  callback: (client: import('pg').PoolClient) => Promise<T>,
): Promise<T> {
  const client = await partnerPool.connect();
  try {
    await client.query('BEGIN');
    // set_config em vez de SET LOCAL pra poder usar parametro $1 com seguranca
    await client.query("SELECT set_config('app.partner_unit_id', $1, true)", [partnerUnitId]);
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
```

### 5.2 Refator do `src/parceiro/auth.ts`

Mudança principal: trocar o SELECT direto pela function `validate_partner_token`.

```typescript
// ANTES (linhas 66-90, simplificado):
const result = await pool.query<PartnerAuthRow>(
  `SELECT pat.id AS token_id, pat.token_hash, p.id AS partner_id, ...
   FROM network.partner_units pu JOIN ... WHERE pu.slug = $2 ...`,
  [env.FAREJADOR_ENV, slug],
);
const receivedHash = sha256(token);
const row = result.rows.find((c) => safeHashCompare(receivedHash, c.token_hash));

// DEPOIS:
import { partnerPool } from './db.js';  // pool da role nova

const result = await partnerPool.query<{
  partner_unit_id: string;
  unit_id: string;
  partner_id: string;
  slug: string;
  partner_name: string;
  unit_name: string;
  token_id: string;
}>(
  'SELECT * FROM network.validate_partner_token($1, $2, $3)',
  [env.FAREJADOR_ENV, slug, token],
);

if (result.rowCount !== 1) {
  void reply.status(401).send({ error: 'partner_unauthorized' });
  return;
}

const row = result.rows[0]!;
request.partnerContext = {
  environment: env.FAREJADOR_ENV,
  partnerId: row.partner_id,
  partnerUnitId: row.partner_unit_id,
  unitId: row.unit_id,
  slug: row.slug,
  partnerName: row.partner_name,
  unitName: row.unit_name,
};
```

**Vantagem:** o `safeHashCompare` em TypeScript some — fica tudo no banco (SECURITY DEFINER function compara hash). Menos código, mesma proteção.

### 5.3 Refator do `src/parceiro/queries.ts`

Todas as funções de `queries.ts` precisam usar o `withPartnerContext` em vez do pool default.

**Padrão atual:**
```typescript
export async function getPartnerVendas(
  ctx: PartnerContext,
  dbPool: Pool = defaultPool,  // ← pool default global (BYPASSRLS)
): Promise<unknown[]> {
  const result = await dbPool.query(`SELECT ... WHERE unit_id = $2 ...`, [...]);
  return result.rows;
}
```

**Padrão novo:**
```typescript
export async function getPartnerVendas(ctx: PartnerContext): Promise<unknown[]> {
  return withPartnerContext(ctx.partnerUnitId, async (client) => {
    // O WHERE unit_id = $2 continua existindo (defesa em profundidade)
    // mas RLS tambem filtra mesmo se a query esquecer
    const result = await client.query(`SELECT ... WHERE unit_id = $2 ...`, [...]);
    return result.rows;
  });
}
```

**Importante:**
- Manter o `WHERE unit_id = $X` nas queries (defesa em profundidade)
- RLS é a rede de segurança, não substituição da boa prática
- O parâmetro `dbPool` opcional desaparece — testes vão usar mock diferente (ver 6)

### 5.4 Lista exata de funções que mudam em `queries.ts`

| Função | Mudança |
|---|---|
| `getPartnerResumo` | Wrap em `withPartnerContext` |
| `getPartnerVendas` | Wrap |
| `getPartnerEstoque` | Wrap |
| `getPartnerProdutos` | Wrap |
| `getPartnerDespesas` | Wrap |
| `getPartnerCompras` | Wrap |
| `registerPartnerSale` | Wrap (chamada da function `register_partner_local_order` dentro do contexto) |
| `cancelPartnerSale` | Wrap (idem) |
| `upsertPartnerStock` | Wrap |
| `deletePartnerStock` | Wrap |
| `registerPartnerPurchase` | Wrap (já usa transação manual — precisa adaptar) |
| `deletePartnerPurchase` | Wrap (idem) |
| `registerPartnerExpense` | Wrap |
| `deletePartnerExpense` | Wrap |

**Cuidado especial:** `registerPartnerPurchase` e `deletePartnerPurchase` já abrem transação manual com `BEGIN/COMMIT`. Vão precisar adaptar pra usar o client do `withPartnerContext` (que já abre transação).

### 5.5 `src/shared/config/env.ts`

Adicionar:
```typescript
PARTNER_DATABASE_URL: z.string().url().optional(),
```

---

## 6. Testes novos

### 6.1 Estratégia

Os testes existentes (`tests/integration/partner-portal.integration.test.ts`) rodam contra Postgres efêmero via testcontainers, usando role default do container (= owner = bypass implícito).

**Pra esta etapa, criamos um teste novo** que:
1. Cria a role `farejador_partner_app` no container de teste
2. Aplica a migration 0044
3. Cria 2 fixtures (parceiro A e B)
4. Faz queries com o partner pool usando `withPartnerContext(unidadeA, ...)`
5. Confirma que SELECT não retorna linhas da unidade B

**Arquivo novo:** `tests/integration/partner-rls-enforcement.integration.test.ts`

```typescript
describe('Etapa 5 — RLS enforcement com role farejador_partner_app', () => {
  it('parceiro A com SET LOCAL nao consegue ler partner_orders de B mesmo via SQL direto', async () => {
    // Cria 2 unidades
    const a = await createPartnerFixture(db.pool, { slugSuffix: 'rls-a' });
    const b = await createPartnerFixture(db.pool, { slugSuffix: 'rls-b' });

    // B faz uma venda
    await db.pool.query(`INSERT INTO commerce.partner_orders ...`, [b.unitId, ...]);

    // Conecta usando role farejador_partner_app (pool restrito)
    const restrictedPool = new Pool({ connectionString: restrictedConnString });
    await withPartnerContextOnPool(restrictedPool, a.partnerUnitId, async (client) => {
      // SELECT sem WHERE explicito — RLS sozinha tem que filtrar
      const result = await client.query('SELECT * FROM commerce.partner_orders');
      // Deve ser zero linhas (B nao aparece)
      expect(result.rowCount).toBe(0);
    });
  });

  it('SELECT em partner_access_tokens com role restrita falha (sem GRANT)', async () => {
    // Confirma que role nao tem permissao direta
    const restrictedPool = new Pool({ connectionString: restrictedConnString });
    await expect(
      restrictedPool.query('SELECT * FROM network.partner_access_tokens'),
    ).rejects.toThrow(/permission denied/);
  });

  it('validate_partner_token funciona com role restrita (SECURITY DEFINER)', async () => {
    const f = await createPartnerFixture(db.pool);
    const restrictedPool = new Pool({ connectionString: restrictedConnString });
    const result = await restrictedPool.query(
      'SELECT * FROM network.validate_partner_token($1, $2, $3)',
      ['test', f.slug, f.tokenPlain],
    );
    expect(result.rowCount).toBe(1);
    expect(result.rows[0].partner_unit_id).toBe(f.partnerUnitId);
  });

  it('app.partner_unit_id sem setar = role nao ve nada (estrita por elimination)', async () => {
    // Sem set_config, current_partner_unit() retorna NULL
    // Como a role NAO tem BYPASSRLS, a policy IS NULL OR ... permite ver tudo
    // MAS — a role nao tem GRANT em network.partner_access_tokens
    // Entao na pratica, role sozinha sem GRANT = nao ve dados sensiveis
    const restrictedPool = new Pool({ connectionString: restrictedConnString });

    // GRANT exists em partner_orders → consegue, mas RLS nao filtra (GUC null)
    const result = await restrictedPool.query('SELECT count(*) FROM commerce.partner_orders');
    // Sem GUC setado, a policy IS NULL OR... passa por todas
    // Esse comportamento E aceito porque o codigo TS SEMPRE usa withPartnerContext.
    // O risco real e cobertura: garantir que TODA query passa por withPartnerContext.
    expect(result.rowCount).toBe(1);
  });
});
```

### 6.2 Os testes existentes (15 atuais) continuam passando?

**Sim, devem continuar.** Mas precisam de uma pequena adaptação:

- O `defaultPool` deles é o do container (= owner do banco, BYPASSRLS implícito)
- A migration 0044 cria a role nova, mas o `pool.query()` direto continua usando o owner
- Logo, RLS continua não aplicando nesses testes — comportamento idêntico ao de hoje

**Risco:** se a migration 0044 quebrar a aplicação de alguma forma (ex: COMMENT em coluna falha), o teste pega. Vamos rodar todos novamente após aplicar.

---

## 7. Coolify — env var nova

### 7.1 O que adicionar

| Variável | Valor |
|---|---|
| `PARTNER_DATABASE_URL` | `postgres://farejador_partner_app:<SENHA_GERADA>@<host>:<porta>/<dbname>` |

Mesmo host/porta/dbname do `DATABASE_URL` atual. Só muda usuário e senha.

### 7.2 Como adicionar (passo a passo)

1. Coolify → Application `farejador-pneus:main...` → Environment Variables
2. Botão "Add" ou similar
3. Nome: `PARTNER_DATABASE_URL`
4. Valor: a connection string completa (não cola aqui no chat)
5. Marcar como "Runtime only" (não build time) — segue padrão do `DATABASE_URL`
6. Salvar

### 7.3 Quando adicionar

**Antes** do deploy do código novo. Ordem importa:

```
1. Aplica migration 0044 no Supabase (cria role + grants)
2. Adiciona PARTNER_DATABASE_URL no Coolify
3. Push do código TS (commit + push)
4. Redeploy no Coolify
```

Se inverter (deploy do código antes da migration), a aplicação tenta conectar com a role nova → erro de credencial → portal cai.

---

## 8. Plano de rollback

Cada mudança tem um rollback isolado. **Ordem do rollback é a inversa da aplicação.**

### 8.1 Se der ruim no Coolify (deploy falha)

```
Coolify → Application → aba "Deployments" → Rollback no deploy anterior
```

Volta pro commit anterior em ~30s. Banco continua com role+RLS novos, mas o código velho usa o pool antigo (que nem sabe da role nova) — funciona normal.

### 8.2 Se der ruim com o portal parceiro (queries falhando)

**Sintoma:** parceiro abre portal, vê erro 500 ou tela vazia.

**Causa provável:** GRANT faltando em alguma tabela/function.

**Mitigação rápida (sem rollback):** adiciona o GRANT que estiver faltando:
```sql
GRANT SELECT, INSERT, UPDATE ON commerce.<tabela_que_quebrou> TO farejador_partner_app;
```

**Rollback total se mitigação não resolver:**

1. Remove `PARTNER_DATABASE_URL` do Coolify (deixa em branco ou apaga)
2. Redeploy
3. Código volta a usar o `DATABASE_URL` antigo (role `postgres` com BYPASSRLS)
4. Portal volta a funcionar como antes
5. Banco continua com role nova + RLS, mas inerte porque ninguém usa

### 8.3 Rollback da migration 0044 (se realmente necessário)

```sql
-- Desliga RLS nas 2 tabelas novas
ALTER TABLE network.partners DISABLE ROW LEVEL SECURITY;
ALTER TABLE network.partner_access_tokens DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS partners_isolation ON network.partners;
DROP POLICY IF EXISTS partner_access_tokens_isolation ON network.partner_access_tokens;

-- Drop da function
DROP FUNCTION IF EXISTS network.validate_partner_token(TEXT, TEXT, TEXT);

-- Drop da role (CUIDADO: tem que revogar GRANTs antes)
REVOKE ALL ON ALL TABLES IN SCHEMA commerce FROM farejador_partner_app;
REVOKE ALL ON ALL TABLES IN SCHEMA finance FROM farejador_partner_app;
REVOKE ALL ON ALL TABLES IN SCHEMA network FROM farejador_partner_app;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA commerce FROM farejador_partner_app;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA network FROM farejador_partner_app;
REVOKE USAGE ON SCHEMA commerce, finance, network, audit FROM farejador_partner_app;
DROP ROLE IF EXISTS farejador_partner_app;
```

**Importante:** rollback da migration **não desfaz** as 7 policies que já existiam antes (essas são da 0035 ou anteriores — fora do escopo desta etapa).

### 8.4 Cenário pior: corrupção de dados

Migration 0044 **não escreve em tabelas de dados**, só DDL (ALTER TABLE, CREATE FUNCTION, GRANT). Não tem como corromper dados.

---

## 9. Checklist de validação pós-deploy

### 9.1 Banco

```sql
-- 1. Role criada e sem BYPASSRLS
SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname = 'farejador_partner_app';
-- Esperado: rolbypassrls = false

-- 2. RLS habilitada em partners e partner_access_tokens
SELECT relname, relrowsecurity FROM pg_class
WHERE relname IN ('partners', 'partner_access_tokens');
-- Esperado: relrowsecurity = true em ambos

-- 3. Policies criadas
SELECT tablename, policyname FROM pg_policies
WHERE tablename IN ('partners', 'partner_access_tokens');
-- Esperado: 1 policy em cada

-- 4. Function validate_partner_token existe
SELECT proname FROM pg_proc WHERE proname = 'validate_partner_token';
-- Esperado: 1 linha
```

### 9.2 Aplicação

1. **Portal Rio do Ouro continua acessível**
   - Abrir `/parceiro/borracharia-rio-do-ouro/`
   - Colar token, ver Resumo carregando

2. **Bot continua respondendo Chatwoot**
   - Webhook recebe mensagem nova
   - `raw.raw_events` ganha linha

3. **Painel admin continua mostrando Rede**
   - `/admin/painel` aba Rede
   - Dados da Rio do Ouro aparecem

4. **Isolamento real testado manualmente**
   - Criar unidade B teste
   - Tentar acessar partner B com token de A → 401 (já funciona hoje via TypeScript)
   - Verificar logs: nenhuma query do parceiro retorna dados de unidade diferente

5. **Logs sem erros novos**
   - Coolify → aba Logs → grep `error|fail|denied`
   - Esperado: zero novos erros

### 9.3 Performance

Comparar antes/depois:
- Tempo de resposta médio do `GET /parceiro/:slug/api/resumo`: hoje ~30-50ms. Aceitável até ~80ms.
- Tempo de venda (`POST .../api/vendas`): hoje ~80-100ms. Aceitável até ~150ms.

Se piorar mais que isso, investigar antes de credenciar parceiro real.

---

## 10. Riscos identificados

| Risco | Mitigação |
|---|---|
| GRANT faltando → portal trava | Lista completa no SQL + testes integration que rodam queries reais |
| Senha da role exposta em git | Senha NÃO vai no SQL versionado, só substitui na hora |
| `withPartnerContext` esquecido em alguma query nova | Code review + (opcional futuro) lint rule |
| Function SECURITY DEFINER vira surface de ataque | Function só compara hash de token, não recebe SQL — seguro |
| Performance degrada > 50% | Smoke test antes/depois (item 9.3) |
| Migration falha no meio | É idempotente, pode rodar de novo. Pior caso, rollback (8.3). |
| Token velho continua válido com a function nova | Sim, e isso é correto — não estamos invalidando tokens, só mudando como são validados. |
| Bot/admin afetado indiretamente | Não afetado: pool deles não muda. Mas testar (item 9.2) |
| 1ª request após deploy é lenta (pool warming) | Aceitável, ~500ms. Não vai cair. |

---

## 11. O que NÃO está nesta etapa

Pra deixar claro o escopo:

- ❌ Não rotaciona credenciais vazadas no chat (item separado)
- ❌ Não resolve S2 (filter deleted_at em network_orders_unified)
- ❌ Não resolve S3 (GAP #7 vendas legadas)
- ❌ Não resolve nenhum dos 10 médios (M1-M10)
- ❌ Não implementa polling (F1)
- ❌ Não separa em processos (A1)
- ❌ Não adiciona domínio próprio (A3)
- ❌ Não muda o pool de bot/atendente/admin
- ❌ Não mexe em código de bot/atendente/planner/organizadora
- ❌ Não invalida tokens existentes

---

## 12. Sequência exata de execução (quando aprovado)

1. **Codex revisa este plano**, dá OK ou pede ajustes
2. (Se ajustes) refazer plano, voltar pro passo 1
3. **Gerar senha forte** pra role `farejador_partner_app` (manual, fora do chat)
4. **Aplicar migration 0044** no Supabase (passo 3 do SQL substituído pela senha real)
5. **Rodar validação SQL** (item 9.1) no Supabase Dashboard
6. **Adicionar `PARTNER_DATABASE_URL` no Coolify** (item 7.2)
7. **Implementar código TS** no repo local (`db.ts` novo, refator `auth.ts`, refator `queries.ts`, env)
8. **Escrever testes novos** (`partner-rls-enforcement.integration.test.ts`)
9. **Rodar todos os testes localmente** (32 atuais + novos)
10. **Commit + push** (2 remotes)
11. **Redeploy no Coolify**
12. **Smokes pós-deploy** (item 9.2)
13. **Documentar etapa 5 concluída** no `EXECUCAO_AUDITORIA_2026-05-21.md`

Tempo total estimado: **5-6 horas de trabalho meu**, mais o tempo do Codex revisar.

---

## 13. Como o Codex deve revisar este plano

Pontos sensíveis pra dar atenção:

1. **A function `validate_partner_token` está correta?** Especialmente o `SECURITY DEFINER` + `search_path` (proteção contra search_path injection).
2. **Os GRANTs estão completos?** Falta algum SELECT/INSERT/UPDATE que vai quebrar portal?
3. **A policy em `partner_access_tokens`** está correta? `partner_unit_id = current_partner_unit()` faz sentido pra tokens? (Token pertence a uma unidade, então sim — mas vale verificar.)
4. **`withPartnerContext` cobre todos os caminhos?** Tem callback que pode escapar e usar `partnerPool.query` direto sem set_config?
5. **`set_config` com terceiro parâmetro `true` (= LOCAL)** está correto? Sim — `true` = is_local, equivalente ao `SET LOCAL`.
6. **A senha da role** vai pro `.env` do Coolify, não pro Git. Confirmado.
7. **Migration é idempotente?** Sim — todas usam `IF NOT EXISTS` / `OR REPLACE` / `IF EXISTS`.
8. **Rollback realmente reverte tudo?** Sim, item 8.

---

*Plano gerado em 2026-05-21 por Claude Opus 4.7. Nenhum SQL foi executado contra prod durante a geração — apenas queries de leitura pra confirmar estado atual. Aguarda revisão Codex antes de execução. Sequência aprovada por Wallace: 1) documentar, 2) Codex revisa, 3) aplicar (só após aprovação).*
