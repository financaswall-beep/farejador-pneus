// Logística da Matriz — períodos da operação e seleção das quatro visões.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.logisticaPeriodos = function () {
  return {
    logisticaDentroPeriodo(d) {
      const data = this.logisticaDataOperacional(d);
      if (!data) return true;
      if (this.logisticaPeriodo === 'amanha') return data === this.amanhaISO();
      if (this.logisticaPeriodo === '7dias') return data >= this.hojeISO() && data <= this.logisticaPeriodoFinalISO();
      if (this.logisticaPeriodo === '30dias') {
        const inicio = new Date(this.hojeISO() + 'T12:00:00-03:00');
        inicio.setUTCDate(inicio.getUTCDate() - 29);
        return data >= this.logisticaDateISO(inicio) && data <= this.hojeISO();
      }
      return data === this.hojeISO();
    },
    logisticaPeriodoLabel() {
      if (this.logisticaPeriodo === 'amanha') return 'Amanhã';
      if (this.logisticaPeriodo === '7dias') return 'Próximos 7 dias';
      if (this.logisticaPeriodo === '30dias') return 'Últimos 30 dias';
      return 'Hoje';
    },
    setLogisticaPeriodo(periodo) {
      this.logisticaPeriodo = periodo;
      this.$nextTick(() => window.lucide && window.lucide.createIcons());
    },
    setLogisticaFiltro(filtro, abrirEntregas = false) {
      this.logisticaFiltro = filtro;
      if (abrirEntregas) {
        this.logisticaTab = 'entregas';
        this.logisticaRotaSelecionadaId = null;
      }
      this.$nextTick(() => window.lucide && window.lucide.createIcons());
    },
    setLogisticaTab(tab) {
      this.logisticaTab = tab;
      this.logisticaRotaSelecionadaId = null;
      if (tab === 'visao') {
        this.logisticaFiltro = 'todas';
        this.logisticaBusca = '';
      }
      if (tab === 'historico') this.logisticaPeriodo = '30dias';
      else if (this.logisticaPeriodo === '30dias') this.logisticaPeriodo = 'hoje';
      this.$nextTick(() => window.lucide && window.lucide.createIcons());
    },
  };
};
