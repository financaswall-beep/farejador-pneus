(function () {
  'use strict';
  const C = window.Caixa;
  const U = C.partnerUI;
  let request = null;
  let respond = null;
  let interval = 0;
  let busy = false;
  let error = '';
  function remaining() {
    const end = Date.parse(request?.expires_at || '');
    return Number.isFinite(end) ? Math.max(0, Math.ceil((end - Date.now()) / 1000)) : 0;
  }
  function timerText() {
    const value = remaining();
    return Math.floor(value / 60) + ':' + String(value % 60).padStart(2, '0');
  }
  function stop() { window.clearInterval(interval); interval = 0; }
  function tick() {
    const timer = document.getElementById('partner-waiting-time');
    if (timer) timer.textContent = timerText();
    if (!remaining()) { stop(); C.partnerHome.render(); }
  }
  async function answer(available) {
    if (busy || !respond || !request || !remaining()) return;
    const session = C.sessionFingerprint(); const current = request;
    busy = true; error = ''; render();
    try {
      // O produtor da solicitação fornece a resposta real; a tela não cria reservas.
      await respond(current.id, available);
      if (session !== C.sessionFingerprint() || request !== current) return;
      reset(); C.showToast(available ? 'Resposta enviada.' : 'Indisponibilidade informada.');
      await C.partnerHome.refresh();
      if (session === C.sessionFingerprint()) C.partnerHome.open('partner-home', true);
    } catch (failure) {
      if (session === C.sessionFingerprint() && request === current) error = U.errorMessage(failure);
    } finally {
      if (session === C.sessionFingerprint()) { busy = false; C.partnerHome.render(); }
    }
  }
  function render() {
    if (!request) return C.partnerOrders.home();
    const page = U.section('Cliente esperando', () => C.partnerHome.open('partner-home'));
    const timer = U.node('div', null, 'ps-timer');
    const clock = U.node('span', null, 'ps-clock'); clock.setAttribute('aria-hidden', 'true'); clock.appendChild(U.icon('clock'));
    const copy = U.node('p');
    copy.appendChild(document.createTextNode(remaining() ? 'Responda em ' : 'Prazo encerrado '));
    const digits = U.node('strong', timerText()); digits.id = 'partner-waiting-time'; copy.appendChild(digits);
    timer.append(clock, copy); page.append(timer, U.items(request.items));
    if (remaining()) {
      page.appendChild(U.node('h4', 'Tem esses pneus?', 'ps-question'));
      const yes = U.button(busy ? 'ENVIANDO…' : 'TENHO', () => void answer(true), 'primary', 'check');
      const no = U.button('NÃO TENHO', () => void answer(false), 'danger', 'close');
      yes.disabled = no.disabled = busy || !respond;
      page.append(yes, no);
    } else {
      page.append(U.node('p', 'Este pedido não aceita mais resposta.', 'ps-copy'), U.button('VOLTAR AOS PEDIDOS', () => C.partnerHome.open('partner-home'), 'secondary'));
    }
    if (error) { const el = U.node('p', error, 'ps-error'); el.setAttribute('role', 'alert'); page.appendChild(el); }
    U.mount(page, 'waiting');
  }
  function open(item, handler) {
    if (!C.isPartner() || !C.canModule('vendas') || !item?.id || !Array.isArray(item.items) || !Number.isFinite(Date.parse(item.expires_at))) return;
    reset(); request = item; respond = typeof handler === 'function' ? handler : null;
    C.partnerHome.open('partner-waiting');
    if (remaining()) interval = window.setInterval(tick, 1000);
  }
  function reset() { stop(); request = null; respond = null; busy = false; error = ''; }
  function sync(rows) {
    if (busy) return;
    const pending = rows.filter(item => Date.parse(item.expires_at) > Date.now()).sort((a, b) => Date.parse(a.expires_at) - Date.parse(b.expires_at));
    const first = pending[0];
    if (!first) { if (request && !request.demo) reset(); return; }
    const handler = (id, available) => C.partnerData.api('operacao/confirmacoes-estoque/' + encodeURIComponent(id), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ available, revision: first.revision }),
    });
    if (request?.id === first.id && request.revision === first.revision) return;
    C.playPartnerAlert?.();
    const home = ['partner-home', 'partner-sales', 'partner-stock'].includes(C.partnerHome.currentTab());
    if (home) open(first, handler);
    else { stop(); request = first; respond = handler; interval = window.setInterval(tick, 1000); }
  }
  C.partnerWaiting = { open, render, reset, stop, sync, current: () => request, remaining, busy: () => busy };
}());
