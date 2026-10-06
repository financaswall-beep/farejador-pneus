(function () {
  'use strict';
  const C = window.Caixa;
  const U = C.partnerUI;
  let page = null;
  let view = 'home';
  let config = null;
  let loading = false;
  let saving = false;
  let error = '';
  let generation = 0;
  const owner = () => C.isPartner() && Boolean(C.token()) && C.stored(C.keys.role) === 'owner';
  const paths = {
    people: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM2 22v-4a7 7 0 0 1 14 0v4M17 4a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 4v4',
    clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4v5l4 2',
    sound: 'M3 9h4l6-5v16l-6-5H3V9Zm13-1a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14',
    exit: 'M10 3H3v18h7m4-15 6 6-6 6M8 12h12',
    arrow: 'm9 5 7 7-7 7',
  };
  function icon(kind) {
    if (['clock', 'people', 'delivery', 'sound'].includes(kind)) {
      const el = U.node('span', null, 'ps-store-art-icon ps-store-art-icon--' + kind);
      el.setAttribute('aria-hidden', 'true'); return el;
    }
    if (kind === 'exit') return C.createSvg([
      { d: 'M10 3H3v18h7', 'stroke-width': '3.2' },
      { d: 'm14 6 6 6-6 6M8 12h12', stroke: '#075b36', 'stroke-width': '3.2' },
    ], 'ps-store-exit-art');
    return paths[kind] ? C.createSvg([{ d: paths[kind] }], 'ps-store-arrow-art') : U.icon(kind);
  }
  function pins(el) {
    ['tl', 'tr', 'bl', 'br'].forEach(corner => {
      const pin = U.node('i', null, 'ps-store-screw ps-store-screw--' + corner);
      pin.setAttribute('aria-hidden', 'true'); el.appendChild(pin);
    });
  }
  function plate(tag = 'div') {
    const el = U.node(tag, null, 'ps-store-plate'); pins(el); return el;
  }
  function screen(title, back) {
    const el = U.section(title, back); el.classList.add('ps-store'); return el;
  }
  function action(label, handler, kind = 'primary', symbol) {
    const el = U.button(label, handler, kind, symbol); el.classList.add('ps-store-action'); return el;
  }
  function row(title, text, kind, handler, disabled) {
    const el = plate('button'); el.type = 'button'; el.classList.add('ps-store-row');
    el.setAttribute('aria-label', title); el.disabled = Boolean(disabled);
    const copy = U.node('span', null, 'ps-store-copy');
    copy.append(U.node('strong', title), U.node('span', text));
    el.append(icon(kind), copy, icon('arrow')); el.addEventListener('click', handler); return el;
  }
  function soundRow() {
    const enabled = localStorage.getItem(C.keys.notifications) !== 'false';
    const el = U.node('div', null, 'ps-store-sound');
    const copy = U.node('div', null, 'ps-store-copy');
    copy.append(U.node('strong', 'Som dos avisos'), U.node('span', enabled ? 'Ativado neste aparelho' : 'Desativado neste aparelho'));
    const toggle = U.node('button', null, 'ps-store-switch'); toggle.type = 'button';
    toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-checked', String(enabled));
    toggle.setAttribute('aria-label', 'Som dos avisos');
    toggle.appendChild(U.node('span'));
    toggle.addEventListener('click', () => { C.elements.notificationsToggle.click(); refresh(); });
    el.append(icon('sound'), copy, toggle); return el;
  }
  function home() {
    const el = screen('Minha loja', () => C.partnerHome.open('partner-home'));
    el.classList.add('ps-store--home');
    const identity = U.node('div', null, 'ps-store-identity');
    identity.append(U.node('strong', C.stored(C.keys.name) || 'Operador'), U.node('p', owner() ? 'Responsável pela loja' : 'Funcionário da loja'));
    el.appendChild(identity);
    if (owner()) {
      const loja = config?.loja;
      const list = U.node('div', null, 'ps-store-menu');
      list.append(row('Horário da loja', loja?.opening_hours_text || (loading ? 'Carregando…' : 'Informe seus horários'), 'clock', () => C.partnerStoreForm.hours(), !loja));
      list.append(row('Funcionários', 'Gerencie sua equipe', 'people', () => C.partnerTeam.open()));
      const radius = Number(loja?.delivery_radius_km);
      const delivery = loja?.faz_entrega ? (radius > 0 ? 'Entrega até ' + radius.toLocaleString('pt-BR') + ' km' : 'Entrega disponível') : 'Somente retirada';
      list.append(row('Retirada e entrega', loja ? delivery : 'Configure o atendimento', 'delivery', () => C.partnerStoreForm.service(), !loja));
      el.appendChild(list);
      if (error) {
        const notice = U.node('p', error, 'ps-error'); notice.setAttribute('role', 'alert'); el.appendChild(notice);
        el.appendChild(action('TENTAR DE NOVO', () => load(true)));
      }
    }
    el.appendChild(soundRow());
    const logout = action('SAIR DA CONTA', () => C.elements.logout.click(), 'secondary');
    logout.prepend(icon('exit')); logout.classList.add('ps-store-logout'); pins(logout); el.appendChild(logout); return el;
  }
  function render() {
    if (!C.isPartner() || !C.token()) return;
    if (!page) page = home();
    if (U.root.children[0] !== page) U.mount(page, 'store');
  }
  function refresh() { if (view === 'home') page = null; render(); }
  function show(next, el) {
    if (!owner() || saving) return false;
    view = next; page = el; render(); U.root.scrollTop = 0; return true;
  }
  function back() { if (saving) return; C.partnerTeam?.reset(); view = 'home'; page = null; render(); }
  async function load(force) {
    if (!owner() || loading || (config && !force)) return;
    const version = generation; const session = C.sessionFingerprint(); loading = true; error = ''; refresh();
    try {
      const data = await C.partnerData.api('configuracoes');
      if (version !== generation || session !== C.sessionFingerprint()) return;
      if (!data.loja) throw new Error('unit_not_found');
      config = data;
    } catch (_) {
      if (version === generation && session === C.sessionFingerprint()) error = 'Não consegui carregar os ajustes da loja.';
    } finally {
      if (version === generation && session === C.sessionFingerprint()) { loading = false; refresh(); }
    }
  }
  async function run(el, operation, success, notice) {
    if (!owner() || saving) return;
    const version = generation; const session = C.sessionFingerprint(); saving = true;
    const controls = [...el.querySelectorAll('button,input,select,textarea')];
    const previous = controls.map(control => control.disabled); controls.forEach(control => { control.disabled = true; });
    notice.textContent = '';
    try {
      const result = await operation(() => version === generation && session === C.sessionFingerprint());
      if (version === generation && session === C.sessionFingerprint()) { saving = false; await success(result); }
    } catch (failure) {
      if (version === generation && session === C.sessionFingerprint()) notice.textContent = failure?.message === 'username_taken'
        ? 'Esse login já está em uso. Escolha outro.' : failure?.status === 403 ? 'Apenas o dono pode alterar estes dados.' : 'Não consegui salvar. Confira os dados e tente novamente.';
    } finally {
      if (version === generation && session === C.sessionFingerprint()) { saving = false; controls.forEach((control, index) => { control.disabled = previous[index]; }); }
    }
  }
  function leave() { generation += 1; page = null; view = 'home'; config = null; loading = false; saving = false; error = ''; C.partnerTeam?.reset(); }
  C.partnerStore = { render, load, back, show, screen, action, plate, row, icon, run, owner, leave,
    snapshot: () => config?.loja, busy: () => saving, generation: () => generation };
}());
