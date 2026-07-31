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
      } finally {
        this.vendasMarcasLoading = false;
        this.$nextTick(() => window.lucide && window.lucide.createIcons());
      }
    },
  };
};
