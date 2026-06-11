/**
 * app.financeiro.kpis.js - fabrica `financeiroKpis` do painel do parceiro (obra <=300, passo 9/11).
 * MORA AQUI: leitura do FINANCEIRO - custo do mes (totalCusts = CMV + despesas; compras
 * NAO entram - contrato 0077/0078), margem, os helpers 0076/0077 de venda REALIZADA
 * (isPhysicalExitSale: delivery so conta entregue; saleRealizedAt: pickup created_at /
 * delivery delivered_at; salesUnitsFor), series 30d, detalhes/totais de contas a pagar
 * e a receber, e rotulos de compra. CONTRATO: docs/CONTRATO_ESTOQUE_FINANCEIRO_0076_0077.md.
 * NAO MORA AQUI: score (app.financeiro.score.js); CRUD (compras/contas/receber).
 * VEIO DE: app.js commit ea22ea3 (ranges 583-743, 1304-1313, 1864-1868), VERBATIM.
 * REGRA: teto 300 (npm run checar-tamanho); `this` e o objeto unico de app.js.
 */
window.PARCEIRO_MODULES = window.PARCEIRO_MODULES || {};
window.PARCEIRO_MODULES.financeiroKpis = () => ({
    // Custo realizado do mes (regime de competencia).
    // Alinhado ao resultado pos-0077: Resultado = Vendas - CMV - Despesas.
    //   Custo do mes = CMV (cogs_month) + Despesas do mes
    // CMV = custo dos pneus efetivamente VENDIDOS no mes (nao o que foi comprado).
    // purchases_month (compras/reposicao) NAO entra aqui: e fluxo de caixa/compromisso,
    // nao custo de competencia do resultado.
    get totalCusts() {
      return this.num(this.resumo?.cogs_month) + this.num(this.resumo?.expenses_month);
    },

    get estimatedMargin() {
      const sales = this.num(this.resumo?.sales_month);
      if (sales <= 0) return 0;
      return (this.num(this.resumo?.estimated_result_month) / sales) * 100;
    },


    // 0076: saída FÍSICA realizada = pickup/balcão (baixa na hora) ou delivery
    // que chegou em 'delivered'. Delivery pending/dispatched só RESERVOU — o pneu
    // ainda não saiu; failed/cancelled também não são saída. Não conta como saída do mês.
    isPhysicalExitSale(sale) {
      if (!sale || sale.status === 'cancelled') return false;
      if (sale.fulfillment_mode === 'delivery') return sale.delivery_status === 'delivered';
      return true;
    },

    saleRealizedAt(sale) {
      if (!sale) return null;
      if (sale.fulfillment_mode === 'delivery') return sale.delivered_at || sale.created_at;
      return sale.created_at;
    },


    get financeOriginSplit() {
      const partnerUnits = this.salesUnitsFor(this.completedPartnerSales);
      const doorUnits = this.salesUnitsFor(this.completedDoorSales);
      const totalUnits = partnerUnits + doorUnits;
      const safeTotal = totalUnits || 1;
      return [
        { label: '2W', value: this.completedPartnerSalesTotal, count: partnerUnits, percent: Math.round((partnerUnits / safeTotal) * 100), color: '#047857' },
        { label: 'Porta', value: this.completedDoorSalesTotal, count: doorUnits, percent: Math.round((doorUnits / safeTotal) * 100), color: '#9ca3af' },
      ];
    },

    salesUnitsFor(sales) {
      return sales.reduce((sum, sale) => {
        const items = Array.isArray(sale.items) ? sale.items : [];
        const itemQty = items.reduce((itemSum, item) => itemSum + this.num(item.quantity), 0);
        return sum + (itemQty || 1);
      }, 0);
    },

    get financeUnitsSeries30d() {
      const days = [];
      const now = new Date();
      for (let i = 29; i >= 0; i -= 1) {
        const d = new Date(now);
        d.setDate(now.getDate() - i);
        days.push({
          key: this.dateKeySaoPaulo(d),
          label: d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: 'short' }).replace('.', ''),
          value: 0,
        });
      }
      for (const sale of this.completedSales) {
        const key = this.dateKeySaoPaulo(this.saleRealizedAt(sale));
        const day = days.find((d) => d.key === key);
        if (!day) continue;
        const items = Array.isArray(sale.items) ? sale.items : [];
        const qty = items.reduce((sum, item) => sum + this.num(item.quantity), 0);
        day.value += qty || 1;
      }
      return days;
    },

    get financeRevenueSeries30d() {
      const days = [];
      const now = new Date();
      for (let i = 29; i >= 0; i -= 1) {
        const d = new Date(now);
        d.setDate(now.getDate() - i);
        days.push({
          key: this.dateKeySaoPaulo(d),
          label: d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: 'short' }).replace('.', ''),
          value: 0,
        });
      }
      for (const sale of this.completedSales) {
        const key = this.dateKeySaoPaulo(this.saleRealizedAt(sale));
        const day = days.find((d) => d.key === key);
        if (day) day.value += this.num(sale.total_amount);
      }
      return days;
    },

    get payablesDetail() {
      return this.payables
        .filter((payable) => payable.status === 'open')
        .map((payable) => ({
          id: `payable-${payable.id}`,
          source_id: payable.id,
          raw: payable,
          type: 'Conta a pagar',
          title: payable.counterparty_name || payable.description,
          subtitle: this.payableCategoryLabel(payable.category),
          date: payable.due_date,
          amount: this.num(payable.amount),
        }))
        .filter((item) => item.amount > 0)
        .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    },

    get receivablesDetail() {
      return this.receivables
        .filter((receivable) => receivable.status === 'open')
        .map((receivable) => ({
          id: `receivable-${receivable.id}`,
          source_id: receivable.id,
          raw: receivable,
          type: this.sourceLabel(receivable.source_tag),
          title: receivable.customer_name || receivable.description,
          subtitle: receivable.description,
          date: receivable.due_date,
          amount: this.num(receivable.amount),
        }))
        .filter((item) => item.amount > 0)
        .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    },

    get payablesOpenTotal() {
      return this.payables
        .filter((payable) => payable.status === 'open')
        .reduce((sum, payable) => sum + this.num(payable.amount), 0);
    },

    // Despesas + contas do mes (regime de competencia).
    // Conforme docs/GUIA_INDICADORES_FINANCEIRO_PARCEIRO_2026-05-24.md: o
    // donut "Composicao dos custos" divide compras x despesas do MES, nao
    // payables em aberto cumulativos.
    get costExpensesCommitted() {
      return this.num(this.resumo?.expenses_month);
    },

    get receivablesOpenTotal() {
      return this.receivables
        .filter((receivable) => receivable.status === 'open')
        .reduce((sum, receivable) => sum + this.num(receivable.amount), 0);
    },

    get payablesPaidMonthTotal() {
      return this.payables
        .filter((payable) => payable.status === 'paid' && this.isCurrentMonth(payable.paid_at || payable.created_at))
        .reduce((sum, payable) => sum + this.num(payable.amount), 0);
    },

    get receivablesReceivedMonthTotal() {
      return this.receivables
        .filter((receivable) => receivable.status === 'received' && this.isCurrentMonth(receivable.received_at || receivable.created_at))
        .reduce((sum, receivable) => sum + this.num(receivable.amount), 0);
    },

    get purchaseTotalLabel() {
      return this.money(this.num(this.purchaseForm.quantity) * this.num(this.purchaseForm.unit_cost));
    },

    get financeCostSplit() {
      return [
        { label: 'Custo dos pneus vendidos', value: this.num(this.resumo?.cogs_month), color: '#7f8f83' },
        { label: 'Despesas/contas', value: this.costExpensesCommitted, color: '#dc3f4d' },
      ];
    },

    purchaseItemsLabel(purchase) {
      const items = Array.isArray(purchase.items) ? purchase.items : [];
      if (!items.length) return 'Itens da compra';
      return items.map((it) => `${it.quantity}x ${it.item_name}`).join(', ');
    },
});
