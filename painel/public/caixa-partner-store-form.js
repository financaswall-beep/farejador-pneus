(function () {
  'use strict';
  const C = window.Caixa;
  const U = C.partnerUI;
  const S = () => C.partnerStore;
  function field(form, label, type, value) {
    const wrap = U.node('label', label, 'ps-field');
    const input = U.node('input'); input.type = type; input.value = value ?? '';
    input.setAttribute('aria-label', label); wrap.appendChild(input); form.appendChild(wrap); return input;
  }
  function setup(title, back = S().back) {
    const page = S().screen(title, back);
    const form = U.node('form'); const content = S().plate(); content.classList.add('ps-store-fields');
    const notice = U.node('p', null, 'ps-error'); notice.setAttribute('role', 'alert');
    const save = S().action('SALVAR', () => {}, 'primary', 'check'); save.type = 'submit';
    form.append(content, notice, save); page.appendChild(form); return { page, form, content, notice };
  }
  function hours() {
    if (!S().owner() || !S().snapshot()) return;
    const { page, form, content, notice } = setup('Horário da loja');
    const input = field(content, 'Quando sua loja abre?', 'text', S().snapshot().opening_hours_text);
    input.maxLength = 500; input.required = true; input.placeholder = 'Seg. a sáb. • 8h às 18h';
    const help = U.node('p', 'Esse horário aparece para o cliente.', 'ps-store-help'); content.appendChild(help);
    form.addEventListener('submit', event => {
      event.preventDefault(); if (!form.reportValidity()) return;
      const hoursText = input.value.trim(); if (!hoursText) { notice.textContent = 'Informe o horário da loja.'; return; }
      void S().run(page, async current => {
        // Esta API substitui o cadastro: conservar TODOS os dados do endereço.
        const fresh = await C.partnerData.api('configuracoes');
        if (!current()) return;
        if (!fresh.loja) throw new Error('unit_not_found');
        const keys = ['display_name', 'address_street', 'address_number', 'address_neighborhood', 'address_city', 'address_complement', 'cep', 'maps_url'];
        const data = Object.fromEntries(keys.map(key => [key, fresh.loja[key] ?? null]));
        data.opening_hours_text = hoursText;
        return C.partnerData.api('configuracoes/loja', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      }, async () => { C.showToast('Horário salvo.'); S().back(); await S().load(true); }, notice);
    });
    S().show('hours', page);
  }
  function toggle(parent, label, enabled) {
    const wrap = U.node('label', null, 'ps-store-option');
    const input = U.node('input'); input.type = 'checkbox'; input.checked = enabled;
    input.setAttribute('aria-label', label); wrap.append(input, U.node('span', label)); parent.appendChild(wrap); return input;
  }
  function service() {
    if (!S().owner() || !S().snapshot()) return;
    const loja = S().snapshot(); const { page, form, content, notice } = setup('Retirada e entrega');
    const pickup = toggle(content, 'Cliente pode retirar na loja', Boolean(loja.tem_retirada));
    const delivery = toggle(content, 'Minha loja faz entrega', Boolean(loja.faz_entrega));
    const radius = field(content, 'Entrega até quantos km?', 'text', loja.delivery_radius_km == null ? '' : String(loja.delivery_radius_km).replace('.', ','));
    radius.inputMode = 'decimal'; radius.maxLength = 10; radius.placeholder = 'Ex.: 5';
    const help = U.node('p', 'Deixe vazio se ainda não definiu o raio.', 'ps-store-help'); content.appendChild(help);
    function update() { radius.disabled = !delivery.checked; }
    delivery.addEventListener('change', update); update();
    form.addEventListener('submit', event => {
      event.preventDefault(); if (!form.reportValidity()) return;
      if (!pickup.checked && !delivery.checked) { notice.textContent = 'Escolha retirada, entrega ou as duas.'; return; }
      const text = radius.value.trim(); const value = text ? Number(text.replace(',', '.')) : null;
      if (delivery.checked && text && (!/^\d+(?:[.,]\d{1,2})?$/.test(text) || !(value > 0 && value <= 9999.99))) {
        notice.textContent = 'Informe um raio maior que zero, como 5 ou 5,5.'; return;
      }
      void S().run(page, () => C.partnerData.api('configuracoes/atendimento', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ faz_entrega: delivery.checked, tem_retirada: pickup.checked, delivery_radius_km: delivery.checked ? value : null }),
      }), async () => { C.showToast('Atendimento salvo.'); S().back(); await S().load(true); }, notice);
    });
    S().show('service', page);
  }
  C.partnerStoreForm = { hours, service, field, toggle, setup };
}());
