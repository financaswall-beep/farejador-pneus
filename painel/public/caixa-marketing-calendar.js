(function () {
  'use strict';
  const M = window.Caixa.marketing, V = M.V, T = window.FarejadorTime;
  const civil = value => T.dateKey(new Date(value));
  M.pages.calendar = () => {
    if (!M.state.month) M.state.month = civil(new Date()).slice(0, 7);
    const first = new Date(M.state.month + '-01T12:00:00Z'), count = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
    const names = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(first);
    M.el('month-label').textContent = names.charAt(0).toUpperCase() + names.slice(1);
    if (!M.state.day.startsWith(M.state.month)) M.state.day = civil(new Date()).startsWith(M.state.month) ? civil(new Date()) : M.state.month + '-01';
    const days = M.el('calendar-days'); days.replaceChildren();
    for (let i = 1; i <= count; i++) {
      const key = M.state.month + '-' + String(i).padStart(2, '0'), day = new Date(key + 'T12:00:00Z');
      const button = V.button('', () => { M.state.day = key; M.render(); }, 'mk-day');
      button.replaceChildren(V.node('small', new Intl.DateTimeFormat('pt-BR', { weekday: 'short', timeZone: 'UTC' }).format(day).replace('.', '')), V.node('strong', String(i)));
      button.setAttribute('aria-pressed', String(M.state.day === key)); button.setAttribute('aria-label', T.formatDate(key));
      if (M.publisher.mpPosts.some(post => post.status === 'scheduled' && post.scheduled_at && civil(post.scheduled_at) === key)) button.classList.add('has-post');
      days.appendChild(button);
    }
    const current = days.querySelector('[aria-pressed=true]'); requestAnimationFrame(() => { if (M.state.page === 'calendar' && current?.isConnected) days.scrollLeft = current.offsetLeft - days.offsetLeft - days.clientWidth / 2 + current.clientWidth / 2; });
    M.el('calendar-title').textContent = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(M.state.day + 'T12:00:00Z'));
    const host = M.el('calendar-posts'); host.replaceChildren();
    const rows = M.publisher.mpPosts.filter(post => post.status === 'scheduled' && post.scheduled_at && civil(post.scheduled_at) === M.state.day).sort((a, b) => Date.parse(a.scheduled_at) - Date.parse(b.scheduled_at));
    if (!M.publisher.mpConfig?.schema_ready || M.publisher.mpWarnings.includes('publisher_posts_unavailable')) { V.empty(host, 'Agenda indisponível. Atualize para conferir.'); return; }
    if (!rows.length) V.empty(host, 'Nenhuma publicação agendada para este dia.');
    rows.forEach(post => {
      const row = V.node('div', null, 'mk-calendar-row'), at = V.node('strong', new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }).format(new Date(post.scheduled_at)), 'mk-at');
      const card = M.postCard(post), actions = V.node('div', null, 'mk-calendar-actions');
      actions.append(card.querySelector('.mk-link'), V.button('Alterar horário', () => M.reschedule(post), 'mk-link', 'calendar')); card.appendChild(actions);
      row.append(at, card); host.appendChild(row);
    });
    host.appendChild(V.node('p', 'Horários de Brasília.', 'mk-muted'));
  };
  function move(delta) {
    const value = M.state.month || civil(new Date()).slice(0, 7), d = new Date(value + '-01T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() + delta);
    M.state.month = d.toISOString().slice(0, 7); M.render();
  }
  M.el('month-prev').addEventListener('click', () => move(-1)); M.el('month-next').addEventListener('click', () => move(1));
  M.el('past').addEventListener('click', () => { M.state.filter = 'published'; M.go('home'); });
}());
