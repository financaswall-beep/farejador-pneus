import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applicationsForMeasure, applicationsForMotorcycle, applicationMeasureKey }
  from '../../../src/shared/vehicle-tire-applications.js';
import { compatibilityInput, vehicleApplicationAnswer }
  from '../../../src/atendente-v2/vehicle-application-answer.js';

describe('aplicações do fabricante — moto, versão, medida e posição', () => {
  it('mantém o snapshot público sincronizado com a pesquisa versionada', async () => {
    const { bikes, applications } = await import('../../../scripts/data/catalog-fitment-research-20260906.mjs');
    const snapshot = JSON.parse(readFileSync('src/shared/data/vehicle-tire-research-20260906.json', 'utf8'));
    expect(snapshot.slice(0, bikes.length)).toEqual(bikes);
    expect(snapshot).toHaveLength(84);
    expect(snapshot.filter((b: any) => b.market === 'Brasil' && b.status === 'Medida confirmada na fonte')).toHaveLength(73);
    const accepted = applications.filter((a: any) => a.market === 'Brasil' && a.status === 'Medida confirmada na fonte');
    expect(accepted).toHaveLength(145);
    expect(new Set(accepted.map((a: any) => a.id)).size).toBe(72);
    for (const a of accepted) {
      expect(applicationsForMeasure(a.measure).some(r => r.model === a.model && r.tire_size === a.measure)).toBe(true);
    }
  });

  it('separa Fan e Titan do mesmo ano e não estende a outros anos', () => {
    expect(applicationsForMotorcycle('fan 160', 2019, 'rear').map(a => a.tire_size)).toEqual(['90/90-18']);
    expect(applicationsForMotorcycle('titan160', 2020, 'rear').map(a => a.tire_size)).toEqual(['100/80-18']);
    expect(applicationsForMotorcycle('titan160', 2018, 'rear')).toEqual([]);
    expect(applicationsForMotorcycle('fan', 2015).every(a => a.model.includes('150'))).toBe(true);
  });

  it('não troca CB 250F e CB 300F nem apaga construção radial', () => {
    expect(applicationsForMotorcycle('CB250F', 2019, 'rear')[0]?.tire_size).toBe('140/70R17');
    expect(applicationsForMotorcycle('CB300F', 2026, 'rear')[0]?.tire_size).toBe('150/60R17');
    expect(applicationsForMeasure('140/70-17').some(a => a.model.includes('CB 300F'))).toBe(false);
  });

  it('distingue dianteira e traseira de Burgman e Lindy', () => {
    for (const model of ['Burgman125i', 'Lindy125']) {
      expect(applicationsForMotorcycle(model, undefined, 'front')[0]?.tire_size).toBe('90/90-10');
      expect(applicationsForMotorcycle(model, undefined, 'rear')[0]?.tire_size).toBe('100/90-10');
    }
  });

  it('inclui aro 15/16, medidas largas e alternativas expressas sem equivalência universal', () => {
    expect(applicationsForMotorcycle('XMAX 300', 2026, 'front')[0]?.tire_size).toBe('120/70-15');
    expect(applicationsForMotorcycle('Citycom HD 300', undefined, 'rear')[0]?.tire_size).toBe('130/70-16');
    expect(applicationsForMotorcycle('Panigale', undefined, 'rear')[0]?.tire_size).toBe('200/60ZR17');
    expect(applicationsForMotorcycle('Mottu', undefined, 'rear').map(a => a.tire_size)).toEqual(['3.00-17', '90/90-17']);
    expect(applicationMeasureKey('3.00-17')).not.toBe(applicationMeasureKey('90/90-17'));
    expect(applicationMeasureKey('150/80B16')).toBe('150/80B16');
  });

  it('não libera fontes conflitantes, internacionais ou de reposição não confirmada', () => {
    for (const model of ['Classic350', 'MT07', 'DR160']) {
      expect(applicationsForMotorcycle(model)).toEqual([]);
    }
    expect(applicationsForMotorcycle('Maxsym 400 GT', 2026)).toEqual([]);
    expect(applicationsForMotorcycle('XMAX250', 2021)).toEqual([]);
    expect(applicationsForMotorcycle('FZ25', 2022)).toEqual([]);
  });

  it('usa o manual brasileiro da Fazer FZ25 2025 sem retroagir a 2022', () => {
    const front = applicationsForMotorcycle('Fazer 250', 2025, 'front')[0];
    const rear = applicationsForMotorcycle('FZ25', 2025, 'rear')[0];
    expect(front).toMatchObject({ tire_size: '100/80-17', index_spec: '52H', mounting: 'Sem câmara' });
    expect(rear).toMatchObject({ tire_size: '140/70-17', index_spec: '66H', mounting: 'Sem câmara' });
    expect(applicationsForMotorcycle('Fazer 250', 2022)).toEqual([]);
  });

  it('responde referência sem fabricar produto, preço ou estoque', () => {
    const answer = vehicleApplicationAnswer(compatibilityInput('prod', {
      moto_modelo: 'CB300F', moto_ano: 2026, posicao_pneu: 'rear',
    }));
    expect(answer).toMatchObject({ encontrado: true, produto_confirmado: false, estoque_consultado: false,
      precisa_confirmar_modelo_versao: false, precisa_confirmar_ano: false, precisa_confirmar_posicao: false });
    expect(answer?.aplicacoes[0]).toMatchObject({ tire_size: '150/60R17', position: 'rear', product_fitment_confirmed: false });
    expect(answer).not.toHaveProperty('veiculos');
    expect(answer).not.toHaveProperty('preco');
    expect(answer).toMatchObject({ referencia_em_uso: true, requer_aprovacao_manual_da_referencia: false,
      consultas_de_produto: [{ medida_pneu: '150/60-17' }] });
  });

  it('pede confirmação de ambiguidade e de ano não delimitado', () => {
    expect(vehicleApplicationAnswer(compatibilityInput('prod', { moto_modelo: 'fan' })))
      .toMatchObject({ precisa_confirmar_modelo_versao: true, precisa_confirmar_ano: true });
    expect(vehicleApplicationAnswer(compatibilityInput('prod', { moto_modelo: 'Lindy 125', moto_ano: 2020 })))
      .toMatchObject({ precisa_confirmar_ano: true });
    expect(vehicleApplicationAnswer(compatibilityInput('prod', { moto_modelo: 'Modelo inexistente' }))).toBeNull();
  });

  it('prepara busca nominal por condição sem confundir posição da aplicação com posição do SKU', () => {
    const answer = vehicleApplicationAnswer(compatibilityInput('prod', {
      moto_modelo: 'Fazer 250', moto_ano: 2025, posicao_pneu: 'rear', condicao_pneu: 'meia_vida',
    }));
    expect(answer?.consultas_de_produto).toEqual([{ medida_pneu: '140/70-17', condicao_pneu: 'meia_vida' }]);
    expect(answer?.aplicacoes[0]?.position).toBe('rear');
    expect(answer?.produto_confirmado).toBe(false);
    for (const args of [{ moto_modelo: 'Fan' }, { moto_modelo: 'Fazer 250', moto_ano: 2025 },
      { moto_modelo: 'Lindy 125', moto_ano: 2020, posicao_pneu: 'rear' }]) {
      expect(vehicleApplicationAnswer(compatibilityInput('prod', args))?.consultas_de_produto).toEqual([]);
    }
  });

  it('não deixa consumidor alterar o catálogo compartilhado', () => {
    const first = applicationsForMotorcycle('CB300F', 2026, 'rear');
    first[0]!.tire_size = '140/70-17';
    expect(applicationsForMotorcycle('CB300F', 2026, 'rear')[0]?.tire_size).toBe('150/60R17');
  });
});
