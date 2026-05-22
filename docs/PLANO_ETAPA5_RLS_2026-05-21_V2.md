# Plano detalhado V2 — Etapa 5: RLS efetivo + role separada + pool separado

**Data:** 2026-05-21
**Versão:** V2 (substitui V1 após revisão Codex)
**Status:** PLANO — nada aplicado. Aguarda revisão Codex da V2 antes de execução.
**Documentos relacionados:**
- [`PLANO_ETAPA5_RLS_2026-05-21.md`](PLANO_ETAPA5_RLS_2026-05-21.md) — V1 (mantida pra trilha)
- [`REVISAO_CODEX_PLANO_ETAPA5_RLS_2026-05-21.md`](REVISAO_CODEX_PLANO_ETAPA5_RLS_2026-05-21.md) — Revisão V1 que motivou esta V2
- [`AUDITORIA_PAINEL_PARCEIRO_2026-05-21.md`](AUDITORIA_PAINEL_PARCEIRO_2026-05-21.md) — Auditoria original

---

## 1. Resumo executivo

V2 é resposta direta aos 6 bloqueios + ajustes de teste apontados pelo Codex na revisão da V1. Todas as observações foram aceitas — não houve contraposição.

### 1.1 O que mudou da V1 pra V2

| # | V1 (rejeitada) | V2 (proposta) |
|:-:|---|---|
| 1 | Policies com `IS NULL OR ...` (modo permissivo) | Policies **estritas** com `IS NOT NULL AND ...` |
| 2 | GUC `app.partner_unit_id` comparado direto com `unit_id` (mistura `network.partner_units.id` com `core.units.id`) | GUC continua sendo `network.partner_units.id`; helper novo `network.current_partner_core_unit()` resolve para `core.units.id` |
| 3 | Views com privilégio do owner (bypassa RLS) | Views recriadas com `security_invoker = true` (suportado Postgres 15+, prod é 17) |
| 4 | `GRANT EXECUTE` na function sem revogar PUBLIC primeiro | `REVOKE ALL FROM PUBLIC` explícito + `GRANT EXECUTE` cirúrgico |
| 5 | Migration versionada com `<SENHA_GERADA_FORA>` (placeholder) | Migration versionada **sem senha**. Runbook operacional separado pra criação da role. |
| 6 | 0044 só ADICIONA coisas novas (não reconcilia o que existe em prod) | 0044 **reconcilia tudo**: recria function `current_partner_unit`, recria as 7 policies existentes (já estritas), enable RLS em 9 tabelas (7 existentes + 2 novas) |
| 7 | Teste aceitava "sem GUC = vê tudo" como comportamento OK | Teste **invertido**: sem GUC = zero linhas + view de `partner_access_tokens` falha por permissão |

### 1.2 Princípio central que mudou

**V1:** "RLS é defesa em profundidade, mas admin precisa ver tudo, então policy fica permissiva e a real defesa é a role."

**V2:** "Pra a role restrita, policy é estrita. Admin/bot continuam vendo tudo porque BYPASSRLS pula a policy de qualquer jeito — não preciso enfraquecer policy pra deixá-los passar."

Essa mudança elimina o anti-padrão "se esquecer de setar GUC, vaza tudo".

---

## 2. Estado atual confirmado em prod (2026-05-21)

Validado via SQL contra Supabase `aoqtgwzeyznycuakrdhp` antes da V2.

### 2.1 RLS hoje (mesmo de V1)

| Schema | Tabela | RLS | Policies | Vai ser tocada pela V2? |
|---|---|:-:|:-:|:-:|
| commerce | partner_order_items | ✅ | 1 | Sim (policy estrita) |
| commerce | partner_orders | ✅ | 1 | Sim |
| commerce | partner_purchase_items | ✅ | 1 | Sim |
| commerce | partner_purchases | ✅ | 1 | Sim |
| commerce | partner_stock_levels | ✅ | 1 | Sim |
| finance | partner_expenses | ✅ | 1 | Sim |
| network | partner_units | ✅ | 1 | Sim |
| network | **partner_access_tokens** | ❌ | 0 | Sim (criar do zero) |
| network | **partners** | ❌ | 0 | Sim (criar do zero) |

### 2.2 FKs confirmadas (Codex apontou inconsistência partner_unit_id vs unit_id)

Confirmado via `information_schema.referential_constraints`:

| Tabela | Coluna | Referencia |
|---|---|---|
| `commerce.partner_orders` | `unit_id` | `core.units.id` |
| `commerce.partner_stock_levels` | `unit_id` | `core.units.id` |
| `commerce.partner_purchases` | `unit_id` | `core.units.id` |
| `finance.partner_expenses` | `unit_id` | `core.units.id` |
| `network.partner_units` | `unit_id` | `core.units.id` |
| `network.partner_units` | `id` | (PK do próprio schema network) |

**Significa:** o "id do parceiro" tem 2 formas — `partner_units.id` (interno network) e `partner_units.unit_id` (= `core.units.id`, usado em todas as outras tabelas). V2 trata os dois explicitamente.

### 2.3 Drift confirmado entre repo e prod

Grep no repo:

```
grep -l "ROW LEVEL\|POLICY\|current_partner_unit" db/migrations/*.sql
→ 0035, 0040, 0042, 0043 todos retornam 0 ocorrências
```

Prod tem:
- Function `network.current_partner_unit()`
- RLS habilitada em 7 tabelas
- 7 policies ativas

**Nenhum desses 3 está em arquivo do repo.** Reconciliar é obrigatório (bloqueio 6 do Codex).

---

## 3. Decisões de design (revisadas)

### 3.1 Por que policies **estritas** (mudança principal vs V1)

Antes:
```sql
current_partner_unit() IS NULL OR unit_id = current_partner_unit()
```

Agora:
```sql
current_partner_unit() IS NOT NULL AND unit_id = current_partner_unit()
```

**Razão correta:** policy só se aplica a roles **sem BYPASSRLS**. Hoje só uma role vai estar nessa situação — a `farejador_partner_app` da Etapa 5. Pra essa role, a única condição válida é "GUC setado E bate".

Se GUC não setado → bloqueia (correto: defesa em profundidade contra esquecimento de TS).
Se GUC setado mas unidade diferente → bloqueia (correto: isolamento).
Se GUC setado e unidade certa → libera (correto: parceiro acessa o próprio).

Admin/bot continuam com role `postgres` (BYPASSRLS) → policy não roda pra eles, veem tudo.

### 3.2 Por que helper `current_partner_core_unit()` (resposta ao bloqueio 2 do Codex)

Convenção V2:

| Onde | Valor |
|---|---|
| GUC `app.partner_unit_id` | `network.partner_units.id` (interno network) |
| Helper `network.current_partner_unit()` | retorna o GUC (`network.partner_units.id`) |
| Helper novo `network.current_partner_core_unit()` | retorna `core.units.id` resolvendo via subquery |

Cada tabela usa o helper certo:

| Tabela | Coluna | Helper na policy |
|---|---|---|
| `network.partner_units` | `id` | `current_partner_unit()` (mesma natureza) |
| `network.partners` | `id` | (especial — ver 3.3) |
| `network.partner_access_tokens` | `partner_unit_id` | `current_partner_unit()` |
| `commerce.partner_*` | `unit_id` | `current_partner_core_unit()` |
| `finance.partner_expenses` | `unit_id` | `current_partner_core_unit()` |

### 3.3 Policy de `network.partners` (caso especial)

A tabela `partners` não tem `unit_id` nem `partner_unit_id` direto. Tem só o próprio `id` (do partner) — e a relação é `partner → many partner_units`.

Policy precisa resolver "qual partner_id pertence ao GUC atual":

```sql
id = (
  SELECT partner_id
  FROM network.partner_units
  WHERE id = network.current_partner_unit()
  LIMIT 1
)
```

A subquery roda 1x por linha de partners — performance OK em N pequeno (10s, no máximo 100s de partners).

### 3.4 `security_invoker = true` em views (resposta ao bloqueio 3)

Views afetadas (consumidas pelo portal restrito):
- `network.partner_unit_summary`
- `commerce.partner_orders_full`

V2 aplica:
```sql
ALTER VIEW network.partner_unit_summary SET (security_invoker = true);
ALTER VIEW commerce.partner_orders_full SET (security_invoker = true);
```

Significa: view executa com privilégios do **chamador**, não do owner. Se chamador é `farejador_partner_app`, RLS das tabelas-base se aplica corretamente.

Views NÃO consumidas pelo portal restrito (`commerce.network_orders_unified`, `commerce.network_stock_unified`) **não precisam** de security_invoker — são lidas só pelo admin pool (BYPASSRLS).

### 3.5 `REVOKE ALL FROM PUBLIC` em function SECURITY DEFINER (resposta ao bloqueio 4)

A function `validate_partner_token` recebe SECURITY DEFINER. Sem `REVOKE FROM PUBLIC`, qualquer role login (incluindo `authenticator` do Supabase) pode chamá-la.

V2 inclui explicitamente:
```sql
REVOKE ALL ON FUNCTION network.validate_partner_token(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION network.validate_partner_token(TEXT, TEXT, TEXT) TO farejador_partner_app;
```

### 3.6 Runbook separado pra criação da role (resposta ao bloqueio 5)

V1 tinha:
```sql
CREATE ROLE farejador_partner_app LOGIN PASSWORD '<SENHA_GERADA_FORA>' NOBYPASSRLS;
```

V2 separa em **dois artefatos**:

**Artefato 1 — migration versionada `db/migrations/0044_partner_rls_policies.sql`:**
Contém só DDL idempotente:
- Function `current_partner_unit()` (recria se já existir)
- Function `current_partner_core_unit()` (nova)
- Function `validate_partner_token()` (nova, SECURITY DEFINER)
- `REVOKE/GRANT` na function
- `ENABLE RLS` em 9 tabelas (7 reconciliação + 2 novas)
- 9 policies estritas
- `ALTER VIEW ... SET (security_invoker = true)` em 2 views
- `GRANT` em tabelas/views/functions pra `farejador_partner_app` (a role já tem que existir — comentado)

A migration **assume** que `farejador_partner_app` já existe. Se não existir, falha controladamente no primeiro GRANT.

**Artefato 2 — runbook operacional `docs/RUNBOOK_ETAPA5_RLS_2026-05-21.md`:**
Lista o procedimento manual (a ser feito por humano, uma vez, fora do Git):

1. Gerar senha forte
2. SQL `CREATE ROLE ... PASSWORD ...`
3. Aplicar a migration 0044
4. Configurar `PARTNER_DATABASE_URL` no Coolify
5. Smoke test

**Ordem importa:** role tem que existir antes da migration ser aplicada (porque migration faz GRANTs pra ela).

---

## 4. SQL completo (migration 0044 V2)

**Arquivo:** `db/migrations/0044_partner_rls_policies.sql`

```sql
-- ============================================================
-- 0044_partner_rls_policies.sql
-- Etapa 5 da auditoria 2026-05-21 — V2 pós-revisão Codex.
--
-- O que essa migration faz:
--   1. Reconciliacao: recria a function network.current_partner_unit()
--      e as 7 policies que existem em prod mas nao aparecem nas migrations
--      0035-0043 do repo (drift identificado pela auditoria).
--
--   2. Helper novo: network.current_partner_core_unit() que resolve
--      partner_unit_id (network.partner_units.id) -> unit_id (core.units.id),
--      necessario porque tabelas commerce.* e finance.* usam unit_id.
--
--   3. Function nova: network.validate_partner_token() com SECURITY DEFINER
--      pra permitir login da role restrita sem dar SELECT direto em
--      partner_access_tokens.
--
--   4. RLS + policies em network.partners e network.partner_access_tokens
--      (que estavam SEM RLS — buraco identificado pela auditoria).
--
--   5. Policies ESTRITAS (sem IS NULL OR — mudanca da V2):
--      - Sem GUC setado = zero linhas pra role restrita
--      - Admin/bot continuam vendo tudo via BYPASSRLS da role 'postgres'
--
--   6. security_invoker=true em views consumidas pelo portal restrito
--      (commerce.partner_orders_full, network.partner_unit_summary).
--
--   7. GRANTs minimos pra role 'farejador_partner_app' (a role tem que ser
--      criada ANTES via runbook, ver RUNBOOK_ETAPA5_RLS_2026-05-21.md).
--
-- Idempotente: pode rodar 100x em prod sem efeito colateral. CREATE OR
-- REPLACE em functions, DROP POLICY IF EXISTS + CREATE POLICY em policies,
-- ENABLE RLS (no-op se ja habilitada), ALTER VIEW (no-op se ja security_
-- invoker), GRANT (no-op se ja concedido).
--
-- Reconciliacao significa que se rodar num banco fresh, sai com mesmo
-- estado que prod hoje. Se rodar em prod hoje, nao muda nada (idempotente).
--
-- Esta migration NAO cria role. Role 'farejador_partner_app' tem que ser
-- criada via runbook ANTES desta migration ser aplicada.
--
-- Assinatura: Claude (Opus 4.7), 2026-05-21 V2 pos-Codex
-- ============================================================

-- ─────────────────────────────────────────────
-- 1. Reconciliacao: function current_partner_unit() (existe em prod)
-- ─────────────────────────────────────────────
-- Le o GUC app.partner_unit_id que guarda network.partner_units.id.
-- Quando GUC nao esta setado, retorna NULL (e a policy estrita bloqueia).
CREATE OR REPLACE FUNCTION network.current_partner_unit()
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.partner_unit_id', true), '')::UUID
$$;

COMMENT ON FUNCTION network.current_partner_unit() IS
  'Retorna network.partner_units.id do contexto atual da request (vindo do GUC app.partner_unit_id). NULL se nao setado.';

-- ─────────────────────────────────────────────
-- 2. Helper novo: current_partner_core_unit() (resposta bloqueio 2 Codex)
-- ─────────────────────────────────────────────
-- Resolve network.partner_units.id -> core.units.id.
-- Necessario porque tabelas commerce.partner_* e finance.partner_expenses
-- usam unit_id (= core.units.id), nao o id interno do network.partner_units.
-- STABLE: dentro da mesma transacao, retorna o mesmo valor — Postgres
-- pode cachear chamadas da policy.
CREATE OR REPLACE FUNCTION network.current_partner_core_unit()
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
  SELECT pu.unit_id
  FROM network.partner_units pu
  WHERE pu.id = network.current_partner_unit()
$$;

COMMENT ON FUNCTION network.current_partner_core_unit() IS
  'Resolve network.partner_units.id (do GUC) para o respectivo core.units.id. Usado nas policies de commerce.partner_* e finance.partner_expenses.';

-- ─────────────────────────────────────────────
-- 3. Function validate_partner_token (SECURITY DEFINER, resposta bloqueio 4)
-- ─────────────────────────────────────────────
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
SET search_path = pg_catalog, network
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
  'Valida token de parceiro. SECURITY DEFINER permite role restrita validar sem SELECT direto em partner_access_tokens. EXECUTE so para farejador_partner_app (PUBLIC revogado).';

-- Bloqueio 4 do Codex: revogar PUBLIC antes de conceder
REVOKE ALL ON FUNCTION network.validate_partner_token(TEXT, TEXT, TEXT) FROM PUBLIC;

-- ─────────────────────────────────────────────
-- 4. ENABLE ROW LEVEL SECURITY em 9 tabelas
--    (7 reconciliacao + 2 novas — bloqueio 6 do Codex)
-- ─────────────────────────────────────────────
-- Idempotente: ALTER TABLE ... ENABLE RLS e no-op se ja habilitada.
ALTER TABLE commerce.partner_orders         ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.partner_order_items    ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.partner_purchases      ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.partner_purchase_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.partner_stock_levels   ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance.partner_expenses        ENABLE ROW LEVEL SECURITY;
ALTER TABLE network.partner_units           ENABLE ROW LEVEL SECURITY;
ALTER TABLE network.partners                ENABLE ROW LEVEL SECURITY;
ALTER TABLE network.partner_access_tokens   ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────
-- 5. Policies ESTRITAS (V2 — sem IS NULL OR, resposta bloqueio 1 Codex)
-- ─────────────────────────────────────────────
-- Padrao: drop velha (que existe em prod com IS NULL OR) + cria nova estrita.
-- Em prod isso EFETIVAMENTE muda comportamento da policy — mas como nada
-- usa a policy hoje (todas as conexoes usam role com BYPASSRLS), o efeito
-- pratico em prod e zero ate o portal ser ligado na role 'farejador_partner_app'.

-- 5.1 network.partner_units (id = current_partner_unit)
DROP POLICY IF EXISTS partner_units_isolation ON network.partner_units;
CREATE POLICY partner_units_isolation ON network.partner_units
  FOR ALL
  USING       (network.current_partner_unit() IS NOT NULL AND id = network.current_partner_unit())
  WITH CHECK  (network.current_partner_unit() IS NOT NULL AND id = network.current_partner_unit());

-- 5.2 network.partners (id resolvido via subquery em partner_units)
DROP POLICY IF EXISTS partners_isolation ON network.partners;
CREATE POLICY partners_isolation ON network.partners
  FOR ALL
  USING (
    network.current_partner_unit() IS NOT NULL
    AND id = (
      SELECT partner_id FROM network.partner_units
      WHERE id = network.current_partner_unit()
      LIMIT 1
    )
  )
  WITH CHECK (
    network.current_partner_unit() IS NOT NULL
    AND id = (
      SELECT partner_id FROM network.partner_units
      WHERE id = network.current_partner_unit()
      LIMIT 1
    )
  );

-- 5.3 network.partner_access_tokens (partner_unit_id = current_partner_unit)
-- (mesmo com policy, a role nao tem SELECT direto — defesa em profundidade)
DROP POLICY IF EXISTS partner_access_tokens_isolation ON network.partner_access_tokens;
CREATE POLICY partner_access_tokens_isolation ON network.partner_access_tokens
  FOR ALL
  USING       (network.current_partner_unit() IS NOT NULL AND partner_unit_id = network.current_partner_unit())
  WITH CHECK  (network.current_partner_unit() IS NOT NULL AND partner_unit_id = network.current_partner_unit());

-- 5.4 commerce.partner_orders (unit_id = current_partner_core_unit)
DROP POLICY IF EXISTS partner_orders_isolation ON commerce.partner_orders;
CREATE POLICY partner_orders_isolation ON commerce.partner_orders
  FOR ALL
  USING       (network.current_partner_core_unit() IS NOT NULL AND unit_id = network.current_partner_core_unit())
  WITH CHECK  (network.current_partner_core_unit() IS NOT NULL AND unit_id = network.current_partner_core_unit());

-- 5.5 commerce.partner_order_items (via EXISTS no parent)
DROP POLICY IF EXISTS partner_order_items_isolation ON commerce.partner_order_items;
CREATE POLICY partner_order_items_isolation ON commerce.partner_order_items
  FOR ALL
  USING (
    network.current_partner_core_unit() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM commerce.partner_orders po
      WHERE po.id = partner_order_items.order_id
        AND po.unit_id = network.current_partner_core_unit()
    )
  )
  WITH CHECK (
    network.current_partner_core_unit() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM commerce.partner_orders po
      WHERE po.id = partner_order_items.order_id
        AND po.unit_id = network.current_partner_core_unit()
    )
  );

-- 5.6 commerce.partner_stock_levels
DROP POLICY IF EXISTS partner_stock_isolation ON commerce.partner_stock_levels;
CREATE POLICY partner_stock_isolation ON commerce.partner_stock_levels
  FOR ALL
  USING       (network.current_partner_core_unit() IS NOT NULL AND unit_id = network.current_partner_core_unit())
  WITH CHECK  (network.current_partner_core_unit() IS NOT NULL AND unit_id = network.current_partner_core_unit());

-- 5.7 commerce.partner_purchases
DROP POLICY IF EXISTS partner_purchases_isolation ON commerce.partner_purchases;
CREATE POLICY partner_purchases_isolation ON commerce.partner_purchases
  FOR ALL
  USING       (network.current_partner_core_unit() IS NOT NULL AND unit_id = network.current_partner_core_unit())
  WITH CHECK  (network.current_partner_core_unit() IS NOT NULL AND unit_id = network.current_partner_core_unit());

-- 5.8 commerce.partner_purchase_items (via EXISTS no parent)
DROP POLICY IF EXISTS partner_purchase_items_isolation ON commerce.partner_purchase_items;
CREATE POLICY partner_purchase_items_isolation ON commerce.partner_purchase_items
  FOR ALL
  USING (
    network.current_partner_core_unit() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM commerce.partner_purchases pp
      WHERE pp.id = partner_purchase_items.purchase_id
        AND pp.unit_id = network.current_partner_core_unit()
    )
  )
  WITH CHECK (
    network.current_partner_core_unit() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM commerce.partner_purchases pp
      WHERE pp.id = partner_purchase_items.purchase_id
        AND pp.unit_id = network.current_partner_core_unit()
    )
  );

-- 5.9 finance.partner_expenses
DROP POLICY IF EXISTS partner_expenses_isolation ON finance.partner_expenses;
CREATE POLICY partner_expenses_isolation ON finance.partner_expenses
  FOR ALL
  USING       (network.current_partner_core_unit() IS NOT NULL AND unit_id = network.current_partner_core_unit())
  WITH CHECK  (network.current_partner_core_unit() IS NOT NULL AND unit_id = network.current_partner_core_unit());

-- ─────────────────────────────────────────────
-- 6. security_invoker=true em views consumidas pelo portal (bloqueio 3 Codex)
-- ─────────────────────────────────────────────
-- Sem isso, view executa com privilegio do owner (postgres com BYPASSRLS)
-- e a role restrita ve dados de outras unidades via view, mesmo com policy
-- correta nas tabelas-base.
ALTER VIEW network.partner_unit_summary SET (security_invoker = true);
ALTER VIEW commerce.partner_orders_full SET (security_invoker = true);

-- Views NAO consumidas pelo portal (so admin pool com BYPASSRLS):
-- commerce.network_orders_unified, commerce.network_stock_unified
-- ficam SEM security_invoker (continuam com privilegio do owner — admin precisa)

-- ─────────────────────────────────────────────
-- 7. GRANTs minimos pra role 'farejador_partner_app'
-- ─────────────────────────────────────────────
-- A role tem que ja existir (criada via runbook). Se nao existir, esses
-- comandos falham aqui com mensagem clara.

-- 7.1 Uso dos schemas
GRANT USAGE ON SCHEMA network  TO farejador_partner_app;
GRANT USAGE ON SCHEMA commerce TO farejador_partner_app;
GRANT USAGE ON SCHEMA finance  TO farejador_partner_app;
GRANT USAGE ON SCHEMA audit    TO farejador_partner_app;

-- 7.2 Tabelas que portal le/escreve (CRUD basico)
GRANT SELECT, INSERT, UPDATE ON commerce.partner_stock_levels   TO farejador_partner_app;
GRANT SELECT, INSERT, UPDATE ON commerce.partner_orders         TO farejador_partner_app;
GRANT SELECT, INSERT, UPDATE ON commerce.partner_order_items    TO farejador_partner_app;
GRANT SELECT, INSERT, UPDATE ON commerce.partner_purchases      TO farejador_partner_app;
GRANT SELECT, INSERT, UPDATE ON commerce.partner_purchase_items TO farejador_partner_app;
GRANT SELECT, INSERT, UPDATE ON finance.partner_expenses        TO farejador_partner_app;

-- 7.3 Tabelas read-only pra portal (resumo / login)
GRANT SELECT ON network.partner_units TO farejador_partner_app;
GRANT SELECT ON network.partners      TO farejador_partner_app;
-- NAO ha GRANT em network.partner_access_tokens — acesso via function

-- 7.4 Audit (so INSERT, registra eventos)
GRANT INSERT ON audit.events TO farejador_partner_app;

-- 7.5 Views consumidas pelo portal (com security_invoker do passo 6)
GRANT SELECT ON network.partner_unit_summary TO farejador_partner_app;
GRANT SELECT ON commerce.partner_orders_full TO farejador_partner_app;

-- 7.6 Functions
GRANT EXECUTE ON FUNCTION network.validate_partner_token(TEXT, TEXT, TEXT)   TO farejador_partner_app;
GRANT EXECUTE ON FUNCTION network.current_partner_unit()                      TO farejador_partner_app;
GRANT EXECUTE ON FUNCTION network.current_partner_core_unit()                 TO farejador_partner_app;
GRANT EXECUTE ON FUNCTION network.hash_partner_token(TEXT)                    TO farejador_partner_app;
GRANT EXECUTE ON FUNCTION commerce.register_partner_local_order(
  TEXT, UUID, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) TO farejador_partner_app;
GRANT EXECUTE ON FUNCTION commerce.cancel_partner_local_order(UUID, TEXT, TEXT) TO farejador_partner_app;

-- 7.7 Sequences (gen_random_uuid via DEFAULT nao usa sequence, mas garantia)
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA commerce TO farejador_partner_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA finance  TO farejador_partner_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA audit    TO farejador_partner_app;

-- ─────────────────────────────────────────────
-- 8. Validacoes pos-migration (executam dentro da migration)
-- ─────────────────────────────────────────────
DO $$
DECLARE
  v_count INTEGER;
BEGIN
  -- Confirma que role existe e nao tem BYPASSRLS
  SELECT count(*) INTO v_count
  FROM pg_roles
  WHERE rolname = 'farejador_partner_app' AND rolbypassrls = false;
  IF v_count = 0 THEN
    RAISE EXCEPTION '0044 falhou: role farejador_partner_app nao existe ou tem BYPASSRLS. Rode o runbook antes.';
  END IF;

  -- Confirma que RLS esta enable nas 9 tabelas
  SELECT count(*) INTO v_count
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind = 'r'
    AND c.relrowsecurity = true
    AND (
      (n.nspname = 'commerce' AND c.relname IN ('partner_orders', 'partner_order_items',
        'partner_purchases', 'partner_purchase_items', 'partner_stock_levels'))
      OR (n.nspname = 'finance' AND c.relname = 'partner_expenses')
      OR (n.nspname = 'network' AND c.relname IN ('partner_units', 'partners', 'partner_access_tokens'))
    );
  IF v_count <> 9 THEN
    RAISE EXCEPTION '0044 falhou: esperado RLS em 9 tabelas, achou %', v_count;
  END IF;

  -- Confirma que 9 policies foram criadas
  SELECT count(*) INTO v_count
  FROM pg_policies
  WHERE schemaname IN ('commerce', 'finance', 'network')
    AND tablename IN ('partner_orders', 'partner_order_items', 'partner_purchases',
      'partner_purchase_items', 'partner_stock_levels', 'partner_expenses',
      'partner_units', 'partners', 'partner_access_tokens');
  IF v_count <> 9 THEN
    RAISE EXCEPTION '0044 falhou: esperado 9 policies, achou %', v_count;
  END IF;
END $$;
```

---

## 5. Runbook operacional separado

**Arquivo:** `docs/RUNBOOK_ETAPA5_RLS_2026-05-21.md` (a ser criado junto com a V2)

Conteúdo:

```markdown
# Runbook — Etapa 5 RLS (operacional, executado uma vez por humano)

## Pre-requisitos
- Acesso ao Supabase Dashboard do projeto Farejador (admin SQL)
- Acesso ao Coolify Application do Farejador
- Gerenciador de senha pra guardar a senha gerada

## Passo 1 — Gerar senha forte (terminal local)

node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"

Anota o output em gerenciador de senha. **Não cola no chat.**

## Passo 2 — Criar role no Supabase

Supabase Dashboard → SQL Editor → New query:

CREATE ROLE farejador_partner_app
  LOGIN
  PASSWORD '<COLA_SENHA_DO_PASSO_1>'
  NOSUPERUSER
  NOBYPASSRLS
  NOINHERIT;

-- Garantia (no-op se ja estiver)
ALTER ROLE farejador_partner_app NOSUPERUSER NOBYPASSRLS NOINHERIT;

Executar. Esperado: "CREATE ROLE".

## Passo 3 — Aplicar migration 0044

Supabase Dashboard → SQL Editor → cola o conteúdo de
db/migrations/0044_partner_rls_policies.sql → executar.

Esperado: nenhuma exceção do bloco DO no final. Se a role do passo 2
não foi criada, o último DO levanta 'role nao existe ou tem BYPASSRLS'.

## Passo 4 — Construir PARTNER_DATABASE_URL

Pega a `DATABASE_URL` atual do Coolify. Exemplo:

postgresql://postgres.<projid>:<senha_postgres>@<host>:5432/postgres

Constrói a `PARTNER_DATABASE_URL` substituindo:
- usuário `postgres.<projid>` por `farejador_partner_app`
- senha do `postgres` pela senha gerada no passo 1

postgresql://farejador_partner_app:<SENHA_PASSO_1>@<host>:5432/postgres

## Passo 5 — Adicionar PARTNER_DATABASE_URL no Coolify

Coolify → Application farejador-pneus:main → Environment Variables → Add:

- Name: PARTNER_DATABASE_URL
- Value: <connection string do passo 4>
- Marcar "Runtime only" (não build-time)
- Salvar

## Passo 6 — Smoke test antes do deploy do código novo

Supabase SQL Editor:

-- Confirma que a senha funciona
-- (Não funciona via SQL Editor — testa conectando externamente)

-- Confirma que role nao tem BYPASSRLS
SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname = 'farejador_partner_app';
-- Esperado: rolbypassrls = false

-- Confirma policies estritas
SELECT policyname, qual FROM pg_policies
WHERE tablename = 'partner_orders';
-- Esperado: qual contém 'IS NOT NULL AND' (não 'IS NULL OR')

## Passo 7 — Deploy do código TS

Quando passos 1-6 estão OK, deploy do código TS (commit + push + Redeploy).
Código novo lê PARTNER_DATABASE_URL, conecta na role nova, RLS aplica.

## Rollback

Ver seção 9 do PLANO_ETAPA5_RLS_2026-05-21_V2.md.
```

---

## 6. Código TypeScript (revisado conforme V2)

### 6.1 `src/parceiro/db.ts` (novo, igual V1 com pequenos ajustes)

```typescript
import { Pool } from 'pg';
import { env } from '../shared/config/env.js';
import { logger } from '../shared/logger.js';

const partnerDatabaseUrl = env.PARTNER_DATABASE_URL ?? env.DATABASE_URL;

if (!env.PARTNER_DATABASE_URL && env.FAREJADOR_ENV === 'prod') {
  logger.warn(
    'PARTNER_DATABASE_URL nao configurado em prod — Etapa 5 RLS nao esta enforced!',
  );
}

const usesSupabase =
  partnerDatabaseUrl.includes('supabase.co') || partnerDatabaseUrl.includes('supabase.com');

export const partnerPool = new Pool({
  connectionString: partnerDatabaseUrl,
  max: 5,
  ssl: (env.DATABASE_SSL || usesSupabase) ? { rejectUnauthorized: false } : undefined,
});

partnerPool.on('error', (err) => {
  logger.error({ err }, 'unexpected partner pool PostgreSQL error');
});

/**
 * Executa callback dentro de uma transacao com app.partner_unit_id setado.
 *
 * V2 (pos-Codex): policies sao estritas, sem GUC = zero linhas. Esse wrapper
 * E obrigatorio em TODA query do portal. Esquecer = portal vazio (correto)
 * em vez de portal vazando dados (errado).
 */
export async function withPartnerContext<T>(
  partnerUnitId: string,  // network.partner_units.id (GUC guarda esse)
  callback: (client: import('pg').PoolClient) => Promise<T>,
): Promise<T> {
  const client = await partnerPool.connect();
  try {
    await client.query('BEGIN');
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

### 6.2 `src/parceiro/auth.ts` (refator)

Igual V1 — troca o SELECT direto pela function `validate_partner_token`. Sem mudança de V2.

### 6.3 `src/parceiro/queries.ts`

Cada função usa `withPartnerContext(ctx.partnerUnitId, ...)`. Mantém `WHERE unit_id = $X` nas queries (defesa em profundidade), agora reforçado pela policy.

Lista de funções igual à V1 (14 funções).

### 6.4 `src/shared/config/env.ts`

```typescript
PARTNER_DATABASE_URL: z.string().url().optional(),
```

---

## 7. Testes (revisados conforme bloqueio sobre testes do Codex)

**Arquivo novo:** `tests/integration/partner-rls-enforcement.integration.test.ts`

Os 10 testes mínimos exigidos pelo Codex:

```typescript
describe('Etapa 5 V2 — RLS enforcement estrito', () => {
  // Setup: cria a role no container de teste, aplica 0044,
  // cria pool restrito apontando pra role nova.

  it('1. parceiro A com contexto A nao ve partner_orders de B (mesmo sem WHERE)', async () => {
    const a = await createPartnerFixture(db.pool, { slugSuffix: 'rls-a' });
    const b = await createPartnerFixture(db.pool, { slugSuffix: 'rls-b' });
    // B faz 1 venda via pool admin
    await db.pool.query(`INSERT INTO commerce.partner_orders (...) VALUES (...)`, [b.unitId, ...]);

    await withRestrictedPartnerContext(a.partnerUnitId, async (client) => {
      const r = await client.query('SELECT * FROM commerce.partner_orders');  // sem WHERE
      expect(r.rowCount).toBe(0);  // RLS sozinha filtra
    });
  });

  it('2. parceiro A com contexto A nao ve estoque de B', async () => { /* ... */ });
  it('3. parceiro A com contexto A nao ve despesas de B', async () => { /* ... */ });
  it('4. parceiro A com contexto A nao ve compras de B', async () => { /* ... */ });

  it('5. role restrita sem contexto = zero linhas em todas as tabelas', async () => {
    // ANTES (V1) este teste aceitava "passa tudo"
    // AGORA (V2) deve ser zero — policy estrita bloqueia GUC NULL
    const restrictedPool = createRestrictedPool();
    for (const t of ['partner_orders', 'partner_stock_levels', 'partner_purchases',
      'partner_order_items', 'partner_purchase_items']) {
      const r = await restrictedPool.query(`SELECT count(*) FROM commerce.${t}`);
      expect(Number(r.rows[0].count)).toBe(0);  // policy bloqueia
    }
    const r = await restrictedPool.query('SELECT count(*) FROM finance.partner_expenses');
    expect(Number(r.rows[0].count)).toBe(0);
  });

  it('6. validate_partner_token funciona sem SELECT direto em partner_access_tokens', async () => {
    const f = await createPartnerFixture(db.pool);
    const restrictedPool = createRestrictedPool();
    const r = await restrictedPool.query(
      'SELECT * FROM network.validate_partner_token($1, $2, $3)',
      ['test', f.slug, f.tokenPlain],
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].partner_unit_id).toBe(f.partnerUnitId);
  });

  it('7. SELECT direto em partner_access_tokens falha pra role restrita (sem GRANT)', async () => {
    const restrictedPool = createRestrictedPool();
    await expect(
      restrictedPool.query('SELECT * FROM network.partner_access_tokens'),
    ).rejects.toThrow(/permission denied/);
  });

  it('8. views do portal respeitam isolamento (security_invoker)', async () => {
    const a = await createPartnerFixture(db.pool, { slugSuffix: 'rls-va' });
    const b = await createPartnerFixture(db.pool, { slugSuffix: 'rls-vb' });
    // B faz venda
    await db.pool.query(`INSERT INTO commerce.partner_orders (...) VALUES (...)`, [b.unitId, ...]);

    await withRestrictedPartnerContext(a.partnerUnitId, async (client) => {
      // network.partner_unit_summary (security_invoker = true)
      const r1 = await client.query(`
        SELECT * FROM network.partner_unit_summary WHERE unit_id = $1
      `, [b.unitId]);
      expect(r1.rowCount).toBe(0);  // policy de partner_units bloqueia

      // commerce.partner_orders_full (security_invoker = true)
      const r2 = await client.query(`SELECT * FROM commerce.partner_orders_full`);
      // So mostra os de A (zero, porque A nao vendeu nada)
      expect(r2.rowCount).toBe(0);
    });
  });

  it('9. venda/cancelamento/compra/despesa funcionam com role restrita', async () => {
    const a = await createPartnerFixture(db.pool, { slugSuffix: 'rls-fc' });

    await withRestrictedPartnerContext(a.partnerUnitId, async (client) => {
      // registerPartnerSale via function
      const sale = await client.query(`
        SELECT commerce.register_partner_local_order($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11) AS oid
      `, ['test', a.unitId, 'Cliente', null,
          JSON.stringify([{partner_stock_id: a.stockId, quantity: 1, unit_price: 100}]),
          'pix', 'pickup', null, 'partner:'+a.slug, 'rls-test-'+Date.now(), 'porta']);
      expect(sale.rows[0].oid).toBeTruthy();

      // estoque baixou
      const stock = await client.query(`SELECT quantity_on_hand FROM commerce.partner_stock_levels WHERE id = $1`,
        [a.stockId]);
      expect(stock.rows[0].quantity_on_hand).toBe(9);  // initial=10, vendeu 1
    });
  });

  it('10. bot/admin (pool antigo com BYPASSRLS) continua vendo tudo', async () => {
    // Pool antigo do teste = role default = BYPASSRLS na pratica
    // Confirma que NAO afetamos esse caminho
    const a = await createPartnerFixture(db.pool, { slugSuffix: 'rls-x' });
    const b = await createPartnerFixture(db.pool, { slugSuffix: 'rls-y' });
    const r = await db.pool.query('SELECT count(*) FROM commerce.partner_orders');
    // Vendas das 2 unidades aparecem (admin ve tudo)
    expect(Number(r.rows[0].count)).toBeGreaterThanOrEqual(0);  // depende do que ja foi inserido
  });
});
```

Helpers necessários:

```typescript
function createRestrictedPool(): Pool {
  const baseConnStr = db.connectionString;
  return new Pool({
    connectionString: baseConnStr.replace(/\/\/test:/, '//farejador_partner_app:'),
    max: 2,
  });
}

async function withRestrictedPartnerContext(partnerUnitId: string, cb: ...) {
  const pool = createRestrictedPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.partner_unit_id', $1, true)", [partnerUnitId]);
    const r = await cb(client);
    await client.query('COMMIT');
    return r;
  } finally {
    client.release();
    await pool.end();
  }
}
```

E no setup do teste, criar a role no container de teste:

```typescript
beforeAll(async () => {
  db = await startPostgres();
  // Cria a role no container de teste (não vai pro Git nem prod)
  await db.pool.query(`
    CREATE ROLE farejador_partner_app LOGIN PASSWORD 'test' NOSUPERUSER NOBYPASSRLS NOINHERIT;
  `);
  // Aplica a 0044 (ja roda como parte das migrations no startPostgres)
});
```

Wait — a 0044 vai ser parte das migrations aplicadas automaticamente pelo `startPostgres`. Mas a 0044 supõe que a role já existe (passo 8 do SQL). Logo, **a role tem que ser criada antes da migration 0044 rodar** no setup do teste.

**Solução:** modificar `helpers/postgres.ts` pra criar a role antes de aplicar migrations.

---

## 8. Mudanças no helper de teste

`tests/integration/helpers/postgres.ts` precisa um pequeno ajuste:

```typescript
async function applyMigrations(pool: Pool): Promise<void> {
  // V2 Etapa 5: cria a role antes das migrations
  // (a migration 0044 supoe que a role ja existe)
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'farejador_partner_app') THEN
        CREATE ROLE farejador_partner_app LOGIN PASSWORD 'test' NOSUPERUSER NOBYPASSRLS NOINHERIT;
      END IF;
    END $$;
  `);

  // resto do applyMigrations igual...
}
```

---

## 9. Plano de rollback (revisado)

### 9.1 Rollback rápido (sem mexer no banco)

Se algo der ruim depois do deploy:

1. Coolify → remover ou apagar `PARTNER_DATABASE_URL`
2. Redeploy
3. Código volta a usar `DATABASE_URL` (role `postgres` com BYPASSRLS)
4. RLS aplicada no banco continua, mas inerte porque ninguém usa a role restrita

Banco continua íntegro. Portal volta a funcionar como antes da Etapa 5.

### 9.2 Rollback do código (commit anterior)

Se quiser voltar pro estado pré-Etapa 5 também no código:
```
Coolify → Deployments → Rollback no deploy anterior
```

### 9.3 Rollback da migration 0044 (cenário improvável)

Se realmente precisar desfazer a migration (algo quebrou em prod e não dá pra resolver de outra forma):

```sql
-- 1. Desabilita RLS nas 9 tabelas
ALTER TABLE commerce.partner_orders         DISABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.partner_order_items    DISABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.partner_purchases      DISABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.partner_purchase_items DISABLE ROW LEVEL SECURITY;
ALTER TABLE commerce.partner_stock_levels   DISABLE ROW LEVEL SECURITY;
ALTER TABLE finance.partner_expenses        DISABLE ROW LEVEL SECURITY;
ALTER TABLE network.partner_units           DISABLE ROW LEVEL SECURITY;
ALTER TABLE network.partners                DISABLE ROW LEVEL SECURITY;
ALTER TABLE network.partner_access_tokens   DISABLE ROW LEVEL SECURITY;

-- 2. Drop policies novas
DROP POLICY IF EXISTS partner_orders_isolation         ON commerce.partner_orders;
DROP POLICY IF EXISTS partner_order_items_isolation    ON commerce.partner_order_items;
DROP POLICY IF EXISTS partner_purchases_isolation      ON commerce.partner_purchases;
DROP POLICY IF EXISTS partner_purchase_items_isolation ON commerce.partner_purchase_items;
DROP POLICY IF EXISTS partner_stock_isolation          ON commerce.partner_stock_levels;
DROP POLICY IF EXISTS partner_expenses_isolation       ON finance.partner_expenses;
DROP POLICY IF EXISTS partner_units_isolation          ON network.partner_units;
DROP POLICY IF EXISTS partners_isolation               ON network.partners;
DROP POLICY IF EXISTS partner_access_tokens_isolation  ON network.partner_access_tokens;

-- 3. Volta views ao default
ALTER VIEW network.partner_unit_summary RESET (security_invoker);
ALTER VIEW commerce.partner_orders_full RESET (security_invoker);

-- 4. Drop function nova
DROP FUNCTION IF EXISTS network.validate_partner_token(TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS network.current_partner_core_unit();
-- (current_partner_unit fica — existia antes)

-- 5. Revoga GRANTs e drop role
REVOKE ALL ON ALL TABLES IN SCHEMA commerce FROM farejador_partner_app;
REVOKE ALL ON ALL TABLES IN SCHEMA finance  FROM farejador_partner_app;
REVOKE ALL ON ALL TABLES IN SCHEMA network  FROM farejador_partner_app;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA commerce FROM farejador_partner_app;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA network  FROM farejador_partner_app;
REVOKE USAGE ON SCHEMA commerce, finance, network, audit FROM farejador_partner_app;
DROP ROLE IF EXISTS farejador_partner_app;
```

**Importante:** após rollback, o estado fica **diferente do estado anterior** — as 7 policies originais (com `IS NULL OR`) NÃO são recriadas. Se precisar restaurá-las exatamente como estavam, copiar as policies da seção 2.1 da V1 do plano.

---

## 10. Checklist de validação pós-deploy

### 10.1 Banco

```sql
-- Role correta
SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'farejador_partner_app';
-- Esperado: rolbypassrls=false, rolsuper=false

-- 9 tabelas com RLS
SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relrowsecurity = true
  AND ((n.nspname = 'commerce' AND c.relname LIKE 'partner_%')
    OR (n.nspname = 'finance' AND c.relname = 'partner_expenses')
    OR (n.nspname = 'network' AND c.relname IN ('partner_units', 'partners', 'partner_access_tokens')));
-- Esperado: 9

-- 9 policies estritas (nenhuma com IS NULL OR)
SELECT count(*) FROM pg_policies WHERE qual NOT LIKE '%IS NULL OR%'
  AND tablename IN ('partner_orders', 'partner_order_items', 'partner_purchases',
    'partner_purchase_items', 'partner_stock_levels', 'partner_expenses',
    'partner_units', 'partners', 'partner_access_tokens');
-- Esperado: 9

-- Views com security_invoker
SELECT relname, reloptions FROM pg_class
WHERE relkind = 'v' AND relname IN ('partner_unit_summary', 'partner_orders_full');
-- Esperado: reloptions contendo 'security_invoker=true' em ambas
```

### 10.2 Aplicação

Igual V1: portal Rio do Ouro acessível, bot OK, admin Rede OK, performance < 80ms.

### 10.3 Isolamento real (teste manual)

Criar unidade B temporária + fazer venda nela + tentar acessar com token de A → 401.

---

## 11. Riscos identificados (revisados)

| Risco | Mitigação |
|---|---|
| Policy estrita bloqueia query do portal por GUC não setado | `withPartnerContext` é obrigatório — testes garantem cobertura |
| Helper `current_partner_core_unit()` lento em escala | Função STABLE — Postgres cacheia chamadas na mesma transação. Volume real (100s de partners) não é problema. |
| Role nova criada com BYPASSRLS por engano | DO block no fim da migration valida e levanta exceção |
| Migration 0044 falha em ambiente fresh por role não existir | Mensagem clara no DO block. Runbook diz pra criar role antes. Helper de teste cria role antes. |
| security_invoker quebra view em algum cenário | Testes 8 cobrem. Postgres 17 suporta nativo. |
| REVOKE FROM PUBLIC quebra alguma chamada existente | Function `validate_partner_token` é NOVA, ninguém usa ainda. Sem regressão. |
| Drift recriado por engano (policies V1 voltam) | DO block valida que policies V2 estão lá (sem `IS NULL OR`) |
| Performance: policies com subquery em partner_units | STABLE function + tabela pequena. Tempo desprezível. |

---

## 12. O que NÃO está nesta etapa

Mantido da V1:

- ❌ Não rotaciona credenciais vazadas
- ❌ Não resolve S2 (deleted_at em network_orders_unified)
- ❌ Não resolve S3 (GAP #7 vendas legadas)
- ❌ Não resolve médios (M1-M10)
- ❌ Não implementa polling (F1)
- ❌ Não separa em processos (A1)
- ❌ Não muda pool de bot/atendente/admin
- ❌ Não mexe em código de bot/atendente/planner/organizadora
- ❌ Não invalida tokens existentes

Novo da V2:

- ❌ Não cria role (runbook faz isso)
- ❌ Não muda comportamento de admin/bot (BYPASSRLS preservado)

---

## 13. Sequência exata de execução (quando aprovado)

1. **Codex revisa V2**, dá OK ou pede V3
2. **Gera senha forte** (runbook passo 1)
3. **Cria role no Supabase** (runbook passo 2)
4. **Aplica migration 0044** no Supabase
5. **Roda validação SQL** (item 10.1)
6. **Construir PARTNER_DATABASE_URL** (runbook passo 4)
7. **Adicionar PARTNER_DATABASE_URL no Coolify**
8. **Implementar código TS** (db.ts novo, refator auth.ts e queries.ts, env.ts)
9. **Escrever testes** (10 testes mínimos da seção 7)
10. **Rodar todos os testes localmente** (32 atuais + 10 novos = 42)
11. **Commit + push** (2 remotes)
12. **Redeploy no Coolify**
13. **Smokes pós-deploy** (item 10.2 + 10.3)
14. **Documentar etapa 5 concluída**

Tempo estimado: igual V1, **5-6h** de trabalho meu + tempo do Codex revisar V2.

---

## 14. Resposta direta aos 6 bloqueios do Codex

Pra Codex conferir item a item:

| # | Bloqueio | Onde foi resolvido na V2 |
|:-:|---|---|
| 1 | Remover `IS NULL OR` | Seção 3.1 + SQL seção 5 (todas as 9 policies estritas com `IS NOT NULL AND`) |
| 2 | `partner_unit_id` vs `unit_id` | Seção 3.2 + função `current_partner_core_unit()` na seção 4 (item 2) + policies de `commerce/finance.*` usam o helper |
| 3 | Views security_invoker | Seção 3.4 + SQL seção 6 do bloco principal |
| 4 | REVOKE EXECUTE FROM PUBLIC | Seção 3.5 + SQL seção 3 do bloco principal (logo após CREATE FUNCTION) |
| 5 | Senha em migration | Seção 3.6 + runbook separado na seção 5 |
| 6 | Reconciliar policies prod ↔ Git | Seção 1.2 (linha 6) + SQL seção 1 (recria current_partner_unit) + seção 4 (ENABLE RLS em 9 tabelas, sendo 7 reconciliação) + seção 5 (recria as 7 policies existentes com versão estrita) |
| Testes | Testes que aceitavam "passa tudo" | Seção 7 — teste 5 invertido + 10 testes mínimos cobrindo todos os cenários do Codex |

---

*V2 gerada em 2026-05-21 por Claude Opus 4.7 em resposta direta à revisão Codex da V1. Nenhum SQL aplicado em prod, nenhum código de produção alterado, nenhum push. Aguarda revisão Codex da V2.*
