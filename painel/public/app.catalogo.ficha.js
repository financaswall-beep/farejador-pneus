window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.catalogoFicha = function () {
  return {
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
          vehicle_type: nullable(form.vehicle_type),
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
            vehicle_type: refreshed.vehicle_type || '',
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
          text: code.includes('vehicle_type') ? 'Essa classificação conflita com uma compatibilidade ou estoque existente. Confira os vínculos antes de alterar.'
            : code.includes('catalog_spec_reason') ? 'Informe o motivo da alteração.'
            : code.includes('catalog_product_not_found') ? 'Produto não encontrado.'
              : 'Não foi possível salvar a ficha técnica. Recarregue e tente novamente.',
        };
      } finally {
        this.catalogoSpecSaving = false;
        this.$nextTick(() => window.lucide && window.lucide.createIcons());
      }
    },

  };
};
