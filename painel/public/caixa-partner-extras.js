(function () {
  'use strict';
  const C = window.Caixa;
  const U = C.partnerUI;
  const state = { stock: null, errors: {}, query: '' };
  let generation = 0;
  async function load(tab) {
    const key = 'stock';
    if (!C.canModule('estoque')) return;
    const session = C.sessionFingerprint(); const current = ++generation;
    state.errors[key] = false;
    try {
      const payload = await C.partnerData.api('operacao/estoque');
      if (session !== C.sessionFingerprint() || current !== generation) return;
      state[key] = payload;
    } catch (failure) {
      if (session !== C.sessionFingerprint() || current !== generation) return;
      state.errors[key] = true;
    }
    if (C.partnerHome.currentTab() === tab) render(tab);
  }
  function stock(page) {
    const field = U.node('label', 'Buscar medida', 'ps-field');
    const input = U.node('input'); input.type = 'search'; input.inputMode = 'numeric'; input.placeholder = 'Ex.: 9018'; input.value = state.query;
    const list = U.node('div');
    function draw() {
      const query = state.query.replace(/\D/g, '');
      const rows = (state.stock.rows || []).filter(row => row.item_type === 'pneu' && (!query || String(row.tire_size || '').replace(/\D/g, '').includes(query)));
      list.replaceChildren();
      rows.forEach(row => {
        const line = U.node('article', null, 'ps-item');
        const reserved = Number(row.quantity_reserved || 0);
        line.append(U.node('strong', row.tire_size || row.item_name, 'ps-size'), U.node('p', U.condition(row.tire_condition)), U.node('b', row.quantity_on_hand == null ? 'Saldo não informado' : row.quantity_on_hand + (reserved ? ' (' + reserved + ' separados)' : ' em estoque')));
        list.appendChild(line);
      });
      if (!rows.length) list.appendChild(U.node('p', query ? 'Nenhum pneu nessa medida.' : 'Nenhum pneu cadastrado.', 'ps-copy'));
    }
    input.addEventListener('input', () => { state.query = input.value; draw(); });
    field.appendChild(input); page.append(field, list); draw();
  }
  function profile(page) {
    page.appendChild(U.info('Operador', C.stored(C.keys.name) || 'Operador'));
    page.appendChild(U.info('Loja', C.stored(C.keys.store) || 'Minha loja'));
    const enabled = localStorage.getItem(C.keys.notifications) !== 'false';
    const sound = U.button(enabled ? 'SOM ATIVADO' : 'ATIVAR SOM', () => {
      C.elements.notificationsToggle.click(); render('partner-profile');
    }, 'secondary'); sound.setAttribute('aria-pressed', String(enabled)); page.appendChild(sound);
    page.appendChild(U.button('SAIR', () => C.elements.logout.click(), 'secondary'));
  }
  function render(tab) {
    const key = tab === 'partner-stock' ? 'stock' : 'profile';
    const page = U.section(({ stock: 'Meus pneus', profile: 'Minha loja' })[key], () => C.partnerHome.open('partner-home'));
    if (key === 'profile') profile(page);
    else if (state.errors[key]) {
      page.append(U.node('p', 'Não consegui atualizar.', 'ps-copy'), U.button('TENTAR DE NOVO', () => void load(tab)));
    } else if (!state[key]) page.appendChild(U.node('p', 'Carregando…', 'ps-copy'));
    else stock(page);
    U.mount(page, key);
  }
  function reset() { ++generation; Object.assign(state, { stock: null, errors: {}, query: '' }); }
  C.partnerExtras = { load, render, reset };
}());
