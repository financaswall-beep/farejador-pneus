import { readFileSync } from 'node:fs';
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
    saldo_anterior: '0.00', entradas_registradas: revenue, saidas_registradas: '0.00',
    movimento_liquido: revenue, saldo_atual: revenue, recebimento_pendente: '0.00',
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
  writer: boolean;
  reader: boolean;
  health?: 'green' | 'yellow' | 'red' | 'disabled';
}) {
  const central = vi.fn().mockResolvedValue(truth('110.00'));
  const health = vi.fn().mockResolvedValue({ status: input.health ?? 'green' });
  vi.doMock('../../../src/persistence/db.js', () => ({ pool: {} }));
  vi.doMock('../../../src/shared/config/env.js', () => ({
    env: {
      FAREJADOR_ENV: 'test', MATRIZ_CENTRAL_LEDGER: input.writer,
      MATRIZ_CENTRAL_LEDGER_READ: input.reader,
    },
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
  return { module, central, health };
}

describe('corte da leitura financeira antiga', () => {
  beforeEach(() => vi.resetModules());

  it.each([
    { writer: false, reader: false },
    { writer: false, reader: true },
    { writer: true, reader: false },
  ])('falha fechado quando o livro central nao esta integralmente ativo', async (flags) => {
    const loaded = await loadSwitch(flags);
    await expect(
      loaded.module.getMatrizFinancialRead('test', {} as never),
    ).rejects.toThrow('central_ledger_disabled');
    expect(loaded.central).not.toHaveBeenCalled();
    expect(loaded.health).not.toHaveBeenCalled();
  });

  it.each(['red', 'disabled'] as const)(
    'falha fechado quando a integracao esta %s',
    async (healthStatus) => {
      const loaded = await loadSwitch({
        writer: true, reader: true, health: healthStatus,
      });
      await expect(
        loaded.module.getMatrizFinancialRead('test', {} as never),
      ).rejects.toThrow(`central_ledger_integration_${healthStatus}`);
      expect(loaded.central).not.toHaveBeenCalled();
    },
  );

  it.each(['green', 'yellow'] as const)(
    'usa exclusivamente o livro central quando a integracao esta %s',
    async (healthStatus) => {
      const loaded = await loadSwitch({
        writer: true, reader: true, health: healthStatus,
      });
      const result = await loaded.module.getMatrizFinancialRead(
        'test', {} as never, '2026-08',
      );
      expect(result).toEqual({
        source: 'central_ledger',
        integration_status: healthStatus,
        truth: truth('110.00'),
      });
      expect(loaded.central).toHaveBeenCalledOnce();
      expect(loaded.central).toHaveBeenCalledWith('test', {}, '2026-08');
    },
  );

  it('nao importa nem chama o calculador financeiro antigo', () => {
    const source = readFileSync(
      'src/admin/painel/queries-financeiro-read-switch.ts',
      'utf8',
    );
    expect(source).not.toContain('getLegacyMatrizFinancialTruth');
    expect(source).not.toContain("source: 'legacy'");
    expect(source).not.toContain('fallback_reason');
  });
});
