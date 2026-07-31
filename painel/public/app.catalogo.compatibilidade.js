window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.catalogoCompatibilidade = function () {
  return {
    async catalogoCompatibilityOpen(row) {
      if (!row?.product_id || row.catalogued === false) return;
      this.catalogoSelecionado = null;
      this.catalogoCadastro.open = false;
      this.catalogoCompatibilidade = {
        open: true,
        row,
        rows: [],
        summary: { models: 0, fitments: 0 },
        loading: true,
        error: null,
      };
      this.$nextTick(() => window.lucide && window.lucide.createIcons());
      await this.catalogoCompatibilityLoad(row.product_id);
    },

    async catalogoCompatibilityLoad(productId) {
      if (!productId || this.catalogoCompatibilidade.row?.product_id !== productId) return;
      this.catalogoCompatibilidade.loading = true;
      this.catalogoCompatibilidade.error = null;
      try {
        const data = await this.apiGet(
          `/admin/api/catalog/${encodeURIComponent(productId)}/compatibility`,
        );
        if (this.catalogoCompatibilidade.row?.product_id !== productId) return;
        this.catalogoCompatibilidade.rows = Array.isArray(data.rows) ? data.rows : [];
        this.catalogoCompatibilidade.summary = data.summary || { models: 0, fitments: 0 };
      } catch {
        if (this.catalogoCompatibilidade.row?.product_id !== productId) return;
        this.catalogoCompatibilidade.rows = [];
        this.catalogoCompatibilidade.summary = { models: 0, fitments: 0 };
        this.catalogoCompatibilidade.error = 'Não foi possível carregar as compatibilidades.';
      } finally {
        if (this.catalogoCompatibilidade.row?.product_id === productId) {
          this.catalogoCompatibilidade.loading = false;
          this.$nextTick(() => window.lucide && window.lucide.createIcons());
        }
      }
    },

    catalogoCompatibilityClose() {
      this.catalogoCompatibilidade = {
        open: false,
        row: null,
        rows: [],
        summary: { models: 0, fitments: 0 },
        loading: false,
        error: null,
      };
    },

    catalogoCompatibilityPositionLabel(value) {
      if (value === 'front') return 'Dianteiro';
      if (value === 'rear') return 'Traseiro';
      if (value === 'both') return 'Dianteiro e traseiro';
      return 'Posição não informada';
    },

    catalogoCompatibilityYearLabel(row) {
      const start = Number(row?.year_start || 0);
      const end = Number(row?.year_end || 0);
      if (start > 0 && end > 0 && start === end) return String(start);
      if (start > 0 && end > 0) return `${start} a ${end}`;
      if (start > 0) return `Desde ${start}`;
      if (end > 0) return `Até ${end}`;
      return 'Anos não informados';
    },

    catalogoCompatibilitySourceLabel(value) {
      if (value === 'manufacturer') return 'Fabricante';
      if (value === 'manual') return 'Base homologada';
      if (value === 'discovery_promoted') return 'Compatibilidade validada';
      return 'Origem não informada';
    },
  };
};
