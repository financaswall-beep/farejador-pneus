// Ranking comercial por marca: vendas confirmadas da Matriz, varejo + atacado.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.vendasMarcas = function () {
  return {
    vendasMarcas: {
      period: '30d', summary: { brands: 0, units: 0, revenue: 0 }, rows: [],
    },
    vendasMarcasLoading: false,
    vendasMarcasError: null,

    async loadVendasMarcas() {
      this.ensureCredentials();
      if (!this.adminAuthenticated || !location.pathname.startsWith('/admin/painel')) return;
      this.vendasMarcasLoading = true;
      this.vendasMarcasError = null;
      try {
        const data = await this.apiGet(
          '/admin/api/sales/brands?period=' + encodeURIComponent(this.vendasPeriodo),
        );
        this.vendasMarcas = {
          period: data?.period || this.vendasPeriodo,
          summary: data?.summary || { brands: 0, units: 0, revenue: 0 },
          rows: Array.isArray(data?.rows) ? data.rows : [],
        };
      } catch (error) {
        this.vendasMarcasError = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        this.vendasMarcasLoading = false;
        this.$nextTick(() => window.lucide && window.lucide.createIcons());
      }
    },

    async loadVarejoResumo() {
      this.ensureCredentials();
      if (!this.adminAuthenticated || !location.pathname.startsWith('/admin/painel')) return;
      this.varejoResumo = (await this.apiGet(
        '/admin/api/varejo/resumo?period=' + this.vendasPeriodo,
      )) || null;
    },
    async loadVendasHistoricoData() {
      const payload = await this.apiGet('/admin/api/sales/history-data?period=' + this.vendasPeriodo);
      this.vendasHistoricoPedidos = this.mapPedidos(payload.varejo || []);
      this.vendasHistoricoAtacado = payload.atacado || [];
    },
    async loadVendasData() {
      const snapshot = {};
      [
        'varejoResumo', 'atacadoBuyers', 'atacadoRanking', 'atacadoMeasures',
        'atacadoStock', 'atacadoResumo', 'atacadoFinance', 'atacadoVendas',
        'vendasMarcas', 'vendasHistoricoPedidos', 'vendasHistoricoAtacado',
        'logistica', 'logisticaLoaded',
      ].forEach((key) => { snapshot[key] = this[key]; });
      const settled = await Promise.allSettled([
        this.loadVarejoResumo(), this.loadAtacadoVendas(), this.loadVendasMarcas(),
        this.loadVendasHistoricoData(),
        this.logisticaLoaded ? Promise.resolve() : this.loadLogistica({ propagate: true }),
      ]);
      const failures = settled.filter((item) => item.status === 'rejected');
      if (failures.length) {
        Object.entries(snapshot).forEach(([key, value]) => { this[key] = value; });
        this.vendasDataError = 'Vendas não foi atualizada. Todos os dados anteriores foram preservados.';
      } else {
        this.vendasDataError = null;
      }
      this.$nextTick(() => window.lucide && window.lucide.createIcons());
      return failures.length === 0;
    },
    async setVendasPeriodo(period) {
      if (this.vendasPeriodo === period) return;
      const previous = this.vendasPeriodo;
      this.vendasPeriodo = period;
      this.varejoPeriodo = period;
      this.atacadoPeriodo = period;
      if (!await this.loadVendasData()) {
        this.vendasPeriodo = previous;
        this.varejoPeriodo = previous;
        this.atacadoPeriodo = previous;
      }
    },
    async setVarejoPeriodo(period) { await this.setVendasPeriodo(period); },
    async setAtacadoPeriodo(period) { await this.setVendasPeriodo(period); },
  };
};
