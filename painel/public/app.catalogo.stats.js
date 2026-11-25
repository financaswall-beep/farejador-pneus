window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.catalogoStats = function () {
  let statsRequest = 0;
  return {
    catalogoTab: 'ficha',
    catalogoStats: null,
    catalogoStatsStatus: 'idle',

    catalogoStatsDisponiveis() {
      const row = this.catalogoSelecionado;
      return this.adminUser?.role === 'owner' && this.isMatrixPanel()
        && row?.product_type === 'tire' && Boolean(row.product_id) && row.catalogued !== false;
    },

    catalogoResetStats() {
      statsRequest++;
      this.catalogoTab = 'ficha';
      this.catalogoStats = null;
      this.catalogoStatsStatus = 'idle';
    },

    async catalogoShowStats() {
      if (!this.catalogoStatsDisponiveis()) return;
      if (this.catalogoTab === 'stats' && this.catalogoStatsStatus !== 'error') return;
      const productId = this.catalogoSelecionado.product_id;
      const request = ++statsRequest;
      const current = () => request === statsRequest && this.catalogoSelecionado?.product_id === productId;
      this.catalogoTab = 'stats';
      this.catalogoStats = null;
      this.catalogoStatsStatus = 'loading';
      try {
        const data = await this.apiGet('/admin/api/catalog/products/' + encodeURIComponent(productId) + '/stats');
        if (!current()) return;
        this.catalogoStats = data;
        this.catalogoStatsStatus = 'ready';
      } catch {
        if (current()) this.catalogoStatsStatus = 'error';
      }
    },

    catalogoTabKey(event) {
      const tabs = [...event.currentTarget.querySelectorAll('[role=tab]')];
      const index = tabs.indexOf(event.target);
      if (index < 0 || !['Home', 'End', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[1] : tabs[1 - index];
      next.focus();
      next.click();
    },

    catalogoStatsVariacao(value) {
      if (value == null) return 'Sem base para comparar com as 4 semanas anteriores.';
      if (value === 0) return 'Mesma participação das 4 semanas anteriores.';
      const change = Number(value).toLocaleString('pt-BR', { maximumFractionDigits: 1, signDisplay: 'always' });
      return change + ' p.p. sobre as 4 semanas anteriores';
    },
  };
};
