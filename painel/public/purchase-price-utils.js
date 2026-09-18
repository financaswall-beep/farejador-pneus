(function () {
  'use strict';
  const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
  const key = row => [normalize(row.measure), normalize(row.brand), row.tire_condition || '', row.vehicle_type || 'unknown'].join('|');
  const cents = value => Math.round(Number(value) * 100);
  const conditions = { novo: 'Novo', meia_vida: 'Meia-vida', remold: 'Remold' };
  function groups(source) {
    const grouped = new Map();
    for (const row of source || []) {
      if (row.avg_cost == null || !Number.isFinite(Number(row.avg_cost)) || Number(row.avg_cost) < 0 || !(Number(row.qty_total) > 0)) continue;
      const variant = key(row);
      if (!grouped.has(variant)) grouped.set(variant, []);
      grouped.get(variant).push({ ...row });
    }
    return [...grouped.entries()].map(([variant, rows]) => {
      rows.sort((a, b) => cents(a.avg_cost) - cents(b.avg_cost) || String(a.supplier_name).localeCompare(String(b.supplier_name)));
      const best = cents(rows[0].avg_cost);
      rows.forEach(row => {
        row.cheapest = cents(row.avg_cost) === best;
        row.diff_pct = best > 0 ? (cents(row.avg_cost) - best) / best * 100 : cents(row.avg_cost) === 0 ? 0 : null;
      });
      return { variant_key: variant, measure: rows[0].measure, brand: rows[0].brand,
        tire_condition: rows[0].tire_condition, vehicle_type: rows[0].vehicle_type || null,
        suppliers: rows, qty: rows.reduce((sum, row) => sum + Number(row.qty_total || 0), 0) };
    }).sort((a, b) => b.qty - a.qty || String(a.measure).localeCompare(String(b.measure)));
  }
  function filter(source, filters = {}) {
    const query = normalize(filters.query).replace(/[^a-z0-9]/g, '');
    return source.filter(group => (!filters.brand || group.brand === filters.brand)
      && (!filters.condition || group.tire_condition === filters.condition)
      && (!query || normalize([group.measure, group.brand, conditions[group.tire_condition]].join(' ')).replace(/[^a-z0-9]/g, '').includes(query)));
  }
  function cards(source, selectedKey, rawQuantity, supplierId) {
    const suppliers = source.find(group => group.variant_key === selectedKey)?.suppliers || [];
    const best = suppliers.find(row => row.supplier_id === supplierId) || suppliers[0] || null;
    const alternative = suppliers.find(row => row.supplier_id !== best?.supplier_id) || null;
    const quantity = Math.min(100000, Math.max(1, Math.round(Number(rawQuantity) || 1)));
    const difference = alternative && best ? (cents(alternative.avg_cost) - cents(best.avg_cost)) / 100 : 0;
    return { variants: source.length, compared: source.filter(g => g.suppliers.length > 1).length,
      withoutCompetition: source.filter(g => g.suppliers.length < 2).length, suppliers: suppliers.length,
      best, alternative, quantity, difference, total: best ? cents(best.avg_cost) * quantity / 100 : 0,
      savings: Math.round(difference * 100) * quantity / 100 };
  }
  function chart(group, formatDate, width = 720, height = 180) {
    const colors = ['#00624e', '#838c31', '#9098a3', '#227c9d', '#a76c51'];
    const left = 54, right = width - 40, top = 26, bottom = height - 38;
    const raw = (group?.suppliers || []).map((supplier, index) => ({
      supplier_id: supplier.supplier_id, supplier_name: supplier.supplier_name, color: colors[index % colors.length],
      points: (supplier.history || []).filter(row => row.purchased_at && row.unit_cost != null && Number.isFinite(Number(row.unit_cost)) && Number(row.unit_cost) >= 0 && Number(row.quantity) > 0)
        .map(row => ({ ...row, supplier_id: supplier.supplier_id, supplier_name: supplier.supplier_name,
          color: colors[index % colors.length], date: row.purchased_at, time: new Date(row.purchased_at).getTime(),
          cost: Number(row.unit_cost), quantity: Number(row.quantity) }))
        .filter(point => Number.isFinite(point.time)).sort((a, b) => a.time - b.time),
    })).filter(series => series.points.length);
    const points = raw.flatMap(series => series.points);
    if (!points.length) return { empty: true, series: [], ticks: [], labels: [], width, height, left, right, bottom };
    const minTime = Math.min(...points.map(p => p.time)), maxTime = Math.max(...points.map(p => p.time));
    const low = Math.min(...points.map(p => p.cost)), high = Math.max(...points.map(p => p.cost));
    const padding = low === high ? Math.max(1, high * .1) : 0;
    const minCost = Math.max(0, low - padding), maxCost = high + padding;
    const x = time => minTime === maxTime ? (left + right) / 2 : left + (time - minTime) / (maxTime - minTime) * (right - left);
    const y = cost => bottom - (cost - minCost) / Math.max(1, maxCost - minCost) * (bottom - top);
    return { empty: false, width, height, left, right, bottom,
      series: raw.map(series => { const mapped = series.points.map(p => ({ ...p, x: x(p.time), y: y(p.cost) }));
        return { ...series, points: mapped, path: mapped.map((p, i) => `${i ? 'L' : 'M'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ') }; }),
      ticks: Array.from({ length: 4 }, (_, i) => ({ y: bottom - i / 3 * (bottom - top), value: minCost + i / 3 * (maxCost - minCost) })),
      labels: minTime === maxTime ? [{ x: (left + right) / 2, value: formatDate(new Date(minTime)) }]
        : [{ x: left, value: formatDate(new Date(minTime)) }, { x: right, value: formatDate(new Date(maxTime)) }],
    };
  }
  window.PurchasePriceUtils = Object.freeze({ key, groups, filter, cards, chart });
}());
