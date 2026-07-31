// Correção auditada: transfere quantidade entre condições sem reescrever histórico.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.galpaoCorrecao = function () {
  return {
    stockConditionCorrectionOpen(row) {
      this.stockConditionCorrection = {
        open: true,
        measure: row.measure,
        brand: row.brand,
        from_condition: row.tire_condition,
        to_condition: '',
        quantity: '',
        available: Number(row.quantity_on_hand) || 0,
        reason: '',
        idempotency_key: '',
        saving: false,
      };
      this.stockMsg = null;
    },
    stockConditionCorrectionClose() {
      this.stockConditionCorrection = {
        open: false, measure: '', brand: '', from_condition: '',
        to_condition: '', quantity: '', available: 0, reason: '',
        idempotency_key: '', saving: false,
      };
    },
    stockConditionCorrectionOptions() {
      const current = this.stockConditionCorrection.from_condition;
      return [
        { value: 'meia_vida', label: 'Meia-vida' },
        { value: 'novo', label: 'Novo' },
        { value: 'remold', label: 'Remold' },
      ].filter((option) => option.value !== current);
    },
    async stockConditionCorrectionSubmit() {
      const form = this.stockConditionCorrection;
      const quantity = Number(form.quantity);
      if (!form.to_condition) {
        this.stockMsg = { ok: false, text: 'Selecione a condição correta.' };
        return;
      }
      if (!Number.isInteger(quantity) || quantity <= 0 || quantity > form.available) {
        this.stockMsg = {
          ok: false,
          text: `Informe uma quantidade inteira entre 1 e ${form.available}.`,
        };
        return;
      }
      if (String(form.reason || '').trim().length < 2) {
        this.stockMsg = { ok: false, text: 'Explique por que a condição está sendo corrigida.' };
        return;
      }
      form.saving = true;
      try {
        form.idempotency_key = form.idempotency_key
          || window.PAINEL_INTEGRITY.operation('stock-condition-transfer', 'form').key;
        const result = await this.apiPost('/admin/api/wholesale/stock/condition-transfer', {
          measure: form.measure,
          brand: form.brand,
          from_condition: form.from_condition,
          to_condition: form.to_condition,
          quantity,
          reason: form.reason.trim(),
          idempotency_key: form.idempotency_key,
        });
        window.PAINEL_INTEGRITY.complete('stock-condition-transfer', 'form');
        this.stockMsg = {
          ok: true,
          text: `${quantity} pneu(s) transferido(s) de ${this.catalogoConditionLabel(form.from_condition)} para ${this.catalogoConditionLabel(form.to_condition)}. Os dois saldos e custos foram recalculados com auditoria.`,
        };
        this.stockConditionCorrectionClose();
        await this.loadAtacado();
        void this.loadStockReconciliation();
        void this.loadGalpaoFilme();
      } catch (error) {
        const code = String(error.message || '');
        this.stockMsg = {
          ok: false,
          text: code.startsWith('condition_transfer_insufficient:')
            ? `Saldo insuficiente. Disponível: ${code.split(':')[1]}.`
            : this.stockErrText(code),
        };
      } finally {
        form.saving = false;
      }
    },
  };
};
