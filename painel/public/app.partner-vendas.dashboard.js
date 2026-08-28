// Apresentação e indicadores da tela de Vendas da unidade. Os totais são
// derivados somente das vendas devolvidas pelo mesmo endpoint do /operacao.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.partnerVendasDashboard = function () {
  let salesChart = null;
  const periods = new Set(['today', '7d', 'month']);
  return {
    partnerVendasDateKey(value) {
      const date = value instanceof Date ? value : new Date(value);
      if (Number.isNaN(date.getTime())) return '';
      return new Intl.DateTimeFormat('en-CA', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        timeZone: 'America/Sao_Paulo',
      }).format(date);
    },

    partnerVendasPeriodStart() {
      const now = new Date();
      if (this.partnerVendas.period === 'today') return this.partnerVendasDateKey(now);
      if (this.partnerVendas.period === '7d') {
        const start = new Date(now);
        start.setDate(start.getDate() - 6);
        return this.partnerVendasDateKey(start);
      }
      const parts = this.partnerVendasDateKey(now).split('-');
      return `${parts[0]}-${parts[1]}-01`;
    },

    partnerVendasRowsInPeriod() {
      const start = this.partnerVendasPeriodStart();
      return this.partnerVendas.rows.filter(
        (row) => this.partnerVendasDateKey(row.created_at) >= start,
      );
    },

    partnerVendasSetPeriod(period) {
      if (!periods.has(period)) return;
      this.partnerVendas.period = period;
      this.partnerVendas.page = 1;
      this.$nextTick(() => this.renderPartnerVendasChart());
    },

    partnerVendasSetFilter(filter) {
      this.partnerVendas.filtro = filter;
      this.partnerVendas.page = 1;
    },

    partnerVendasPeriodLabel() {
      return ({ today: 'Hoje', '7d': 'Últimos 7 dias', month: 'Mês atual' })[
        this.partnerVendas.period
      ] || 'Mês atual';
    },

    get partnerVendasRealizedRows() {
      return this.partnerVendasRowsInPeriod().filter((row) => this.partnerVendasIsRealized(row));
    },

    get partnerVendasMetrics() {
      const realized = this.partnerVendasRealizedRows;
      const revenue = realized.reduce((sum, row) => sum + Number(row.total_amount || 0), 0);
      const received = realized.reduce((sum, row) => sum + Math.min(
        Number(row.total_amount || 0), Number(row.received_amount || 0),
      ), 0);
      const tires = realized.reduce((sum, row) => sum + (row.items || []).reduce(
        (itemSum, item) => itemSum + Number(item.quantity || 0), 0,
      ), 0);
      return {
        revenue, received, orders: realized.length, tires,
        average: realized.length ? revenue / realized.length : 0,
        receivable: Math.max(0, revenue - received),
      };
    },

    get partnerVendasStatusSummary() {
      const summary = { confirmed: 0, pickup: 0, delivery: 0, cancelled: 0 };
      for (const row of this.partnerVendasRowsInPeriod()) {
        if (row.status === 'cancelled') summary.cancelled += 1;
        else if (row.awaiting_pickup) summary.pickup += 1;
        else if (row.fulfillment_mode === 'delivery' && row.delivery_status !== 'delivered') {
          summary.delivery += 1;
        } else summary.confirmed += 1;
      }
      return summary;
    },

    partnerVendasStatusClass(row) {
      if (row.status === 'cancelled') return 'bg-rose-50 text-rose-700';
      if (this.partnerVendasIsPending(row)) return 'bg-amber-50 text-amber-700';
      return 'bg-emerald-50 text-emerald-800';
    },

    partnerVendasOrderDate(value) {
      if (!value) return '—';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '—';
      return new Intl.DateTimeFormat('pt-BR', {
        day: '2-digit', month: '2-digit', year: '2-digit',
        hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo',
      }).format(date);
    },

    partnerVendasItemsLabel(row) {
      const items = Array.isArray(row.items) ? row.items : [];
      if (!items.length) return 'Itens não informados';
      const first = items[0];
      const label = [first.tire_size, first.brand, first.item_name].filter(Boolean).join(' · ');
      return items.length > 1 ? `${label} +${items.length - 1}` : label;
    },

    partnerVendasPaymentLabel(row) {
      const method = String(row.payment_method || '').trim();
      if (method) return method;
      if (Number(row.received_amount || 0) < Number(row.total_amount || 0)) return 'A receber';
      return '—';
    },

    partnerVendasFulfillmentLabel(row) {
      return row.fulfillment_mode === 'delivery' ? 'Entrega' : 'Retirada';
    },

    partnerVendasChartRows() {
      const now = new Date();
      const start = new Date(now);
      if (this.partnerVendas.period === '7d') start.setDate(start.getDate() - 6);
      else if (this.partnerVendas.period === 'month') start.setDate(1);
      const totals = new Map();
      for (const row of this.partnerVendasRealizedRows) {
        const day = this.partnerVendasDateKey(row.created_at);
        const current = totals.get(day) || { revenue: 0, received: 0 };
        current.revenue += Number(row.total_amount || 0);
        current.received += Math.min(Number(row.total_amount || 0), Number(row.received_amount || 0));
        totals.set(day, current);
      }
      const rows = [];
      const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 12);
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
      while (cursor <= end) {
        const day = this.partnerVendasDateKey(cursor);
        rows.push({ day, ...(totals.get(day) || { revenue: 0, received: 0 }) });
        cursor.setDate(cursor.getDate() + 1);
      }
      return rows;
    },

    renderPartnerVendasChart() {
      if (typeof document === 'undefined' || typeof Chart === 'undefined') return;
      const canvas = document.getElementById('partnerVendasChart');
      if (!canvas || !this.isPartnerPanel()) return;
      if (salesChart) salesChart.destroy();
      const rows = this.partnerVendasChartRows();
      const money = (value) => this.formatCurrency(Number(value || 0));
      salesChart = new Chart(canvas, {
        type: 'bar',
        data: {
          labels: rows.map((row) => row.day.slice(8, 10) + '/' + row.day.slice(5, 7)),
          datasets: [
            { label: 'Vendas realizadas', data: rows.map((row) => row.revenue),
              backgroundColor: 'rgba(22,163,74,.22)', borderColor: '#16a34a',
              borderWidth: 1, borderRadius: 5 },
            { type: 'line', label: 'Recebido', data: rows.map((row) => row.received),
              borderColor: '#0369a1', backgroundColor: '#0369a1', pointRadius: 2,
              pointHoverRadius: 5, tension: .35, borderWidth: 2.5 },
          ],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { position: 'top', align: 'start', labels: { usePointStyle: true } },
            tooltip: { callbacks: { label: (item) => ` ${item.dataset.label}: ${money(item.raw)}` } },
          },
          scales: {
            x: { grid: { display: false } },
            y: { beginAtZero: true, ticks: { callback: (value) => money(value) } },
          },
        },
      });
    },
  };
};
