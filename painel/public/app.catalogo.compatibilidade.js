window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.catalogoCompatibilidade = function () {
  return {
    catalogoCompatibilityState(row) {
      return {
        open: Boolean(row), row, rows: [], applications: [], applicationReviews: [],
        referencesToClassify: [], selectedReferences: [], summary: { models: 0, fitments: 0 },
        loading: Boolean(row), error: null, search: '', searchRows: [], searching: false,
        searchVersion: 0, loadVersion: 0, searchDone: false, selectedVehicle: null,
        carModel: null, carAction: null, carReference: null,
        form: { position: 'both', is_oem: false, source: 'manual', year_start: '', year_end: '', reason: '' },
        editingPeriod: null, saving: false, message: null,
        discoveries: [], discoveriesLoading: false,
        discoveryForm: { source_url: '', source_title: '', evidence_summary: '', confidence_level: 0.8 },
      };
    },

    async catalogoCompatibilityOpen(row) {
      if (!row?.tire_size || row.product_type === 'service') return;
      this.catalogoSelecionado = null;
      this.catalogoCadastro.open = false;
      this.catalogoCompatibilidade = this.catalogoCompatibilityState(row);
      this.$nextTick(() => window.lucide && window.lucide.createIcons());
      if (!row.product_id) {
        await this.catalogoCompatibilityLoad();
        return;
      }
      await Promise.all([
        this.catalogoCompatibilityLoad(row.product_id),
        this.catalogoDiscoveryLoad(row.product_id),
      ]);
    },

    async catalogoCompatibilityLoad(productId) {
      const state = this.catalogoCompatibilidade;
      if (!state.row?.tire_size && !productId) return;
      if ((state.row?.product_id || null) !== (productId || null)) return;
      const category = state.row?.vehicle_type;
      const url = productId ? `/admin/api/catalog/${encodeURIComponent(productId)}/compatibility`
        : `/admin/api/catalog/measure-applications?measure=${encodeURIComponent(state.row.tire_size)}&vehicle_type=${['motorcycle', 'car'].includes(category) ? category : 'unknown'}`;
      const version = (state.loadVersion || 0) + 1;
      state.loadVersion = version;
      state.loading = true;
      state.error = null;
      try {
        const data = await this.apiGet(url);
        if (state.loadVersion !== version) return;
        state.rows = Array.isArray(data.rows) ? data.rows : [];
        state.applications = Array.isArray(data.applications) ? data.applications : [];
        state.referencesToClassify = category === 'car' ? [] : data.referencias_para_classificar || [];
        state.selectedReferences = [];
        state.applicationReviews = Array.isArray(data.application_reviews) ? data.application_reviews : [];
        state.summary = data.summary || { models: 0, fitments: 0 };
      } catch {
        if (state.loadVersion !== version) return;
        state.rows = [];
        state.applications = [];
        state.applicationReviews = [];
        state.summary = { models: 0, fitments: 0 };
        state.error = 'Não foi possível carregar as compatibilidades.';
      } finally {
        if (state.loadVersion === version) state.loading = false;
        this.$nextTick(() => window.lucide && window.lucide.createIcons());
      }
    },

    async catalogoClassifyReferences() {
      const state = this.catalogoCompatibilidade;
      if (this.adminUser?.role !== 'owner' || state.loading || state.error || state.saving || state.row?.vehicle_type === 'car' || !state.selectedReferences?.length) return;
      state.saving = true;
      state.message = null;
      try {
        const result = await this.apiPost('/admin/api/catalog/measure-applications/classify-motorcycle', {
          measure: state.row.tire_size, application_ids: [...state.selectedReferences],
        });
        state.message = { ok: true, text: 'Referências classificadas como Moto: ' + result.changed + '.' };
        if (this.catalogoCompatibilidade === state) await this.catalogoCompatibilityLoad(state.row.product_id);
        await this.loadCatalogo();
      } catch (error) {
        if (error.message === 'catalog_reference_selection_changed') {
          if (this.catalogoCompatibilidade === state) await this.catalogoCompatibilityLoad(state.row.product_id);
          state.message = { ok: false, text: 'As referências mudaram. Confira a lista atualizada.' };
        } else {
          state.message = { ok: false, text: 'Não foi possível confirmar a classificação. Reabra a ficha para conferir.' };
        }
      } finally {
        state.saving = false;
      }
    },

    catalogoCompatibilityClose() {
      this.catalogoCompatibilidade = this.catalogoCompatibilityState(null);
    },

    catalogoCompatibilityResetSearch() {
      const state = this.catalogoCompatibilidade;
      state.searchVersion = (state.searchVersion || 0) + 1;
      state.searchRows = [];
      state.searching = false;
      state.searchDone = false;
      state.selectedVehicle = null;
      state.editingPeriod = null;
      state.carModel = null;
      state.carReference = null;
      state.carAction = null;
      state.message = null;
    },

    async catalogoCompatibilitySearch() {
      const state = this.catalogoCompatibilidade;
      const term = String(state.search || '').trim();
      const category = state.row?.vehicle_type;
      if (term.length < 2 || state.selectedVehicle || state.carModel || !['motorcycle', 'car'].includes(category)) return;
      const version = state.searchVersion;
      state.searching = true;
      try {
        const data = await this.apiGet(
          `/admin/api/catalog/vehicle-models?q=${encodeURIComponent(term)}&vehicle_type=${category}`,
        );
        if (state.searchVersion !== version) return;
        state.searchRows = Array.isArray(data.rows) ? data.rows : [];
        state.searchDone = true;
      } catch {
        if (state.searchVersion === version) state.message = { ok: false, text: 'Não foi possível pesquisar os modelos de veículo.' };
      } finally {
        if (state.searchVersion === version) state.searching = false;
      }
    },

    catalogoCompatibilitySelectVehicle(vehicle) {
      const state = this.catalogoCompatibilidade;
      if (vehicle.vehicle_type && vehicle.vehicle_type !== state.row?.vehicle_type) return;
      this.catalogoCompatibilityResetSearch();
      state.selectedVehicle = vehicle;
      state.search = [vehicle.make, vehicle.model, vehicle.variant].filter(Boolean).join(' ');
      state.form = { position: 'both', is_oem: false, source: 'manual', reason: '',
        year_start: vehicle.year_start || '', year_end: vehicle.year_end || '' };
      state.discoveryForm = { source_url: '', source_title: '', evidence_summary: '', confidence_level: 0.8 };
      if (state.row?.vehicle_type === 'car') this.catalogoCarStartReference();
    },

    catalogoCompatibilityEdit(item) {
      const state = this.catalogoCompatibilidade;
      if (state.saving) return;
      this.catalogoCompatibilitySelectVehicle(item);
      state.carAction = 'fitment';
      state.editingPeriod = { year_start: item.year_start, year_end: item.year_end };
      state.form.position = item.position;
      state.form.source = item.source === 'manufacturer' ? 'manufacturer' : 'manual';
      state.form.is_oem = item.is_oem;
      state.form.reason = '';
      state.message = null;
      this.$nextTick(() => this.$refs.compatibilityStart?.focus());
    },

    catalogoCompatibilityYearValue(value) {
      if (value === '' || value === null || value === undefined) return null;
      const year = Number(value);
      return Number.isInteger(year) ? year : null;
    },

    catalogoCompatibilityYearsValid() {
      const form = this.catalogoCompatibilidade.form || {};
      const startEmpty = form.year_start === '' || form.year_start === null || form.year_start === undefined;
      const endEmpty = form.year_end === '' || form.year_end === null || form.year_end === undefined;
      const start = startEmpty ? null : Number(form.year_start);
      const end = endEmpty ? null : Number(form.year_end);
      if (start !== null && (!Number.isInteger(start) || start < 1900 || start > 2100)) return false;
      if (end !== null && (!Number.isInteger(end) || end < 1900 || end > 2100)) return false;
      return start === null || end === null || end >= start;
    },

    catalogoCompatibilityCanSave() {
      const state = this.catalogoCompatibilidade;
      return this.adminUser?.role === 'owner' && !state.saving && !state.loading && !state.error
        && (state.row?.vehicle_type !== 'car' || state.carAction === 'fitment')
        && Boolean(state.selectedVehicle?.vehicle_model_id)
        && ['front', 'rear', 'both'].includes(state.form?.position)
        && this.catalogoCompatibilityYearsValid()
        && String(state.form?.reason || '').trim().length >= 2;
    },

    async catalogoCompatibilitySave() {
      const state = this.catalogoCompatibilidade;
      const productId = state.row?.product_id;
      if (!productId || !this.catalogoCompatibilityCanSave()) return;
      state.saving = true;
      state.message = null;
      try {
        await this.apiPost(`/admin/api/catalog/${encodeURIComponent(productId)}/compatibility`, {
          vehicle_model_id: state.selectedVehicle.vehicle_model_id,
          position: state.form.position,
          ...(state.editingPeriod ? { previous_period: state.editingPeriod } : {}),
          is_oem: Boolean(state.form.is_oem),
          ...(!state.editingPeriod || state.form.source !== (state.selectedVehicle.source === 'manufacturer' ? 'manufacturer' : 'manual')
            ? { source: state.form.source || 'manual' } : {}),
          ...(!state.editingPeriod ? { confidence_level: 1 } : {}),
          year_start: this.catalogoCompatibilityYearValue(state.form.year_start),
          year_end: this.catalogoCompatibilityYearValue(state.form.year_end),
          reason: String(state.form.reason).trim(),
        });
        state.search = '';
        state.searchRows = [];
        state.selectedVehicle = null;
        state.editingPeriod = null;
        state.form = { position: 'both', is_oem: false, source: 'manual', year_start: '', year_end: '', reason: '' };
        state.message = { ok: true, text: state.row.vehicle_type === 'car'
          ? 'Vínculo salvo para este pneu.' : 'Vínculo salvo para os pneus de moto desta medida.' };
        await this.catalogoCompatibilityLoad(productId);
        await this.loadCatalogo();
      } catch (error) {
        const text = error.message === 'catalog_fitment_period_already_exists' ? 'O período de destino já está cadastrado.'
          : error.message === 'catalog_fitment_period_not_found' ? 'Este período mudou. Reabra a ficha e confira os anos.'
          : 'Não foi possível salvar a compatibilidade.';
        state.message = { ok: false, text };
      } finally {
        state.saving = false;
      }
    },

    async catalogoCompatibilityRemove(item) {
      const state = this.catalogoCompatibilidade;
      const productId = state.row?.product_id;
      if (this.adminUser?.role !== 'owner' || !productId || state.saving) return;
      const reason = window.prompt('Motivo da remoção desta compatibilidade:');
      if (!reason || reason.trim().length < 2) return;
      const scope = state.row.vehicle_type === 'car' ? 'deste pneu' : 'dos pneus de moto desta medida';
      if (!window.confirm(`Remover o vínculo ${scope} no período ${this.catalogoCompatibilityYearLabel(item)}?`)) return;
      state.saving = true;
      state.message = null;
      try {
        await this.apiDelete(
          `/admin/api/catalog/${encodeURIComponent(productId)}/compatibility/${encodeURIComponent(item.vehicle_model_id)}/${encodeURIComponent(item.position)}`,
          { reason: reason.trim(), previous_period: { year_start: item.year_start, year_end: item.year_end } },
        );
        state.message = { ok: true, text: 'Vínculo removido e registrado na auditoria.' };
        await this.catalogoCompatibilityLoad(productId);
        await this.loadCatalogo();
      } catch {
        state.message = { ok: false, text: 'Não foi possível remover a compatibilidade.' };
      } finally {
        state.saving = false;
      }
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
