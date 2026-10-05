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
  function open() {
    if (!C.isPartner() || !C.canModule('estoque') || C.partnerStock.busy()) return;
    page = U.section('Adicionar pneu', close); page.classList.add('ps-stock', 'ps-stock-form');
    const form = U.node('form');
    const size = field(form, 'Medida', 'tire_size', 'text', ''); size.placeholder = 'Ex.: 90/90-18';
    size.pattern = '[0-9]{2,3}/[0-9]{2,3}-[0-9]{2}'; size.maxLength = 10;
    const brandField = U.node('label', 'Marca', 'ps-field'); const brand = U.node('select');
    brand.name = 'brand'; brand.required = true; brand.setAttribute('aria-label', 'Marca');
    const chooseBrand = U.node('option', 'Escolha a marca'); chooseBrand.value = ''; brand.appendChild(chooseBrand);
    C.populateCatalogBrandSelect(brand); brandField.appendChild(brand); form.appendChild(brandField);
    const conditionField = U.node('label', 'Condição', 'ps-field'); const condition = U.node('select');
    condition.name = 'tire_condition'; condition.setAttribute('aria-label', 'Condição');
    ['meia_vida', 'novo', 'remold'].forEach(value => { const option = U.node('option', U.condition(value)); option.value = value; condition.appendChild(option); });
    condition.value = 'meia_vida';
    conditionField.appendChild(condition); form.appendChild(conditionField);
    const fields = U.node('div', null, 'ps-stock-form-pair'); form.appendChild(fields);
    const quantity = field(fields, 'Na loja', 'quantity_on_hand', 'number', '1'); quantity.min = '0'; quantity.max = '999999'; quantity.step = '1'; quantity.inputMode = 'numeric';
    const price = field(fields, 'Preço de venda (R$)', 'sale_price', 'number', ''); price.min = '0.01'; price.max = '99999999.99'; price.step = '0.01'; price.inputMode = 'decimal';
    const error = U.node('p', null, 'ps-error'); error.setAttribute('role', 'alert');
    const submit = U.button('SALVAR PNEU', () => {}); submit.type = 'submit'; submit.classList.add('ps-stock-add');
    form.append(error, submit); page.appendChild(form);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (saving || !C.isPartner() || !C.canModule('estoque') || !form.reportValidity()) return;
      const session = C.sessionFingerprint(); const version = generation;
      saving = true; error.textContent = '';
      const buttons = [...page.querySelectorAll('button,input,select')]; buttons.forEach(control => { control.disabled = true; });
      try {
        await C.partnerData.api('operacao/estoque/itens', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tire_size: size.value.trim(), brand: brand.value, tire_condition: condition.value,
            quantity_on_hand: Number(quantity.value), sale_price: Number(price.value) }),
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
        }
      }
    });
    render(); U.root.scrollTop = 0;
  }
  function render() { if (page && U.root.dataset.view !== 'stock-form') U.mount(page, 'stock-form'); }
  function reset() { ++generation; page = null; saving = false; }
  C.partnerStockForm = { open, render, reset, isOpen: () => Boolean(page), busy: () => saving };
}());
