window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.financeiroVisao = function () {
  const cents = (v) => Math.round(Number(v || 0) * 100);
  return {
    finOverview: null, finOverviewLoading: false, finOverviewError: '',
    finOverviewRequest: 0, finVisaoRequest: 0, finVisaoLoading: false,
    finVisaoDias: 7, finAgendaFiltro: 'todos',
    async loadFinOverview() {
      const request = ++this.finOverviewRequest;
      const month = this.finMes || this.finMesAtual();
      this.finOverviewLoading = true;
      this.finOverviewError = '';
      try {
        const data = await this.apiGet('/admin/api/matriz/financeiro/overview?mes=' + encodeURIComponent(month));
        if (request === this.finOverviewRequest) this.finOverview = data;
      } catch (error) {
        if (request === this.finOverviewRequest) {
          this.finOverview = null;
          this.finOverviewError = 'Não foi possível carregar o histórico do caixa e as despesas.';
        }
      } finally { if (request === this.finOverviewRequest) this.finOverviewLoading = false; }
    },
    finVisaoAtual() { return this.finMes === this.finMesAtual(); },
    finVisaoPeriodo() {
      const end = this.finVisaoAtual() ? this.finHoje() : this.finOverview?.through;
      return end ? '01 a ' + this.financeDate(end) : this.finMesLabel();
    },
    finVisaoResumo() {
      const truth = this.financeiroVisao?.verdade;
      const result = Number(truth?.competencia?.lucro_confirmado || 0);
      const pending = Number(truth?.competencia?.receita_custo_pendente || 0);
      const revenue = Number(truth?.competencia?.receita_custo_conhecido || 0);
      const missing = pending > 0;
      return {
        result, missing,
        title: missing ? 'Resultado parcial do mês' : 'Resultado do mês',
        margin: missing ? 'Há vendas com custo pendente' : revenue > 0
          ? new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(result / revenue * 100) + '% de margem'
          : result === 0 ? 'Resultado zerado' : 'Sem receita para calcular a margem',
      };
    },
    finVisaoFluxo() {
      const all = this.finFluxoItens();
      const future = all.filter(r => r.dias !== null && r.dias >= 0 && r.dias <= this.finVisaoDias);
      const incoming = future.filter(r => r.direcao === 'entrada').reduce((s, r) => s + cents(r.valor), 0);
      const outgoing = future.filter(r => r.direcao === 'saida').reduce((s, r) => s + cents(r.valor), 0);
      const balance = cents(this.financeiroVisao?.verdade?.caixa?.saldo_atual);
      const overdue = all.filter(r => r.dias !== null && r.dias < 0);
      return {
        rows: future,
        incoming: incoming / 100, outgoing: outgoing / 100,
        balance: balance / 100, projected: (balance + incoming - outgoing) / 100,
        overdueIncoming: overdue.filter(r => r.direcao === 'entrada').reduce((s, r) => s + cents(r.valor), 0) / 100,
        overdueOutgoing: overdue.filter(r => r.direcao === 'saida').reduce((s, r) => s + cents(r.valor), 0) / 100,
        overdueCount: overdue.length,
        undated: all.filter(r => r.dias === null).length,
      };
    },
    finVisaoAgenda() {
      return this.finVisaoFluxo().rows.filter(r => this.finAgendaFiltro === 'todos' || r.direcao === this.finAgendaFiltro);
    },
    finVisaoVencimento(row) {
      return (row.dias === 0 ? 'Hoje · ' : '') + this.financeDate(row.due_date);
    },
    finVisaoVerAtrasos() { this.finIndicadorTab = 'inadimplencia'; this.finOpenTab('indicadores'); },
    finVisaoVerFluxo() {
      this.finFluxoDias = this.finVisaoDias;
      this.finIndicadorTab = 'fluxo'; this.finOpenTab('indicadores');
    },
    finVisaoDespesas() {
      const rows = this.finOverview?.period === this.finMes ? this.finOverview.expenses : [];
      const max = Math.max(1, ...(rows || []).map(r => Math.abs(Number(r.amount))));
      return (rows || []).map(r => ({ ...r, width: Math.abs(Number(r.amount)) / max * 100 }));
    },
    finVisaoMovimentos() {
      if (this.finCaixaExtrato?.period !== this.finMes) return [];
      return (this.finCaixaExtrato?.rows || []).filter(r => ['entrada', 'saida'].includes(r.direction)).slice(0, 3);
    },
    finVisaoDetalheMovimento(row) {
      const method = { dinheiro: 'Dinheiro', pix: 'Pix', transferencia: 'Transferência' }[row.metadata?.payment_method];
      return this.financeDate(row.cash_on) + ' · ' + (method || row.origin);
    },
    finVisaoExportar() {
      if (!this.financeiroVisao || this.finVisaoLoading || !this.finOverview || this.finOverviewLoading) return;
      const truth = this.financeiroVisao.verdade;
      const flow = this.finVisaoFluxo();
      const rows = [['Financeiro — visão geral', this.finMes], ['Indicador', 'Valor (R$)'],
        ['Resultado registrado do mês', truth.competencia.lucro_confirmado],
        ['Receitas do mês', truth.competencia.receita_total],
        ['Receita com custo pendente', truth.competencia.receita_custo_pendente],
        ['Custo conhecido dos pneus vendidos', truth.competencia.custo_conhecido],
        ['Despesas', truth.competencia.despesas],
        ['Saldo anterior', truth.caixa.saldo_anterior],
        ['Saldo em caixa no fim do recorte', truth.caixa.saldo_atual],
        ['Total a receber — posição atual', truth.posicao.a_receber],
        ['Total a pagar — posição atual', truth.posicao.a_pagar]];
      if (this.finVisaoAtual()) rows.push(
        ['Receber em ' + this.finVisaoDias + ' dias', flow.incoming],
        ['Pagar em ' + this.finVisaoDias + ' dias', flow.outgoing],
        ['Saldo previsto', flow.projected]);
      rows.push([], ['Caixa realizado', 'Entradas', 'Saídas']);
      for (const day of this.finOverview.days) rows.push([day.date, day.incoming, day.outgoing]);
      rows.push([], ['Despesas do período', 'Valor']);
      for (const expense of this.finVisaoDespesas()) rows.push([expense.label, expense.amount]);
      const cell = v => '"' + String(v ?? '').replace(/^[=+@\t\r]|^-(?!\d)/, "'$&").replace(/"/g, '""') + '"';
      const blob = new Blob(['\uFEFF' + rows.map(r => r.map(cell).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob), anchor = document.createElement('a');
      anchor.href = url; anchor.download = 'financeiro-' + this.finMes + '.csv'; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
  };
};
