window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.comprasReposicao = function () {
  const number = (value) => Math.max(0, Number(value) || 0);
  const ageDays = (value) => value
    ? Math.floor((Date.now() - new Date(value).getTime()) / 86400000) : Infinity;
  return {
    comprasReplenishmentKey(row) {
      return [String(row.measure || '').trim().toLowerCase(), row.tire_condition].join('\0');
    },
    comprasReplenishmentPriceGroups(priceRows) {
      const groups = new Map();
      for (const row of priceRows || []) {
        const cost = number(row.avg_cost);
        if (!cost || row.supplier_archived) continue;
        const key = this.comprasReplenishmentKey(row);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
      }
      for (const rows of groups.values()) {
        rows.sort((a, b) => number(a.avg_cost) - number(b.avg_cost));
      }
      return groups;
    },
    comprasReplenishmentBestPrices(priceRows) {
      return new Map([...this.comprasReplenishmentPriceGroups(priceRows)]
        .map(([key, rows]) => [key, rows[0]]));
    },
    comprasReplenishmentStockGroups(stockRows) {
      const groups = new Map();
      for (const stock of stockRows || []) {
        const key = this.comprasReplenishmentKey(stock);
        if (!groups.has(key)) groups.set(key, {
          measure: stock.measure, tire_condition: stock.tire_condition,
          quantity_available: 0, in_transit_quantity: 0, sales_30d: 0,
          min_quantity: null, brands: [],
        });
        const group = groups.get(key);
        group.quantity_available += number(this.measureAvailable(stock));
        group.in_transit_quantity += number(stock.in_transit_quantity);
        group.sales_30d += number(stock.sales_30d);
        if (stock.min_quantity != null) {
          group.min_quantity = Math.max(number(group.min_quantity), number(stock.min_quantity));
        }
        if (!group.brands.includes(stock.brand)) group.brands.push(stock.brand);
      }
      for (const group of groups.values()) group.brands.sort((a, b) => a.localeCompare(b));
      return [...groups.values()];
    },
    comprasReplenishmentMissingMinimum(stockRows) {
      return this.comprasReplenishmentStockGroups(stockRows)
        .filter((row) => row.min_quantity == null).length;
    },
    comprasReplenishmentBuild(stockRows, priceRows) {
      const prices = this.comprasReplenishmentPriceGroups(priceRows);
      return this.comprasReplenishmentStockGroups(stockRows).map((stock) => {
        const available = number(stock.quantity_available);
        const minimum = stock.min_quantity;
        const inTransit = number(stock.in_transit_quantity);
        const suggested = minimum == null
          ? 0 : Math.max(0, Math.ceil(minimum - available - inTransit));
        const references = prices.get(this.comprasReplenishmentKey(stock)) || [];
        const best = references[0] || null;
        const alternative = references.find((row) => row.supplier_id !== best?.supplier_id) || null;
        const cost = best ? number(best.avg_cost) : null;
        const brand = best?.brand || stock.brands[0] || '';
        return {
          ...stock, brand, recommended_brand: brand,
          brand_summary: stock.brands.join(', '), quantity_available: available,
          min_quantity: minimum,
          in_transit_quantity: inTransit, suggested_quantity: suggested,
          planned_quantity: suggested, selected: suggested > 0,
          supplier_id: best?.supplier_id || null,
          supplier_name: best?.supplier_name || null,
          historical_unit_cost: cost,
          estimated_amount: cost == null ? null : cost * suggested,
          supplier_purchases_count: number(best?.purchases_count || best?.purchase_count),
          reference_last_purchased_at: best?.last_purchased_at || null,
          alternative_supplier_name: alternative?.supplier_name || null,
          alternative_unit_cost: alternative ? number(alternative.avg_cost) : null,
        };
      }).filter((row) => row.suggested_quantity > 0)
        .sort((a, b) => (a.quantity_available === 0 ? 0 : 1)
          - (b.quantity_available === 0 ? 0 : 1)
          || number(b.sales_30d) - number(a.sales_30d)
          || this.comprasReplenishmentKey(a).localeCompare(this.comprasReplenishmentKey(b)));
    },
    async comprasGenerateReplenishment() {
      const previous = this.comprasReplenishment || {};
      previous.loading = true;
      previous.error = null;
      const period = ['30d', '90d', 'year', 'all'].includes(previous.period)
        ? previous.period : 'all';
      try {
        const [stockPayload, pricePayload] = await Promise.all([
          this.apiGet('/admin/api/wholesale/stock'),
          this.apiGet(`/admin/api/wholesale/suppliers/prices?period=${period}`),
        ]);
        const stockRows = stockPayload.rows || [];
        this.atacadoStock = stockRows;
        this.comprasReplenishment = {
          ...previous, rows: this.comprasReplenishmentBuild(stockRows, pricePayload.rows || []),
          generatedAt: new Date().toISOString(), loading: false, error: null,
          noMinimum: this.comprasReplenishmentMissingMinimum(stockRows), period,
        };
      } catch (error) {
        previous.loading = false;
        previous.error = error?.message || 'Não foi possível gerar o relatório.';
      } finally {
        this.$nextTick(() => window.lucide && window.lucide.createIcons());
      }
    },
    comprasReplenishmentVisibleRows() {
      const state = this.comprasReplenishment || {};
      const search = String(state.search || '').trim().toLowerCase();
      const condition = state.condition || 'all';
      return (state.rows || []).filter((row) => {
        if (condition !== 'all' && row.tire_condition !== condition) return false;
        if (state.onlyCompetition && !row.alternative_supplier_name) return false;
        return !search || `${row.measure} ${row.brand_summary} ${row.recommended_brand} ${row.supplier_name || ''}`
          .toLowerCase().includes(search);
      });
    },
    comprasReplenishmentSelectedRows() {
      return this.comprasReplenishmentVisibleRows()
        .filter((row) => row.selected && number(row.planned_quantity) > 0);
    },
    comprasReplenishmentAllVisibleSelected() {
      const rows = this.comprasReplenishmentVisibleRows();
      return rows.length > 0 && rows.every((row) => row.selected);
    },
    comprasReplenishmentToggleVisible(selected) {
      for (const row of this.comprasReplenishmentVisibleRows()) row.selected = !!selected;
    },
    comprasReplenishmentSetQuantity(row, value) {
      row.planned_quantity = Math.min(100000, Math.max(1, Math.round(number(value) || 1)));
    },
    comprasReplenishmentSummary() {
      const rows = this.comprasReplenishmentSelectedRows();
      return {
        variants: rows.length,
        measures: rows.length,
        tires: rows.reduce((sum, row) => sum + number(row.planned_quantity), 0),
        transit: rows.reduce((sum, row) => sum + number(row.in_transit_quantity), 0),
        estimated: rows.reduce((sum, row) => sum
          + number(row.historical_unit_cost) * number(row.planned_quantity), 0),
        savings: rows.reduce((sum, row) => sum + Math.max(0,
          number(row.alternative_unit_cost) - number(row.historical_unit_cost))
          * number(row.planned_quantity), 0),
        suppliers: new Set(rows.filter((row) => row.supplier_id)
          .map((row) => row.supplier_id)).size,
        withoutSupplier: rows.filter((row) => !row.supplier_id).length,
      };
    },
    comprasReplenishmentSuppliers() {
      const groups = new Map();
      for (const row of this.comprasReplenishmentSelectedRows()) {
        const key = row.supplier_id || 'sem-referencia';
        if (!groups.has(key)) groups.set(key, {
          key, supplier_id: row.supplier_id,
          supplier_name: row.supplier_name || 'Sem referência histórica',
          rows: [], quantity: 0, estimated: 0, incomplete: false,
        });
        const group = groups.get(key);
        group.rows.push(row);
        group.quantity += number(row.planned_quantity);
        group.estimated += number(row.historical_unit_cost) * number(row.planned_quantity);
        if (row.historical_unit_cost == null) group.incomplete = true;
      }
      return [...groups.values()].sort((a, b) => b.quantity - a.quantity);
    },
    comprasReplenishmentConfidence(row) {
      if (!row.supplier_id) return { label: 'Sem histórico', css: 'bg-gray-100 text-gray-600' };
      if (ageDays(row.reference_last_purchased_at) > 180) {
        return { label: 'Preço antigo', css: 'bg-gray-100 text-gray-600' };
      }
      if (number(row.supplier_purchases_count) >= 3) {
        return { label: 'Alta', css: 'bg-emerald-100 text-emerald-800' };
      }
      return { label: 'Média', css: 'bg-emerald-50 text-emerald-700' };
    },
    comprasReplenishmentCondition(value) {
      return typeof this.catalogoConditionLabel === 'function'
        ? this.catalogoConditionLabel(value)
        : ({ meia_vida: 'Meia-vida', novo: 'Novo', remold: 'Remold' }[value]
          || String(value || ''));
    },
    comprasReplenishmentText() {
      const summary = this.comprasReplenishmentSummary();
      const generated = this.comprasReplenishment.generatedAt
        ? this.formatDateTime(this.comprasReplenishment.generatedAt) : 'agora';
      const lines = ['*PLANO DE REPOSIÇÃO — FAREJADOR*', `Gerado em ${generated}`,
        `Comprar: ${summary.tires} pneu(s) em ${summary.measures} medida(s)`, ''];
      for (const group of this.comprasReplenishmentSuppliers()) {
        lines.push(`*${group.supplier_name}*`);
        for (const row of group.rows) {
          lines.push(`• ${row.planned_quantity}x ${row.measure} · ${this.comprasReplenishmentCondition(row.tire_condition)}`);
          lines.push(`  Marca sugerida: ${row.recommended_brand || 'a definir'}`);
          lines.push(`  Disponível ${row.quantity_available} | Mínimo ${row.min_quantity} | Em trânsito ${row.in_transit_quantity}`);
          lines.push(row.historical_unit_cost == null
            ? '  Sem preço histórico — cotar antes de comprar'
            : `  Referência histórica: ${this.formatCurrency(row.historical_unit_cost)}/un`);
        }
        lines.push('');
      }
      lines.push(`Estimativa histórica: ${this.formatCurrency(summary.estimated)}`);
      lines.push('Confirme preços, disponibilidade e frete antes de fechar a compra.');
      return lines.join('\n');
    },
    comprasShareReplenishment() {
      if (!this.comprasReplenishmentSelectedRows().length) {
        this.comprasReplenishment.error = 'Selecione ao menos um item antes de abrir o WhatsApp.';
        return null;
      }
      const url = `https://wa.me/?text=${encodeURIComponent(this.comprasReplenishmentText())}`;
      window.open(url, '_blank', 'noopener,noreferrer');
      return url;
    },
    comprasExportReplenishment() {
      const rows = this.comprasReplenishmentSelectedRows();
      if (!rows.length) return;
      const safe = (value) => {
        const text = String(value ?? '');
        const guarded = /^[=+@-]/.test(text) ? `'${text}` : text;
        return `"${guarded.replaceAll('"', '""')}"`;
      };
      const csv = [['Medida', 'Condição', 'Marcas no estoque', 'Marca sugerida', 'Estoque', 'Mínimo', 'Giro 30d',
        'Comprar', 'Fornecedor', 'Preço unitário', 'Subtotal']]
        .concat(rows.map((row) => [row.measure,
          this.comprasReplenishmentCondition(row.tire_condition), row.brand_summary,
          row.recommended_brand, row.quantity_available,
          row.min_quantity, number(row.sales_30d), row.planned_quantity,
          row.supplier_name || 'A cotar', row.historical_unit_cost ?? '',
          row.historical_unit_cost == null ? ''
            : number(row.historical_unit_cost) * number(row.planned_quantity)]));
      const blob = new Blob(['\uFEFF' + csv.map((line) => line.map(safe).join(';')).join('\n')],
        { type: 'text/csv;charset=utf-8' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `plano-reposicao-${window.FarejadorTime.businessDate()}.csv`;
      link.click();
      URL.revokeObjectURL(link.href);
    },
    comprasReplenishmentOpenPurchase(group) {
      if (!group?.supplier_id || !group.rows?.length) return;
      const rows = group.rows.map((row) => ({ ...row,
        suggested_quantity: row.planned_quantity }));
      this.repoAbrirCompra(rows);
      if (this.adminUser?.role === 'owner' && this.compraForm?.items?.length) {
        this.compraForm.supplierKey = group.supplier_id;
        this.compraMsg = { ok: true,
          text: `Plano de ${group.supplier_name} preparado. Confirme os preços atuais, o frete e o recebimento.` };
      }
    },
  };
};
