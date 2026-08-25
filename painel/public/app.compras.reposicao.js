window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.comprasReposicao = function () {
  const number = (value) => Math.max(0, Number(value) || 0);
  return {
    comprasReplenishmentBestPrices(priceRows) {
      const best = new Map();
      for (const row of priceRows || []) {
        const cost = number(row.avg_cost);
        if (!cost || row.supplier_archived) continue;
        const key = this.stockVariantKey(row);
        const current = best.get(key);
        if (!current || cost < number(current.avg_cost)) best.set(key, row);
      }
      return best;
    },
    comprasReplenishmentBuild(stockRows, priceRows) {
      const best = this.comprasReplenishmentBestPrices(priceRows);
      return (stockRows || []).map((stock) => {
        const available = this.measureAvailable(stock) ?? 0;
        const minimum = stock.min_quantity == null ? null : number(stock.min_quantity);
        const inTransit = number(stock.in_transit_quantity);
        const suggested = minimum == null
          ? 0 : Math.max(0, Math.ceil(minimum - available - inTransit));
        const reference = best.get(this.stockVariantKey(stock)) || null;
        const historicalCost = reference ? number(reference.avg_cost) : null;
        return {
          ...stock, quantity_available: available, min_quantity: minimum,
          in_transit_quantity: inTransit, suggested_quantity: suggested,
          supplier_id: reference?.supplier_id || null,
          supplier_name: reference?.supplier_name || null,
          historical_unit_cost: historicalCost,
          estimated_amount: historicalCost == null ? null : historicalCost * suggested,
          reference_last_purchased_at: reference?.last_purchased_at || null,
        };
      }).filter((row) => row.suggested_quantity > 0)
        .sort((a, b) => {
          const zeroA = a.quantity_available === 0 ? 0 : 1;
          const zeroB = b.quantity_available === 0 ? 0 : 1;
          return zeroA - zeroB || number(b.sales_30d) - number(a.sales_30d)
            || this.stockVariantKey(a).localeCompare(this.stockVariantKey(b));
        });
    },
    async comprasGenerateReplenishment() {
      this.comprasReplenishment.loading = true;
      this.comprasReplenishment.error = null;
      try {
        const [stockPayload, pricePayload] = await Promise.all([
          this.apiGet('/admin/api/wholesale/stock'),
          this.apiGet('/admin/api/wholesale/suppliers/prices?period=all'),
        ]);
        const stockRows = stockPayload.rows || [];
        this.atacadoStock = stockRows;
        this.comprasReplenishment = {
          rows: this.comprasReplenishmentBuild(stockRows, pricePayload.rows || []),
          generatedAt: new Date().toISOString(), loading: false, error: null,
          noMinimum: stockRows.filter((row) => row.min_quantity == null).length,
        };
      } catch (error) {
        this.comprasReplenishment.loading = false;
        this.comprasReplenishment.error = error?.message || 'Não foi possível gerar o relatório.';
      } finally {
        this.$nextTick(() => window.lucide && window.lucide.createIcons());
      }
    },
    comprasReplenishmentSummary() {
      const rows = this.comprasReplenishment.rows || [];
      return {
        variants: rows.length,
        tires: rows.reduce((sum, row) => sum + number(row.suggested_quantity), 0),
        transit: rows.reduce((sum, row) => sum + number(row.in_transit_quantity), 0),
        estimated: rows.reduce((sum, row) => sum + number(row.estimated_amount), 0),
        withoutSupplier: rows.filter((row) => !row.supplier_id).length,
      };
    },
    comprasReplenishmentSuppliers() {
      const groups = new Map();
      for (const row of this.comprasReplenishment.rows || []) {
        const key = row.supplier_id || 'sem-referencia';
        if (!groups.has(key)) groups.set(key, {
          key, supplier_id: row.supplier_id, supplier_name: row.supplier_name || 'Sem referência histórica',
          rows: [], quantity: 0, estimated: 0, incomplete: false,
        });
        const group = groups.get(key);
        group.rows.push(row);
        group.quantity += number(row.suggested_quantity);
        group.estimated += number(row.estimated_amount);
        if (row.estimated_amount == null) group.incomplete = true;
      }
      return [...groups.values()].sort((a, b) => {
        if (!a.supplier_id) return 1;
        if (!b.supplier_id) return -1;
        return a.supplier_name.localeCompare(b.supplier_name);
      });
    },
    comprasReplenishmentCondition(value) {
      if (typeof this.catalogoConditionLabel === 'function') {
        return this.catalogoConditionLabel(value);
      }
      return { meia_vida: 'Meia-vida', novo: 'Novo', remold: 'Remold' }[value]
        || String(value || '');
    },
    comprasReplenishmentText() {
      const summary = this.comprasReplenishmentSummary();
      const generated = this.comprasReplenishment.generatedAt
        ? this.formatDateTime(this.comprasReplenishment.generatedAt) : 'agora';
      const lines = [
        '*PLANO DE REPOSIÇÃO — FAREJADOR*', `Gerado em ${generated}`,
        `Comprar: ${summary.tires} pneu(s) em ${summary.variants} variante(s)`, '',
      ];
      for (const group of this.comprasReplenishmentSuppliers()) {
        lines.push(`*${group.supplier_name}*`);
        for (const row of group.rows) {
          const identity = `${row.brand} ${row.measure} · ${this.comprasReplenishmentCondition(row.tire_condition)}`;
          lines.push(`• ${row.suggested_quantity}x ${identity}`);
          lines.push(`  Disponível ${row.quantity_available} | Mínimo ${row.min_quantity} | Em trânsito ${row.in_transit_quantity}`);
          lines.push(row.historical_unit_cost == null
            ? '  Sem preço histórico — cotar antes de comprar'
            : `  Referência histórica: ${this.formatCurrency(row.historical_unit_cost)}/un`);
        }
        lines.push('');
      }
      lines.push(`Estimativa histórica: ${this.formatCurrency(summary.estimated)}`);
      if (summary.withoutSupplier) lines.push(`${summary.withoutSupplier} variante(s) ainda precisam de cotação.`);
      lines.push('Confirme preços, disponibilidade e frete antes de fechar a compra.');
      return lines.join('\n');
    },
    comprasShareReplenishment() {
      if (!this.comprasReplenishment.rows?.length) {
        this.comprasReplenishment.error = 'Gere um relatório com itens antes de abrir o WhatsApp.';
        return null;
      }
      const url = 'https://wa.me/?text=' + encodeURIComponent(this.comprasReplenishmentText());
      window.open(url, '_blank', 'noopener,noreferrer');
      return url;
    },
    comprasReplenishmentOpenPurchase(group) {
      if (!group?.supplier_id || !group.rows?.length) return;
      this.repoAbrirCompra(group.rows);
      if (this.adminUser?.role === 'owner' && this.compraForm?.items?.length) {
        this.compraForm.supplierKey = group.supplier_id;
        this.compraMsg = {
          ok: true,
          text: `Plano de ${group.supplier_name} preparado. Confirme os preços atuais, o frete e o recebimento.`,
        };
      }
    },
  };
};
