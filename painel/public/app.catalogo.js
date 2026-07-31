window.PAINEL_MODULES = window.PAINEL_MODULES || {};
const CATALOGO_KNOWN_BRANDS = Object.freeze([
  'Pirelli', 'Metzeler', 'Michelin', 'Bridgestone', 'Dunlop', 'Levorin',
  'Rinaldi', 'Maggion', 'Technic', 'Vipal', 'Mitas', 'Kenda',
]);
window.PAINEL_MODULES.catalogo = function () {
  return {
    async loadCatalogo() {
      if (!this.adminAuthenticated) return;
      this.catalogoLoading = true;
      this.catalogoError = null;
      try {
        const data = await this.apiGet('/admin/api/catalog');
        this.catalogoRows = Array.isArray(data.rows) ? data.rows : [];
        const actualBrands = Array.isArray(data.brands) ? data.brands : [];
        this.catalogoBrands = [
          ...CATALOGO_KNOWN_BRANDS,
          ...actualBrands.filter((brand) => !CATALOGO_KNOWN_BRANDS.includes(brand)),
        ];
        this.catalogoSummary = data.summary || { products: 0, stock_only: 0, brands: 0, without_price: 0, with_stock: 0 };
        this.catalogoPagina = Math.min(this.catalogoPagina, this.catalogoTotalPaginas());
      } catch (error) {
        this.catalogoError = error instanceof Error ? error.message : String(error);
      } finally {
        this.catalogoLoading = false;
        this.$nextTick(() => window.lucide && window.lucide.createIcons());
      }
    },

    catalogoFiltrados() {
      const search = String(this.catalogoBusca || '').trim().toLocaleLowerCase('pt-BR');
      return this.catalogoRows.filter((row) => {
        if (this.catalogoMarca !== 'todas' && row.brand !== this.catalogoMarca) return false;
        if (this.catalogoFiltro === 'estoque' && Number(row.official_quantity_on_hand || 0) <= 0) return false;
        if (this.catalogoFiltro === 'sem_preco' && row.price_amount != null) return false;
        if (!search) return true;
        return [row.product_code, row.product_name, row.brand, row.tire_size]
          .some((value) => String(value || '').toLocaleLowerCase('pt-BR').includes(search));
      });
    },

    catalogoPaginaRows() {
      const start = (this.catalogoPagina - 1) * this.catalogoPorPagina;
      return this.catalogoFiltrados().slice(start, start + this.catalogoPorPagina);
    },

    catalogoTotalPaginas() {
      return Math.max(1, Math.ceil(this.catalogoFiltrados().length / this.catalogoPorPagina));
    },

    catalogoSetMarca(brand) {
      this.catalogoMarca = brand;
      this.catalogoPagina = 1;
    },

    catalogoSetFiltro(filter) {
      this.catalogoFiltro = filter;
      this.catalogoPagina = 1;
    },

    catalogoBrandLogo(brand) {
      const key = String(brand || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
      const aliases = {
        pirelli: 'pirelli',
        metzeler: 'metzeler',
        michelin: 'michelin',
        bridgestone: 'bridgestone',
        dunlop: 'dunlop',
        levorin: 'levorin',
        rinaldi: 'rinaldi',
        maggion: 'maggion',
        magion: 'maggion',
        technic: 'technic',
        vipal: 'vipal',
        mitas: 'mitas',
        kenda: 'kenda',
      };
      const asset = aliases[key];
      return asset
        ? `/admin/painel/assets/catalog-brands/${asset}.webp?v=20260729-catalogo2`
        : null;
    },

    async catalogoOpen(row) {
      if (!row?.product_id || row.catalogued === false) {
        this.catalogoCreateOpen(row);
        return;
      }
      this.catalogoSelecionado = row;
      this.catalogoPriceForm = {
        price: row.price_amount == null ? '' : Number(row.price_amount).toFixed(2),
        reason: '',
        marginPreset: null,
      };
      this.catalogoHistory = [];
      this.catalogoMessage = null;
      await this.catalogoLoadHistory(row.product_id);
      this.$nextTick(() => window.lucide && window.lucide.createIcons());
    },

    catalogoCreateOpen(row) {
      if (!row || row.catalogued !== false) return;
      const brandCode = String(row.brand || '').normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/gi, '')
        .slice(0, 3).toUpperCase() || 'PNE';
      const measureCode = String(row.tire_size || '').replace(/\D/g, '') || 'MEDIDA';
      this.catalogoCadastro = {
        open: true,
        row,
        form: {
          product_code: `${brandCode}-${measureCode}`,
          product_name: `Pneu ${row.brand}`,
        },
        saving: false,
        message: null,
      };
      this.$nextTick(() => {
        window.lucide && window.lucide.createIcons();
        document.getElementById('catalog-product-code')?.focus();
      });
    },

    catalogoCreateClose() {
      if (this.catalogoCadastro.saving) return;
      this.catalogoCadastro.open = false;
      this.catalogoCadastro.message = null;
    },

    catalogoCreateCanSave() {
      const form = this.catalogoCadastro.form;
      return !this.catalogoCadastro.saving
        && /^[A-Z0-9][A-Z0-9._/-]{1,79}$/.test(String(form.product_code || '').trim().toUpperCase())
        && String(form.product_name || '').trim().length >= 2;
    },

    catalogoCreateViewStock() {
      const row = this.catalogoCadastro.row;
      this.catalogoCreateClose();
      this.stockBusca = row?.tire_size || '';
      this.stockTab = 'visao';
      this.currentPage = 'estoque';
    },

    async catalogoCreateSave() {
      if (!this.catalogoCreateCanSave() || !this.catalogoCadastro.row) return;
      const row = this.catalogoCadastro.row;
      const form = this.catalogoCadastro.form;
      this.catalogoCadastro.saving = true;
      this.catalogoCadastro.message = null;
      try {
        const created = await this.apiPost('/admin/api/catalog/products', {
          measure: row.tire_size,
          brand: row.brand,
          product_code: String(form.product_code).trim().toUpperCase(),
          product_name: String(form.product_name).trim(),
        });
        await this.loadCatalogo();
        const product = this.catalogoRows.find((item) =>
          item.product_id === created.product_id);
        if (!product) throw new Error('catalog_product_reload_failed');
        this.catalogoCadastro.open = false;
        await this.catalogoOpen(product);
        this.catalogoMessage = {
          ok: true,
          text: 'Produto cadastrado. Agora defina o preço oficial para liberá-lo para venda.',
        };
      } catch (error) {
        const code = error instanceof Error ? error.message : String(error);
        this.catalogoCadastro.message = {
          ok: false,
          text: code.includes('catalog_product_code_duplicate')
            ? 'Esse código já está em uso. Informe outro código.'
            : code.includes('catalog_variant_already_exists')
              ? 'Essa medida e marca já possuem um produto no Catálogo.'
              : code.includes('catalog_variant_archived')
                ? 'Essa variante possui um produto arquivado. Reative-o antes de criar outro.'
                : code.includes('catalog_stock_variant_ambiguous')
                  ? 'Há mais de um estoque para essa medida e marca. Corrija a duplicidade antes de cadastrar.'
                : code.includes('catalog_stock_variant_not_found')
                  ? 'A variante não existe mais no Estoque. Recarregue o Catálogo.'
                  : 'Não foi possível cadastrar o produto. Recarregue e tente novamente.',
        };
      } finally {
        this.catalogoCadastro.saving = false;
        this.$nextTick(() => window.lucide && window.lucide.createIcons());
      }
    },

    catalogoClose() {
      if (this.catalogoSaving) return;
      this.catalogoSelecionado = null;
      this.catalogoHistory = [];
      this.catalogoMessage = null;
    },

    async catalogoLoadHistory(productId) {
      try {
        const data = await this.apiGet(`/admin/api/catalog/${encodeURIComponent(productId)}/history`);
        this.catalogoHistory = Array.isArray(data.rows) ? data.rows : [];
      } catch {
        this.catalogoHistory = [];
      }
    },

    catalogoNovoPreco() {
      return Number(this.catalogoPriceForm.price || 0);
    },

    catalogoLucro() {
      if (this.catalogoSelecionado?.official_unit_cost == null) return null;
      const cost = Number(this.catalogoSelecionado?.official_unit_cost);
      const price = this.catalogoNovoPreco();
      return Number.isFinite(cost) && price > 0 ? price - cost : null;
    },

    catalogoMargem() {
      const profit = this.catalogoLucro();
      const price = this.catalogoNovoPreco();
      return profit == null || price <= 0 ? null : (profit / price) * 100;
    },

    catalogoPrecoMinimo() {
      if (this.catalogoSelecionado?.official_unit_cost == null) return null;
      const cost = Number(this.catalogoSelecionado?.official_unit_cost);
      return Number.isFinite(cost) && cost > 0 ? cost / 0.65 : null;
    },

    catalogoApplyMargin(percent) {
      if (this.catalogoSelecionado?.official_unit_cost == null) return;
      const cost = Number(this.catalogoSelecionado?.official_unit_cost);
      if (!Number.isFinite(cost) || cost <= 0 || percent >= 100) return;
      this.catalogoPriceForm.price = (cost / (1 - percent / 100)).toFixed(2);
      this.catalogoPriceForm.marginPreset = percent;
    },

    catalogoPodeSalvar() {
      return !this.catalogoSaving
        && this.catalogoNovoPreco() > 0
        && String(this.catalogoPriceForm.reason || '').trim().length >= 2;
    },

    async catalogoSavePrice() {
      if (!this.catalogoSelecionado || !this.catalogoPodeSalvar()) return;
      this.catalogoSaving = true;
      this.catalogoMessage = null;
      const productId = this.catalogoSelecionado.product_id;
      try {
        const result = await this.apiPost(`/admin/api/catalog/${encodeURIComponent(productId)}/price`, {
          price_amount: this.catalogoNovoPreco(),
          reason: String(this.catalogoPriceForm.reason || '').trim(),
        });
        await Promise.all([this.loadCatalogo(), this.loadRealData()]);
        this.catalogoSelecionado = this.catalogoRows.find((row) => row.product_id === productId) || null;
        await this.catalogoLoadHistory(productId);
        this.catalogoPriceForm.reason = '';
        this.catalogoMessage = {
          ok: true,
          text: result.changed ? 'Preço oficial atualizado em todos os canais.' : 'Esse já era o preço oficial.',
        };
      } catch (error) {
        const code = error instanceof Error ? error.message : String(error);
        this.catalogoMessage = {
          ok: false,
          text: code.includes('catalog_price_reason') ? 'Informe o motivo da alteração.'
            : code.includes('catalog_product_not_found') ? 'Produto não encontrado.'
              : 'Não foi possível salvar o preço. Recarregue e tente novamente.',
        };
      } finally {
        this.catalogoSaving = false;
        this.$nextTick(() => window.lucide && window.lucide.createIcons());
      }
    },

    catalogoPercent(value) {
      return value == null ? '—' : `${Number(value).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
    },

    catalogoDate(value) {
      if (!value) return 'Sem registro';
      return new Date(value).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
    },
  };
};
