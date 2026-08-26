window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.comprasPrecos = function () {
  const colors = ['#047857', '#65a30d', '#64748b', '#0f766e', '#166534'];
  const validDate = (value) => {
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : null;
  };

  return {
    comprasPriceVisibleGroups() {
      const query = String(this.comprasPriceVariantSearch || '').trim().toLowerCase();
      if (!query) return this.comprasPriceGroups();
      return this.comprasPriceGroups().filter((group) => [
        group.measure, group.brand, group.tire_condition,
        this.catalogoConditionLabel(group.tire_condition),
      ].filter(Boolean).join(' ').toLowerCase().includes(query));
    },
    comprasPriceHistoryDate(value) {
      return value ? window.FarejadorTime.formatDate(value) : '—';
    },
    comprasPriceHistoryChart() {
      const selected = this.comprasPriceSelected();
      const rawSeries = (selected?.suppliers || []).map((supplier, index) => ({
        supplier_id: supplier.supplier_id,
        supplier_name: supplier.supplier_name,
        color: colors[index % colors.length],
        points: (supplier.history || []).map((row) => ({
          supplier_id: supplier.supplier_id,
          supplier_name: supplier.supplier_name,
          color: colors[index % colors.length],
          date: row.purchased_at,
          time: validDate(row.purchased_at),
          cost: Number(row.unit_cost || 0),
          quantity: Number(row.quantity || 0),
          purchase_id: row.purchase_id,
        })).filter((point) => point.time !== null && point.cost >= 0)
          .sort((a, b) => a.time - b.time),
      })).filter((series) => series.points.length > 0);
      const points = rawSeries.flatMap((series) => series.points);
      if (!points.length) return { empty: true, series: [], ticks: [], labels: [] };

      const minTime = Math.min(...points.map((point) => point.time));
      const maxTime = Math.max(...points.map((point) => point.time));
      const rawMinCost = Math.min(...points.map((point) => point.cost));
      const rawMaxCost = Math.max(...points.map((point) => point.cost));
      const costPadding = rawMaxCost === rawMinCost ? Math.max(1, rawMaxCost * 0.1) : 0;
      const minCost = Math.max(0, rawMinCost - costPadding);
      const maxCost = rawMaxCost + costPadding;
      const xAt = (time) => 54 + ((time - minTime) / Math.max(1, maxTime - minTime)) * 626;
      const yAt = (cost) => 142 - ((cost - minCost) / Math.max(1, maxCost - minCost)) * 116;
      const series = rawSeries.map((item) => {
        const chartPoints = item.points.map((point) => ({
          ...point, x: xAt(point.time), y: yAt(point.cost),
        }));
        return {
          ...item,
          points: chartPoints,
          path: chartPoints.map((point, index) =>
            `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' '),
        };
      });
      const ticks = Array.from({ length: 4 }, (_, index) => {
        const ratio = index / 3;
        return { y: 142 - ratio * 116, value: minCost + ratio * (maxCost - minCost) };
      });
      return {
        empty: false, series, ticks,
        labels: [
          { x: 54, value: this.comprasPriceHistoryDate(new Date(minTime)) },
          { x: 680, value: this.comprasPriceHistoryDate(new Date(maxTime)) },
        ],
      };
    },
  };
};
