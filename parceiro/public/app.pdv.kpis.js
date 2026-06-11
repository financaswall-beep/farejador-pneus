/**
 * app.pdv.kpis.js - fabrica `pdvKpis` do painel do parceiro (obra <=300, passo 8/11).
 * MORA AQUI: leitura/rotulos da FRENTE DE CAIXA - getters do carrinho (subtotal/total/
 * unidades/troco), produtos filtrados/ordenados, caixa do dia (posCashTodayTotal: vendas
 * pagas na hora + recebiveis recebidos hoje, SEM dupla contagem - contrato 0077),
 * vendas de hoje, e rotulos de produto do PDV. CONTRATO: ver
 * docs/CONTRATO_ESTOQUE_FINANCEIRO_0076_0077.md (caixa do dia, disponivel).
 * NAO MORA AQUI: acoes do carrinho/checkout (app.pdv.js); cliente (app.pdv.clientes.js).
 * VEIO DE: app.js commit d04768b (ranges 1315-1444, 1528-1549), VERBATIM.
 * REGRA: teto 300 (npm run checar-tamanho); `this` e o objeto unico de app.js.
 */
window.PARCEIRO_MODULES = window.PARCEIRO_MODULES || {};
window.PARCEIRO_MODULES.pdvKpis = () => ({
    get saleTotalLabel() {
      return this.money(this.num(this.saleForm.quantity) * this.num(this.saleForm.unit_price));
    },

    get posProducts() {
      const search = this.posSearch.trim().toLowerCase();
      return this.produtos.filter((item) => {
        const haystack = [
          item.item_name,
          item.tire_size,
          item.brand,
          item.supplier_name,
        ].filter(Boolean).join(' ').toLowerCase();
        return !search || haystack.includes(search);
      });
    },

    get posBrandOptions() {
      return [...new Set(this.produtos.map((item) => item.brand).filter(Boolean))]
        .sort((a, b) => String(a).localeCompare(String(b), 'pt-BR'));
    },

    get posRimOptions() {
      return [...new Set(this.produtos.map((item) => {
        if (item.tire_rim_diameter) return String(item.tire_rim_diameter);
        return String(this.parseTireSize(item.tire_size).rim || '');
      }).filter(Boolean))]
        .sort((a, b) => Number(a) - Number(b));
    },

    posProductSalesCount(stockId) {
      if (!stockId) return 0;
      return this.completedSales.reduce((sum, sale) => {
        const items = Array.isArray(sale.items) ? sale.items : [];
        return sum + items.reduce((itemSum, item) => {
          if (item.partner_stock_id !== stockId) return itemSum;
          return itemSum + (this.num(item.quantity) || 1);
        }, 0);
      }, 0);
    },

    get posDisplayProducts() {
      const filtered = this.posProducts.filter((item) => {
        const brandOk = this.posBrandFilter === 'all' || item.brand === this.posBrandFilter;
        const rim = item.tire_rim_diameter || this.parseTireSize(item.tire_size).rim;
        const rimOk = this.posRimFilter === 'all' || String(rim || '') === String(this.posRimFilter);
        return brandOk && rimOk;
      });
      return [...filtered].sort((a, b) => {
        if (this.posSort === 'price_asc') return this.num(a.sale_price) - this.num(b.sale_price);
        if (this.posSort === 'price_desc') return this.num(b.sale_price) - this.num(a.sale_price);
        if (this.posSort === 'best_sellers') return this.posProductSalesCount(b.stock_id) - this.posProductSalesCount(a.stock_id);
        return 0;
      });
    },

    get posCartSubtotal() {
      return this.posCart.reduce((sum, item) => sum + (this.num(item.quantity) * this.num(item.unit_price)), 0);
    },

    get posCartTotal() {
      return Math.max(0, this.posCartSubtotal - this.num(this.posDiscountAmount) + this.num(this.posFreightAmount));
    },

    get posCartUnits() {
      return this.posCart.reduce((sum, item) => sum + this.num(item.quantity), 0);
    },

    get posChangeAmount() {
      if (this.saleForm.payment_status === 'receivable') return 0;
      return Math.max(0, this.num(this.posReceivedAmount) - this.posCartTotal);
    },

    get posCashTodayTotal() {
      // Caixa do dia = dinheiro que efetivamente entrou hoje. Duas fontes, sem
      // dupla contagem:
      //   (1) vendas concluidas hoje pagas na hora (exclui "A receber": COD/fiado
      //       nao entram aqui — entram via recebivel recebido em (2));
      //   (2) recebiveis com status 'received' e received_at hoje (COD entregue
      //       hoje + fiado quitado hoje). Venda a vista nao gera recebivel, entao
      //       nao ha sobreposicao com (1).
      const today = this.dateKeySaoPaulo(new Date());
      const cashSales = this.salesToday.reduce((sum, sale) => {
        if (sale.payment_method === 'A receber') return sum;
        return sum + this.num(sale.total_amount);
      }, 0);
      const receivablesToday = (this.receivables || []).reduce((sum, receivable) => {
        if (receivable.status !== 'received' || !receivable.received_at) return sum;
        if (this.dateKeySaoPaulo(receivable.received_at) !== today) return sum;
        return sum + this.num(receivable.amount);
      }, 0);
      return cashSales + receivablesToday;
    },

    get salesTodayTotal() {
      // Vendas hoje = faturado total do dia (inclui "A receber"); diferente do caixa.
      return this.salesToday.reduce((sum, sale) => sum + this.num(sale.total_amount), 0);
    },

    get salesToday() {
      const today = this.dateKeySaoPaulo(new Date());
      return this.completedSales.filter((sale) => this.dateKeySaoPaulo(this.saleRealizedAt(sale)) === today);
    },

    get posFirstSaleTodayLabel() {
      if (!this.salesToday.length) return 'sem venda hoje ainda';
      const first = [...this.salesToday].sort((a, b) => new Date(this.saleRealizedAt(a) || 0) - new Date(this.saleRealizedAt(b) || 0))[0];
      return `aberto as ${new Intl.DateTimeFormat('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(this.saleRealizedAt(first)))}`;
    },

    get posSalesTodayHourly() {
      const buckets = Array.from({ length: 24 }, (_, hour) => ({ hour, label: `${String(hour).padStart(2, '0')}h`, value: 0 }));
      for (const sale of this.salesToday) {
        const hour = Number(new Intl.DateTimeFormat('pt-BR', {
          timeZone: 'America/Sao_Paulo',
          hour: '2-digit',
          hour12: false,
        }).format(new Date(this.saleRealizedAt(sale))));
        if (Number.isFinite(hour) && buckets[hour]) buckets[hour].value += this.num(sale.total_amount);
      }
      return buckets;
    },

    get posLastSale() {
      return this.completedSales[0] || null;
    },

    // RÃ³tulo de cada item do dropdown da venda.
    formatPartnerStockOption(item) {
      const parts = [item.item_name];
      if (item.tire_size) parts.push(item.tire_size);
      if (item.brand) parts.push(item.brand);
      const qtyLabel = this.stockAvailabilityLabel(item);
      parts.push(qtyLabel);
      return parts.join(' - ');
    },

    posProductTitle(item) {
      return [item.tire_size, item.item_name].filter(Boolean).join(' - ') || 'Produto';
    },

    posProductSubtitle(item) {
      return [item.brand, item.supplier_name].filter(Boolean).join(' - ') || 'Sem marca';
    },

    posStockLabel(item) {
      if (!item.is_tracked) return 'sem controle';
      return this.stockAvailabilityLabel(item);
    },
});
