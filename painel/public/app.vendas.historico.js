// Histórico comercial unificado da Matriz.
// Usa somente as coleções já carregadas por app.varejo.js e app.atacado.js:
// não cria fonte paralela nem altera o menu lateral.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.vendasHistorico = function () {
  return {
    vendasHistoricoNumero(row) {
      const raw = String(row?.id || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
      const sufixo = (raw.slice(-8) || '00000000').padStart(8, '0');
      return `#${row?.canalId === 'atacado' ? 'ATA' : 'VND'}-${sufixo}`;
    },

    vendasHistoricoStatusId(row) {
      const status = String(row?.status || '').toLocaleLowerCase('pt-BR');
      if (status.includes('cancel')) return 'cancelada';
      if (status.includes('aberto') || status.includes('pendent') || status.includes('separa') || status.includes('entrega')) return 'andamento';
      return 'confirmada';
    },

    vendasHistoricoPagamentoId(row) {
      const pagamento = String(row?.pagto || '').toLocaleLowerCase('pt-BR');
      if (pagamento.includes('fiado') || pagamento.includes('receber')) return 'fiado';
      if (pagamento.includes('pago') || pagamento.includes('pix') || pagamento.includes('cart') || pagamento.includes('dinheiro')) return 'pago';
      return 'outros';
    },

    vendasHistoricoFiltrado() {
      const busca = this.vendasBusca.trim().toLocaleLowerCase('pt-BR');
      return this.vendasHistorico().filter((row) => {
        if (this.vendasHistoricoCanal !== 'todos' && row.canalId !== this.vendasHistoricoCanal) return false;
        if (this.vendasHistoricoStatus !== 'todos' && this.vendasHistoricoStatusId(row) !== this.vendasHistoricoStatus) return false;
        if (this.vendasHistoricoPagamento !== 'todos' && this.vendasHistoricoPagamentoId(row) !== this.vendasHistoricoPagamento) return false;
        if (!busca) return true;
        const telefone = row.telefone || row.atacado?.buyer_phone || row.atacado?.phone || '';
        const haystack = [this.vendasHistoricoNumero(row), row.id, row.cliente, telefone, row.itens, row.pagto, row.status]
          .filter(Boolean).join(' ').toLocaleLowerCase('pt-BR');
        return haystack.includes(busca);
      });
    },

    vendasHistoricoResumo() {
      const rows = this.vendasHistoricoFiltrado();
      const canceladas = rows.filter((row) => this.vendasHistoricoStatusId(row) === 'cancelada');
      const efetivadas = rows.filter((row) => this.vendasHistoricoStatusId(row) !== 'cancelada');
      const total = efetivadas.reduce((sum, row) => sum + Number(row.totalAmount || 0), 0);
      return {
        registros: rows.length,
        total,
        ticket: efetivadas.length ? total / efetivadas.length : 0,
        canceladas: canceladas.length,
        cancelPct: rows.length ? (canceladas.length / rows.length) * 100 : 0,
      };
    },

    vendasHistoricoTotalPaginas() {
      return Math.max(1, Math.ceil(this.vendasHistoricoFiltrado().length / this.vendasHistoricoPorPagina));
    },

    vendasHistoricoPaginaAtual() {
      return Math.min(Math.max(1, Number(this.vendasHistoricoPagina || 1)), this.vendasHistoricoTotalPaginas());
    },

    vendasHistoricoPaginaRows() {
      const pagina = this.vendasHistoricoPaginaAtual();
      const inicio = (pagina - 1) * this.vendasHistoricoPorPagina;
      return this.vendasHistoricoFiltrado().slice(inicio, inicio + this.vendasHistoricoPorPagina);
    },

    vendasHistoricoIntervalo() {
      const total = this.vendasHistoricoFiltrado().length;
      if (!total) return { inicio: 0, fim: 0, total: 0 };
      const inicio = (this.vendasHistoricoPaginaAtual() - 1) * this.vendasHistoricoPorPagina + 1;
      return { inicio, fim: Math.min(inicio + this.vendasHistoricoPorPagina - 1, total), total };
    },

    vendasHistoricoPaginasVisiveis() {
      const total = this.vendasHistoricoTotalPaginas();
      const atual = this.vendasHistoricoPaginaAtual();
      const inicio = Math.max(1, Math.min(atual - 2, total - 4));
      const fim = Math.min(total, inicio + 4);
      return Array.from({ length: fim - inicio + 1 }, (_, index) => inicio + index);
    },

    vendasHistoricoIrPagina(pagina) {
      this.vendasHistoricoPagina = Math.min(Math.max(1, Number(pagina || 1)), this.vendasHistoricoTotalPaginas());
    },

    vendasHistoricoTemFiltros() {
      return !!this.vendasBusca || this.vendasHistoricoCanal !== 'todos'
        || this.vendasHistoricoStatus !== 'todos' || this.vendasHistoricoPagamento !== 'todos';
    },

    vendasHistoricoLimparFiltros() {
      this.vendasBusca = '';
      this.vendasHistoricoCanal = 'todos';
      this.vendasHistoricoStatus = 'todos';
      this.vendasHistoricoPagamento = 'todos';
      this.vendasHistoricoPagina = 1;
    },

    vendasHistoricoAbrir(row) {
      this.vendaHistoricoSelecionada = row || null;
      this.$nextTick(() => window.lucide && window.lucide.createIcons());
    },

    vendasHistoricoCsvCell(value) {
      return `"${String(value ?? '').replace(/"/g, '""')}"`;
    },

    vendasHistoricoExportar() {
      const rows = this.vendasHistoricoFiltrado();
      const cabecalho = ['Data', 'Venda', 'Cliente', 'Canal', 'Itens', 'Pagamento', 'Total', 'Status'];
      const linhas = rows.map((row) => [
        row.data, this.vendasHistoricoNumero(row), row.cliente, row.canal,
        row.itens, row.pagto, Number(row.totalAmount || 0).toFixed(2).replace('.', ','), row.status,
      ]);
      const csv = '\ufeff' + [cabecalho, ...linhas].map((linha) => linha.map(this.vendasHistoricoCsvCell).join(';')).join('\r\n');
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `historico-vendas-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    },
  };
};
