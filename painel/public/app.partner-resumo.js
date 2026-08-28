// Resumo simples da unidade. Totais financeiros chegam prontos do servidor;
// o navegador apenas apresenta cards, alertas, série diária e atalhos permitidos.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.partnerResumo = function () {
  let movementChart = null;
  const periods = new Set(['today', '7d', 'month']);
  const eventMeta = Object.freeze({
    sale: { label: 'Venda', icon: 'shopping-cart', cls: 'bg-emerald-50 text-emerald-700' },
    purchase: { label: 'Compra', icon: 'package-plus', cls: 'bg-sky-50 text-sky-700' },
    pickup: { label: 'Retirada', icon: 'package-check', cls: 'bg-amber-50 text-amber-700' },
    delivery: { label: 'Entrega', icon: 'truck', cls: 'bg-amber-50 text-amber-700' },
    expense: { label: 'Despesa', icon: 'circle-dollar-sign', cls: 'bg-rose-50 text-rose-700' },
  });
  return {
    partnerResumoData: null,
    partnerResumoAlerts: [],
    partnerResumoLoading: false,
    partnerResumoError: '',
    partnerResumoUpdatedAt: null,
    partnerResumoPeriod: 'month',
    partnerResumoRequest: 0,

    async loadPartnerResumo() {
      if (!this.isPartnerPanel() || !this.hasPanelModule('resumo')) return;
      const request = ++this.partnerResumoRequest;
      const startedAt = performance.now();
      this.partnerResumoLoading = true;
      this.partnerResumoError = '';
      const period = periods.has(this.partnerResumoPeriod) ? this.partnerResumoPeriod : 'month';
      const resource = period === 'month' ? 'resumo' : `resumo?period=${period}`;
      const [summary, notices] = await Promise.allSettled([
        this.partnerApiGet(resource), this.partnerApiGet('operacao/notificacoes'),
      ]);
      if (request !== this.partnerResumoRequest) return;
      if (summary.status === 'fulfilled') {
        this.partnerResumoData = summary.value.rows?.[0] || null;
        this.partnerResumoUpdatedAt = new Date().toISOString();
      } else {
        this.partnerResumoData = null;
        this.partnerResumoError = 'Não foi possível carregar o resumo da unidade.';
      }
      this.partnerResumoAlerts = notices.status === 'fulfilled'
        && Array.isArray(notices.value.notifications) ? notices.value.notifications : [];
      const primaryError = summary.status === 'rejected' ? summary.reason : null;
      void this.partnerPanelTelemetry({
        page: 'resumo', event_type: 'read', operation: 'load_summary',
        outcome: primaryError ? 'error' : 'success',
        status_code: primaryError?.status || null,
        duration_ms: Math.round(performance.now() - startedAt),
        error_code: primaryError ? this.partnerPanelErrorCode(primaryError) : null,
      });
      this.partnerResumoLoading = false;
      this.$nextTick(() => {
        lucide.createIcons();
        this.renderPartnerResumoChart();
      });
    },

    async partnerResumoSetPeriod(period) {
      if (!periods.has(period) || this.partnerResumoLoading) return;
      this.partnerResumoPeriod = period;
      await this.loadPartnerResumo();
    },

    partnerResumoNumber(value) {
      const number = Number(value);
      return Number.isFinite(number) ? number : 0;
    },

    get partnerResumoHasPendingCost() {
      return this.partnerResumoNumber(this.partnerResumoData?.pending_cost_items_month) > 0;
    },

    get partnerResumoRecentEvents() {
      return Array.isArray(this.partnerResumoData?.recent_events)
        ? this.partnerResumoData.recent_events : [];
    },

    get partnerResumoAttentionRows() {
      const rows = Array.isArray(this.partnerResumoAlerts)
        ? this.partnerResumoAlerts.map((row) => ({ ...row })) : [];
      const hasKind = (kind) => rows.some((row) => row.kind === kind);
      if (!hasKind('stock') && this.partnerResumoNumber(this.partnerResumoData?.low_stock_items) > 0) {
        const count = this.partnerResumoNumber(this.partnerResumoData.low_stock_items);
        rows.push({ kind: 'stock', target: 'stock', priority: 'normal',
          title: `${count} ${count === 1 ? 'item está' : 'itens estão'} com estoque baixo` });
      }
      if (this.partnerResumoHasPendingCost) {
        const count = this.partnerResumoNumber(this.partnerResumoData.pending_cost_items_month);
        rows.push({ kind: 'cost', target: 'finance', priority: 'attention',
          title: `${count} ${count === 1 ? 'item está' : 'itens estão'} sem custo confirmado` });
      }
      return rows.slice(0, 4);
    },

    partnerResumoPeriodLabel() {
      return ({ today: 'Hoje', '7d': 'Últimos 7 dias', month: 'Mês atual' })[
        this.partnerResumoPeriod
      ] || 'Mês atual';
    },

    partnerResumoEventMeta(kind) {
      return eventMeta[kind] || eventMeta.sale;
    },

    partnerResumoEventDate(value) {
      if (!value) return '—';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '—';
      return new Intl.DateTimeFormat('pt-BR', {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
        timeZone: 'America/Sao_Paulo',
      }).format(date);
    },

    partnerResumoAlertPage(alert) {
      return ({ stock: 'estoque', deliveries: 'logistica', finance: 'financeiro' })[
        alert?.target
      ] || null;
    },

    partnerResumoGo(page, action = null) {
      if (!this.panelPageEnabled(page)) return;
      this.currentPage = page;
      this.$nextTick(() => {
        if (action && typeof this[action] === 'function') this[action]();
        lucide.createIcons();
      });
    },

    renderPartnerResumoChart() {
      if (typeof document === 'undefined' || typeof Chart === 'undefined') return;
      const canvas = document.getElementById('partnerResumoMovementChart');
      if (!canvas || !this.isPartnerPanel()) return;
      if (movementChart) movementChart.destroy();
      const rows = Array.isArray(this.partnerResumoData?.movement_series)
        ? this.partnerResumoData.movement_series : [];
      const money = (value) => this.formatCurrency(Number(value || 0));
      movementChart = new Chart(canvas, {
        type: 'bar',
        data: {
          labels: rows.map((row) => new Intl.DateTimeFormat('pt-BR', {
            day: '2-digit', month: '2-digit', timeZone: 'UTC',
          }).format(new Date(`${row.day}T12:00:00Z`))),
          datasets: [
            { label: 'Faturamento', data: rows.map((row) => Number(row.total || 0)),
              backgroundColor: 'rgba(22,163,74,.22)', borderRadius: 5, yAxisID: 'money' },
            { type: 'line', label: 'Vendas concluídas', data: rows.map((row) => Number(row.orders || 0)),
              borderColor: '#065f46', backgroundColor: '#065f46', pointRadius: 2,
              pointHoverRadius: 5, tension: .35, borderWidth: 2.5, yAxisID: 'orders' },
          ],
        },
        options: {
          responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
          plugins: { legend: { position: 'top', align: 'start', labels: { usePointStyle: true } },
            tooltip: { callbacks: { label: (item) => item.dataset.yAxisID === 'money'
              ? ` Faturamento: ${money(item.raw)}` : ` Vendas: ${item.raw}` } } },
          scales: {
            x: { grid: { display: false } },
            money: { beginAtZero: true, ticks: { callback: (value) => money(value) } },
            orders: { beginAtZero: true, position: 'right', grid: { drawOnChartArea: false },
              ticks: { precision: 0 } },
          },
        },
      });
    },
  };
};
