// Ajuste manual do galpão: compara o valor oficial anterior com a edição atual.
// Mantido separado do fluxo de entradas/baixas para o fiscal de módulos ≤300 linhas.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.galpaoAjuste = function () {
  return {
    stockAdjustmentChangesValue() {
      const form = this.stockForm || {};
      const originalQty = form.original_quantity_on_hand;
      const originalCost = form.original_unit_cost;
      if (originalQty == null || originalQty === '' || originalCost == null || originalCost === '') {
        return true;
      }
      const currentQty = Number(form.quantity_on_hand);
      const currentCostCents = Math.round((Number(form.unit_cost) || 0) * 100);
      return currentQty !== Number(originalQty)
        || currentCostCents !== Math.round((Number(originalCost) || 0) * 100);
    },
    stockAdjustmentImpact() {
      const form = this.stockForm || {};
      if (form.original_quantity_on_hand == null || form.original_quantity_on_hand === ''
          || form.original_unit_cost == null || form.original_unit_cost === '') {
        return null;
      }
      const quantityBefore = Number(form.original_quantity_on_hand);
      const costBefore = Number(form.original_unit_cost) || 0;
      const quantityAfter = Number(form.quantity_on_hand);
      const costAfter = Number(form.unit_cost) || 0;
      if (!Number.isFinite(quantityAfter) || !Number.isFinite(costAfter)) return null;
      return {
        quantityBefore, costBefore, quantityAfter, costAfter,
        valueBefore: quantityBefore * costBefore,
        valueAfter: quantityAfter * costAfter,
        valueDelta: (quantityAfter * costAfter) - (quantityBefore * costBefore),
      };
    },
  };
};
