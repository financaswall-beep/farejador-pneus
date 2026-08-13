import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const html = readFileSync(resolve('painel/public/index.html'), 'utf8');
const readModule = readFileSync(resolve('painel/public/app.logistica.js'), 'utf8');
const periodModule = readFileSync(resolve('painel/public/app.logistica.periodos.js'), 'utf8');
const resultModule = readFileSync(resolve('painel/public/app.logistica.resultado.js'), 'utf8');

function logisticsHtml(): string {
  const start = html.indexOf('<div x-show="currentPage === \'logistica\'"');
  const end = html.indexOf('<!-- ═══ TELA: FINANCEIRO', start);
  return html.slice(start, end);
}

describe('Redesign das quatro abas da Logistica da Matriz', () => {
  const screen = logisticsHtml();

  it('preserva menu externo, banner e navegacao existentes', () => {
    expect(screen).toContain('/admin/painel/assets/logistica-hero-v2.webp');
    expect(html).toContain('/admin/painel/app.logistica.js?v=20260813-logistica-redesign2');
    expect(html).toContain('/admin/painel/app.logistica.resultado.js?v=20260813-logistica-redesign2');
    expect(html).toContain('/admin/painel/app.montagem.js?v=20260813-logistica-redesign2');
    expect(screen).toContain('aria-labelledby="logistica-heading"');
    expect(screen).toContain('aria-label="Seções de Logística"');
    expect(screen).toContain("{ id: 'visao', label: 'Visão geral' }");
    expect(screen).toContain("{ id: 'entregas', label: 'Entregas' }");
    expect(screen).toContain("{ id: 'rotas', label: 'Rotas' }");
    expect(screen).toContain("{ id: 'historico', label: 'Histórico' }");
  });

  it('separa a composicao de cada aba', () => {
    expect(screen).toContain('Operação de hoje');
    expect(screen).toContain('Fila de entregas');
    expect(screen).toContain('Rotas da Matriz');
    expect(screen).toContain('Concluída');
    expect(screen).toContain('Histórico de entregas');
    expect(screen).toContain('Taxa de sucesso');
    expect(screen).toContain('Tempo médio');
    expect(screen).toContain('Planejar próxima saída');
    expect(screen).toContain('Últimos 30 dias');
  });

  it('mantem todas as acoes operacionais de entrega e rota', () => {
    for (const action of [
      'remarcarEntrega(d, $event.target.value)',
      'pendurarNaRota(d)',
      "logisticaStatus(d, 'dispatched')",
      "logisticaStatus(d, 'delivered')",
      'logisticaRecolocar(d)',
      'logisticaConfirmarFalha(d)',
      'enviarComprovante(logisticaRotaAtual(), $event)',
      'fecharRota(logisticaRotaAtual())',
      'abrirRota()',
      'abrirResultadoRota(t)',
    ]) expect(screen).toContain(action);
  });

  it('calcula o resumo do historico somente com dados reais do periodo', () => {
    expect(resultModule).toContain('logisticaHistoricoResumo()');
    expect(resultModule).toContain("d.delivery_status === 'delivered'");
    expect(resultModule).toContain('d.delivered_at');
    expect(resultModule).toContain('this.logisticaDentroPeriodo(d)');
    expect(readModule).toContain('logisticaFinalizadasView()');
    expect(periodModule).toContain("this.logisticaPeriodo === '30dias'");
  });

  it('mantem a revisao detalhada recolhida e exclusiva da visao geral', () => {
    expect(screen).toContain('<details x-ref="receiptReviewDetails"');
    expect(screen).toContain("logisticaTab === 'visao'");
    expect(screen).toContain('$refs.receiptReviewDetails.open = true');
  });
});
