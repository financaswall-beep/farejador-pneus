(function () {
  'use strict';
  const C = window.Caixa, U = C.partnerUI, S = () => C.partnerStore;
  const labels = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
  let generation = 0;
  function clockIcon() { return C.createSvg([{ d: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4v5l4 2' }]); }
  function clock() {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', weekday: 'short',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
    const value = type => parts.find(part => part.type === type)?.value || '';
    return { day: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(value('weekday')), time: value('hour') + ':' + value('minute') };
  }
  function preview(hours) {
    if (hours === null) return { state: 'unknown', text: 'Horário por dia ainda não definido.' };
    const current = clock(), today = hours.find(row => row.day === current.day);
    if (today && current.time >= today.opens_at && current.time < today.closes_at) return { state: 'open', text: 'Aberta até ' + today.closes_at };
    for (let offset = 0; offset <= 7; offset += 1) {
      const day = (current.day + offset) % 7, next = hours.find(row => row.day === day);
      if (!next || (offset === 0 && current.time >= next.opens_at)) continue;
      const when = offset === 0 ? 'hoje' : offset === 1 ? 'amanhã' : labels[day].toLocaleLowerCase('pt-BR');
      return { state: 'closed', text: 'Fechada · abre ' + when + ' às ' + next.opens_at };
    }
    return { state: 'closed', text: 'Todos os dias fechados' };
  }
  function open() {
    if (!S().owner() || !S().snapshot() || S().busy()) return;
    const version = ++generation, session = C.sessionFingerprint();
    const page = S().screen('Horário da loja', S().back); page.classList.add('ps-hours');
    page.appendChild(U.node('p', 'Defina quando sua loja atende.', 'ps-hours-subtitle'));
    const status = S().plate(), lamp = U.node('span', null, 'ps-hours-lamp');
    status.classList.add('ps-hours-status'); status.setAttribute('role', 'status');
    const statusText = U.node('strong', 'Carregando horários…'); status.append(lamp, statusText); page.appendChild(status);
    const form = U.node('form'); form.noValidate = true;
    const card = S().plate(); card.classList.add('ps-hours-card');
    const header = U.node('div', null, 'ps-hours-heading'), title = U.node('h3', 'Dias e horários'); title.prepend(clockIcon());
    const copy = U.button('Copiar segunda', () => copyMonday(), 'secondary'); copy.classList.add('ps-hours-copy'); copy.disabled = true;
    header.append(title, copy); card.appendChild(header);
    const columns = U.node('div', null, 'ps-hours-columns'); columns.setAttribute('aria-hidden', 'true');
    columns.append(U.node('span', 'Dia'), U.node('span'), U.node('span', 'Abre'), U.node('span', 'Fecha')); card.appendChild(columns);
    const rows = [], legacy = U.node('p', null, 'ps-hours-legacy'); let ready = false, dirty = false, saved = null;
    function values() { return rows.filter(row => row.enabled).map(row => ({ day: row.day, opens_at: row.opens.value, closes_at: row.closes.value })); }
    function renderStatus() {
      const hours = values(), invalid = rows.some(row => row.enabled && (!row.opens.value || !row.closes.value || row.closes.value <= row.opens.value));
      const result = invalid ? { state: 'unknown', text: 'Confira abertura e fechamento.' } : preview(saved === null && !dirty ? null : hours);
      status.dataset.state = result.state; statusText.textContent = 'Prévia: ' + result.text;
      save.disabled = !ready || (saved === null && !dirty);
    }
    function sync(row) {
      row.toggle.setAttribute('aria-checked', String(row.enabled)); row.el.dataset.open = String(row.enabled);
      row.opens.disabled = row.closes.disabled = !ready || !row.enabled;
      row.openWrap.hidden = row.closeWrap.hidden = !row.enabled; row.closed.hidden = row.enabled;
    }
    function input(day, kind, value) {
      const wrap = U.node('label', null, 'ps-hours-time'); wrap.appendChild(clockIcon());
      const control = U.node('input'); control.type = 'time'; control.value = value; control.step = '60'; control.disabled = true;
      control.required = true; control.setAttribute('aria-label', labels[day] + ': ' + kind); wrap.appendChild(control);
      control.addEventListener('input', () => { dirty = true; notice.textContent = ''; renderStatus(); }); return { wrap, control };
    }
    [1,2,3,4,5,6,0].forEach(day => {
      const el = U.node('div', null, 'ps-hours-row'); el.dataset.day = String(day);
      const toggle = U.node('button', null, 'ps-hours-toggle'); toggle.type = 'button'; toggle.disabled = true;
      toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-label', labels[day] + ': loja aberta'); toggle.appendChild(U.node('span'));
      const a = input(day, 'abertura', '08:00'), b = input(day, 'fechamento', day === 6 ? '14:00' : '18:00');
      const closed = U.node('span', 'Fechado', 'ps-hours-closed');
      const row = { day, el, toggle, enabled: false, opens: a.control, closes: b.control, openWrap: a.wrap, closeWrap: b.wrap, closed };
      toggle.addEventListener('click', () => { row.enabled = !row.enabled; dirty = true; notice.textContent = ''; sync(row); renderStatus(); });
      el.append(U.node('strong', labels[day]), toggle, a.wrap, b.wrap, closed); rows.push(row); sync(row); card.appendChild(el);
    });
    function copyMonday() {
      const monday = rows.find(row => row.day === 1);
      rows.filter(row => row.day >= 2 && row.day <= 5).forEach(row => {
        row.enabled = monday.enabled; row.opens.value = monday.opens.value; row.closes.value = monday.closes.value; sync(row);
      }); dirty = true; notice.textContent = ''; renderStatus(); C.showToast('Segunda copiada para terça a sexta.');
    }
    const notice = U.node('p', null, 'ps-error'); notice.setAttribute('role', 'alert');
    const save = S().action('SALVAR HORÁRIOS', () => {}, 'primary', 'check'); save.type = 'submit'; save.disabled = true;
    const cancel = U.button('Cancelar', S().back, 'secondary'); cancel.classList.add('ps-hours-cancel');
    form.append(card, legacy, U.node('p', 'O cliente verá os horários salvos.', 'ps-hours-help'), notice, save, cancel);
    page.appendChild(form);
    if (!S().show('hours', page)) return;
    function active() { return version === generation && session === C.sessionFingerprint() && page.isConnected; }
    async function load() {
      notice.textContent = '';
      try {
        const data = await C.partnerData.api('configuracoes/horarios'); if (!active()) return;
        if (!data.schema_ready) { statusText.textContent = 'Atualização dos horários ainda não disponível.'; return; }
        saved = Array.isArray(data.hours) ? data.hours : null;
        rows.forEach(row => { const period = saved?.find(value => value.day === row.day);
          row.enabled = Boolean(period); if (period) { row.opens.value = period.opens_at; row.closes.value = period.closes_at; } });
        ready = true; rows.forEach(row => { row.toggle.disabled = false; sync(row); }); copy.disabled = false;
        legacy.textContent = saved === null && data.legacy_text ? 'Horário atual: ' + data.legacy_text + '. Preencha os dias para atualizar.' : '';
        renderStatus();
      } catch (_) { if (active()) { statusText.textContent = 'Não consegui carregar os horários.';
        notice.textContent = 'Tente abrir esta tela novamente.'; } }
    }
    form.addEventListener('submit', event => {
      event.preventDefault(); if (!ready || S().busy()) return;
      const invalid = rows.find(row => row.enabled && (!row.opens.value || !row.closes.value || row.closes.value <= row.opens.value));
      if (invalid) { notice.textContent = labels[invalid.day] + ': o fechamento deve ser depois da abertura.'; invalid.closes.focus(); return; }
      const hours = values();
      void S().run(page, async current => {
        if (!current() || !active()) return;
        return C.partnerData.api('configuracoes/horarios', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hours }) });
      }, async () => { C.showToast('Horários salvos.'); S().back(); await S().load(true); }, notice);
    });
    void load();
  }
  C.partnerHours = { open, preview };
}());
