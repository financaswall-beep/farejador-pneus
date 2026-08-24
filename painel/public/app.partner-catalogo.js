// Catálogo central visto pelo parceiro: somente identidade técnica e o preço/saldo
// da própria unidade. Não chama APIs administrativas nem calcula margem/custo.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.partnerCatalogo = function () {
  return {
    partnerCatalogo: {
      rows: [], brands: [], page: 1, limit: 40, total: 0, pages: 1,
      q: '', brand: '', type: 'all', loading: false, error: null, request: 0,
      selected: null, compatibility: [], compatibilitySummary: null,
      compatibilityLoading: false, compatibilityError: null,
    },

    partnerCatalogoOwner() {
      return this.isPartnerPanel() && this.panelWorkplace?.role === 'owner';
    },

    async loadPartnerCatalogo(page = 1) {
      if (!this.partnerCatalogoOwner()) return;
      const state = this.partnerCatalogo;
      const requestedPage = Math.max(1, Number(page) || 1);
      const request = ++state.request;
      const parts = [`page=${requestedPage}`, `limit=${state.limit}`];
      if (String(state.q || '').trim()) parts.push(`q=${encodeURIComponent(String(state.q).trim())}`);
      if (state.brand) parts.push(`brand=${encodeURIComponent(state.brand)}`);
      if (state.type !== 'all') parts.push(`type=${encodeURIComponent(state.type)}`);
      state.loading = true;
      state.error = null;
      try {
        const payload = await this.partnerApiGet(`painel/catalogo?${parts.join('&')}`);
        if (request !== state.request) return;
        state.rows = Array.isArray(payload.rows) ? payload.rows : [];
        state.brands = Array.isArray(payload.brands) ? payload.brands : [];
        state.page = Number(payload.page || requestedPage);
        state.total = Number(payload.total || 0);
        state.pages = Math.max(1, Number(payload.pages || 1));
      } catch (_) {
        if (request === state.request) state.error = 'Não foi possível carregar o catálogo.';
      } finally {
        if (request === state.request) state.loading = false;
        this.$nextTick(() => lucide.createIcons());
      }
    },

    partnerCatalogoSearch() { return this.loadPartnerCatalogo(1); },
    partnerCatalogoSetBrand(brand) {
      this.partnerCatalogo.brand = brand || '';
      return this.loadPartnerCatalogo(1);
    },
    partnerCatalogoSetType(type) {
      this.partnerCatalogo.type = ['tire', 'service'].includes(type) ? type : 'all';
      return this.loadPartnerCatalogo(1);
    },
    partnerCatalogoPrevious() {
      if (this.partnerCatalogo.page > 1) return this.loadPartnerCatalogo(this.partnerCatalogo.page - 1);
    },
    partnerCatalogoNext() {
      if (this.partnerCatalogo.page < this.partnerCatalogo.pages) {
        return this.loadPartnerCatalogo(this.partnerCatalogo.page + 1);
      }
    },

    partnerCatalogoIdentity(row) {
      return row.tire_size || row.product_name || row.product_code || 'Produto';
    },
    partnerCatalogoCondition(row) {
      return { novo: 'Novo', meia_vida: 'Meia-vida', remold: 'Remold' }[row.tire_condition] || '';
    },
    partnerCatalogoPosition(row) {
      return { front: 'Dianteiro', rear: 'Traseiro', both: 'Ambos' }[row.tire_position] || '';
    },
    partnerCatalogoPrice(row) {
      const min = Number(row.local_sale_price_min);
      const max = Number(row.local_sale_price_max);
      if (!(min > 0)) return null;
      return max > min ? { min, max } : { min, max: min };
    },
    partnerCatalogoBrandLogo(brand) {
      return typeof this.catalogoBrandLogo === 'function' ? this.catalogoBrandLogo(brand) : null;
    },

    async partnerCatalogoOpenCompatibility(row) {
      if (!row?.product_id || row.product_type !== 'tire') return;
      const state = this.partnerCatalogo;
      state.selected = row;
      state.compatibility = [];
      state.compatibilitySummary = null;
      state.compatibilityError = null;
      state.compatibilityLoading = true;
      try {
        const payload = await this.partnerApiGet(
          `painel/catalogo/${encodeURIComponent(row.product_id)}/compatibilidade`,
        );
        state.selected = { ...row, ...(payload.product || {}) };
        state.compatibility = Array.isArray(payload.rows) ? payload.rows : [];
        state.compatibilitySummary = payload.summary || { models: 0, fitments: 0 };
      } catch (_) {
        state.compatibilityError = 'Não foi possível carregar as motos compatíveis.';
      } finally {
        state.compatibilityLoading = false;
        this.$nextTick(() => lucide.createIcons());
      }
    },
    partnerCatalogoCloseCompatibility() {
      this.partnerCatalogo.selected = null;
      this.partnerCatalogo.compatibility = [];
      this.partnerCatalogo.compatibilitySummary = null;
      this.partnerCatalogo.compatibilityError = null;
    },
    partnerCatalogoVehicleLabel(row) {
      return [row.make, row.model, row.variant].filter(Boolean).join(' ');
    },
    partnerCatalogoYears(row) {
      if (!row.year_start && !row.year_end) return 'Todos os anos cadastrados';
      if (row.year_start && row.year_end && row.year_start !== row.year_end) {
        return `${row.year_start} a ${row.year_end}`;
      }
      return String(row.year_start || row.year_end);
    },
  };
};
