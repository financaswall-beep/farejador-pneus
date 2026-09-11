window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.catalogoCompatibilidade = function () {
  return {
    async catalogoCompatibilityOpen(row) {
      if (!row?.tire_size || row.product_type === 'service') return;
      this.catalogoSelecionado = null;
      this.catalogoCadastro.open = false;
      this.catalogoCompatibilidade = {
        open: true,
        row,
        rows: [],
        applications: [], applicationReviews: [],
        summary: { models: 0, fitments: 0 },
        loading: true,
        error: null,
        search: '', searchRows: [], searching: false, selectedVehicle: null,
        form: { position: 'both', is_oem: false, source: 'manual', year_start: '', year_end: '', reason: '' },
        saving: false, message: null,
        discoveries: [], discoveriesLoading: false,
        discoveryForm: { source_url: '', source_title: '', evidence_summary: '', confidence_level: 0.8 },
      };
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
      if (!productId && !this.catalogoCompatibilidade.row?.product_id) {
        const state = this.catalogoCompatibilidade;
        if (!state.row?.tire_size) return;
        state.loading = true;
        state.error = null;
        try {
          const data = await this.apiGet(`/admin/api/catalog/measure-applications?measure=${encodeURIComponent(state.row.tire_size)}`);
          if (this.catalogoCompatibilidade !== state) return;
          state.applications = Array.isArray(data.applications) ? data.applications : [];
          state.applicationReviews = Array.isArray(data.application_reviews) ? data.application_reviews : [];
        } catch {
          state.error = 'Não foi possível carregar as aplicações desta medida.';
        } finally {
          state.loading = false;
          this.$nextTick(() => window.lucide && window.lucide.createIcons());
        }
        return;
      }
      if (!productId || this.catalogoCompatibilidade.row?.product_id !== productId) return;
      this.catalogoCompatibilidade.loading = true;
      this.catalogoCompatibilidade.error = null;
      try {
        const data = await this.apiGet(
          `/admin/api/catalog/${encodeURIComponent(productId)}/compatibility`,
        );
        if (this.catalogoCompatibilidade.row?.product_id !== productId) return;
        this.catalogoCompatibilidade.rows = Array.isArray(data.rows) ? data.rows : [];
        this.catalogoCompatibilidade.applications = Array.isArray(data.applications) ? data.applications : [];
        this.catalogoCompatibilidade.applicationReviews = Array.isArray(data.application_reviews) ? data.application_reviews : [];
        this.catalogoCompatibilidade.summary = data.summary || { models: 0, fitments: 0 };
      } catch {
        if (this.catalogoCompatibilidade.row?.product_id !== productId) return;
        this.catalogoCompatibilidade.rows = [];
        this.catalogoCompatibilidade.applications = [];
        this.catalogoCompatibilidade.applicationReviews = [];
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
        applications: [], applicationReviews: [],
        summary: { models: 0, fitments: 0 },
        loading: false,
        error: null,
        search: '', searchRows: [], searching: false, selectedVehicle: null,
        form: { position: 'both', is_oem: false, source: 'manual', year_start: '', year_end: '', reason: '' },
        saving: false, message: null,
        discoveries: [], discoveriesLoading: false,
        discoveryForm: { source_url: '', source_title: '', evidence_summary: '', confidence_level: 0.8 },
      };
    },

    async catalogoDiscoveryLoad(productId) {
      if (!productId || this.catalogoCompatibilidade.row?.product_id !== productId) return;
      this.catalogoCompatibilidade.discoveriesLoading = true;
      try {
        const data = await this.apiGet(
          `/admin/api/catalog/${encodeURIComponent(productId)}/fitment-discoveries`,
        );
        if (this.catalogoCompatibilidade.row?.product_id === productId) {
          this.catalogoCompatibilidade.discoveries = Array.isArray(data.rows) ? data.rows : [];
        }
      } catch {
        if (this.catalogoCompatibilidade.row?.product_id === productId) {
          this.catalogoCompatibilidade.message = {
            ok: false, text: 'As compatibilidades oficiais abriram, mas a fila de pesquisa não carregou.',
          };
        }
      } finally {
        this.catalogoCompatibilidade.discoveriesLoading = false;
      }
    },

    catalogoDiscoveryCanCreate() {
      const state = this.catalogoCompatibilidade;
      const form = state.discoveryForm || {};
      return this.adminUser?.role === 'owner' && !state.saving
        && Boolean(state.selectedVehicle?.vehicle_model_id)
        && /^https?:\/\//i.test(String(form.source_url || '').trim())
        && String(form.evidence_summary || '').trim().length >= 5
        && this.catalogoCompatibilityYearsValid();
    },

    async catalogoDiscoveryCreate() {
      const state = this.catalogoCompatibilidade;
      const productId = state.row?.product_id;
      if (!productId || !this.catalogoDiscoveryCanCreate()) return;
      state.saving = true;
      state.message = null;
      try {
        await this.apiPost(`/admin/api/catalog/${encodeURIComponent(productId)}/fitment-discoveries`, {
          vehicle_model_id: state.selectedVehicle.vehicle_model_id,
          position: state.form.position,
          source_url: String(state.discoveryForm.source_url).trim(),
          source_title: String(state.discoveryForm.source_title || '').trim() || null,
          evidence_summary: String(state.discoveryForm.evidence_summary).trim(),
          suggested_is_oem: Boolean(state.form.is_oem),
          confidence_level: Number(state.discoveryForm.confidence_level || 0.8),
          year_start: this.catalogoCompatibilityYearValue(state.form.year_start),
          year_end: this.catalogoCompatibilityYearValue(state.form.year_end),
        });
        state.discoveryForm = { source_url: '', source_title: '', evidence_summary: '', confidence_level: 0.8 };
        state.search = '';
        state.selectedVehicle = null;
        state.form.year_start = '';
        state.form.year_end = '';
        state.message = { ok: true, text: 'Pesquisa registrada como candidata. O Bot ainda não usa esse dado até a aprovação.' };
        await this.catalogoDiscoveryLoad(productId);
      } catch (error) {
        const code = error instanceof Error ? error.message : String(error);
        state.message = {
          ok: false,
          text: code.includes('catalog_discovery_already_pending')
            ? 'Já existe uma pesquisa pendente para esta moto, posição e medida.'
            : 'Não foi possível registrar a pesquisa.',
        };
      } finally {
        state.saving = false;
      }
    },

    async catalogoDiscoveryReview(item, decision) {
      const state = this.catalogoCompatibilidade;
      const productId = state.row?.product_id;
      if (this.adminUser?.role !== 'owner' || !productId || state.saving) return;
      if (item.active_reference) {
        state.message = { ok: true, text: 'Esta referência já está em uso pelo Bot. Não precisa aprovar para consultar por medida.' };
        return;
      }
      const action = decision === 'approve' ? 'aprovar' : 'rejeitar';
      const reason = window.prompt(`Motivo para ${action} esta pesquisa:`);
      if (!reason || reason.trim().length < 2) return;
      state.saving = true;
      state.message = null;
      try {
        const result = await this.apiPost(
          `/admin/api/catalog/${encodeURIComponent(productId)}/fitment-discoveries/${encodeURIComponent(item.discovery_id)}/review`,
          { decision, reason: reason.trim() },
        );
        state.message = { ok: true, text: result.status === 'promoted'
          ? 'Pesquisa aprovada e propagada para todos os produtos desta medida.'
          : 'Pesquisa rejeitada e preservada no histórico.' };
        await Promise.all([
          this.catalogoDiscoveryLoad(productId),
          this.catalogoCompatibilityLoad(productId),
          this.loadCatalogo(),
        ]);
      } catch {
        state.message = { ok: false, text: 'Não foi possível revisar esta pesquisa.' };
      } finally {
        state.saving = false;
      }
    },

    async catalogoCompatibilitySearch() {
      const term = String(this.catalogoCompatibilidade.search || '').trim();
      this.catalogoCompatibilidade.selectedVehicle = null;
      this.catalogoCompatibilidade.searchRows = [];
      if (term.length < 2) return;
      this.catalogoCompatibilidade.searching = true;
      this.catalogoCompatibilidade.message = null;
      try {
        const data = await this.apiGet(
          `/admin/api/catalog/vehicle-models?q=${encodeURIComponent(term)}`,
        );
        this.catalogoCompatibilidade.searchRows = Array.isArray(data.rows) ? data.rows : [];
      } catch {
        this.catalogoCompatibilidade.message = {
          ok: false, text: 'Não foi possível pesquisar os modelos de moto.',
        };
      } finally {
        this.catalogoCompatibilidade.searching = false;
        this.$nextTick(() => window.lucide && window.lucide.createIcons());
      }
    },

    catalogoCompatibilitySelectVehicle(vehicle) {
      this.catalogoCompatibilidade.selectedVehicle = vehicle;
      this.catalogoCompatibilidade.searchRows = [];
      this.catalogoCompatibilidade.search = [vehicle.make, vehicle.model, vehicle.variant]
        .filter(Boolean).join(' ');
      this.catalogoCompatibilidade.form.year_start = vehicle.year_start || '';
      this.catalogoCompatibilidade.form.year_end = vehicle.year_end || '';
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
      return this.adminUser?.role === 'owner' && !state.saving
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
          is_oem: Boolean(state.form.is_oem),
          source: state.form.source || 'manual',
          confidence_level: 1,
          year_start: this.catalogoCompatibilityYearValue(state.form.year_start),
          year_end: this.catalogoCompatibilityYearValue(state.form.year_end),
          reason: String(state.form.reason).trim(),
        });
        state.search = '';
        state.searchRows = [];
        state.selectedVehicle = null;
        state.form = { position: 'both', is_oem: false, source: 'manual', year_start: '', year_end: '', reason: '' };
        state.message = { ok: true, text: 'Compatibilidade salva para todos os produtos desta medida.' };
        await this.catalogoCompatibilityLoad(productId);
        await this.loadCatalogo();
      } catch {
        state.message = { ok: false, text: 'Não foi possível salvar a compatibilidade.' };
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
      if (!window.confirm('Remover esta moto de todos os produtos desta medida?')) return;
      state.saving = true;
      state.message = null;
      try {
        await this.apiDelete(
          `/admin/api/catalog/${encodeURIComponent(productId)}/compatibility/${encodeURIComponent(item.vehicle_model_id)}/${encodeURIComponent(item.position)}`,
          { reason: reason.trim() },
        );
        state.message = { ok: true, text: 'Compatibilidade removida da medida e registrada na auditoria.' };
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
