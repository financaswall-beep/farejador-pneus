import type { Pool, PoolClient } from 'pg';
import { tireSizeKey } from '../../shared/tire-size.js';

/**
 * Casamento de uma medida DIGITADA no galpão (atacado) com o CATÁLOGO (commerce.tire_specs).
 * Objetivo (Fase 4): o galpão da matriz guardar a medida no padrão do parceiro — formato
 * OFICIAL do catálogo + os 3 números (largura/perfil/aro) — e RECUSAR medida fantasma.
 * Mata o erro de digitação grudada ('10080-18') e a duplicata por formato
 * ('100-80-18' vs '100/80-18' vs '100/80 18' → todos a mesma linha canônica).
 */

/** Uma medida do catálogo: o formato OFICIAL (tire_size) + os 3 números. */
export interface CatalogMeasure {
  measure: string; // tire_size canônico (ex.: '90/90-18')
  width: number | null; // width_mm
  aspect: number | null; // aspect_ratio
  rim: number | null; // rim_diameter
}

/**
 * Casa a medida digitada contra o catálogo pela CHAVE canônica (tireSizeKey — os 3 números,
 * ignorando separador/letra; a MESMA do bot, pra cadastro e busca nunca divergirem). Devolve
 * a entrada OFICIAL do catálogo ou null quando não existe (lixo '10080-18' vira chave de 2
 * números e não casa; medida fora do catálogo idem). PURA — testável sem banco.
 */
export function pickCatalogMeasure(measure: string, catalog: CatalogMeasure[]): CatalogMeasure | null {
  const key = tireSizeKey(measure);
  if (!key) return null;
  for (const c of catalog) {
    if (tireSizeKey(c.measure) === key) return c;
  }
  return null;
}

/**
 * Versão com banco: carrega o catálogo (tire_specs, dezenas de linhas — barato) e casa a
 * medida. Usada pelo cadastro do galpão (set/entry) pra gravar o formato OFICIAL + os números
 * e recusar fantasma. Aceita Pool ou PoolClient (mesma transação da venda, se preciso).
 */
export async function resolveMeasureInCatalog(
  db: Pool | PoolClient,
  environment: 'prod' | 'test',
  measure: string,
): Promise<CatalogMeasure | null> {
  const r = await db.query<{
    tire_size: string;
    width_mm: number | null;
    aspect_ratio: number | null;
    rim_diameter: number | null;
  }>(
    `SELECT DISTINCT tire_size, width_mm, aspect_ratio, rim_diameter
       FROM commerce.tire_specs
      WHERE environment = $1 AND tire_size IS NOT NULL`,
    [environment],
  );
  const catalog: CatalogMeasure[] = r.rows.map((row) => ({
    measure: row.tire_size,
    width: row.width_mm,
    aspect: row.aspect_ratio,
    rim: row.rim_diameter,
  }));
  return pickCatalogMeasure(measure, catalog);
}
