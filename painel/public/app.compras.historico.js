window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.comprasHistorico = function () {
  const nullableNumber = (value) => value === null || value === undefined ? null : Number(value);
  const summaryOf = (analytics) => {
    const row = analytics?.summary || {};
    return {
      purchases: Number(row.purchases_count || 0),
      committed: Number(row.total_committed || 0),
      paid: Number(row.paid_amount || 0),
      open: Number(row.open_amount || 0),
      tires: Number(row.tires || 0),
      received: Number(row.received_tires || 0),
      transit: Number(row.in_transit_tires || 0),
      suppliers: Number(row.active_suppliers || 0),
      average: Number(row.average_cost || 0),
      previousAverage: nullableNumber(row.previous_average_cost),
      averageChange: nullableNumber(row.average_change_pct),
      minimum: nullableNumber(row.minimum_item_cost),
      maximum: nullableNumber(row.maximum_item_cost),
    };
  };
  const timelineOf = (analytics) => Array.isArray(analytics?.timeline) ? analytics.timeline : [];
  const chartPoint = (rows, row, index, field, width, height) => {
    const padX = 34; const padY = 20;
    const max = Math.max(1, ...rows.map((item) => Number(item[field] || 0)));
    const x = rows.length <= 1 ? width / 2
      : padX + (index * (width - padX * 2)) / (rows.length - 1);
    const y = height - padY - (Number(row?.[field] || 0) / max) * (height - padY * 2);
    return { x, y };
  };
  const chartPoints = (rows, field, width, height) => rows.map((row, index) => {
    const point = chartPoint(rows, row, index, field, width, height);
    return `${point.x},${point.y}`;
  }).join(' ');
  const chartArea = (rows, field, width, height) => {
    if (!rows.length) return '';
    const baseline = height - 20;
    const first = chartPoint(rows, rows[0], 0, field, width, height);
    const last = chartPoint(rows, rows.at(-1), rows.length - 1, field, width, height);
    return `${first.x},${baseline} ${chartPoints(rows, field, width, height)} ${last.x},${baseline}`;
  };
  const tickRows = (rows) => {
    if (rows.length <= 4) return rows.map((row, index) => ({ row, index }));
    const indexes = [0, Math.floor((rows.length - 1) / 3),
      Math.floor(((rows.length - 1) * 2) / 3), rows.length - 1];
    return [...new Set(indexes)].map((index) => ({ row: rows[index], index }));
  };
  const periodLabel = (period) => ({ '30d': 'últimos 30 dias', '90d': 'últimos 90 dias',
    year: 'este ano', all: 'todo o histórico' })[period] || 'período selecionado';
  const averageChangeLabel = (summary) => {
    const value = summary.averageChange;
    if (value === null) return 'Sem período anterior comparável';
    if (value === 0) return 'Sem alteração frente ao período anterior';
    return `${value > 0 ? '↑' : '↓'} ${Math.abs(value).toLocaleString('pt-BR', {
      minimumFractionDigits: 1, maximumFractionDigits: 1,
    })}% frente ao período anterior`;
  };

  return {
    comprasHistoryPageNumbers() {
      const current = Number(this.comprasHistory.pagination?.page || 1);
      const pages = Number(this.comprasHistory.pagination?.pages || 1);
      const start = Math.max(1, Math.min(current - 2, pages - 4));
      return Array.from({ length: Math.min(5, pages) }, (_, index) => start + index);
    },
    comprasHistoryPage(page) {
      if (page < 1 || page > Number(this.comprasHistory.pagination?.pages || 1)) return;
      this.comprasHistoryFilters.page = page;
      void this.loadComprasHistory();
    },
    comprasHistorySummary() { return summaryOf(this.comprasHistoryAnalytics); },
    comprasCostSummary() { return summaryOf(this.comprasCost.analytics); },
    comprasHistoryPeriodLabel() { return periodLabel(this.comprasHistoryFilters.period); },
    comprasCostPeriodLabel() { return periodLabel(this.comprasCost.filters.period); },
    comprasSupplierLabel(supplierId) {
      if (!supplierId) return 'Todos os fornecedores';
      return this.fornecedores.find((row) => row.id === supplierId)?.name
        || 'Fornecedor selecionado';
    },
    comprasHistorySupplierLabel() {
      return this.comprasSupplierLabel(this.comprasHistoryFilters.supplierId);
    },
    comprasCostSupplierLabel() { return this.comprasSupplierLabel(this.comprasCost.filters.supplierId); },
    comprasHistoryAverageChangeLabel() {
      return averageChangeLabel(this.comprasHistorySummary());
    },
    comprasCostAverageChangeLabel() { return averageChangeLabel(this.comprasCostSummary()); },
    comprasHistoryTimeline() { return timelineOf(this.comprasHistoryAnalytics); },
    comprasCostTimeline() { return timelineOf(this.comprasCost.analytics); },
    comprasHistoryTimelineLabel(row) {
      if (!row?.bucket) return '—';
      return new Date(`${row.bucket}T12:00:00`).toLocaleDateString('pt-BR', {
        day: '2-digit', month: 'short',
      }).replace('.', '');
    },
    comprasHistoryChartPoint(row, index, field, width = 1000, height = 220) {
      return chartPoint(this.comprasHistoryTimeline(), row, index, field, width, height);
    },
    comprasHistoryChartPoints(field, width = 1000, height = 220) {
      return chartPoints(this.comprasHistoryTimeline(), field, width, height);
    },
    comprasHistoryChartArea(field, width = 1000, height = 220) {
      return chartArea(this.comprasHistoryTimeline(), field, width, height);
    },
    comprasCostChartPoint(row, index, field = 'average_cost', width = 1000, height = 240) {
      return chartPoint(this.comprasCostTimeline(), row, index, field, width, height);
    },
    comprasCostChartPoints(field = 'average_cost', width = 1000, height = 240) {
      return chartPoints(this.comprasCostTimeline(), field, width, height);
    },
    comprasCostChartArea(field = 'average_cost', width = 1000, height = 240) {
      return chartArea(this.comprasCostTimeline(), field, width, height);
    },
    comprasHistoryReceiptBar(row, index, width = 1000, height = 220) {
      const rows = this.comprasHistoryTimeline();
      const max = Math.max(1, ...rows.map((item) => Number(item.received_tires || 0)));
      const point = chartPoint(rows, row, index, 'total_committed', width, height);
      const barHeight = (Number(row?.received_tires || 0) / max) * 110;
      const barWidth = Math.max(7, Math.min(20, 500 / Math.max(1, rows.length)));
      return { x: point.x - barWidth / 2, y: height - 20 - barHeight,
        width: barWidth, height: barHeight };
    },
    comprasHistoryTickRows() { return tickRows(this.comprasHistoryTimeline()); },
    comprasCostTickRows() { return tickRows(this.comprasCostTimeline()); },
    comprasHistoryHoveredRow() {
      return this.comprasHistoryTimeline()[Number(this.comprasHistoryHoverIndex)] || null;
    },
    comprasHistoryHoverStyle() {
      const rows = this.comprasHistoryTimeline();
      const index = Number(this.comprasHistoryHoverIndex || 0);
      const raw = rows.length <= 1 ? 50 : 3.4 + (index * 93.2) / (rows.length - 1);
      return `left:${Math.max(10, Math.min(90, raw))}%`;
    },
    comprasHistoryHoverDetail(row) {
      if (!row) return '';
      const received = Number(row.received_tires || 0);
      const transit = Math.max(0, Number(row.tires || 0) - received);
      return [received ? `${received} recebido${received === 1 ? '' : 's'}` : '',
        transit ? `${transit} em trânsito` : ''].filter(Boolean).join(' · ') || 'Sem pneus no período';
    },
    comprasCostQuery() {
      const filters = this.comprasCost.filters;
      const query = new URLSearchParams({ period: filters.period, status: 'all',
        payment: 'all', page: '1', page_size: '10' });
      if (filters.supplierId) query.set('supplier_id', filters.supplierId);
      return query.toString();
    },
    async loadComprasCostAnalysis() {
      this.comprasCost.loading = true; this.comprasCost.error = null;
      try {
        this.comprasCost.analytics = await this.apiGet(
          '/admin/api/wholesale/purchases/analytics?' + this.comprasCostQuery(),
        );
      } catch (error) {
        this.comprasCost.error = error.message;
      } finally {
        this.comprasCost.loading = false;
      }
    },
    comprasOpenCostDialog() {
      this.comprasCost.filters = { period: this.comprasHistoryFilters.period,
        supplierId: this.comprasHistoryFilters.supplierId };
      this.comprasCostDialogOpen = true;
      void this.loadComprasCostAnalysis();
      this.$nextTick(() => window.lucide && window.lucide.createIcons());
    },
    comprasCloseCostDialog() { this.comprasCostDialogOpen = false; },
  };
};
