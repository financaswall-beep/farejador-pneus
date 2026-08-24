(function () {
  'use strict';
  const Caixa = window.Caixa;
  const P = Caixa && Caixa.Pickups;
  if (!P) return;
  const elements = P.elements;
  const state = P.state;

  function serviceLabel(code) {
    const definition = state.serviceCatalog.find(function (item) { return item.code === code; });
    return definition ? definition.label : code;
  }
  function setServices(row, next) {
    state.services[row.order_id] = next;
    renderSheet();
  }
  function renderServiceRow(row, service, index, locked) {
    const wrapper = P.node('div', 'pickup-service-row');
    const select = document.createElement('select');
    select.setAttribute('aria-label', 'Serviço');
    state.serviceCatalog.forEach(function (item) {
      const option = document.createElement('option');
      option.value = item.code;
      option.textContent = item.label;
      option.selected = item.code === service.code;
      option.disabled = P.draftServices(row).some(function (other, position) {
        return position !== index && other.code === item.code;
      });
      select.appendChild(option);
    });
    select.disabled = locked;
    select.addEventListener('change', function () {
      setServices(row, P.draftServices(row).map(function (item, position) {
        return position === index ? Object.assign({}, item, { code: select.value }) : item;
      }));
    });
    wrapper.appendChild(select);
    const mode = P.node('button', 'pickup-service-mode', service.charge_mode === 'charged' ? 'Cobrar' : 'Cortesia');
    mode.type = 'button'; mode.disabled = locked;
    mode.setAttribute('aria-pressed', String(service.charge_mode === 'charged'));
    mode.addEventListener('click', function () {
      const charged = service.charge_mode !== 'charged';
      setServices(row, P.draftServices(row).map(function (item, position) {
        if (position !== index) return item;
        return Object.assign({}, item, {
          charge_mode: charged ? 'charged' : 'courtesy',
          amount_cents: charged ? Math.max(Number(item.amount_cents || 0), 100) : 0,
        });
      }));
    });
    wrapper.appendChild(mode);
    const price = document.createElement('input');
    price.type = 'number'; price.min = '0'; price.max = '10000'; price.step = '0.01';
    price.inputMode = 'decimal';
    price.setAttribute('aria-label', 'Valor de ' + serviceLabel(service.code));
    price.value = (Number(service.amount_cents || 0) / 100).toFixed(2);
    price.disabled = locked || service.charge_mode !== 'charged';
    price.addEventListener('input', function () {
      const cents = Math.max(0, Math.round(Number(String(price.value).replace(',', '.')) * 100) || 0);
      service.amount_cents = cents;
      elements.servicesTotal.textContent = P.money(P.servicesCents(row) / 100);
      elements.grandTotal.textContent = P.money(P.fullTotal(row));
    });
    price.addEventListener('change', renderSheet);
    wrapper.appendChild(price);
    const remove = P.node('button', 'pickup-service-remove', '×');
    remove.type = 'button'; remove.disabled = locked;
    remove.setAttribute('aria-label', 'Remover ' + serviceLabel(service.code));
    remove.addEventListener('click', function () {
      setServices(row, P.draftServices(row).filter(function (_item, position) { return position !== index; }));
    });
    wrapper.appendChild(remove);
    return wrapper;
  }
  function renderServices(row) {
    const locked = P.pickupStage(row) === 'completed' || state.saving;
    const services = P.draftServices(row);
    elements.serviceList.replaceChildren();
    if (!services.length) {
      elements.serviceList.appendChild(P.node('p', 'pickups-services-empty', 'Nenhum serviço incluído.'));
    } else {
      services.forEach(function (service, index) {
        elements.serviceList.appendChild(renderServiceRow(row, service, index, locked));
      });
    }
    elements.addService.disabled = locked || services.length >= state.serviceCatalog.length;
  }
  function renderSteps(stage) {
    const rank = { waiting: 0, arrived: 1, installing: 3, completed: 4 }[stage] || 0;
    document.querySelectorAll('[data-pickup-step]').forEach(function (step) {
      const target = { arrived: 1, payment: 2, installing: 3, completed: 4 }[step.dataset.pickupStep] || 99;
      step.classList.toggle('done', rank >= target);
      step.classList.toggle('current', rank < target && target === Math.min(rank + 1, 4));
    });
  }
  function renderPayment(row, locked) {
    const payment = P.normalizedPayment(state.payments[row.order_id] || row.payment_method);
    document.querySelectorAll('[data-pickup-payment]').forEach(function (button) {
      const active = button.dataset.pickupPayment === payment;
      button.classList.toggle('active', active);
      button.setAttribute('aria-checked', String(active));
      button.disabled = locked;
    });
  }
  function renderSheet() {
    const row = P.selected();
    if (!row) return P.closeSheet();
    const stage = P.pickupStage(row);
    const locked = stage === 'completed' || state.saving;
    elements.sheetTitle.textContent = P.orderLabel(row);
    elements.sheetCustomer.textContent = row.customer_name || 'Cliente não identificado';
    elements.sheetStatus.className = 'pickup-status pickup-status--' + stage;
    elements.sheetStatus.textContent = P.stageLabel(stage);
    elements.sheetItems.textContent = P.itemsLabel(row);
    elements.productTotal.textContent = P.money(row.total_amount);
    elements.servicesTotal.textContent = P.money(P.servicesCents(row) / 100);
    elements.grandTotal.textContent = P.money(P.fullTotal(row));
    renderSteps(stage); renderPayment(row, locked); renderServices(row);
    elements.backStage.classList.toggle('hidden', locked || stage === 'waiting');
    elements.stageAction.classList.toggle('hidden', locked || stage === 'installing'
      || (stage === 'arrived' && P.draftServices(row).length === 0));
    elements.completeAction.classList.toggle('hidden', locked || stage === 'waiting');
    elements.cancelOpen.classList.toggle('hidden', locked);
    elements.stageAction.textContent = stage === 'waiting' ? 'Cliente chegou' : 'Iniciar instalação';
    elements.completeAction.textContent = stage === 'installing'
      ? 'Concluir instalação e pagamento' : 'Confirmar retirada e pagamento';
    elements.backStage.disabled = state.saving;
    elements.stageAction.disabled = state.saving;
    elements.completeAction.disabled = state.saving;
    elements.cancelOpen.disabled = state.saving;
  }

  Object.assign(P, {
    setServices: setServices,
    renderPayment: renderPayment,
    renderSheet: renderSheet,
  });
}());
