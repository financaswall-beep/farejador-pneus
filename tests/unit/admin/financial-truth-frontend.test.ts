import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

describe('verdade financeira na interface da Matriz', () => {
  it('usa o pedido cheio no card do varejo e explicita pneus/frete no CSV', () => {
    const varejo = readFileSync(`${ROOT}/painel/public/app.varejo.js`, 'utf8');
    const historico = readFileSync(`${ROOT}/painel/public/app.vendas.historico.js`, 'utf8');

    expect(varejo).toContain('varejoResumo.faturamento_total');
    expect(historico).toContain("'Pneus'");
    expect(historico).toContain("'Frete'");
    expect(historico).toContain('row.itemsAmount');
    expect(historico).toContain('row.freightAmount');
  });

  it('não chama competência de realizado e lê o movimento de caixa do backend', () => {
    const indicadores = readFileSync(`${ROOT}/painel/public/app.financeiro.indicadores.js`, 'utf8');
    const html = readFileSync(`${ROOT}/painel/public/index.html`, 'utf8');

    expect(indicadores).toContain('v.verdade.caixa.movimento_liquido');
    expect(indicadores).not.toContain('const resultado = Number(v.mes.lucro || 0)');
    expect(html).toContain('Movimento líquido registrado');
    expect(html).toContain('Lucro confirmado');
    expect(html).toContain('receita_custo_pendente');
    expect(html).toContain('Livro financeiro central');
    expect(html).toContain('Fallback automático');
  });

  it('baixa a agenda central sem desviar marketing e devoluções para rotas legadas', () => {
    const financeiro = readFileSync(`${ROOT}/painel/public/app.financeiro.js`, 'utf8');
    const compras = readFileSync(`${ROOT}/painel/public/app.compras.js`, 'utf8');

    expect(financeiro).toContain('/admin/api/matriz/financeiro/ledger/settle');
    expect(financeiro).toContain("item.settlement_mode === 'central_account'");
    expect(financeiro).toContain('/admin/api/rede/mensalidades/settle');
    expect(financeiro).toContain('/admin/api/rede/comissoes/refund');
    expect(compras).toContain("marketing: 'Marketing'");
    expect(compras).toContain("devolucao_cliente: 'Devolução ao cliente'");
  });
});
