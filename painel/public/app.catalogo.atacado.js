window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.catalogoAtacado = function () {
  return {
    catalogoAtacadoForm: { price: '', reason: '' }, catalogoAtacadoSaving: false,
    catalogoAtacadoMessage: null, catalogoAtacadoHistory: [], catalogoAtacadoHistoryError: false,
    catalogoAtacadoInit(row) {
      this.catalogoAtacadoForm = { price: row?.wholesale_price_amount == null
        ? '' : Number(row.wholesale_price_amount).toFixed(2), reason: '' };
      this.catalogoAtacadoHistory = []; this.catalogoAtacadoMessage = null;
      this.catalogoAtacadoHistoryError = false;
      if (row?.product_type === 'tire') this.catalogoAtacadoLoadHistory(row.product_id);
    },
    async catalogoAtacadoLoadHistory(productId) {
      try {
        const data = await this.apiGet(`/admin/api/catalog/${encodeURIComponent(productId)}/wholesale-history`);
        if (this.catalogoSelecionado?.product_id !== productId) return;
        this.catalogoAtacadoHistory = Array.isArray(data.rows) ? data.rows : [];
        this.catalogoAtacadoHistoryError = false;
      } catch {
        if (this.catalogoSelecionado?.product_id === productId) this.catalogoAtacadoHistoryError = true;
      }
    },
    catalogoAtacadoValue() {
      const text = String(this.catalogoAtacadoForm.price ?? '').trim();
      return text === '' ? null : Number(text.replace(',', '.'));
    },
    catalogoAtacadoCanSave() {
      const price = this.catalogoAtacadoValue(), reason = this.catalogoAtacadoForm.reason.trim();
      return this.adminUser?.role === 'owner' && this.catalogoSelecionado?.product_type === 'tire'
        && Boolean(this.catalogoSelecionado.product_id) && !this.catalogoAtacadoSaving
        && !this.catalogoSaving && !this.catalogoSpecSaving
        && (price === null || (Number.isFinite(price) && price > 0 && price <= 9999999.99
          && Math.abs(price * 100 - Math.round(price * 100)) < 1e-7))
        && reason.length >= 2 && reason.length <= 500
        && price !== (this.catalogoSelecionado.wholesale_price_amount ?? null);
    },
    async catalogoAtacadoSave() {
      if (!this.catalogoAtacadoCanSave()) return;
      const productId = this.catalogoSelecionado.product_id, price = this.catalogoAtacadoValue();
      this.catalogoAtacadoSaving = true; this.catalogoAtacadoMessage = null;
      try {
        const result = await this.apiPost(`/admin/api/catalog/${encodeURIComponent(productId)}/wholesale-price`, {
          price_amount: price, reason: this.catalogoAtacadoForm.reason.trim(),
        });
        // Atualiza só o campo de atacado. Alterações de varejo ainda não salvas permanecem.
        const row = this.catalogoRows.find(item => item.product_id === productId);
        if (row) row.wholesale_price_amount = result.price_amount;
        if (this.catalogoSelecionado?.product_id !== productId) return;
        this.catalogoSelecionado.wholesale_price_amount = result.price_amount;
        this.catalogoAtacadoForm.price = result.price_amount == null ? '' : Number(result.price_amount).toFixed(2);
        this.catalogoAtacadoForm.reason = '';
        this.catalogoAtacadoMessage = { ok: true, text: result.price_amount == null
          ? 'Oferta de atacado retirada. O preço de varejo continua igual.'
          : 'Preço de atacado salvo. O preço de varejo continua igual.' };
        await this.catalogoAtacadoLoadHistory(productId);
      } catch (error) {
        const code = error instanceof Error ? error.message : String(error);
        this.catalogoAtacadoMessage = { ok: false, text: code.includes('catalog_product_not_found')
          ? 'Produto não encontrado. Recarregue o Catálogo.' : 'Não foi possível salvar o atacado. Tente novamente.' };
      } finally { this.catalogoAtacadoSaving = false; }
    },
  };
};
