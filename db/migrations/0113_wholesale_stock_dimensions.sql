-- ============================================================
-- 0113_wholesale_stock_dimensions.sql
-- ATACADO (Fase 4) — UNIFORMIZA o galpão da matriz com o estoque do parceiro.
--
-- Contexto: hoje commerce.wholesale_stock guarda a medida só no TEXTO (measure).
-- O estoque do PARCEIRO (commerce.partner_stock_levels) guarda a medida também em
-- NÚMEROS (tire_width_mm/tire_aspect_ratio/tire_rim_diameter) — robusto a formato
-- ('100-80-18' == '100/80-18') e à prova do erro de digitação grudada ('10080-18').
-- Esta migration espelha esses 3 campos no galpão. O cadastro passa a preenchê-los
-- casando a medida com o catálogo (commerce.tire_specs) — ver wholesale-catalog.ts.
-- Base também pro futuro "parceiro pede pneu da matriz via sistema".
--
-- Decisão (2026-06-23, dono): ESPELHAR a estrutura do parceiro, NÃO fundir as tabelas
-- (matriz = fornecedor, parceiro = revendedor; papéis distintos). Ver memória
-- project_virada_producao.
--
-- Segurança: dado SÓ DA MATRIZ (igual 0110/0111/0112) → ZERO grant pro
-- farejador_partner_app (re-checado na §3). 100% ADITIVA: colunas nullable, nenhum
-- dado destruído; preenche o que já existe casando measure = tire_size do catálogo.
-- Assinatura: Orquestrador (Claude Opus 4.8) — banco/matriz, 2026-06-23
-- ============================================================

-- ─────────────────────────────────────────────
-- 1. NÚMEROS DA MEDIDA (espelha partner_stock_levels)
-- ─────────────────────────────────────────────
ALTER TABLE commerce.wholesale_stock
  ADD COLUMN IF NOT EXISTS tire_width_mm     INTEGER,  -- largura (ex.: 90)
  ADD COLUMN IF NOT EXISTS tire_aspect_ratio INTEGER,  -- perfil/altura (ex.: 90)
  ADD COLUMN IF NOT EXISTS tire_rim_diameter INTEGER;  -- aro (ex.: 18)

COMMENT ON COLUMN commerce.wholesale_stock.tire_width_mm IS
  'Largura da medida em numero (espelha partner_stock_levels, 0113). Preenchido pelo cadastro casando com o catalogo tire_specs.';

-- ─────────────────────────────────────────────
-- 2. MIGRA O QUE JÁ EXISTE — preenche os números casando measure = tire_size do catálogo
-- ─────────────────────────────────────────────
-- Casa pelo formato EXATO (as linhas atuais vieram do catálogo). O que não casar exato
-- fica NULL e o próximo cadastro corrige (canoniza pelo catálogo). Vários tire_specs com
-- o mesmo tire_size (front/rear) têm os MESMOS números → o match arbitrário é seguro.
UPDATE commerce.wholesale_stock ws
   SET tire_width_mm     = ts.width_mm,
       tire_aspect_ratio = ts.aspect_ratio,
       tire_rim_diameter = ts.rim_diameter
  FROM commerce.tire_specs ts
 WHERE ts.environment = ws.environment
   AND ts.tire_size = ws.measure
   AND ws.tire_width_mm IS NULL;

-- ─────────────────────────────────────────────
-- 3. VALIDAÇÃO — colunas existem + parceiro continua SEM acesso (regra de ouro)
-- ─────────────────────────────────────────────
DO $check$
DECLARE
  v_cols INTEGER;
  v_sel  BOOLEAN;
BEGIN
  SELECT count(*) INTO v_cols
    FROM information_schema.columns
   WHERE table_schema = 'commerce' AND table_name = 'wholesale_stock'
     AND column_name IN ('tire_width_mm','tire_aspect_ratio','tire_rim_diameter');
  IF v_cols <> 3 THEN
    RAISE EXCEPTION '0113 falhou: esperava 3 colunas novas, achei %', v_cols;
  END IF;

  SELECT has_table_privilege('farejador_partner_app', 'commerce.wholesale_stock', 'SELECT') INTO v_sel;
  IF v_sel THEN
    RAISE EXCEPTION '0113 falhou: farejador_partner_app NAO deveria acessar wholesale_stock';
  END IF;

  RAISE NOTICE '0113 OK: galpao com larg/alt/aro, parceiro segue sem acesso ao atacado.';
END;
$check$;

-- ============================================================
-- ROLLBACK (manual, se precisar):
--   ALTER TABLE commerce.wholesale_stock
--     DROP COLUMN IF EXISTS tire_width_mm,
--     DROP COLUMN IF EXISTS tire_aspect_ratio,
--     DROP COLUMN IF EXISTS tire_rim_diameter;
-- ============================================================
