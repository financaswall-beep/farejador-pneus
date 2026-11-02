(function () {
  'use strict';
  const C = window.Caixa, P = C.purchases;
  const G = C.purchaseTrips = { state: { mode: 'orders', rows: [], options: [], detail: null, page: 1, more: false, tab: 'expenses', busy: false, request: 0, session: '' } };
  const s = G.state;
  G.id = name => document.getElementById('vg-' + name);
  G.allowed = () => !C.isPartner() && C.canModule('purchases') && C.stored(C.keys.role) === 'owner' && Boolean(C.token());
  G.api = (suffix, body) => P.request('/viagens' + suffix, body);
  G.error = error => ({ purchase_group_closed: 'Esta viagem está fechada. Reabra para alterar os vínculos.',
    purchase_group_not_empty: 'Desvincule as compras e os gastos antes de excluir.', purchase_already_grouped: 'Esta compra já está em uma viagem.',
    expense_already_grouped: 'Este gasto já está em uma viagem.', expense_owned_by_other_module: 'Este gasto pertence a uma rota, folha ou comissão.',
    purchase_order_split_across_groups: 'As compras da mesma OC precisam ficar na mesma viagem.',
    idempotency_conflict: 'Esta tentativa tem outros dados. Confira o resultado antes de tentar novamente.',
    purchase_group_not_found: 'Viagem não encontrada. Atualize a lista.', invalid_session: 'Sua sessão mudou. Entre novamente.'
  }[error.message] || 'Não foi possível concluir. Tente novamente; a mesma tentativa será retomada.');
  G.notice = message => { G.id('error').textContent = message || ''; G.id('error').hidden = !message; };
  G.mutate = async (suffix, body) => {
    if (s.busy) throw Error('busy');
    const session = C.sessionFingerprint(), subject = 'farejador.trip:' + session + ':' + suffix + ':' + JSON.stringify(body);
    let key; try { key = sessionStorage.getItem(subject) || crypto.randomUUID(); sessionStorage.setItem(subject, key); }
    catch { throw Error('storage_unavailable'); }
    s.busy = true;
    try { const result = await G.api(suffix, { ...body, idempotency_key: key }); sessionStorage.removeItem(subject); return result; }
    finally { if (session === C.sessionFingerprint()) s.busy = false; }
  };
  G.loadOptions = async () => {
    const rows = []; let page = 1, more = true;
    while (more) { const result = await G.api('?limit=100&page=' + page++); rows.push(...result.rows); more = result.has_more; }
    s.options = rows; return rows;
  };
  G.load = async () => {
    const ticket = ++s.request; G.notice(''); G.id('loading').hidden = false;
    try { const result = await G.api('?page=' + s.page); if (ticket !== s.request) return;
      s.rows = result.rows; s.more = result.has_more; G.view.list(); }
    catch (error) { if (ticket === s.request) G.notice(G.error(error)); }
    finally { if (ticket === s.request) G.id('loading').hidden = true; }
  };
  G.mode = value => {
    s.mode = value; const trips = value !== 'orders';
    P.id('home').classList.toggle('vg-trip-mode', trips); P.id('home').classList.toggle('vg-detail-mode', value === 'detail');
    G.id('home').hidden = !trips; G.id('tabs').hidden = value === 'detail';
    ['orders', 'trips'].forEach(name => G.id('section-' + name).setAttribute('aria-selected', String(trips === (name === 'trips'))));
    if (trips) { P.id('wizard').hidden = true; P.id('home').hidden = false; }
  };
  G.open = async id => {
    if (!G.allowed()) return;
    C.showTab('purchases'); P.id('dialog').close(); P.notice(''); G.mode('detail'); G.notice('');
    const ticket = ++s.request; G.id('loading').hidden = false; G.id('content').replaceChildren();
    try { const detail = await G.api('/' + id); if (ticket !== s.request) return;
      s.detail = detail; G.view.detail(); document.getElementById('purchases-panel').scrollTop = 0; }
    catch (error) { if (ticket === s.request) G.notice(G.error(error)); }
    finally { if (ticket === s.request) G.id('loading').hidden = true; }
  };
  G.list = () => { G.mode('trips'); s.detail = null; void G.load(); };
  G.link = async (group, kind, id, unlink) => {
    try { await G.mutate('/' + group + '/vinculo', { kind, record_id: id, unlink: Boolean(unlink) });
      G.id('dialog').close(); await G.open(group); }
    catch (error) { G.notice(G.error(error)); if (G.id('dialog').open) { const message = G.id('dialog-error'); message.hidden = false; message.textContent = G.error(error); } }
  };
  G.action = async action => {
    if (!s.detail || s.busy) return;
    try { await G.mutate('/' + s.detail.group.id + '/acao', { action });
      if (action === 'delete') G.list(); else await G.open(s.detail.group.id); }
    catch (error) { G.notice(G.error(error)); }
  };
  G.receipt = expense => {
    if (!expense.receipt_id) { C.showToast('Este gasto não tem comprovante anexado.'); return; }
    void window.ExpenseReceiptViewer.show('/api/caixa/financeiro-despesas/comprovantes/' + expense.receipt_id + '/imagem', C.authenticatedFetch);
  };
  const thumbnails = new Map();
  G.thumbnail = (receiptId, image) => {
    const session = C.sessionFingerprint();
    if (!thumbnails.has(receiptId)) thumbnails.set(receiptId, C.authenticatedFetch('/api/caixa/financeiro-despesas/comprovantes/' + receiptId + '/imagem')
      .then(response => { if (!response.ok) throw Error('image_unavailable'); return response.blob(); })
      .then(blob => { if (session !== C.sessionFingerprint()) return null; return URL.createObjectURL(blob); }).catch(() => null));
    void thumbnails.get(receiptId).then(url => { if (url && session === C.sessionFingerprint() && image.isConnected) image.src = url; });
  };
  G.sync = tab => {
    const session = C.sessionFingerprint();
    if (s.session && s.session !== session) G.reset(); s.session = session;
    if (tab !== 'purchases') { G.id('dialog').close(); s.request++; }
    else if (G.allowed()) { G.mode(s.mode); if (s.mode === 'trips') void G.load(); }
    G.expense?.sync(tab);
  };
  G.reset = () => { thumbnails.forEach(promise => void promise.then(url => { if (url) URL.revokeObjectURL(url); })); thumbnails.clear();
    s.request++; s.mode = 'orders'; s.rows = []; s.options = []; s.detail = null; s.busy = false;
    G.id('dialog').close(); G.id('content').replaceChildren(); G.mode('orders'); G.expense?.reset(); };
  G.blockNavigation = () => { if (!s.busy) return false; C.showToast('Aguarde a confirmação da viagem.'); return true; };
  G.id('section-orders').addEventListener('click', () => { G.mode('orders'); });
  G.id('section-trips').addEventListener('click', G.list);
  const start = P.start;
  P.start = function (...args) { G.mode('orders'); return start(...args); };
  const reset = P.reset;
  P.reset = function () { reset(); G.reset(); };
}());
