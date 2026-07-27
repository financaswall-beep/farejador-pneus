import { beforeEach, describe, expect, it, vi } from 'vitest';

const truth = (revenue: string) => ({
  competencia: {
    receita_total: revenue, receita_custo_conhecido: revenue,
    receita_custo_pendente: '0.00', custo_conhecido: '0.00',
    despesas: '0.00',
    ajustes_estoque: { ganhos: '0.00', perdas: '0.00', efeito_liquido: '0.00' },
    lucro_confirmado: revenue, status: 'confirmado',
  },
  caixa: {
    entradas_registradas: revenue, saidas_registradas: '0.00',
    movimento_liquido: revenue, recebimento_pendente: '0.00',
    recebimentos: { varejo: revenue, atacado: '0.00', comissao: '0.00' },
    pagamentos: {
      compras: '0.00', despesas: '0.00', devolucoes_comissao: '0.00',
    },
  },
  posicao: {
    a_receber: '0.00', a_pagar: '0.00', varejo_a_receber_sem_baixa: '0.00',
  },
  conciliacao: {
    status: 'ok', diferenca_total: '0.00', origens: [],
    custo_pendente: { receita: '0.00', itens: 0, pedidos: 0 },
    cancelamentos: { varejo: 0, atacado: 0, compras: 0, comissoes: 0, despesas: 0 },
    qualidade: {
      datas_caixa_inferidas: 0, comissoes_estornadas_apos_quitacao: 0,
      registros_teste_suspeitos: 0,
    },
  },
});

async function loadSwitch(input: {
  writer: boolean; reader: boolean; health?: 'green' | 'yellow' | 'red';
}) {
  const legacy = vi.fn().mockResolvedValue(truth('100.00'));
  const central = vi.fn().mockResolvedValue(truth('110.00'));
  const health = vi.fn().mockResolvedValue({ status: input.health ?? 'green' });
  vi.doMock('../../../src/persistence/db.js', () => ({ pool: {} }));
  vi.doMock('../../../src/shared/config/env.js', () => ({
    env: {
      FAREJADOR_ENV: 'test', MATRIZ_CENTRAL_LEDGER: input.writer,
      MATRIZ_CENTRAL_LEDGER_READ: input.reader,
    },
  }));
  vi.doMock('../../../src/admin/painel/queries-financeiro-verdade.js', () => ({
    getLegacyMatrizFinancialTruth: legacy,
  }));
  vi.doMock('../../../src/admin/painel/matriz-ledger-financial-read.js', () => ({
    getMatrizCentralLedgerFinancialTruth: central,
  }));
  vi.doMock('../../../src/admin/painel/matriz-ledger-integration-health.js', () => ({
    getMatrizLedgerIntegrationHealth: health,
  }));
  const module = await import(
    '../../../src/admin/painel/queries-financeiro-read-switch.js'
  );
  return { module, legacy, central, health };
}

describe('troca controlada da leitura financeira', () => {
  beforeEach(() => vi.resetModules());

  it('mantem a leitura antiga quando a flag de leitura esta desligada', async () => {
    const loaded = await loadSwitch({ writer: true, reader: false });
    const result = await loaded.module.getMatrizFinancialRead('test', {} as never);
    expect(result).toMatchObject({
      source: 'legacy', requested_source: 'legacy', fallback_reason: null,
    });
    expect(loaded.central).not.toHaveBeenCalled();
    expect(loaded.health).not.toHaveBeenCalled();
  });

  it('faz fallback se pedirem leitura nova sem o writer central', async () => {
    const loaded = await loadSwitch({ writer: false, reader: true });
    const result = await loaded.module.getMatrizFinancialRead('test', {} as never);
    expect(result).toMatchObject({
      source: 'legacy', requested_source: 'central_ledger',
      fallback_reason: 'central_ledger_disabled',
    });
  });

  it('faz fallback automatico quando o monitor esta vermelho', async () => {
    const loaded = await loadSwitch({ writer: true, reader: true, health: 'red' });
    const result = await loaded.module.getMatrizFinancialRead('test', {} as never);
    expect(result).toMatchObject({
      source: 'legacy', fallback_reason: 'integration_red',
      integration_status: 'red',
    });
    expect(loaded.central).not.toHaveBeenCalled();
  });

  it('usa o livro e devolve comparacao quando o gate esta verde', async () => {
    const loaded = await loadSwitch({ writer: true, reader: true, health: 'green' });
    const result = await loaded.module.getMatrizFinancialRead('test', {} as never);
    expect(result).toMatchObject({
      source: 'central_ledger', fallback_reason: null,
      truth: { competencia: { receita_total: '110.00' } },
      comparison: {
        matched: false, fields: { receita: { difference: '10.00' } },
      },
    });
  });
});
