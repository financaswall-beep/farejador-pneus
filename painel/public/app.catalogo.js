window.PAINEL_MODULES = window.PAINEL_MODULES || {};
const CATALOGO_KNOWN_BRANDS = Object.freeze([
  'Pirelli', 'Metzeler', 'Michelin', 'Bridgestone', 'CEAT', 'Dunlop', 'IRA', 'IRC',
  'Levorin', 'Rinaldi', 'Maggion', 'Technic', 'Vipal', 'Mitas', 'Kenda',
]);
const catalogoMoneyValue = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
// Apenas apresentação. Nunca usar este texto como identidade, medida de gravação
// ou critério de compatibilidade: R/ZR continuam presentes no dado original.
const catalogoPresentationText = (value) => String(value || '')
  .replace(/\b(\d{2,3})\s*\/\s*(\d{2,3})\s*(?:ZR|R)\s*(\d{2})(?!\d)/gi, '$1/$2-$3')
  .replace(/\b(\d[.,]\d{1,2})\s*R\s*(\d{2})(?!\d)/gi, '$1-$2');
window.PAINEL_MODULES.catalogo = function () {
  return {
    catalogoMeasureLabel(value) {
      return catalogoPresentationText(value).trim() || '—';
    },
    catalogoProductLabel(row) {
      const name = String(row?.product_name || '');
      return row?.product_type === 'service' ? name : catalogoPresentationText(name);
    },
    catalogoTitle(row) {
      if (row?.product_type === 'service') return this.catalogoProductLabel(row);
      const measure = String(row?.tire_size || '').trim();
      return measure ? this.catalogoMeasureLabel(measure) : this.catalogoProductLabel(row);
    },
    catalogoTechnicalLabel(row) {
      if (!row || row.product_type === 'service' || !row.tire_size) return '';
      const original = String(row.tire_size).trim();
      const radialMark = /^(?:\d{2,3}\s*\/\s*\d{2,3}\s*(?:ZR|R)|\d[.,]\d{1,2}\s*R)\s*\d{2}$/i.test(original);
      const beltedMark = /^\d{2,3}\s*\/\s*\d{2,3}\s*B\s*\d{2}$/i.test(original);
      const construction = { radial: 'radial', bias: 'diagonal' }[row.tire_construction]
        || (radialMark ? 'radial' : beltedMark ? 'diagonal cintada' : 'não informada');
      if ((radialMark && row.tire_construction === 'bias')
        || (beltedMark && row.tire_construction === 'radial')) {
        return `Especificação original: ${original} · Construção divergente: conferir cadastro`;
      }
      return `Especificação original: ${original} · Construção: ${construction}`;
    },
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
        this.catalogoSummary = data.summary || { products: 0, stock_only: 0, brands: 0, without_price: 0, with_stock: 0, without_position: 0 };
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
        if (this.catalogoFiltro === 'incompleto' && !row.measure_draft) return false;
        if (this.catalogoMarca !== 'todas' && row.brand !== this.catalogoMarca) return false;
        if (this.catalogoFiltro === 'estoque' && Number(row.total_stock_available ?? row.official_quantity_on_hand ?? 0) <= 0) return false;
        if (this.catalogoFiltro === 'sem_preco' && Number(row.price_amount) > 0) return false;
        if (this.catalogoFiltro === 'sem_posicao'
          && (row.product_type !== 'tire' || row.catalogued === false || row.tire_position)) return false;
        if (!search) return true;
        return [row.product_code, row.product_name, row.brand, row.tire_size,
          this.catalogoMeasureLabel(row.tire_size), this.catalogoProductLabel(row),
          this.catalogoConditionLabel(row.tire_condition), row.tread_pattern,
          row.load_index, row.speed_rating, row.application_search,
          this.catalogoPositionLabel(row.tire_position)]
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
      if (filter === 'incompleto') this.catalogoMarca = 'todas';
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
        ceat: 'ceat',
        ciat: 'ceat',
        ira: 'ira',
        irc: 'irc',
      };
      const asset = aliases[key];
      return asset
        ? `/admin/painel/assets/catalog-brands/${asset}.webp?v=20260824-catalog-brand3`
        : null;
    },

    catalogoConditionLabel(value) {
      if (value === 'meia_vida') return 'Meia-vida';
      if (value === 'novo') return 'Novo';
      if (value === 'remold') return 'Remold';
      return 'Condição pendente';
    },

    catalogoPositionLabel(value) {
      return { front: 'Dianteiro', rear: 'Traseiro', both: 'Ambos' }[value]
        || 'Não informado';
    },

    catalogoApplicationPositionLabel(row) {
      const positions = row?.application_positions || [];
      if (positions.length > 1) return 'Dianteiro ou traseiro, conforme a moto';
      if (positions.length === 1) return this.catalogoPositionLabel(positions[0]) + ' nas aplicações';
      return 'Aplicações pendentes de conferência';
    },

    async catalogoOpen(row) {
      if (this.adminUser?.role !== 'owner') return;
      if (row?.measure_draft) {
        this.catalogoCreateNew();
        this.catalogoCadastro.row = row;
        this.catalogoCadastro.form.measure = row.tire_size;
        this.catalogoCadastro.form.tire_condition = '';
        return;
      }
      if (row?.product_type === 'tire' && this.catalogoIsUnknownBrand(row?.brand)) {
        this.catalogoBrandCorrectionOpen(row);
        return;
      }
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
      this.catalogoSpecForm = {
        tread_pattern: row.tread_pattern || '',
        load_index: row.load_index || '',
        speed_rating: row.speed_rating || '',
        position: row.tire_position || '',
        reason: '',
      };
      this.catalogoHistory = [];
      this.catalogoMessage = null;
      this.catalogoSpecMessage = null;
      await this.catalogoLoadHistory(row.product_id);
      this.$nextTick(() => window.lucide && window.lucide.createIcons());
    },

    catalogoClose() {
      if (this.catalogoSaving || this.catalogoSpecSaving) return;
      this.catalogoSelecionado = null;
      this.catalogoHistory = [];
      this.catalogoMessage = null;
      this.catalogoSpecMessage = null;
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
      const cost = catalogoMoneyValue(this.catalogoSelecionado?.official_unit_cost);
      const price = catalogoMoneyValue(this.catalogoNovoPreco());
      return Number.isFinite(cost) && price > 0 ? price - cost : null;
    },
    catalogoMargem() {
      const profit = this.catalogoLucro();
      const price = catalogoMoneyValue(this.catalogoNovoPreco());
      return profit == null || price <= 0 ? null : (profit / price) * 100;
    },
    catalogoPrecoMinimo() {
      if (this.catalogoSelecionado?.official_unit_cost == null) return null;
      const cost = catalogoMoneyValue(this.catalogoSelecionado?.official_unit_cost);
      return Number.isFinite(cost) && cost > 0 ? cost / 0.65 : null;
    },
    catalogoApplyMargin(percent) {
      if (this.catalogoSelecionado?.official_unit_cost == null) return;
      const cost = catalogoMoneyValue(this.catalogoSelecionado?.official_unit_cost);
      if (!Number.isFinite(cost) || cost <= 0 || percent >= 100) return;
      this.catalogoPriceForm.price = (cost / (1 - percent / 100)).toFixed(2);
      this.catalogoPriceForm.marginPreset = percent;
    },
    catalogoPodeSalvar() {
      const price = this.catalogoNovoPreco();
      return this.adminUser?.role === 'owner' && !this.catalogoSaving
        && price > 0 && Math.abs(price * 100 - Math.round(price * 100)) < 1e-7
        && String(this.catalogoPriceForm.reason || '').trim().length >= 2;
    },

    async catalogoSavePrice() {
      if (this.adminUser?.role !== 'owner'
        || !this.catalogoSelecionado || !this.catalogoPodeSalvar()) return;
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

    catalogoPodeSalvarSpec() {
      return this.adminUser?.role === 'owner' && !this.catalogoSpecSaving
        && this.catalogoSelecionado?.product_type === 'tire'
        && String(this.catalogoSpecForm?.reason || '').trim().length >= 2;
    },

    async catalogoSaveSpec() {
      if (!this.catalogoPodeSalvarSpec()) return;
      const productId = this.catalogoSelecionado.product_id;
      const form = this.catalogoSpecForm;
      this.catalogoSpecSaving = true;
      this.catalogoSpecMessage = null;
      try {
        const nullable = (value) => String(value || '').trim() || null;
        const result = await this.apiPost(`/admin/api/catalog/${encodeURIComponent(productId)}/spec`, {
          tread_pattern: nullable(form.tread_pattern),
          load_index: nullable(form.load_index),
          speed_rating: nullable(form.speed_rating),
          position: nullable(form.position),
          reason: String(form.reason || '').trim(),
        });
        await this.loadCatalogo();
        const refreshed = this.catalogoRows.find((row) => row.product_id === productId) || null;
        this.catalogoSelecionado = refreshed;
        if (refreshed) {
          this.catalogoSpecForm = {
            tread_pattern: refreshed.tread_pattern || '',
            load_index: refreshed.load_index || '',
            speed_rating: refreshed.speed_rating || '',
            position: refreshed.tire_position || '',
            reason: '',
          };
        }
        this.catalogoSpecMessage = {
          ok: true,
          text: result.changed ? 'Ficha técnica atualizada e registrada no histórico de auditoria.'
            : 'A ficha técnica já estava com esses dados.',
        };
      } catch (error) {
        const code = error instanceof Error ? error.message : String(error);
        this.catalogoSpecMessage = {
          ok: false,
          text: code.includes('catalog_spec_reason') ? 'Informe o motivo da alteração.'
            : code.includes('catalog_product_not_found') ? 'Produto não encontrado.'
              : 'Não foi possível salvar a ficha técnica. Recarregue e tente novamente.',
        };
      } finally {
        this.catalogoSpecSaving = false;
        this.$nextTick(() => window.lucide && window.lucide.createIcons());
      }
    },

    catalogoPercent(value) {
      return value == null ? '—' : `${Number(value).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
    },

    catalogoDate(value) {
      if (!value) return 'Sem registro';
      return window.FarejadorTime.formatDateTime(value);
    },
  };
};
