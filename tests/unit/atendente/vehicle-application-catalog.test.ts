import { describe, expect, it, vi } from 'vitest';
import { buildApplicationImport } from '../../../scripts/vehicle-application-import.js';
import { loadVehicleApplicationCatalog, matchCatalogApplications } from '../../../src/shared/vehicle-application-catalog.js';
import { compatibilityInput, vehicleApplicationAnswer } from '../../../src/atendente-v2/vehicle-application-answer.js';

const plan = buildApplicationImport();
const catalog = plan.filter(r => r.status === 'verified').map(r => r.application);
describe('catálogo de aplicações independente de SKU', () => {
  it.each([2017,2018,2019,2020,2021,2022,2023,2024,2025,2026])('NMAX %i resolve o par pelos anos comprovados', year => {
    const rows = matchCatalogApplications(catalog, 'NMAX 160', year, 'both');
    expect(new Set(rows.filter(r=>r.position==='front').map(r=>r.tire_size))).toEqual(new Set(['110/70-13']));
    expect(new Set(rows.filter(r=>r.position==='rear').map(r=>r.tire_size))).toEqual(new Set(['130/70-13']));
    const result = vehicleApplicationAnswer(compatibilityInput('test', {
      moto_modelo:'NMAX',moto_ano:year,posicao_pneu:'rear',
    }),catalog);
    expect(result).toMatchObject({precisa_confirmar_ano:false,precisa_confirmar_modelo_versao:false,
      consultas_de_produto:[{medida_pneu:'130/70-13'}]});
  });
  it('edições repetidas não obrigam a perguntar o ano da NMAX nem a repetir a posição dos dois pneus', () => {
    const rear = vehicleApplicationAnswer(compatibilityInput('test', {moto_modelo:'NMAX',posicao_pneu:'rear'}),catalog);
    expect(rear).toMatchObject({precisa_confirmar_ano:false,precisa_confirmar_posicao:false,
      consultas_de_produto:[{medida_pneu:'130/70-13'}]});
    const pair = vehicleApplicationAnswer(compatibilityInput('test', {moto_modelo:'NMAX',posicao_pneu:'both'}),catalog);
    expect(pair?.precisa_confirmar_posicao).toBe(false);
    expect(pair?.consultas_de_produto).toHaveLength(2);
  });
  it('não estende o período comprovado para anos sem evidência', () => {
    const result = vehicleApplicationAnswer(compatibilityInput('test', {
      moto_modelo:'NMAX',moto_ano:2030,posicao_pneu:'rear',
    }),catalog);
    expect(result).toMatchObject({tipo_resultado:'modelo_reconhecido_ano_nao_confirmado',consultas_de_produto:[]});
    const incomplete = vehicleApplicationAnswer(compatibilityInput('test', {
      moto_modelo:'Fan',posicao_pneu:'rear',
    }),catalog);
    expect(incomplete?.precisa_confirmar_ano).toBe(true);
    expect(incomplete?.consultas_de_produto).toEqual([]);
  });
  it('preserva diferenças de geração, polegadas e construção', () => {
    expect(matchCatalogApplications(catalog,'Fazer 150',2018,'front').map(r=>r.tire_size)).toEqual(['2.75-18']);
    expect(new Set(matchCatalogApplications(catalog,'Fazer 150',2025,'front').map(r=>r.tire_size)))
      .toEqual(new Set(['2.75-18','80/100-18']));
    expect(matchCatalogApplications(catalog,'CB250F',2021,'rear')[0]?.tire_size).toBe('140/70R17');
    expect(matchCatalogApplications(catalog,'CB250F',2023,'rear')).toEqual([]);
    expect(matchCatalogApplications(catalog,'Crosser',2018,'rear')[0]?.tire_size).toBe('110/90-17');
    expect(matchCatalogApplications(catalog,'Fazer 250',2018,'rear')[0]?.tire_size).toBe('140/70-17');
    expect(matchCatalogApplications(catalog,'Fluo 125',2025,'rear')[0]?.tire_size).toBe('110/90-12');
    expect(matchCatalogApplications(catalog,'PCX150',2015,'rear').map(r=>r.tire_size)).not.toContain('120/70-14');
  });
  it('preserva as 24 medidas na revisão e mantém alternativas fora do bot', () => {
    expect(new Set(plan.map(r=>r.application.display_measure)).size).toBeGreaterThanOrEqual(24);
    expect(plan.filter(r=>r.kind==='alternative')).toHaveLength(5);
    expect(plan.filter(r=>r.kind==='alternative').every(r=>r.status!=='verified')).toBe(true);
    expect(catalog.every(r=>r.product_fitment_confirmed===false && r.source_url.startsWith('https://'))).toBe(true);
    expect(new Set(plan.map(r=>r.application.application_id)).size).toBe(plan.length);
  });
  it('lê exclusivamente o ambiente e as aplicações originais verificadas; erro do banco não usa lista desatualizada', async () => {
    const query = vi.fn().mockResolvedValue({rows:[]});
    expect(await loadVehicleApplicationCatalog({query},'test','140/70R17')).toEqual([]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("status='verified' AND application_kind='original'"),['test','140/70-17']);
    query.mockRejectedValue(new Error('offline'));
    await expect(loadVehicleApplicationCatalog({query},'prod')).rejects.toThrow('offline');
  });
});
