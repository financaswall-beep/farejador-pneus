(function () {
  'use strict';
  const C = window.Caixa;
  const U = C.partnerUI;
  const state = { sales: null, stock: null, errors: {}, query: '' };
  let generation = 0;
  async function load(tab) {
    const key = tab === 'partner-sales' ? 'sales' : 'stock';
    const permission = key === 'sales' ? 'vendas' : 'estoque';
    if (!C.canModule(permission)) return;
    const session = C.sessionFingerprint(); const current = ++generation;
    state.errors[key] = false;
    try {
      const payload = await C.partnerData.api(key === 'sales' ? 'minhas-vendas?week=0' : 'operacao/estoque');
      if (session !== C.sessionFingerprint() || current !== generation) return;
      state[key] = payload;
    } catch (failure) {
      if (session !== C.sessionFingerprint() || current !== generation) return;
      state.errors[key] = true;
    }
    if (C.partnerHome.currentTab() === tab) render(tab);
  }
  function sales(page) {
    const payload = state.sales;
    const summary = payload.summary || {};
    page.appendChild(U.info('Vendido nesta semana', C.currency.format(Number(summary.revenue || 0))));
    page.appendChild(U.node('p', (summary.sales_count || 0) + ' vendas', 'ps-copy'));
    const chart = U.node('div', null, 'ps-sales-chart');
    chart.setAttribute('role', 'img'); chart.setAttribute('aria-label', 'Vendas por dia da semana');
    const series = payload.daily_series || [];
    const max = Math.max(1, ...series.map(day => Number(day.revenue || 0)));
    series.forEach(day => {
      const col = U.node('div'); const bar = U.node('span', null, 'ps-sales-bar');
      bar.style.height = Math.max(2, Number(day.revenue || 0) / max * 100) + 'px';
      const date = new Date(day.date + 'T12:00:00-03:00');
      const name = Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('pt-BR', { weekday: 'short', timeZone: 'America/Sao_Paulo' });
      col.append(U.node('small', C.currency.format(Number(day.revenue || 0))), bar, U.node('b', name)); chart.appendChild(col);
    });
    if (series.length) page.appendChild(chart);
    (payload.sales || []).forEach(sale => {
      const row = U.node('div', null, 'ps-order-row');
      row.append(U.node('strong', U.orderLabel({ order_id: sale.id || sale.order_id, order_number: sale.order_number })), U.node('p', C.currency.format(Number(sale.total_amount || 0))));
      page.appendChild(row);
    });
    if (!(payload.sales || []).length) page.appendChild(U.node('p', 'Nenhuma venda nesta semana.', 'ps-copy'));
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
    const key = tab === 'partner-sales' ? 'sales' : tab === 'partner-stock' ? 'stock' : 'profile';
    const page = U.section(({ sales: 'Vendas', stock: 'Meus pneus', profile: 'Minha loja' })[key], () => C.partnerHome.open('partner-home'));
    if (key === 'profile') profile(page);
    else if (state.errors[key]) {
      page.append(U.node('p', 'Não consegui atualizar.', 'ps-copy'), U.button('TENTAR DE NOVO', () => void load(tab)));
    } else if (!state[key]) page.appendChild(U.node('p', 'Carregando…', 'ps-copy'));
    else if (key === 'sales') sales(page);
    else stock(page);
    U.mount(page, key);
  }
  function reset() { ++generation; Object.assign(state, { sales: null, stock: null, errors: {}, query: '' }); }
  C.partnerExtras = { load, render, reset };
}());
