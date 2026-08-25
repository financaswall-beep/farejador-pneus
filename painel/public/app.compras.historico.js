window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.comprasHistorico = function () {
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
    comprasHistorySummary() {
      const row = this.comprasHistoryAnalytics?.summary || {};
      const nullable = (value) => value === null || value === undefined ? null : Number(value);
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
        previousAverage: nullable(row.previous_average_cost),
        averageChange: nullable(row.average_change_pct),
        minimum: nullable(row.minimum_item_cost),
        maximum: nullable(row.maximum_item_cost),
      };
    },
    comprasHistoryPeriodLabel() {
      return ({ '30d': 'últimos 30 dias', '90d': 'últimos 90 dias',
        year: 'este ano', all: 'todo o histórico' })[this.comprasHistoryFilters.period]
        || 'período selecionado';
    },
    comprasHistorySupplierLabel() {
      if (!this.comprasHistoryFilters.supplierId) return 'Todos os fornecedores';
      return this.fornecedores.find((row) => row.id === this.comprasHistoryFilters.supplierId)?.name
        || 'Fornecedor selecionado';
    },
    comprasHistoryAverageChangeLabel() {
      const value = this.comprasHistorySummary().averageChange;
      if (value === null) return 'Sem período anterior comparável';
      if (value === 0) return 'Sem alteração frente ao período anterior';
      return `${value > 0 ? '↑' : '↓'} ${Math.abs(value).toLocaleString('pt-BR', {
        minimumFractionDigits: 1, maximumFractionDigits: 1,
      })}% frente ao período anterior`;
    },
    comprasHistoryTimeline() {
      return Array.isArray(this.comprasHistoryAnalytics?.timeline)
        ? this.comprasHistoryAnalytics.timeline : [];
    },
    comprasHistoryTimelineLabel(row) {
      if (!row?.bucket) return '—';
      return new Date(`${row.bucket}T12:00:00`).toLocaleDateString('pt-BR', {
        day: '2-digit', month: 'short',
      }).replace('.', '');
    },
    comprasHistoryChartPoint(row, index, field, width = 1000, height = 220) {
      const rows = this.comprasHistoryTimeline();
      const padX = 34; const padY = 20;
      const values = rows.map((item) => Number(item[field] || 0));
      const max = Math.max(1, ...values);
      const x = rows.length <= 1 ? width / 2
        : padX + (index * (width - padX * 2)) / (rows.length - 1);
      const y = height - padY - (Number(row?.[field] || 0) / max) * (height - padY * 2);
      return { x, y };
    },
    comprasHistoryChartPoints(field, width = 1000, height = 220) {
      return this.comprasHistoryTimeline().map((row, index) => {
        const point = this.comprasHistoryChartPoint(row, index, field, width, height);
        return `${point.x},${point.y}`;
      }).join(' ');
    },
    comprasHistoryChartArea(field, width = 1000, height = 220) {
      const rows = this.comprasHistoryTimeline();
      if (!rows.length) return '';
      const baseline = height - 20;
      const first = this.comprasHistoryChartPoint(rows[0], 0, field, width, height);
      const last = this.comprasHistoryChartPoint(rows.at(-1), rows.length - 1, field, width, height);
      return `${first.x},${baseline} ${this.comprasHistoryChartPoints(field, width, height)} ${last.x},${baseline}`;
    },
    comprasHistoryReceiptBar(row, index, width = 1000, height = 220) {
      const rows = this.comprasHistoryTimeline();
      const max = Math.max(1, ...rows.map((item) => Number(item.received_tires || 0)));
      const point = this.comprasHistoryChartPoint(row, index, 'total_committed', width, height);
      const barHeight = (Number(row?.received_tires || 0) / max) * 110;
      const barWidth = Math.max(7, Math.min(20, 500 / Math.max(1, rows.length)));
      return { x: point.x - barWidth / 2, y: height - 20 - barHeight,
        width: barWidth, height: barHeight };
    },
    comprasHistoryTickRows() {
      const rows = this.comprasHistoryTimeline();
      if (rows.length <= 4) return rows.map((row, index) => ({ row, index }));
      const indexes = [0, Math.floor((rows.length - 1) / 3),
        Math.floor(((rows.length - 1) * 2) / 3), rows.length - 1];
      return [...new Set(indexes)].map((index) => ({ row: rows[index], index }));
    },
    comprasOpenCostDialog() {
      this.comprasCostDialogOpen = true;
      this.$nextTick(() => window.lucide && window.lucide.createIcons());
    },
    comprasCloseCostDialog() { this.comprasCostDialogOpen = false; },
  };
};
