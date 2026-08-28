// Obra 300 (2026-07-05): fatia do painel da MATRIZ — modal de venda manual/walk-in + período e meta da Rede.
// VERBATIM das linhas 550-604 do app.js pré-obra (commit dd64a35).
// Montado em app.js via getOwnPropertyDescriptors — NUNCA usar spread (congela getter).
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.vendaModal = function () {
  return {
    openSaleModal(conv) {
      this.modalConv = conv;
      const firstProduct = this.produtos.find((product) => product.walkin_sellable) || null;
      const hasDraft = Boolean(conv?.draft_id);
      this.saleForm = {
        product_id: firstProduct?.product_id || '',
        quantity: 1,
        unit_price: Number(firstProduct?.price_amount || 0),
        payment_method: conv?.draft_payment_method || 'Pix',
        payment_due_on: '',
        fulfillment_mode: conv?.draft_fulfillment_mode || 'delivery',
        delivery_address: conv?.draft_delivery_address || '',
        notes: '',
        idempotency_key: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
        source_tag: hasDraft ? 'chatwoot_com_bot' : 'chatwoot_sem_bot',
        customer_name: '',
        customer_phone: '',
      };
      this.orderError = null;
      this.saleModalOpen = true;
    },

    async openWalkinModal() {
      this.modalConv = null;
      // O estoque pode ter mudado em Compras sem que o shell do painel tenha
      // sido recarregado. A venda sempre abre sobre uma fotografia nova do
      // catálogo para não exibir saldo/custo antigos ao operador.
      try {
        const payload = await this.apiGet('/admin/api/dashboard/produtos?limit=100');
        this.applyProdutos(payload.rows);
      } catch (_error) {
        window.alert('Não consegui atualizar o estoque para a venda. Atualize a página e tente novamente.');
        return;
      }
      const firstProduct = this.produtos.find((product) => product.walkin_sellable) || null;
      this.saleForm = {
        product_id: firstProduct?.product_id || '',
        quantity: 1,
        unit_price: Number(firstProduct?.price_amount || 0),
        payment_method: 'Dinheiro',
        payment_due_on: '',
        fulfillment_mode: 'pickup',
        delivery_address: '',
        notes: '',
        idempotency_key: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
        source_tag: 'walkin_balcao',
        customer_name: '',
        customer_phone: '',
      };
      this.orderError = null;
      this.saleModalOpen = true;
    },

    // ─── LIFECYCLE ──────────────────────────────────
    async setRedePeriod(period) {
      if (this.redePeriod === period) return;
      this.redePeriod = period;
      localStorage.setItem('farejador_rede_period', period);
      await this.loadRedeData();
    },

    updateRedeSalesGoal() {
      const value = Math.max(0, Number(this.redeSalesGoal || 0));
      this.redeSalesGoal = value;
      localStorage.setItem('farejador_rede_sales_goal', String(value));
      this.$nextTick(() => this.renderRedeChart());
    },
  };
};
