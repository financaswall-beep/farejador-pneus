(function () {
  'use strict';
  const C = window.Caixa, V = C.financeView, el = id => document.getElementById(id);
  const partial = ['wholesale_sale', 'retail_sale', 'wholesale_purchase', 'central_obligation', 'central_account'];
  function field(form, label, type, value, options) {
    const wrap = V.node('label', label, 'mf-field'), input = V.node(type === 'select' ? 'select' : 'input');
    if (type === 'select') options.forEach(([value, title]) => { const option = V.node('option', title); option.value = value; input.appendChild(option); });
    else input.type = type;
    input.value = value; input.required = true; input.setAttribute('aria-label', label); wrap.appendChild(input); form.appendChild(wrap); return input;
  }
  function account(row, direction, onSuccess) {
    if (C.stored(C.keys.role) !== 'owner') return;
    const body = V.dialog(direction === 'out' ? 'Registrar pagamento' : 'Registrar recebimento');
    body.append(V.node('h4', row.nome), V.node('p', 'Confira os dados antes de confirmar a baixa no caixa.'));
    const form = V.node('form', undefined, 'mf-payment-form');
    const amount = field(form, 'Valor (R$)', 'number', V.number(row.valor).toFixed(2)); amount.step = '0.01'; amount.min = '0.01'; amount.max = String(row.valor);
    const acceptsPartial = partial.includes(row.settlement_mode); amount.readOnly = !acceptsPartial;
    const today = window.FarejadorTime.dateKey(new Date());
    const date = field(form, direction === 'out' ? 'Data do pagamento' : 'Data do recebimento', 'date', today); date.max = today;
    const method = field(form, 'Forma de pagamento', 'select', '', [['', 'Selecione'], ['pix', 'Pix'], ['dinheiro', 'Dinheiro'], ['transferencia', 'Transferência'], ['cartao', 'Cartão'], ['boleto', 'Boleto'], ['outros', 'Outros']]);
    const cash = field(form, 'Conta do caixa', 'text', 'Caixa principal'); cash.maxLength = 80; cash.minLength = 2;
    const note = field(form, 'Observação (opcional)', 'text', ''); note.required = false; note.maxLength = 500;
    body.appendChild(form);
    const error = V.node('p', '', 'mf-inline-error hidden'); error.setAttribute('role', 'alert'); form.appendChild(error);
    const submit = V.node('button', direction === 'out' ? 'Confirmar pagamento' : 'Confirmar recebimento', 'mf-primary'); submit.type = 'submit'; form.appendChild(submit);
    let attempt = null, sending = false;
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (sending || !form.reportValidity()) return;
      const paidAt = date.value === today ? new Date().toISOString() : new Date(date.value + 'T12:00:00-03:00').toISOString();
      const data = { settlement_mode: row.settlement_mode, target_id: row.id, obligation_id: row.obligation_id,
        account_code: row.account_code, payment_method: method.value, cash_account: cash.value.trim(), note: note.value.trim(), paid_at: paidAt };
      if (acceptsPartial) data.amount = Number(amount.value);
      // Uma tentativa incerta reutiliza exatamente o mesmo corpo e a mesma chave.
      if (!attempt) attempt = { ...data, idempotency_key: 'app-account-' + crypto.randomUUID() };
      sending = true; submit.disabled = true; error.classList.add('hidden');
      Array.from(form.elements).forEach(input => { if (input !== submit) input.disabled = true; });
      const session = C.sessionFingerprint();
      try {
        const response = await C.authenticatedFetch('/api/caixa/financeiro-contas/baixar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(attempt) });
        const result = await C.json(response); if (!response.ok) throw Error(result.error || 'payment_failed');
        if (C.sessionFingerprint() !== session) return;
        if (body.isConnected && body.contains(form)) el('mf-detail').close();
        C.showToast(direction === 'out' ? 'Pagamento registrado no Financeiro.' : 'Recebimento registrado no Financeiro.'); onSuccess();
      } catch (failure) {
        if (C.sessionFingerprint() !== session) return;
        error.textContent = /not_open|not_found|nothing_open|conflict|exceeds_balance/.test(failure.message)
          ? 'Esta conta mudou. Feche os detalhes e atualize a lista antes de continuar.'
          : 'Não foi possível confirmar. Tente novamente com os mesmos dados ou atualize a lista para conferir se a baixa foi registrada.';
        error.classList.remove('hidden'); submit.disabled = /not_open|not_found|nothing_open|conflict|exceeds_balance/.test(failure.message);
        submit.textContent = 'Tentar confirmar novamente';
      } finally { sending = false; }
    });
  }
  C.financePayment = { account };
}());
