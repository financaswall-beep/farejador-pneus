-- 0207 - Identidade visual das marcas e nome canônico dos pneus do Catálogo.
-- Não altera preço, estoque, compras, pedidos, custos nem financeiro.

DO $preflight$
BEGIN
  IF to_regclass('commerce.products') IS NULL
     OR to_regclass('commerce.tire_specs') IS NULL
     OR to_regclass('audit.events') IS NULL THEN
    RAISE EXCEPTION '0207: tabelas obrigatorias ausentes';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM commerce.products p
      LEFT JOIN commerce.tire_specs ts
        ON ts.environment=p.environment AND ts.product_id=p.id
     WHERE p.product_type='tire' AND p.deleted_at IS NULL
     GROUP BY p.environment,p.id
    HAVING count(ts.id)<>1
  ) THEN
    RAISE EXCEPTION '0207: pneu ativo sem exatamente uma medida no catalogo';
  END IF;

  IF EXISTS (
    WITH normalized AS (
      SELECT p.environment,p.id,p.tire_condition,
             regexp_replace(ts.tire_size,'[^0-9]+','','g') AS measure_key,
             CASE regexp_replace(lower(btrim(COALESCE(p.brand,''))),'[^a-z0-9]+','','g')
               WHEN 'ira' THEN 'IRA'
               WHEN 'irc' THEN 'IRC'
               WHEN 'ciat' THEN 'CEAT'
               WHEN 'ceat' THEN 'CEAT'
               ELSE btrim(COALESCE(p.brand,''))
             END AS normalized_brand
        FROM commerce.products p
        JOIN commerce.tire_specs ts
          ON ts.environment=p.environment AND ts.product_id=p.id
       WHERE p.product_type='tire' AND p.deleted_at IS NULL
    )
    SELECT 1
      FROM normalized
     GROUP BY environment,measure_key,lower(normalized_brand),tire_condition
    HAVING count(*)>1
  ) THEN
    RAISE EXCEPTION '0207: normalizacao de marca criaria variante duplicada';
  END IF;
END
$preflight$;

WITH target AS (
  SELECT p.id,p.environment,p.product_name AS old_name,p.brand AS old_brand,
         CASE regexp_replace(lower(btrim(COALESCE(p.brand,''))),'[^a-z0-9]+','','g')
           WHEN 'ira' THEN 'IRA'
           WHEN 'irc' THEN 'IRC'
           WHEN 'ciat' THEN 'CEAT'
           WHEN 'ceat' THEN 'CEAT'
           ELSE btrim(p.brand)
         END AS new_brand,
         ts.tire_size
    FROM commerce.products p
    JOIN commerce.tire_specs ts
      ON ts.environment=p.environment AND ts.product_id=p.id
   WHERE p.product_type='tire' AND p.deleted_at IS NULL
), changes AS (
  SELECT *,concat('Pneu ',new_brand,' ',tire_size) AS new_name
    FROM target
   WHERE old_brand IS DISTINCT FROM new_brand
      OR old_name IS DISTINCT FROM concat('Pneu ',new_brand,' ',tire_size)
)
INSERT INTO audit.events
  (environment,domain,entity_table,entity_id,event_type,actor_label,payload_before,payload_after)
SELECT environment,'catalog','commerce.products',id,
       'catalog_product_identity_normalized','migration_0207',
       jsonb_build_object('product_name',old_name,'brand',old_brand),
       jsonb_build_object(
         'product_name',new_name,
         'brand',new_brand,
         'tire_size',tire_size,
         'reason','Padrao Pneu + Marca + Medida e aliases oficiais CEAT/IRA/IRC',
         'effects',jsonb_build_object(
           'price',false,'stock',false,'purchase',false,'finance',false,'orders',false
         )
       )
  FROM changes;

WITH target AS (
  SELECT p.id,p.environment,
         CASE regexp_replace(lower(btrim(COALESCE(p.brand,''))),'[^a-z0-9]+','','g')
           WHEN 'ira' THEN 'IRA'
           WHEN 'irc' THEN 'IRC'
           WHEN 'ciat' THEN 'CEAT'
           WHEN 'ceat' THEN 'CEAT'
           ELSE btrim(p.brand)
         END AS new_brand,
         ts.tire_size
    FROM commerce.products p
    JOIN commerce.tire_specs ts
      ON ts.environment=p.environment AND ts.product_id=p.id
   WHERE p.product_type='tire' AND p.deleted_at IS NULL
)
UPDATE commerce.products p
   SET brand=t.new_brand,
       product_name=concat('Pneu ',t.new_brand,' ',t.tire_size),
       updated_at=now()
  FROM target t
 WHERE p.environment=t.environment AND p.id=t.id
   AND (p.brand IS DISTINCT FROM t.new_brand
        OR p.product_name IS DISTINCT FROM concat('Pneu ',t.new_brand,' ',t.tire_size));

DO $smoke$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM commerce.products p
      JOIN commerce.tire_specs ts
        ON ts.environment=p.environment AND ts.product_id=p.id
     WHERE p.product_type='tire' AND p.deleted_at IS NULL
       AND p.product_name IS DISTINCT FROM concat('Pneu ',p.brand,' ',ts.tire_size)
  ) THEN
    RAISE EXCEPTION 'smoke 0207: nome de pneu fora do padrao canonico';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM commerce.products p
     WHERE p.product_type='tire' AND p.deleted_at IS NULL
       AND regexp_replace(lower(btrim(COALESCE(p.brand,''))),'[^a-z0-9]+','','g')
           IN ('ciat')
  ) THEN
    RAISE EXCEPTION 'smoke 0207: alias Ciat permaneceu no catalogo';
  END IF;
END
$smoke$;
