-- 0136 - Etapa 5: integridade de atacado, compras e operacoes concorrentes.
-- Aditiva: a API antiga continua podendo inserir linhas sem chave de idempotencia;
-- a API da Etapa 5 passa a exigir a chave na borda. Nao aplicar sem autorizacao.

-- Um unico livro de operacoes evita colunas de idempotencia diferentes em cada
-- entidade. A reserva, a mutacao e o resultado final vivem na mesma transacao.
CREATE TABLE IF NOT EXISTS audit.operation_idempotency (
  environment         env_t NOT NULL,
  domain              TEXT NOT NULL CHECK (length(domain) BETWEEN 3 AND 80),
  idempotency_key     TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  entity_table        TEXT,
  entity_id           UUID,
  result              JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at        TIMESTAMPTZ,
  PRIMARY KEY (environment, domain, idempotency_key),
  CHECK ((completed_at IS NULL AND result IS NULL)
      OR (completed_at IS NOT NULL AND result IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS operation_idempotency_entity_idx
  ON audit.operation_idempotency (environment, entity_table, entity_id)
  WHERE entity_id IS NOT NULL;

COMMENT ON TABLE audit.operation_idempotency IS
  '0136: resultado persistido de operacoes financeiras/estoque. Mesma chave+payload devolve o resultado original; payload divergente e conflito.';

-- Identidade normalizada do fornecedor: pontuacao, espacos, caixa e acentos nao
-- podem criar duas fichas para a mesma identidade comercial.
CREATE OR REPLACE FUNCTION ops.normalize_supplier_identity(value TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $fn$
  SELECT regexp_replace(
    translate(
      lower(coalesce(value, '')),
      'áàâãäéèêëíìîïóòôõöúùûüçñ',
      'aaaaaeeeeiiiiooooouuuucn'
    ),
    '[^a-z0-9]+', '', 'g'
  )
$fn$;

ALTER TABLE commerce.wholesale_suppliers
  ADD COLUMN IF NOT EXISTS document TEXT,
  ADD COLUMN IF NOT EXISTS normalized_name TEXT
    GENERATED ALWAYS AS (ops.normalize_supplier_identity(name)) STORED,
  ADD COLUMN IF NOT EXISTS normalized_document TEXT
    GENERATED ALWAYS AS (regexp_replace(coalesce(document, ''), '[^0-9]+', '', 'g')) STORED,
  ADD COLUMN IF NOT EXISTS normalized_phone TEXT
    GENERATED ALWAYS AS (regexp_replace(coalesce(phone, ''), '[^0-9]+', '', 'g')) STORED;

DO $check_duplicates$
BEGIN
  IF EXISTS (
    SELECT 1 FROM commerce.wholesale_suppliers
     WHERE deleted_at IS NULL
     GROUP BY environment, normalized_name
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION '0136 bloqueada: ha fornecedores ativos com nome normalizado duplicado';
  END IF;
  IF EXISTS (
    SELECT 1 FROM commerce.wholesale_suppliers
     WHERE deleted_at IS NULL AND normalized_document <> ''
     GROUP BY environment, normalized_document
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION '0136 bloqueada: ha fornecedores ativos com documento normalizado duplicado';
  END IF;
  IF EXISTS (
    SELECT 1 FROM commerce.wholesale_suppliers
     WHERE deleted_at IS NULL AND normalized_phone <> ''
     GROUP BY environment, normalized_phone
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION '0136 bloqueada: ha fornecedores ativos com telefone normalizado duplicado';
  END IF;
END
$check_duplicates$;

CREATE UNIQUE INDEX IF NOT EXISTS wholesale_suppliers_normalized_name_uniq
  ON commerce.wholesale_suppliers (environment, normalized_name)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS wholesale_suppliers_normalized_document_uniq
  ON commerce.wholesale_suppliers (environment, normalized_document)
  WHERE deleted_at IS NULL AND normalized_document <> '';

CREATE UNIQUE INDEX IF NOT EXISTS wholesale_suppliers_normalized_phone_uniq
  ON commerce.wholesale_suppliers (environment, normalized_phone)
  WHERE deleted_at IS NULL AND normalized_phone <> '';

-- Compra pendente significa mercadoria ainda nao recebida: nao mexe no galpao.
-- Default true preserva as insercoes da versao anterior durante uma implantacao
-- escalonada; o backend novo grava false explicitamente nas compras pendentes.
ALTER TABLE commerce.wholesale_purchases
  ADD COLUMN IF NOT EXISTS stock_applied BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS stock_applied_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stock_applied_by TEXT;

UPDATE commerce.wholesale_purchases
   SET stock_applied_at = COALESCE(stock_applied_at, purchased_at),
       stock_applied_by = COALESCE(stock_applied_by, created_by)
 WHERE stock_applied AND stock_applied_at IS NULL;

ALTER TABLE commerce.wholesale_purchases
  DROP CONSTRAINT IF EXISTS wholesale_purchases_status_check;
ALTER TABLE commerce.wholesale_purchases
  ADD CONSTRAINT wholesale_purchases_status_check
  CHECK (status IN ('pending', 'confirmed', 'cancelled'));

ALTER TABLE commerce.wholesale_purchases
  DROP CONSTRAINT IF EXISTS wholesale_purchases_stock_state_check;
ALTER TABLE commerce.wholesale_purchases
  ADD CONSTRAINT wholesale_purchases_stock_state_check
  CHECK ((status <> 'pending' OR stock_applied = false)
     AND (status <> 'confirmed' OR stock_applied = true));

CREATE INDEX IF NOT EXISTS wholesale_purchases_receipt_pending_idx
  ON commerce.wholesale_purchases (environment, purchased_at DESC)
  WHERE status = 'pending' AND stock_applied = false;

-- Dinheiro nasce na compra, nao no recebimento. O indice legado de contas a
-- pagar precisa incluir mercadoria em transito e excluir apenas canceladas.
DROP INDEX IF EXISTS commerce.wholesale_purchases_pending_idx;
CREATE INDEX wholesale_purchases_pending_idx
  ON commerce.wholesale_purchases(environment, due_date)
  WHERE payment_status = 'pending' AND status <> 'cancelled';

-- A remocao continua sendo soft delete, agora com operador e motivo na propria
-- entidade alem do evento imutavel em audit.events.
ALTER TABLE commerce.matriz_expenses
  ADD COLUMN IF NOT EXISTS deleted_by TEXT,
  ADD COLUMN IF NOT EXISTS delete_reason TEXT;

DO $validation$
DECLARE
  t TEXT;
  column_list TEXT;
  privilege_name TEXT;
BEGIN
  IF to_regclass('audit.operation_idempotency') IS NULL THEN
    RAISE EXCEPTION '0136 falhou: livro de idempotencia nao existe';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'farejador_partner_app') THEN
    FOREACH t IN ARRAY ARRAY[
      'audit.operation_idempotency',
      'commerce.wholesale_suppliers',
      'commerce.wholesale_purchases',
      'commerce.matriz_expenses'
    ] LOOP
      EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE %s FROM %I',
                     t::regclass, 'farejador_partner_app');
      SELECT string_agg(format('%I', a.attname), ',' ORDER BY a.attnum)
        INTO column_list
        FROM pg_attribute a
       WHERE a.attrelid=t::regclass AND a.attnum>0 AND NOT a.attisdropped;
      IF column_list IS NOT NULL THEN
        EXECUTE format('REVOKE ALL PRIVILEGES (%s) ON TABLE %s FROM %I',
                       column_list, t::regclass, 'farejador_partner_app');
      END IF;

      FOREACH privilege_name IN ARRAY ARRAY[
        'SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'
      ] LOOP
        IF has_table_privilege('farejador_partner_app', t, privilege_name) THEN
          RAISE EXCEPTION '0136 falhou: parceiro possui privilegio % sobre %', privilege_name, t;
        END IF;
      END LOOP;
      FOREACH privilege_name IN ARRAY ARRAY['SELECT','INSERT','UPDATE','REFERENCES'] LOOP
        IF has_any_column_privilege('farejador_partner_app', t, privilege_name) THEN
          RAISE EXCEPTION '0136 falhou: parceiro possui privilegio de coluna % sobre %', privilege_name, t;
        END IF;
      END LOOP;
    END LOOP;
  END IF;
END
$validation$;

-- Rollback manual (exige primeiro retirar o backend 0136):
-- DROP INDEX IF EXISTS commerce.wholesale_purchases_receipt_pending_idx;
-- ALTER TABLE commerce.wholesale_purchases DROP CONSTRAINT IF EXISTS wholesale_purchases_stock_state_check;
-- ALTER TABLE commerce.wholesale_purchases DROP CONSTRAINT IF EXISTS wholesale_purchases_status_check;
-- ALTER TABLE commerce.wholesale_purchases ADD CONSTRAINT wholesale_purchases_status_check CHECK (status IN ('confirmed','cancelled'));
-- ALTER TABLE commerce.wholesale_purchases DROP COLUMN IF EXISTS stock_applied, DROP COLUMN IF EXISTS stock_applied_at, DROP COLUMN IF EXISTS stock_applied_by;
-- DROP INDEX IF EXISTS commerce.wholesale_suppliers_normalized_document_uniq;
-- DROP INDEX IF EXISTS commerce.wholesale_suppliers_normalized_phone_uniq;
-- DROP INDEX IF EXISTS commerce.wholesale_suppliers_normalized_name_uniq;
-- ALTER TABLE commerce.wholesale_suppliers DROP COLUMN IF EXISTS normalized_phone, DROP COLUMN IF EXISTS normalized_document, DROP COLUMN IF EXISTS normalized_name, DROP COLUMN IF EXISTS document;
-- ALTER TABLE commerce.matriz_expenses DROP COLUMN IF EXISTS deleted_by, DROP COLUMN IF EXISTS delete_reason;
-- DROP TABLE IF EXISTS audit.operation_idempotency;
-- DROP FUNCTION IF EXISTS ops.normalize_supplier_identity(TEXT);
