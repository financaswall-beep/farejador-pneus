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
      return window.FarejadorTime.formatDateTime(value);
    },

    businessTodaySaoPaulo(now = new Date()) {
      return window.FarejadorTime.businessDate(now);
    },

    businessFactInstant(date, today = this.businessTodaySaoPaulo(), nowIso = new Date().toISOString()) {
      if (date > today) throw new Error('business_date_future');
      if (date === today) return nowIso;
      return new Date(`${date}T12:00:00-03:00`).toISOString();
    },

    atacadoDateOnly(value) {
      const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (!match) return 'data inválida';
      return `${match[3]}/${match[2]}/${match[1]}`;
    },

    atacadoErrText(code) {
      const map = {
        buyer_required: 'Escolha ou cadastre o comprador.',
        items_required: 'Adicione ao menos um pneu.',
        partner_not_found: 'Parceiro não encontrado.',
        buyer_not_found: 'Cliente não encontrado.',
        oversell: 'Estoque insuficiente. A venda não foi registrada; confira o galpão.',
        tire_condition_required: 'Selecione a condição de cada pneu.',
        idempotency_conflict: 'Os dados mudaram durante o envio. Recarregue e confira antes de tentar novamente.',
        buyer_ambiguous: 'Escolha apenas um comprador.',
        sold_at_future: 'A data da venda não pode estar no futuro.',
        paid_at_future: 'A data do pagamento não pode estar no futuro.',
        paid_at_before_sale: 'A data do pagamento não pode ser anterior à venda.',
        due_date_before_sale: 'O vencimento não pode ser anterior à venda.',
        unit_price_cent_precision: 'Informe o preço com no máximo duas casas decimais.',
        sale_line_total_too_large: 'O total de um item ultrapassa o limite aceito.',
        sale_total_too_large: 'O total da venda ultrapassa o limite aceito.',
        sale_items_limit: 'A venda tem itens demais para um único lançamento.',
        partner_unit_required: 'Este parceiro tem mais de uma unidade. Escolha qual receberá os pneus.',
        partner_unit_not_found: 'A unidade parceira não está ativa ou não foi encontrada.',
        partner_unit_not_allowed: 'Este comprador não é uma unidade parceira.',
        wholesale_parent_order_not_open_root: 'O pedido original não está disponível para receber acréscimos.',
        wholesale_addition_partner_unit_mismatch: 'O acréscimo precisa ir para a mesma unidade do pedido original.',
        matrix_partner_transfer_not_in_transit: 'Esta carga já foi acertada ou ainda não está disponível para acerto.',
        matrix_partner_arrival_items_mismatch: 'A lista de pneus mudou. Recarregue a venda antes de confirmar.',
        matrix_partner_arrival_quantity_invalid: 'A quantidade aceita precisa ficar entre zero e a quantidade enviada.',
        matrix_partner_cargo_not_found: 'Esta carga já foi usada ou retornou ao galpão.',
        matrix_partner_cargo_insufficient: 'A carga não tem mais essa quantidade disponível.',
        matrix_partner_arrival_total_mismatch: 'Os valores do acerto não fecharam. Recarregue e confira antes de confirmar.',
        matrix_partner_original_ledger_missing: 'O lançamento financeiro original da saída não foi encontrado.',
      };
      return map[code] || `Não consegui registrar (${code}).`;
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
        const condition = {
          meia_vida: 'Meia-vida', novo: 'Novo', remold: 'Remold',
        }[item.tire_condition] || (item.tire_condition ? 'Condição a confirmar' : null);
        const details = [item.tire_size, item.brand, condition].filter(Boolean);
        return `${item.quantity || 1}x ${name}${details.length ? ` · ${details.join(' · ')}` : ''}`;
      }).join(' + ');
    },

    selectedProduct() {
      return this.produtos.find((product) => product.product_id === this.saleForm.product_id) || null;
    },

    saleStockError() {
      const product = this.selectedProduct();
      if (!product) return 'Escolha um produto do catálogo.';
      const messages = {
        walkin_measure_not_found: 'Esse pneu não está cadastrado no estoque do galpão.',
        walkin_cost_missing: 'Essa medida está sem custo no galpão. Cadastre o custo antes de vender.',
        walkin_stock_insufficient: 'Essa medida está sem saldo no galpão.',
        walkin_stock_ambiguous: 'Essa medida tem mais de um cadastro no galpão. Corrija o estoque antes de vender.',
        catalog_price_missing: 'Esse pneu está sem preço oficial. Defina o valor no Catálogo antes de vender.',
      };
      if (!product.walkin_sellable) {
        return messages[product.walkin_block_reason] || 'Esse produto não pode ser vendido agora.';
      }
      const requested = Number(this.saleForm.quantity || 0);
      const available = Number(product.total_stock_available ?? product.official_quantity_on_hand ?? 0);
      if (!Number.isInteger(requested) || requested <= 0) return 'Informe uma quantidade válida.';
      if (requested > available) return `Só tem ${available} dessa medida no galpão.`;
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
