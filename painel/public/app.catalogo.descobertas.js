window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.catalogoDescobertas = function () {
  return {
    async catalogoDiscoveryLoad(productId) {
      const state = this.catalogoCompatibilidade;
      if (!productId || state.row?.product_id !== productId) return;
      state.discoveriesLoading = true;
      try {
        const data = await this.apiGet(
          `/admin/api/catalog/${encodeURIComponent(productId)}/fitment-discoveries`,
        );
        state.discoveries = Array.isArray(data.rows) ? data.rows : [];
      } catch {
        state.message = { ok: false, text: 'Não foi possível carregar a fila de pesquisa deste pneu.' };
      } finally {
        state.discoveriesLoading = false;
      }
    },

    catalogoDiscoveryCanCreate() {
      const state = this.catalogoCompatibilidade;
      const form = state.discoveryForm || {};
      return this.adminUser?.role === 'owner' && !state.saving && !state.loading && !state.error
        && (state.row?.vehicle_type !== 'car' || state.carAction === 'fitment')
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
            ? 'Já existe uma pesquisa pendente para este modelo, posição e medida.'
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
          ? (state.row.vehicle_type === 'car' ? 'Pesquisa aprovada para este pneu.' : 'Pesquisa aprovada para os pneus de moto desta medida.')
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

  };
};
