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
        search: '', searchRows: [], searching: false, selectedVehicle: null,
        form: { position: 'both', is_oem: false, source: 'manual', reason: '' },
        saving: false, message: null,
        discoveries: [], discoveriesLoading: false,
        discoveryForm: { source_url: '', source_title: '', evidence_summary: '', confidence_level: 0.8 },
      };
      this.$nextTick(() => window.lucide && window.lucide.createIcons());
      await Promise.all([
        this.catalogoCompatibilityLoad(row.product_id),
        this.catalogoDiscoveryLoad(row.product_id),
      ]);
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
        search: '', searchRows: [], searching: false, selectedVehicle: null,
        form: { position: 'both', is_oem: false, source: 'manual', reason: '' },
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
        && String(form.evidence_summary || '').trim().length >= 5;
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
        });
        state.discoveryForm = { source_url: '', source_title: '', evidence_summary: '', confidence_level: 0.8 };
        state.search = '';
        state.selectedVehicle = null;
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
    },

    catalogoCompatibilityCanSave() {
      const state = this.catalogoCompatibilidade;
      return this.adminUser?.role === 'owner' && !state.saving
        && Boolean(state.selectedVehicle?.vehicle_model_id)
        && ['front', 'rear', 'both'].includes(state.form?.position)
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
          reason: String(state.form.reason).trim(),
        });
        state.search = '';
        state.searchRows = [];
        state.selectedVehicle = null;
        state.form = { position: 'both', is_oem: false, source: 'manual', reason: '' };
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
