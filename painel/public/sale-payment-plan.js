// Cálculos em centavos. O dia do primeiro vencimento é a referência de cada mês.
window.SalePaymentPlan = (() => {
  function cents(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return 0;
    const br = /^(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{1,2})?$/.test(raw);
    if (!br && !/^\d+\.\d{1,2}$/.test(raw)) return NaN;
    const amount = Number(br ? raw.replace(/\./g, '').replace(',', '.') : raw);
    return Math.round(amount * 100);
  }
  function build(form, total, soldOn) {
    const entry = cents(form.entry);
    const balance = Math.round(total * 100) - entry;
    const count = Number(form.installment_count ?? 1);
    const invalid = error => ({ error, rows: [], balance: Number.isFinite(balance) ? balance / 100 : 0 });
    if (!Number.isSafeInteger(entry) || !Number.isSafeInteger(balance) || balance <= 0)
      return invalid('Informe uma entrada menor que o total. Para recebimento integral, escolha À vista.');
    if (!Number.isInteger(count) || count < 1 || count > 120 || count > balance)
      return invalid('Confira a quantidade de parcelas. Cada parcela precisa ter ao menos um centavo.');
    if (!form.due_date || form.due_date < soldOn) return invalid('Informe o primeiro vencimento a partir da data da venda.');
    const first = new Date(form.due_date + 'T12:00:00Z');
    if (!Number.isFinite(first.getTime())) return invalid('Confira o primeiro vencimento.');
    const parts = Array.from({ length: count }, (_, index) => {
      const date = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + index + 1, 0));
      date.setUTCDate(Math.min(first.getUTCDate(), date.getUTCDate()));
      const custom = form.installment_edits?.[index];
      const partCents = custom?.amount == null
        ? Math.floor(balance / count) + Number(index < balance % count) : cents(custom.amount);
      return { due_date: custom?.due_date ?? date.toISOString().slice(0,10), amount: partCents / 100 };
    });
    const invalidDates = parts.some((part, i) => !part.due_date || part.due_date < (i ? parts[i-1].due_date : soldOn));
    const validSum = parts.every(part => Number.isFinite(part.amount) && part.amount > 0)
      && parts.reduce((sum, part) => sum + Math.round(part.amount * 100), 0) === balance;
    return { balance: balance / 100, rows: parts,
      error: invalidDates ? 'Confira a ordem dos vencimentos.' : validSum ? '' : 'A soma das parcelas precisa fechar com o saldo a receber.',
      plan: { received: entry / 100, ...(entry ? { method: form.entry_method || 'Pix' } : {}), installments: parts } };
  }
  function edit(form, index, field, value) {
    const edits = form.installment_edits || {};
    form.installment_edits = { ...edits, [index]: { ...edits[index], [field]: value } };
  }
  const messages = {
    sale_plan_finance_required: 'Ative o Financeiro central para registrar entrada e parcelas.',
    sale_plan_in_transit: 'Registre a entrada e as parcelas no acerto da chegada.',
    sale_plan_invalid: 'Confira a entrada, a forma de pagamento e o primeiro vencimento.',
    sale_plan_dates_invalid: 'Confira a ordem dos vencimentos.',
    sale_plan_total_mismatch: 'A entrada e as parcelas precisam somar o valor da venda.',
  };
  function dateEditor() {
    return {
      target: null, date: '', saving: false, stale: false, error: '', attempt: null,
      openDate(target) {
        if (this.saving || this.adminUser?.role !== 'owner') return;
        this.target = target;
        this.date = target.due;
        this.error = '';
        this.stale = false;
        this.attempt = null;
        this.$root.showModal();
      },
      async refreshSale(id) {
        if (this.currentPage === 'financeiro') {
          await this.loadFinanceiro();
          if (this.financeiroLoadError) throw new Error('finance_refresh_failed');
          return;
        }
        if (this.vendasTab === 'lotes') {
          await this.loadLotSalesPage();
          if (this.lotSales.error) throw new Error('sales_refresh_failed');
          return;
        }
        const data = await this.apiGet('/admin/api/wholesale/sales');
        this.atacadoVendas = data.rows || [];
        if (this.vendaAtacadoSelecionada?.id === id)
          this.vendaAtacadoSelecionada = this.atacadoVendas.find(row => row.id === id) || null;
      },
      async saveDate() {
        const target = this.target;
        if (!target || this.saving || this.stale || !this.date || this.date === target.due) return;
        if (this.attempt?.due_date !== this.date) this.attempt = {
          due_date: this.date, expected_due_date: target.due, idempotency_key: crypto.randomUUID(),
        };
        this.error = '';
        this.saving = true;
        let saved = false;
        try {
          await this.apiPost('/admin/api/wholesale/sales/' + target.orderId + '/installments/' + target.number + '/due-date', this.attempt);
          saved = true;
          await this.refreshSale(target.orderId);
          this.$root.close();
        } catch (err) {
          this.stale = saved || err.message === 'sale_installment_changed' || err.message === 'sale_not_found';
          if (saved) this.error = 'Vencimento salvo. Atualize a tela para consultar a nova data.';
          else if (this.stale) {
            this.error = 'A parcela mudou ou foi encerrada. Confira o vencimento atual antes de tentar novamente.';
            await this.refreshSale(target.orderId).catch(() => {});
          } else this.error = ({
            installment_before_sale: 'Escolha uma data a partir da data da venda ou do acerto da chegada.',
            invalid_installment_date: 'Confira a data informada.',
            installment_date_migration_required: 'A alteração de vencimentos precisa da atualização 0283 do banco.',
            sale_plan_finance_required: messages.sale_plan_finance_required,
          })[err.message] || 'Não foi possível confirmar a alteração. Tente novamente.';
        } finally { this.saving = false; }
      },
    };
  }
  return { build, edit, messages, dateEditor };
})();
