// Contagem física auditável do estoque oficial da Matriz.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.galpaoContagem = function () {
  return {
    async loadStockReconciliation() {
      if (window.PAINEL_STOCK_PREVIEW?.enabled()) {
        this.stockReconciliation.loading = false;
        this.stockReconciliation.error = null;
        this.stockReconciliation.summary = { ...window.PAINEL_STOCK_PREVIEW.reconciliation.summary };
        this.stockReconciliation.rows = window.PAINEL_STOCK_PREVIEW.reconciliation.rows
          .map((row) => ({ ...row, counted_quantity: '' }));
        return;
      }
      this.stockReconciliation.loading = true;
      this.stockReconciliation.error = null;
      try {
        const report = await this.apiGet('/admin/api/wholesale/stock/reconciliation');
        this.stockReconciliation.summary = report.summary || null;
        this.stockReconciliation.rows = (report.rows || [])
          .map((row) => ({ ...row, counted_quantity: '' }));
      } catch (err) {
        this.stockReconciliation.error = err instanceof Error ? err.message : String(err);
      } finally {
        this.stockReconciliation.loading = false;
      }
    },
    reconciliationStatusText(status) {
      const labels = {
        aligned: 'Alinhado', quantity_divergent: 'Saldo diferente', catalog_only: 'SÃ³ no catÃ¡logo legado',
        official_only: 'SÃ³ no estoque oficial', official_ambiguous: 'Cadastro oficial duplicado',
        official_cost_missing: 'Custo oficial ausente',
      };
      return labels[status] || status;
    },
    stockCountDifference(row) {
      if (row.counted_quantity === '' || row.counted_quantity == null) return null;
      const counted = Number(row.counted_quantity);
      return Number.isInteger(counted) ? counted - Number(row.official_quantity || 0) : null;
    },
    stockCountSummary() {
      const counted = this.stockReconciliation.rows.filter((row) =>
        row.counted_quantity !== '' && row.counted_quantity != null);
      return {
        counted: counted.length,
        divergent: counted.filter((row) => this.stockCountDifference(row) !== 0).length,
        gains: counted.reduce((sum, row) => Math.max(0, this.stockCountDifference(row) || 0) + sum, 0),
        losses: counted.reduce((sum, row) => Math.max(0, -(this.stockCountDifference(row) || 0)) + sum, 0),
      };
    },
    stockCountClear() {
      for (const row of this.stockReconciliation.rows) row.counted_quantity = '';
      this.stockCount.reason = '';
      this.stockCount.message = null;
    },
    async stockCountApply() {
      if (this.stockCount.saving) return;
      const rows = this.stockReconciliation.rows
        .filter((row) => row.official_quantity != null
          && row.counted_quantity !== '' && row.counted_quantity != null)
        .map((row) => ({
          measure: row.official_measures[0] || row.key,
          brand: row.official_brand,
          counted_quantity: Number(row.counted_quantity),
        }));
      if (!rows.length || rows.some((row) =>
        !Number.isInteger(row.counted_quantity) || row.counted_quantity < 0)) {
        this.stockCount.message = { ok: false, text: 'Preencha ao menos uma contagem com número inteiro e zero ou mais.' };
        return;
      }
      if (String(this.stockCount.reason || '').trim().length < 2) {
        this.stockCount.message = { ok: false, text: 'Informe quem contou ou o motivo desta contagem.' };
        return;
      }
      const keyTarget = rows.map((row) =>
        `${row.measure}:${row.brand}:${row.counted_quantity}`).join('|');
      const operation = window.PAINEL_INTEGRITY.operation('stock-physical-count', keyTarget);
      this.stockCount.saving = true;
      this.stockCount.message = null;
      try {
        const result = await this.apiPost('/admin/api/wholesale/stock/physical-count', {
          rows, reason: this.stockCount.reason.trim(), idempotency_key: operation.key,
        });
        window.PAINEL_INTEGRITY.complete('stock-physical-count', keyTarget);
        this.stockCount.message = {
          ok: true,
          text: `${result.checked} variante(s) conferida(s), ${result.changed} ajustada(s). Ganhos: ${result.gains}; perdas: ${result.losses}.`,
        };
        await Promise.allSettled([
          this.loadAtacado(), this.loadStockReconciliation(), this.loadGalpaoFilme(),
          this.loadFinanceiro(),
        ]);
      } catch (err) {
        this.stockCount.message = { ok: false, text: `Não consegui aplicar a contagem (${err.message}).` };
      } finally {
        this.stockCount.saving = false;
      }
    },
  };
};
