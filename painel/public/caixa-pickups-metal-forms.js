(function () {
  'use strict';
  const C = window.Caixa, P = C.Pickups, V = C.pickupMetalView;
  const { el, icon, button, plate } = V;
  function invalidServices(row) {
    return P.draftServices(row).some(service => !Number.isInteger(service.amount_cents)
      || service.amount_cents < 0 || service.amount_cents > 1000000
      || (service.charge_mode === 'charged' && service.amount_cents <= 0));
  }
  function serviceRow(row, service, index) {
    const n = plate('mp-service'), select = el('select'); select.id = 'mp-service-' + index + '-code'; select.dataset.serviceIndex = index; select.dataset.field = 'code'; select.setAttribute('aria-label', 'Serviço');
    P.state.serviceCatalog.forEach(def => {
      const option = el('option', def.label); option.value = def.code; option.selected = def.code === service.code;
      option.disabled = P.draftServices(row).some((other, position) => index !== position && def.code === other.code); select.appendChild(option);
    });
    const header = el('header'), remove = button('', 'remove-service', 'icon', 'trash'); remove.dataset.index = index; remove.setAttribute('aria-label', 'Remover serviço'); header.append(icon('tool'), select, remove); n.appendChild(header);
    const modes = el('div', null, 'mp-service-modes');
    [['courtesy', 'Cortesia'], ['charged', 'Cobrar']].forEach(([value, label]) => {
      const b = button(label, 'service-mode'); b.id = 'mp-service-' + index + '-' + value; b.dataset.index = index; b.dataset.mode = value; b.classList.toggle('active', service.charge_mode === value); b.setAttribute('aria-pressed', String(service.charge_mode === value)); modes.appendChild(b);
    }); n.appendChild(modes);
    const label = el('label', service.charge_mode === 'courtesy' ? 'Cortesia registrada com valor zero' : 'Valor do serviço', 'mp-field');
    const amount = el('input'); amount.type = 'number'; amount.inputMode = 'decimal'; amount.step = '0.01'; amount.min = '0'; amount.max = '10000'; amount.value = Number.isFinite(service.amount_cents) ? (service.amount_cents / 100).toFixed(2) : '';
    amount.id = 'mp-service-' + index + '-amount'; amount.dataset.serviceIndex = index; amount.dataset.field = 'amount'; amount.disabled = service.charge_mode === 'courtesy'; amount.setAttribute('aria-label', 'Valor do serviço'); label.appendChild(amount); n.appendChild(label); return n;
  }
  function services(row) {
    const installing = P.pickupStage(row) === 'installing', page = el('div', null, 'mp-page'); page.append(V.heading('Serviços', 'queue'), V.identity(row), V.product(row, true));
    if (installing) page.appendChild(el('p', 'Instalação em andamento. Confira os serviços antes de receber.', 'mp-hint'));
    const items = P.draftServices(row);
    items.forEach((service, index) => page.appendChild(serviceRow(row, service, index)));
    if (!items.length) page.appendChild(el('p', 'Nenhum serviço incluído.', 'mp-notice'));
    const add = button('Adicionar serviço', 'add-service', 'secondary', 'plus'); add.disabled = items.length >= P.state.serviceCatalog.length; page.appendChild(add);
    const totals = V.totals(row); totals.id = 'mp-service-totals'; page.appendChild(totals);
    if (invalidServices(row)) page.appendChild(el('p', 'Informe um valor válido para cada serviço cobrado, até R$ 10.000,00.', 'mp-service-validation'));
    if (!installing && items.length) page.appendChild(button('Iniciar instalação', 'install', 'primary', 'tool'));
    page.append(button(installing ? 'Conferir pagamento' : 'Ir para pagamento', 'payment', installing || !items.length ? 'primary' : 'secondary', 'card'),
      el('p', 'A instalação é opcional.', 'mp-hint'), button('Voltar etapa', 'previous-stage', 'secondary', 'back'), button('Cancelar pedido', 'cancel', 'link-danger', 'trash'));
    return page;
  }
  function payment(row, m) {
    const page = el('div', null, 'mp-page'); page.append(V.heading('Concluir retirada', 'services'), V.identity(row), V.product(row, true));
    const totals = V.totals(row); totals.querySelector('.mp-total-large span').textContent = 'Total a receber'; page.appendChild(totals);
    const methods = el('fieldset', null, 'mp-methods'); methods.appendChild(el('legend', 'Como recebeu?'));
    [['Pix', 'pix'], ['Dinheiro', 'cash'], ['Cartão', 'card']].forEach(([name, symbol]) => {
      const label = el('label', null, 'mp-method'), radio = el('input'); radio.id = 'mp-method-' + symbol; radio.type = 'radio'; radio.name = 'mp-payment'; radio.value = name; radio.checked = P.state.payments[row.order_id] === name;
      label.append(radio, icon(symbol), el('span', name)); methods.appendChild(label);
    }); page.appendChild(methods);
    const received = el('label', null, 'mp-received'), check = el('input'); check.type = 'checkbox'; check.id = 'mp-received'; check.checked = m.received; received.append(check, el('span', 'Conferi o recebimento')); page.appendChild(received);
    const confirm = button('Confirmar retirada e pagamento', 'complete', 'primary', 'check'); confirm.disabled = !m.received || invalidServices(row); page.append(confirm, el('p', 'A confirmação registra o pagamento e a saída dos pneus.', 'mp-hint'));
    return page;
  }
  function cancellation(row, m) {
    const page = el('div', null, 'mp-page'); page.append(V.heading('Cancelar pedido', 'cancel-back'), V.identity(row), V.product(row, true));
    const warning = el('p', null, 'mp-warning'); warning.append(icon('warning'), el('span', 'Os pneus voltarão a ficar disponíveis.')); page.appendChild(warning);
    const form = el('form'); form.id = 'mp-cancel-form';
    const label = el('label', 'Motivo do cancelamento', 'mp-field'), reason = el('textarea'); reason.id = 'mp-cancel-reason'; reason.required = true; reason.maxLength = 500; reason.rows = 3; reason.placeholder = 'Ex.: cliente desistiu da retirada'; reason.value = m.reason; label.appendChild(reason); form.appendChild(label);
    const summary = plate('mp-cancel-summary'); summary.append(el('span', 'Reserva a liberar'), el('strong', V.quantity(row) + (V.quantity(row) === 1 ? ' pneu' : ' pneus'))); form.appendChild(summary);
    const submit = button('Confirmar cancelamento', 'cancel-confirm', 'danger', 'trash'); submit.type = 'submit';
    form.append(button('Manter pedido', 'cancel-back', 'secondary', 'back'), submit, el('p', 'O cancelamento libera a reserva e não registra recebimento.', 'mp-hint')); page.appendChild(form); return page;
  }
  Object.assign(V, { invalidServices, services, payment, cancellation });
}());
