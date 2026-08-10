/**
 * app.resumo.js - fabrica `resumo` do painel do parceiro (obra <=300, passo 10/11).
 * MORA AQUI: as DERIVADAS da tela Resumo - avgTicket, filtros/contadores de cliente,
 * vendas concluidas (completedSales = regra 0077 de venda REALIZADA via helpers do
 * financeiro.kpis), recortes porta/2w, salesTodayCount, serie de 7 dias
 * (salesSeries7d) e labels de tendencia/atualizacao.
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

    // Resumo mobile do dono: o ranking usa faturamento bruto FINALIZADO no mês.
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
      const now = new Date();
      for (let i = 6; i >= 0; i -= 1) {
        const d = new Date(now);
        d.setDate(now.getDate() - i);
        days.push({
          key: this.dateKeySaoPaulo(d),
          label: d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' }),
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
      return `Atualizado ${this.lastUpdatedAt.toLocaleString('pt-BR')}`;
    },
});
