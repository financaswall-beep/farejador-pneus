import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { pickCatalogMeasure, resolveMeasureInCatalog, type CatalogMeasure } from '../../../src/admin/painel/wholesale-catalog.js';

// Catálogo de exemplo (formato OFICIAL + números), como vem de commerce.tire_specs.
const catalogo: CatalogMeasure[] = [
  { measure: '100/80-18', width: 100, aspect: 80, rim: 18 },
  { measure: '90/90-18', width: 90, aspect: 90, rim: 18 },
  { measure: '3.00-10', width: 3, aspect: 0, rim: 10 },
];

describe('pickCatalogMeasure — casa a medida digitada com o catálogo (Fase 4)', () => {
  it('casa formatos diferentes da MESMA medida e devolve o formato OFICIAL', () => {
    for (const digitado of ['100/80-18', '100-80-18', '100 80 18', '100/80/18', '100/80-18 traseiro', ' 100/80-18 ']) {
      const hit = pickCatalogMeasure(digitado, catalogo);
      expect(hit, `"${digitado}" deveria casar`).not.toBeNull();
      expect(hit!.measure).toBe('100/80-18'); // sempre canoniza pro formato do catálogo
      expect(hit!.width).toBe(100);
      expect(hit!.aspect).toBe(80);
      expect(hit!.rim).toBe(18);
    }
  });

  it('RECUSA o erro de digitação grudada (10080-18) — o furo do texto livre', () => {
    expect(pickCatalogMeasure('10080-18', catalogo)).toBeNull();
  });

  it('RECUSA medida que não existe no catálogo', () => {
    expect(pickCatalogMeasure('130/70-13', catalogo)).toBeNull();
  });

  it('RECUSA entradas sem medida (vazio, só letra)', () => {
    expect(pickCatalogMeasure('', catalogo)).toBeNull();
    expect(pickCatalogMeasure('   ', catalogo)).toBeNull();
    expect(pickCatalogMeasure('pneu', catalogo)).toBeNull();
  });

  it('cobre medida em polegada (3.00-10)', () => {
    const hit = pickCatalogMeasure('3.00 10', catalogo);
    expect(hit!.measure).toBe('3.00-10');
    expect(hit!.rim).toBe(10);
  });
});

describe('resolveMeasureInCatalog — versão com banco (carrega tire_specs e casa)', () => {
  it('consulta o catálogo do ambiente certo e devolve o match canônico', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ tire_size: '100/80-18', width_mm: 100, aspect_ratio: 80, rim_diameter: 18 }],
    });
    const db = { query } as unknown as Pool;
    const hit = await resolveMeasureInCatalog(db, 'prod', '100-80-18');
    expect(hit!.measure).toBe('100/80-18');
    expect(query).toHaveBeenCalledTimes(1);
    const [, params] = query.mock.calls[0];
    expect(params).toEqual(['prod']); // só puxa o catálogo do ambiente pedido
  });

  it('devolve null quando o catálogo não tem a medida', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ tire_size: '90/90-18', width_mm: 90, aspect_ratio: 90, rim_diameter: 18 }] });
    const db = { query } as unknown as Pool;
    expect(await resolveMeasureInCatalog(db, 'test', '10080-18')).toBeNull();
  });
});
