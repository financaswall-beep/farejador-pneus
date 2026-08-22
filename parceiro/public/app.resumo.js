/**
 * app.resumo.js - fabrica `resumo` do painel do parceiro (obra <=300, passo 10/11).
 * MORA AQUI: as DERIVADAS da tela Resumo - avgTicket, filtros/contadores de cliente,
 * vendas concluidas (completedSales = regra 0077 de venda REALIZADA via helpers do
 * financeiro.kpis), recortes porta/2w, séries do resumo mobile/web e labels de
 * tendência/atualização.
 * NAO MORA AQUI: KPIs financeiros (app.financeiro.kpis.js); graficos
 * (app.charts.resumo.js); pedidos/entregas (app.pedidos.js / app.entregas.js).
 * VEIO DE: app.js commit 29e9817 (ranges 549-621, 932-961), VERBATIM.
 * REGRA: teto 300 (npm run checar-tamanho); `this` e o objeto unico de app.js.
 */
window.PARCEIRO_MODULES = window.PARCEIRO_MODULES || {};
window.PARCEIRO_MODULES.resumo = () => ({
    // â”€â”€â”€ DERIVADAS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    get avgTicket() {
      const orders = this.num(this.resumo?.orders_month);
      const sales = this.num(this.resumo?.sales_month);
      return orders > 0 ? sales / orders : 0;
    },

    get filteredCustomers() {
      const query = String(this.customerListSearch || '').trim().toLowerCase();
      const digits = query.replace(/\D/g, '');
      const list = Array.isArray(this.clientes) ? this.clientes : [];
      if (!query) return list;
      return list.filter((customer) => {
        const name = String(customer?.name || '').toLowerCase();
        const phone = String(customer?.phone || '').replace(/\D/g, '');
        const address = this.customerAddressLine(customer).toLowerCase();
        return name.includes(query)
          || (!!digits && phone.includes(digits))
          || address.includes(query);
      });
    },

    get customersWithPhoneCount() {
      return (this.clientes || []).filter((customer) => String(customer?.phone || '').trim()).length;
    },

    get customersWithAddressCount() {
      return (this.clientes || []).filter((customer) => this.customerAddressLine(customer) !== '-').length;
    },

    get identifiedSalesCount() {
      return this.completedSales.filter((sale) => sale.customer_id || sale.customer_name || sale.customer_phone || sale.customer_cpf).length;
    },


    get salesTodayCount() {
      const today = this.dateKeySaoPaulo(new Date());
      return this.completedSales.filter((sale) => this.dateKeySaoPaulo(this.saleRealizedAt(sale)) === today).length;
    },

    get activeSales() {
      return this.vendas.filter((sale) => sale.status !== 'cancelled');
    },

    // Venda realizada: pickup/balcão conta na criação; delivery só depois de entregue.
    // Delivery aberto é reserva + a receber, não venda concluída.
    get completedSales() {
      return this.activeSales
        .filter((sale) => this.isPhysicalExitSale(sale))
        .sort((a, b) => new Date(this.saleRealizedAt(b) || 0).getTime() - new Date(this.saleRealizedAt(a) || 0).getTime());
    },

    get completedPartnerSales() {
      return this.completedSales.filter((sale) => this.normalizeSource(sale.source_tag || sale.source) === '2w');
    },

    get completedDoorSales() {
      return this.completedSales.filter((sale) => this.normalizeSource(sale.source_tag || sale.source) === 'porta');
    },

    get completedPartnerSalesTotal() {
      return this.completedPartnerSales.reduce((sum, sale) => sum + this.num(sale.total_amount), 0);
    },

    get completedDoorSalesTotal() {
      return this.completedDoorSales.reduce((sum, sale) => sum + this.num(sale.total_amount), 0);
    },

    // Resumo mobile liberado pelo dono: o ranking usa faturamento bruto FINALIZADO no mês.
    // A API já devolve apenas vendas consolidadas no ledger de comissão; aqui só
    // ordenamos de forma explícita para a posição não depender do valor da comissão.
    get mobileSummaryTeam() {
      const rows = Array.isArray(this.commissionTeam?.rows) ? this.commissionTeam.rows : [];
      return [...rows]
        .sort((a, b) => {
          const byGross = this.num(b?.gross_sales) - this.num(a?.gross_sales);
          if (byGross) return byGross;
          const bySales = this.num(b?.finalized_sales) - this.num(a?.finalized_sales);
          if (bySales) return bySales;
          return String(a?.label || a?.username || '').localeCompare(
            String(b?.label || b?.username || ''),
            'pt-BR',
          );
        })
        .slice(0, 3);
    },

    get mobileSummaryTeamMaxGross() {
      return Math.max(0, ...this.mobileSummaryTeam.map((member) => this.num(member?.gross_sales)));
    },

    mobileSummaryTeamProgress(member) {
      const max = this.mobileSummaryTeamMaxGross;
      if (max <= 0) return 0;
      return Math.max(4, Math.round((this.num(member?.gross_sales) / max) * 100));
    },

    get mobileSummaryReceivablesOpenCount() {
      const rows = Array.isArray(this.receivables) ? this.receivables : [];
      return rows.filter((item) => item?.status === 'open').length;
    },

    get mobileSummaryPayablesDueTodayCount() {
      const today = this.dateKeySaoPaulo(new Date());
      const rows = Array.isArray(this.payables) ? this.payables : [];
      return rows.filter((item) => item?.status === 'open'
        && String(item?.due_date || '').slice(0, 10) === today).length;
    },

    // Resumo web: distribui as vendas realizadas do mês em cinco faixas de 7 dias.
    // Usa a mesma regra de realização do restante do painel (delivery só ao entregar).
    get desktopSummaryMonthWeeks() {
      const month = this.dateKeySaoPaulo(new Date()).slice(0, 7);
      const weeks = Array.from({ length: 5 }, (_, index) => ({
        label: `Semana ${index + 1}`,
        value: 0,
      }));
      for (const sale of this.completedSales) {
        const key = this.dateKeySaoPaulo(this.saleRealizedAt(sale));
        if (!key.startsWith(month)) continue;
        const day = Number(key.slice(8, 10));
        const index = Math.min(4, Math.max(0, Math.floor((day - 1) / 7)));
        weeks[index].value += this.num(sale.total_amount);
      }
      return weeks;
    },

    get desktopSummaryChartCoordinates() {
      const max = Math.max(1, ...this.desktopSummaryMonthWeeks.map((week) => week.value));
      return this.desktopSummaryMonthWeeks.map((week, index) => ({
        ...week,
        x: 28 + (index * 146),
        y: Math.round(152 - ((week.value / max) * 110)),
      }));
    },

    get desktopSummaryChartPoints() {
      return this.desktopSummaryChartCoordinates.map((point) => `${point.x},${point.y}`).join(' ');
    },

    get desktopSummaryChartArea() {
      const points = this.desktopSummaryChartCoordinates;
      if (!points.length) return '';
      return `M ${points[0].x} 160 L ${points.map((point) => `${point.x} ${point.y}`).join(' L ')} L ${points[points.length - 1].x} 160 Z`;
    },

    desktopSummarySaleLabel(sale) {
      const items = Array.isArray(sale?.items) ? sale.items : [];
      const first = items[0] || {};
      const label = first.tire_size || first.item_name || 'Venda registrada';
      return items.length > 1 ? `${label} + ${items.length - 1} item(ns)` : label;
    },

    openMobileSummaryTeam() {
      this.configTab = 'equipe';
      this.goToSection('config');
    },

    get partnerSalesShareLabel() {
      const total = this.completedSales.length;
      if (!total) return 'sem vendas ainda';
      return `${Math.round((this.completedPartnerSales.length / total) * 100)}% das vendas`;
    },

    get salesSeries7d() {
      const days = [];
      const today = window.FarejadorTime.businessDate();
      for (let i = 6; i >= 0; i -= 1) {
        const key = window.FarejadorTime.addDays(today, -i);
        days.push({
          key,
          label: window.FarejadorTime.formatDate(key).slice(0, 5),
          value: 0,
        });
      }
      for (const sale of this.vendas) {
        if (!this.isPhysicalExitSale(sale)) continue;
        const key = this.dateKeySaoPaulo(this.saleRealizedAt(sale));
        const day = days.find((d) => d.key === key);
        if (day) day.value += this.num(sale.total_amount);
      }
      return days;
    },

    get trendBadgeLabel() {
      const total = this.salesSeries7d.reduce((s, d) => s + d.value, 0);
      return total > 0 ? `${this.money(total)} em 7d` : 'sem dados';
    },

    get lastUpdatedLabel() {
      if (!this.lastUpdatedAt) return 'Aguardando atualização';
      return `Atualizado ${window.FarejadorTime.formatDateTime(this.lastUpdatedAt)}`;
    },
});
