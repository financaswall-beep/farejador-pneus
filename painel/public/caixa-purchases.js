(function () {
  'use strict';
  const C = window.Caixa;
  const P = C.purchases = {};
  const s = P.state = { rows: [], page: 1, pages: 1, tab: 'pending', request: 0,
    suppliers: [], credit: false, draft: null, pending: null, preview: null, busy: false, session: '' };
  P.id = function (id) { return document.getElementById('purchase-' + id); };
  P.money = function (value) { return C.currency.format(Number(value || 0)); };
  P.today = function () { return window.FarejadorTime.dateKey(new Date()); };
  P.day = function (value) { return value ? window.FarejadorTime.formatCivilDate(String(value).slice(0, 10)) : '—'; };
  P.date = function (value) { return value ? window.FarejadorTime.formatDate(value) : '—'; };
  P.el = function (tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };
  P.button = function (label, action, cls) {
    const node = P.el('button', cls || 'pc-button', label);
    node.type = 'button'; node.addEventListener('click', action); return node;
  };
  P.icon = function (name) {
    const paths = { box: 'm3 7 9-5 9 5-9 5-9-5Zm0 0v10l9 5 9-5V7M12 12v10M7 4l10 6',
      truck: 'M1 3h14v14H1zM15 8h4l4 5v4h-8M6 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm12 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z',
      trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
      plus: 'M12 5v14M5 12h14', arrow: 'M5 12h14m-6-6 6 6-6 6' };
    return C.createSvg([{ d: paths[name] || paths.box }]);
  };
  P.tire = function (row) {
    const image = P.el('img', 'pc-tire'); image.alt = '';
    image.src = row.vehicle_type === 'car' ? '/operacao/catalog-tire-car.png' : '/operacao/catalog-tire.webp';
    image.width = 62; image.height = 76; image.loading = 'lazy'; return image;
  };
  P.condition = function (value) { return C.operationCatalogUtils.conditionLabel(value); };
  const errors = {
    forbidden: 'Compras está disponível para o proprietário da matriz com acesso ao estoque.',
    supplier_required: 'Escolha um fornecedor ou preencha o nome do novo fornecedor.',
    supplier_not_found: 'Fornecedor indisponível. Atualize a lista e escolha outro.',
    supplier_name_conflict: 'Esse fornecedor já existe. Selecione o cadastro existente.',
    supplier_duplicate: 'Esse fornecedor já existe. Selecione o cadastro existente.',
    wholesale_finance_disabled: 'Compras a prazo não estão habilitadas. Atualize os dados antes de continuar.',
    due_date_required: 'Informe o vencimento da compra.', due_date_before_purchase: 'O vencimento não pode ser anterior à compra.',
    installments_total_mismatch: 'A soma das parcelas deve ser igual ao total com frete e desconto.',
    installment_amount_invalid: 'Cada parcela precisa ter um valor maior que zero.',
    purchased_at_future: 'A data da compra não pode estar no futuro.', paid_at_future: 'O pagamento não pode estar no futuro.',
    received_at_future: 'O recebimento não pode estar no futuro.', received_before_purchase: 'O recebimento não pode ser anterior à compra.',
    payment_details_required: 'Informe a forma e a data do pagamento.', brand_required: 'Cadastre a marca deste pneu no catálogo.',
    purchase_discount_invalid: 'O desconto não pode ser maior que o valor da compra com frete.',
    discount_exceeds_purchase: 'O desconto não pode ser maior que o valor dos pneus recebidos com frete.',
    purchase_received_quantity_invalid: 'A quantidade recebida deve estar entre zero e a quantidade pedida.',
    purchase_receipt_items_incomplete: 'Os itens desta compra mudaram. Atualize a lista e confira novamente.',
    purchase_quantity_invalid: 'Confira as quantidades dos pneus.', vehicle_type_conflict: 'O tipo de veículo difere do cadastro. Confira o catálogo.',
    money_cent_precision: 'Use no máximo duas casas decimais nos valores.', unit_cost_cent_precision: 'Use no máximo duas casas decimais no custo.',
    purchase_already_confirmed: 'Esta compra já foi recebida. Atualize o histórico.',
    purchase_already_cancelled: 'Esta compra foi cancelada. Atualize a lista.',
    purchase_not_found: 'Compra não encontrada. Atualize a lista.',
    idempotency_conflict: 'Esta tentativa já existe com outros dados. Atualize o histórico antes de prosseguir.',
    idempotency_incomplete: 'A tentativa ainda não foi concluída. Tente novamente com os mesmos dados.',
  };
  P.message = function (error) {
    if (errors[error.message]) return errors[error.message];
    if (error.status >= 400 && error.status < 500) {
      const path = error.issues?.[0]?.path?.join('.') || '';
      return 'Confira os campos da compra' + (path ? ' (' + path + ')' : '') + '. ' +
        (error.status === 409 ? 'Atualize os dados antes de tentar novamente.' : 'Preencha datas, quantidades e valores válidos.');
    }
    return 'Não foi possível confirmar a resposta. Tente novamente; a mesma tentativa será retomada sem duplicar a compra.';
  };
  P.notice = function (text, good) {
    const node = P.id('notice'); node.textContent = text;
    node.className = 'pc-notice' + (good ? ' pc-success' : ''); node.hidden = !text;
  };
  P.request = async function (suffix, body) {
    if (!C.canModule('purchases') || !C.token()) throw new Error('invalid_session');
    const session = C.sessionFingerprint();
    const controller = new AbortController(); const timer = setTimeout(function () { controller.abort(); }, 25000);
    try {
      const response = await C.authenticatedFetch('/api/caixa/operacao/compras' + suffix, {
        signal: controller.signal, ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
      });
      const data = await C.json(response);
      if (session !== C.sessionFingerprint()) throw new Error('invalid_session');
      if (!response.ok) throw Object.assign(new Error(data.error || 'request_failed'), { status: response.status, issues: data.issues });
      return data;
    } finally { clearTimeout(timer); }
  };
  function storageKey() { return 'farejador_purchase_v1:' + C.scope() + ':' + C.stored(C.keys.user); }
  P.persist = function () {
    if (!C.token() || s.session !== C.sessionFingerprint()) return;
    try { sessionStorage.setItem(storageKey(), JSON.stringify({ draft: s.draft, pending: s.pending })); } catch { /* Memory still protects retries. */ }
  };
  P.restore = function () {
    const session = C.sessionFingerprint(); if (s.session === session) return;
    P.reset(); s.session = session;
    try { const saved = JSON.parse(sessionStorage.getItem(storageKey()) || '{}'); s.draft = saved.draft || null; s.pending = saved.pending || null; } catch { /* Start empty. */ }
  };
  P.reset = function () {
    if (P.prices) P.prices.reset(); s.tab = 'pending';
    s.request++; s.session = ''; s.rows = []; s.suppliers = []; s.draft = null; s.pending = null; s.preview = null; s.busy = false;
    P.id('dialog').close(); P.id('cards').replaceChildren(); P.id('items').replaceChildren(); P.id('catalog-results').replaceChildren();
    P.id('supplier').replaceChildren(); P.id('detail').replaceChildren(); P.id('form').reset(); P.notice('');
    P.id('wizard').hidden = true; P.id('home').hidden = false;
  };
  P.send = async function (suffix, body, detail) {
    if (s.busy) return null;
    s.busy = true;
    s.pending = s.pending || { suffix: suffix, body: body, detail: detail || null };
    P.persist(); const attempt = s.pending;
    const session = s.session;
    try {
      const result = await P.request(attempt.suffix, attempt.body);
      if (!result || typeof result.purchase_id !== 'string') throw new Error('invalid_response');
      s.pending = null;
      if (attempt.suffix !== '/confirmar') s.draft = null;
      s.preview = null; P.persist(); return result;
    } catch (error) {
      if (error.message === 'invalid_session') throw error;
      if (error.status >= 400 && error.status < 500 && !['idempotency_conflict', 'idempotency_incomplete'].includes(error.message)) {
        s.pending = null; P.persist();
      }
      throw error;
    } finally { if (session === s.session && session === C.sessionFingerprint()) s.busy = false; }
  };
  P.syncTab = function (tab) {
    const active = tab === 'purchases';
    document.getElementById('purchases-panel').classList.toggle('hidden', !active);
    C.elements.sessionView.classList.toggle('is-purchases', active);
    const nav = document.getElementById('nav-purchases'); nav.classList.toggle('active', active); nav.toggleAttribute('aria-current', active);
    if (!active && location.hash === '#compras') history.replaceState(null, '', location.pathname + location.search);
    if (active) {
      C.elements.appHeadingTitle.textContent = 'Compras'; P.restore();
      history.replaceState(null, '', location.pathname + location.search + '#compras');
      P.selectListTab(s.tab); void P.summary();
      if (s.pending?.suffix === '/confirmar') P.openDetail(s.pending.detail, true);
      else if (s.draft) void P.start();
    }
  };
  document.getElementById('nav-purchases').addEventListener('click', function () { C.showTab('purchases'); });
  window.addEventListener('storage', function (event) {
    if ([C.keys.token, C.keys.user, C.keys.scope, C.keys.slug].includes(event.key)) P.reset();
  });
}());
