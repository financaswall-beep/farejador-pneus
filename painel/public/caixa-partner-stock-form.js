(function () {
  'use strict';
  const C = window.Caixa;
  const U = C.partnerUI;
  let page = null;
  let saving = false;
  let generation = 0;
  function close() {
    if (saving) return;
    page = null; C.partnerStock.render();
  }
  function field(form, label, name, type, value) {
    const wrap = U.node('label', label, 'ps-field');
    const input = U.node('input'); input.name = name; input.type = type; input.value = value || '';
    input.required = true; input.setAttribute('aria-label', label);
    wrap.appendChild(input); form.appendChild(wrap); return input;
  }
  function plate(className) {
    const el = U.node('div', null, 'ps-stock-entry' + (className ? ' ' + className : ''));
    ['tl', 'tr', 'bl', 'br'].forEach(corner => { const pin = U.node('i', null, 'ps-stock-screw ps-stock-screw--' + corner); pin.setAttribute('aria-hidden', 'true'); el.appendChild(pin); });
    return el;
  }
  function priceValue(value) {
    const text = value.trim();
    if (!/^(?:\d+(?:[,.]\d{1,2})?|\d{1,3}(?:\.\d{3})+,\d{1,2})$/.test(text)) return null;
    const amount = Number(text.includes(',') ? text.replace(/\./g, '').replace(',', '.') : text);
    return amount >= .01 && amount <= 99999999.99 ? amount : null;
  }
  function priceField(form) {
    const wrap = U.node('label', 'Preço de venda', 'ps-field ps-stock-price-field');
    const control = U.node('span', null, 'ps-stock-price-control');
    const currency = U.node('span', 'R$', 'ps-stock-currency'); currency.setAttribute('aria-hidden', 'true');
    const input = U.node('input'); input.type = 'text'; input.name = 'sale_price'; input.required = true;
    input.inputMode = 'decimal'; input.placeholder = '0,00'; input.maxLength = 16; input.setAttribute('aria-label', 'Preço de venda (R$)');
    function validate() { input.setCustomValidity?.(priceValue(input.value) == null ? 'Informe um preço maior que zero, como 180,00.' : ''); }
    input.addEventListener('input', validate);
    input.addEventListener('blur', () => {
      const value = priceValue(input.value);
      if (value != null) input.value = value.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      validate();
    });
    control.append(currency, input); wrap.appendChild(control); form.appendChild(wrap); return input;
  }
  function conditionField(form) {
    const group = U.node('fieldset', null, 'ps-stock-condition');
    group.appendChild(U.node('legend', 'Condição'));
    const choices = U.node('div', null, 'ps-stock-condition-options');
    const radios = ['meia_vida', 'novo', 'remold'].map(value => {
      const label = U.node('label', null, 'ps-stock-condition-choice');
      const radio = U.node('input'); radio.type = 'radio'; radio.name = 'tire_condition'; radio.value = value;
      radio.checked = value === 'meia_vida'; radio.required = true;
      const check = C.createSvg([{ d: 'm5 12 4 4L19 6' }]); check.setAttribute('aria-hidden', 'true');
      label.append(radio, check, U.node('span', U.condition(value))); choices.appendChild(label); return radio;
    });
    group.appendChild(choices); form.appendChild(group);
    return () => radios.find(radio => radio.checked)?.value;
  }
  function quantityField(form) {
    const wrap = U.node('div', null, 'ps-stock-quantity-field');
    const inputId = 'partner-new-tire-quantity';
    const label = U.node('label', 'Quantidade'); label.setAttribute('for', inputId);
    const controls = U.node('div', null, 'ps-stock-quantity');
    const input = U.node('input'); input.id = inputId; input.name = 'quantity_on_hand'; input.type = 'number';
    input.value = '1'; input.min = '0'; input.max = '999999'; input.step = '1'; input.inputMode = 'numeric';
    input.required = true; input.setAttribute('aria-label', 'Na loja');
    function update() {
      const value = Number(input.value); const valid = Number.isInteger(value) && value >= 0 && value <= 999999;
      minus.disabled = saving || !valid || value === 0; plus.disabled = saving || !valid || value === 999999;
    }
    function step(delta) { input.value = String(Number(input.value) + delta); update(); }
    const minus = U.button('−', () => step(-1)); minus.classList.add('ps-stock-step'); minus.setAttribute('aria-label', 'Diminuir quantidade');
    const plus = U.button('+', () => step(1)); plus.classList.add('ps-stock-step'); plus.setAttribute('aria-label', 'Aumentar quantidade');
    input.addEventListener('input', update); controls.append(minus, input, plus); wrap.append(label, controls); form.appendChild(wrap); update();
    return { input, update };
  }
  function open() {
    if (!C.isPartner() || !C.canModule('estoque') || C.partnerStock.busy()) return;
    page = U.section('Adicionar pneu', close); page.classList.add('ps-stock', 'ps-stock-form');
    page.querySelectorAll('button')[0].classList.add('ps-stock-step');
    const form = U.node('form');
    const identity = plate();
    const size = field(identity, 'Medida', 'tire_size', 'text', ''); size.placeholder = '90/90-18';
    size.classList.add('ps-stock-size-input'); size.autocomplete = 'off'; size.spellcheck = false;
    size.pattern = '[0-9]{2,3}/[0-9]{2,3}-[0-9]{2}'; size.maxLength = 10;
    const condition = conditionField(identity);
    const brandField = U.node('label', 'Marca', 'ps-field'); const brand = U.node('select');
    brand.name = 'brand'; brand.required = true; brand.setAttribute('aria-label', 'Marca');
    const chooseBrand = U.node('option', 'Escolha a marca'); chooseBrand.value = ''; brand.appendChild(chooseBrand);
    C.populateCatalogBrandSelect(brand); brandField.appendChild(brand); identity.appendChild(brandField);
    const balance = plate('ps-stock-entry--balance');
    const quantity = quantityField(balance);
    const price = priceField(balance);
    const error = U.node('p', null, 'ps-error'); error.setAttribute('role', 'alert');
    const submit = U.button('SALVAR PNEU', () => {}, 'primary', 'check'); submit.type = 'submit'; submit.classList.add('ps-stock-add');
    form.append(identity, balance, error, submit); page.appendChild(form);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (saving || !C.isPartner() || !C.canModule('estoque') || !form.reportValidity()) return;
      const amount = priceValue(price.value);
      if (amount == null) { error.textContent = 'Informe um preço maior que zero, como 180,00.'; return; }
      const session = C.sessionFingerprint(); const version = generation;
      saving = true; error.textContent = '';
      const buttons = [...page.querySelectorAll('button,input,select')]; buttons.forEach(control => { control.disabled = true; });
      try {
        await C.partnerData.api('operacao/estoque/itens', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tire_size: size.value.trim(), brand: brand.value, tire_condition: condition(),
            quantity_on_hand: Number(quantity.input.value), sale_price: amount }),
        });
        if (version !== generation || session !== C.sessionFingerprint()) return;
        saving = false; page = null;
        C.showToast('Pneu cadastrado.'); C.partnerStock.render(); await C.partnerStock.load();
      } catch (failure) {
        if (version !== generation || session !== C.sessionFingerprint()) return;
        error.textContent = failure?.message === 'stock_item_already_exists' ? 'Esse pneu já está cadastrado. Ajuste a quantidade na lista.'
          : failure?.message === 'invalid_tire_size' ? 'Use a medida no formato 90/90-18.' : 'Não consegui cadastrar. Confira os dados e tente novamente.';
      } finally {
        if (version === generation && session === C.sessionFingerprint()) {
          saving = false; buttons.forEach(control => { control.disabled = false; });
          quantity.update();
        }
      }
    });
    render(); U.root.scrollTop = 0;
  }
  function render() { if (page && U.root.dataset.view !== 'stock-form') U.mount(page, 'stock-form'); }
  function reset() { ++generation; page = null; saving = false; }
  C.partnerStockForm = { open, render, reset, isOpen: () => Boolean(page), busy: () => saving };
}());
