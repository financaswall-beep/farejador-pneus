// Obra 300 (2026-07-05): fatia do painel da MATRIZ — moeda/data/tempo/iniciais + widgets do form de venda.
// VERBATIM das linhas 705-768 do app.js pré-obra (commit dd64a35).
// Montado em app.js via getOwnPropertyDescriptors — NUNCA usar spread (congela getter).
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.format = function () {
  return {
    formatCurrency(value) {
      return Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    },

    formatDateTime(value) {
      if (!value) return '-';
      return new Date(value).toLocaleString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
    },

    timeAgo(value) {
      if (!value) return '-';
      const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
      if (seconds < 60) return `${seconds}s`;
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return `${minutes}min`;
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return `${hours}h`;
      return `${Math.floor(hours / 24)}d`;
    },

    truncateText(value, max = 110) {
      const text = String(value || '').trim();
      if (text.length <= max) return text;
      return `${text.slice(0, max - 1)}...`;
    },

    initials(name) {
      return (name || '?').trim().slice(0, 1).toUpperCase();
    },

    displaySlot(value) {
      if (value === null || value === undefined) return '';
      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      if (typeof value === 'object' && 'value' in value) return this.displaySlot(value.value);
      return JSON.stringify(value);
    },

    itemSummary(items) {
      if (!Array.isArray(items) || items.length === 0) return 'Sem itens';
      return items.map((item) => {
        const name = item.product_name || item.product_code || item.product_id || 'Produto';
        return `${item.quantity || 1}x ${name}`;
      }).join(' + ');
    },

    selectedProduct() {
      return this.produtos.find((product) => product.product_id === this.saleForm.product_id) || null;
    },

    saleStockError() {
      const product = this.selectedProduct();
      if (!product) return 'Escolha um produto do catÃ¡logo.';
      const messages = {
        walkin_measure_not_found: 'Esse pneu nÃ£o estÃ¡ cadastrado no estoque do galpÃ£o.',
        walkin_cost_missing: 'Essa medida estÃ¡ sem custo no galpÃ£o. Cadastre o custo antes de vender.',
        walkin_stock_insufficient: 'Essa medida estÃ¡ sem saldo no galpÃ£o.',
        walkin_stock_ambiguous: 'Essa medida tem mais de um cadastro no galpÃ£o. Corrija o estoque antes de vender.',
      };
      if (!product.walkin_sellable) {
        return messages[product.walkin_block_reason] || 'Esse produto nÃ£o pode ser vendido agora.';
      }
      const requested = Number(this.saleForm.quantity || 0);
      const available = Number(product.official_quantity_on_hand || 0);
      if (!Number.isInteger(requested) || requested <= 0) return 'Informe uma quantidade vÃ¡lida.';
      if (requested > available) return `SÃ³ tem ${available} dessa medida no galpÃ£o.`;
      return null;
    },

    saleCanSubmit() {
      return this.saleStockError() === null;
    },

    saleTotal() {
      return this.formatCurrency(Number(this.saleForm.quantity || 0) * Number(this.saleForm.unit_price || 0));
    },

    onProductChanged() {
      const product = this.selectedProduct();
      this.saleForm.unit_price = Number(product?.price_amount || 0);
      this.orderError = null;
    },

  };
};
