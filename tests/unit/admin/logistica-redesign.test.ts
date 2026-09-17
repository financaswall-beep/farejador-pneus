import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const html = readFileSync(resolve('painel/public/index.html'), 'utf8');
const readModule = readFileSync(resolve('painel/public/app.logistica.js'), 'utf8');
const resultModule = readFileSync(resolve('painel/public/app.logistica.resultado.js'), 'utf8');

function logisticsHtml(): string {
  const start = html.indexOf('<div x-show="currentPage === \'logistica\' && isMatrixPanel()"');
  const end = html.indexOf('<!-- ═══ TELA: FINANCEIRO', start);
  return html.slice(start, end);
}

describe('Redesign das três abas da Logistica da Matriz', () => {
  const screen = logisticsHtml();

  it('preserva a navegação e carrega a nova operação', () => {
    expect(html).toContain('/admin/painel/logistica-operacao.css');
    expect(html).toContain('/admin/painel/app.logistica.operacao.js');
    expect(html).toContain('/admin/painel/app.logistica.js?v=20260917-entregas1');
    expect(html).toContain('/admin/painel/app.logistica.resultado.js?v=20260917-entregas1');
    expect(html).toContain('/admin/painel/app.montagem.js?v=20260917-entregas1');
    expect(html).not.toContain('app.logistica.periodos.js');
    expect(screen).toContain('aria-labelledby="logistica-heading"');
    expect(screen).toContain('aria-label="Seções de Logística"');
    expect(screen).toContain("{ id: 'visao', label: 'Operação' }");
    expect(screen).toContain("{ id: 'entregas', label: 'Entregas' }");
    expect(screen).not.toContain("{ id: 'rotas', label: 'Rotas' }");
    expect(screen).toContain("{ id: 'historico', label: 'Histórico e resultados' }");
  });

  it('separa a composicao de cada aba', () => {
    expect(screen).toContain('Próxima saída');
    expect(screen).toContain('Rotas abertas');
    expect(screen).toContain('Precisa de decisão');
    expect(screen).toContain('Pedidos no período');
    expect(screen).toContain('Rotas encerradas');
    expect(screen).toContain('Concluída');
    expect(screen).toContain('Histórico de entregas');
    expect(screen).toContain('Taxa de sucesso');
    expect(screen).toContain('Tempo médio');
    expect(screen).toContain('Gerencie a saída pela aba Operação.');
    expect(screen).toContain('Últimos 30 dias');
  });

  it('ordena os indicadores pelo fluxo operacional e mantem os numeros no periodo', () => {
    const aguardando = screen.indexOf('Aguardando saída');
    const emRota = screen.indexOf('>Em entrega<');
    const entregues = screen.indexOf("'Entregues · '");
    const problemas = screen.indexOf('>Ocorrências<');

    expect(aguardando).toBeGreaterThan(-1);
    expect(aguardando).toBeLessThan(emRota);
    expect(emRota).toBeLessThan(entregues);
    expect(entregues).toBeLessThan(problemas);
    expect(readModule).toContain("entregues: noPeriodo.filter((d) => d.delivery_status === 'delivered').length");
    expect(readModule).toContain('(this.logistica?.reportadas || []).filter((d) => this.logisticaDentroPeriodo(d)).length');
    expect(readModule).toContain('.filter((d) => this.logisticaDentroPeriodo(d) && this.logisticaBuscaMatch(d))');
    expect(screen).toContain("setLogisticaFiltro('entregues', true)");
  });

  it('mantem todas as acoes operacionais de entrega e rota', () => {
    for (const action of ['logEntRemarcar()', 'logOpAdicionar(d)', "logisticaStatus(logOpDialogPedido(), 'delivered')", 'logOpRecolocar()', 'logOpConfirmarFalha()', 'logOpEnviarComprovante($event)', 'logOpFecharRota()', 'logOpAbrirRota()', 'abrirResultadoRota(t)']) expect(screen).toContain(action);
  });

  it('calcula o resumo do historico somente com dados reais do periodo', () => {
    expect(resultModule).toContain('logisticaHistoricoResumo()');
    expect(resultModule).toContain("d.delivery_status === 'delivered'");
    expect(resultModule).toContain('d.delivered_at');
    expect(resultModule).toContain('this.logisticaDentroPeriodo(d)');
    expect(readModule).toContain('logisticaFinalizadasView()');
    expect(resultModule).toContain("this.logisticaPeriodo === '30dias'");
  });

  it('mantem a revisao detalhada recolhida e exclusiva da visao geral', () => {
    expect(screen).toContain('<details x-ref="receiptReviewDetails"');
    expect(screen).toContain("logisticaTab === 'visao'");
    expect(screen).toContain('$refs.receiptReviewDetails.open = true');
  });
});
