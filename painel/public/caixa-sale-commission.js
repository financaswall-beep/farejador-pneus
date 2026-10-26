(function () {
  'use strict';
  const C = window.Caixa, doc = document;
  const paths = {
    person: 'M20 21v-2a7 7 0 0 0-14 0v2M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
    origin: 'M3 10h18L19 3H5l-2 7Zm2 0v11h14V10M9 21v-7h6v7',
    coins: 'M20 6c0 2-4 3-8 3S4 8 4 6s4-3 8-3 8 1 8 3ZM4 6v5c0 2 4 3 8 3s8-1 8-3V6M4 11v5c0 2 4 3 8 3s8-1 8-3v-5',
    calculator: 'M5 2h14v20H5zM8 6h8M8 11h1m6 0h1m-8 4h1m6 0h1m-8 4h1m6 0h1',
    clock: 'M12 8v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
    check: 'm5 12 4 4L19 6', cross: 'm6 6 12 12M6 18 18 6',
    info: 'M12 11v6m0-10v1M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
    arrow: 'm9 5 7 7-7 7', back: 'm15 5-7 7 7 7',
  };
  function node(tag, text, className) {
    const el = doc.createElement(tag); if (text != null) el.textContent = String(text);
    if (className) el.className = className; return el;
  }
  function number(value) {
    return value != null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
  }
  function money(value) { const n = number(value); return n == null ? '—' : C.currency.format(n); }
  function icon(name) { return C.createSvg([{ d: paths[name] || paths.info }]); }
  function heading(text, name) { const el = node('h3'); el.append(icon(name), node('span', text)); return el; }
  function origin(receipt, labels) { return labels.saleOrigin(Object.assign({}, receipt, { seller_name: null })); }
  // Só apresenta os valores da consulta; não refaz nem altera o cálculo financeiro.
  function model(receipt) {
    const amount = number(receipt.commission_amount), value = number(receipt.commission_value);
    const calculation = receipt.commission_calculation || {};
    const itemized = calculation.itemized === true;
    const configured = calculation.active !== false && (itemized ||
      (['percent', 'fixed'].includes(receipt.commission_kind) && value > 0));
    const rule = calculation.active === false ? 'Regra de comissão inativa'
      : itemized ? 'Regras por tipo de item'
        : receipt.commission_kind === 'fixed' && value > 0 ? 'Valor fixo por venda'
          : receipt.commission_kind === 'percent' && value > 0
            ? new Intl.NumberFormat('pt-BR').format(value) + '% sobre ' +
              (receipt.commission_basis === 'margin' ? 'a margem' : receipt.commission_basis === 'revenue' ? 'o valor da venda' : 'a base configurada')
            : amount === 0 ? 'Venda sem comissão' : 'Regra não informada';
    let state = 'unknown', label = 'Não informada', note = 'A situação da comissão não foi informada.';
    if (receipt.status === 'cancelled' || receipt.commission_status === 'reversed') {
      state = 'reversed'; label = 'Cancelada'; note = 'Comissão cancelada; não há valor a receber.';
    } else if (amount == null) {
      note = 'O valor da comissão não foi informado.';
    } else if (['open', 'pending', 'reserved'].includes(receipt.status)) {
      state = 'pending'; label = 'Ainda não gerada'; note = 'A venda ainda está em andamento.';
    } else if (amount === 0) {
      state = 'none'; label = 'Sem comissão'; note = 'Esta venda não gerou comissão.';
    } else if (receipt.commission_status === 'paid') {
      state = 'paid'; label = 'Paga'; note = 'Comissão já paga.';
    } else if (receipt.commission_status === 'receivable') {
      state = 'receivable'; label = 'A receber'; note = 'Comissão aguardando pagamento.';
    }
    return { amount, value, calculation, itemized, configured, rule, state, label, note };
  }
  function badge(data) {
    const el = node('span', '', 'mc-commission-badge'); el.dataset.status = data.state;
    el.append(icon(data.state === 'paid' ? 'check' : data.state === 'reversed' ? 'cross' :
      ['receivable', 'pending'].includes(data.state) ? 'clock' : 'info'), node('span', data.label)); return el;
  }
  function originCard(receipt, labels) {
    const card = node('section', '', 'mc-receipt-card mc-receipt-origin');
    const fields = node('div', '', 'mc-origin-fields');
    [['Origem', origin(receipt, labels), 'origin'], ['Vendedor', receipt.seller_name || 'Sem vendedor vinculado', 'person']].forEach(values => {
      const field = node('div'), copy = node('span');
      copy.append(node('small', values[0]), node('strong', values[1])); field.append(icon(values[2]), copy); fields.append(field);
    });
    card.append(heading('Origem e atendimento', 'origin'), fields); return card;
  }
  function summary(receipt, open) {
    const data = model(receipt), card = node('section', '', 'mc-receipt-card mc-receipt-commission');
    const amount = node('div', '', 'mc-commission-amount');
    amount.append(node('strong', money(data.amount)), badge(data));
    const rule = node('div', '', 'mc-commission-rule');
    const button = node('button', '', 'mc-commission-open'); button.type = 'button';
    button.setAttribute('aria-label', 'Ver cálculo da comissão'); button.append(node('span', 'Ver cálculo'), icon('arrow'));
    button.addEventListener('click', open);
    rule.append(node('p', data.rule), button);
    card.append(heading('Comissão da venda', 'coins'), amount, rule); return card;
  }
  function detail(receipt, labels) {
    const data = model(receipt), view = node('div', '', 'mc-commission-view hidden');
    const meta = node('section', '', 'mc-receipt-card mc-commission-meta');
    const order = String(receipt.order_number || '');
    const identification = node('div', '', 'mc-receipt-identification'), date = new Date(receipt.created_at);
    identification.append(node('strong', order.startsWith('PED-') ? order : labels.orderLabel(order)),
      node('p', Number.isFinite(date.getTime()) ? C.dateTime.format(date) : 'Data não informada'));
    meta.append(identification, node('b', receipt.customer_name || 'Cliente não informado'), node('p', 'Origem: ' + origin(receipt, labels)));
    const person = node('section', '', 'mc-receipt-card mc-commission-person');
    const seller = node('div', '', 'mc-commission-seller'), name = node('span');
    name.append(node('small', 'Vendedor'), node('strong', receipt.seller_name || 'Sem vendedor vinculado'));
    seller.append(icon('person'), name);
    const amount = node('div', '', 'mc-commission-amount'); amount.append(node('strong', money(data.amount)), badge(data));
    person.append(seller, node('b', 'Comissão'), amount);
    const calculation = node('section', '', 'mc-receipt-card mc-commission-calculation');
    calculation.append(heading('Como foi calculada', 'calculator'));
    const list = node('dl');
    function row(label, value) { const el = node('div'); el.append(node('dt', label), node('dd', value)); list.append(el); }
    if (data.itemized) {
      row('Regra', 'Por tipo de item');
      const rules = data.calculation.item_rules;
      if (rules) [['tire', 'Pneus'], ['service', 'Serviços'], ['other', 'Outros']].forEach(([group, label]) => {
        const rule = rules[group], value = number(rule?.value);
        row(label, !rule || value == null ? 'Não informada'
          : rule.kind === 'none' || value === 0 ? 'Sem comissão'
            : rule.kind === 'percent' ? new Intl.NumberFormat('pt-BR').format(value) + '%'
              : rule.kind === 'fixed' && group === 'tire' ? money(value) + ' por pneu' : 'Não informada');
      });
    } else if (data.configured && receipt.commission_kind === 'fixed') {
      row('Regra', 'Valor fixo por venda'); row('Valor fixo', money(data.value));
    } else if (data.configured && receipt.commission_kind === 'percent') {
      const base = number(data.calculation.base_amount) ?? (receipt.commission_basis === 'revenue' ? number(receipt.total_amount) : null);
      row(receipt.commission_basis === 'margin' ? 'Margem da venda' : 'Base de cálculo', base == null ? 'Não informada' : money(base));
      row('Percentual', new Intl.NumberFormat('pt-BR').format(data.value) + '%');
    } else row('Regra', data.rule);
    row('Comissão', money(data.amount)); calculation.append(list, node('p', data.itemized
      ? 'Pneus, serviços e outros itens seguem as regras por tipo de item.' : data.rule + '.'));
    const note = node('p', '', 'mc-commission-note'); note.dataset.status = data.state;
    note.append(icon('info'), node('span', data.note));
    view.append(meta, person, calculation, note); return view;
  }
  C.matrixSaleCommission = { originCard, summary, detail, icon, model };
}());
