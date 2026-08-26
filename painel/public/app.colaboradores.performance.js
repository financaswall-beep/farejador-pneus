// Desempenho operacional da equipe. A mesma apresentação atende Matriz e parceiro,
// mas cada escopo lê sua própria API autorizada; nenhum cálculo de folha nasce aqui.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.colaboradoresPerformance = function () {
  const emptyPayload = () => ({
    period_start: '', period_end: '', unit_name: '', collaborators: [], daily: [],
    summary: {
      sales_count: 0, revenue: 0, margin: 0, installations_count: 0, deliveries_count: 0,
      commission_total: 0, commission_collaborators: 0, unassigned_sales: 0,
      waiting_pickups: 0, commission_review_count: 0, missing_cost_items: 0,
    },
  });
  const money = (value) => Math.round(Number(value || 0) * 100) / 100;
  const shift = (value, days) => {
    const [year, month, day] = String(value).split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
  };
  return {
    teamPerformance: {
      payload: emptyPayload(), range: 'month', workArea: 'all', collaboratorId: 'all',
      loading: false, error: null, request: 0, loadedScope: null, hoverIndex: -1,
    },

    async loadTeamPerformance(force = false) {
      const state = this.teamPerformance;
      const scope = this.isPartnerPanel() ? 'partner' : 'matrix';
      if (!force && state.loadedScope === scope && state.payload?.period_start) return;
      const request = ++state.request;
      state.loading = true;
      state.error = null;
      try {
        const payload = scope === 'partner'
          ? await this.partnerApiGet(`equipe/desempenho?range=${encodeURIComponent(state.range)}`)
          : await this.apiGet(`/admin/api/colaboradores/desempenho?range=${encodeURIComponent(state.range)}`);
        if (request !== state.request) return;
        state.payload = payload || emptyPayload();
        state.loadedScope = scope;
        if (state.collaboratorId !== 'all'
            && !state.payload.collaborators.some((row) => row.id === state.collaboratorId)) {
          state.collaboratorId = 'all';
        }
      } catch (_) {
        if (request === state.request) state.error = 'Não foi possível carregar o desempenho da equipe.';
      } finally {
        if (request === state.request) state.loading = false;
        this.$nextTick(() => window.lucide && window.lucide.createIcons());
      }
    },
    async teamPerformanceSetRange(range) {
      if (!['7d', '30d', 'month'].includes(range)) return;
      this.teamPerformance.range = range;
      this.teamPerformance.loadedScope = null;
      await this.loadTeamPerformance(true);
    },
    teamPerformanceRows() {
      const state = this.teamPerformance;
      return (state.payload.collaborators || []).filter((row) => (
        (state.workArea === 'all' || row.work_area === state.workArea)
        && (state.collaboratorId === 'all' || row.id === state.collaboratorId)
      ));
    },
    teamPerformanceWorkAreas() {
      return [...new Set((this.teamPerformance.payload.collaborators || [])
        .map((row) => row.work_area).filter(Boolean))];
    },
    teamPerformanceAreaLabel(area) {
      return ({ sales: 'Comercial', delivery: 'Logística', stock: 'Estoque', workshop: 'Oficina',
        administrative: 'Administrativo', other: 'Outras funções' })[area] || 'Outras funções';
    },
    teamPerformanceSummary() {
      const rows = this.teamPerformanceRows();
      const source = this.teamPerformance.payload.summary || {};
      return rows.reduce((acc, row) => ({
        ...acc,
        sales_count: acc.sales_count + Number(row.sales_count || 0),
        revenue: money(acc.revenue + Number(row.revenue || 0)),
        margin: money(acc.margin + Number(row.margin || 0)),
        installations_count: acc.installations_count + Number(row.installations_count || 0),
        deliveries_count: acc.deliveries_count + Number(row.deliveries_count || 0),
        commission_total: money(acc.commission_total + Number(row.commission_amount || 0)),
        commission_collaborators: acc.commission_collaborators + (Number(row.commission_amount || 0) !== 0 ? 1 : 0),
        missing_cost_items: acc.missing_cost_items + Number(row.missing_cost_items || 0),
      }), {
        sales_count: 0, revenue: 0, margin: 0, installations_count: 0, deliveries_count: 0,
        commission_total: 0, commission_collaborators: 0, missing_cost_items: 0,
        unassigned_sales: Number(source.unassigned_sales || 0),
        waiting_pickups: Number(source.waiting_pickups || 0),
        commission_review_count: Number(source.commission_review_count || 0),
      });
    },
    teamPerformanceMarginRate() {
      const summary = this.teamPerformanceSummary();
      return summary.revenue > 0 ? Math.round(summary.margin * 1000 / summary.revenue) / 10 : 0;
    },
    teamPerformanceDays() {
      const payload = this.teamPerformance.payload || {};
      if (!payload.period_start || !payload.period_end) return [];
      const selected = new Set(this.teamPerformanceRows().map((row) => row.id));
      const values = new Map();
      for (let date = payload.period_start; date < payload.period_end; date = shift(date, 1)) {
        values.set(date, { date, sales_count: 0, installations_count: 0 });
      }
      for (const item of payload.daily || []) {
        if (!selected.has(item.collaborator_id) || !values.has(item.date)) continue;
        const day = values.get(item.date);
        day.sales_count += Number(item.sales_count || 0);
        day.installations_count += Number(item.installations_count || 0);
      }
      return [...values.values()];
    },
    teamPerformanceChartMax() {
      return Math.max(1, ...this.teamPerformanceDays()
        .flatMap((row) => [Number(row.sales_count || 0), Number(row.installations_count || 0)]));
    },
    teamPerformanceChartX(index) {
      const total = Math.max(this.teamPerformanceDays().length - 1, 1);
      return 34 + (index * 652 / total);
    },
    teamPerformanceChartY(value) {
      return 190 - (Number(value || 0) * 150 / this.teamPerformanceChartMax());
    },
    teamPerformanceLinePoints() {
      return this.teamPerformanceDays().map((row, index) => (
        `${this.teamPerformanceChartX(index)},${this.teamPerformanceChartY(row.sales_count)}`
      )).join(' ');
    },
    teamPerformanceAxisLabels() {
      const days = this.teamPerformanceDays();
      if (!days.length) return [];
      const step = Math.max(1, Math.ceil(days.length / 6));
      return days.map((row, index) => ({ ...row, index }))
        .filter((row, index) => index === 0 || index === days.length - 1 || index % step === 0);
    },
    teamPerformanceDateLabel(value) {
      const [, month, day] = String(value || '').split('-');
      return day && month ? `${day}/${month}` : '—';
    },
    teamPerformanceInitials(row) {
      return String(row?.name || '?').trim().split(/\s+/).slice(0, 2)
        .map((part) => part.charAt(0).toUpperCase()).join('') || '?';
    },
    teamPerformanceHoverDay() {
      const days = this.teamPerformanceDays();
      return days[this.teamPerformance.hoverIndex] || null;
    },
    teamPerformanceHighlights() {
      const rows = this.teamPerformanceRows();
      const candidates = [
        { label: 'Vendas', metric: 'revenue', row: [...rows].sort((a, b) => b.revenue - a.revenue)[0] },
        { label: 'Instalações', metric: 'installations', row: [...rows].sort((a, b) => b.installations_count - a.installations_count)[0] },
        { label: 'Logística', metric: 'deliveries', row: [...rows].sort((a, b) => b.deliveries_count - a.deliveries_count)[0] },
      ];
      return candidates.filter((item) => item.row && (
        item.metric === 'revenue' ? item.row.revenue > 0
          : item.metric === 'installations' ? item.row.installations_count > 0
            : item.row.deliveries_count > 0
      ));
    },
    teamPerformanceHighlightValue(item) {
      if (item.metric === 'revenue') return `${item.row.sales_count} venda(s) · ${this.formatCurrency(item.row.revenue)}`;
      if (item.metric === 'installations') return `${item.row.installations_count} instalação(ões)`;
      return `${item.row.deliveries_count} entrega(s)`;
    },
    teamPerformanceCommercialRows() {
      return this.teamPerformanceRows().filter((row) => row.work_area === 'sales' || row.sales_count > 0)
        .sort((a, b) => b.revenue - a.revenue);
    },
    teamPerformanceOperationalRows() {
      return this.teamPerformanceRows().filter((row) => row.work_area !== 'sales'
        || row.installations_count > 0 || row.deliveries_count > 0)
        .sort((a, b) => (b.installations_count + b.deliveries_count)
          - (a.installations_count + a.deliveries_count));
    },
    teamPerformancePeriodLabel() {
      return ({ '7d': 'últimos 7 dias', '30d': 'últimos 30 dias', month: 'mês atual' })[this.teamPerformance.range];
    },
  };
};
