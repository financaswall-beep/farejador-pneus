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
  return { build, edit, messages };
})();
