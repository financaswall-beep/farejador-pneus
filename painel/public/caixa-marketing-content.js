(function () {
  'use strict';
  const M = window.Caixa.marketing, V = M.V;
  const group = post => post.status === 'draft' ? 'draft' : post.status === 'scheduled' ? 'scheduled' : 'published';
  function mediaFor(post) { return M.publisher.mpMedia.find(media => media.id === post.media_id); }
  function thumbnail(post) { return post.image_url || mediaFor(post)?.thumbnail_url; }
  function postCard(post, hero = false) {
    const card = V.node('article', null, 'mk-card mk-post-card' + (hero ? ' is-hero' : ''));
    const thumb = V.image(thumbnail(post), post.title, 'mk-post-image');
    if (post.media_kind === 'video' || mediaFor(post)?.kind === 'video') {
      const duration = Number(mediaFor(post)?.duration), label = Number.isFinite(duration) && duration > 0 ? Math.round(duration) + 's' : 'Vídeo';
      const play = V.node('span', label, 'mk-video-label'); play.prepend(V.icon('play')); thumb.appendChild(play);
    }
    const copy = V.node('div', null, 'mk-post-copy'); copy.append(V.node('h4', post.title), V.networks(post.destinations || post.deliveries), V.badge(post.status));
    if (post.scheduled_at) copy.appendChild(V.node('small', V.date(post.scheduled_at), 'mk-muted'));
    const open = V.button(post.status === 'draft' ? 'Continuar edição' : 'Ver detalhes', () => openPost(post), 'mk-link', 'chevron');
    card.append(thumb, copy, open); return card;
  }
  function openPost(post) {
    if (M.busy()) return;
    const p = M.publisher;
    if (post.status === 'draft') { p.mpEdit(post); M.go('compose'); return; }
    const body = V.dialog(post.title);
    body.append(V.badge(post.status), V.node('p', post.caption || 'Sem legenda', 'mk-post-caption'));
    if (post.scheduled_at) body.appendChild(V.node('p', 'Horário de Brasília: ' + V.date(post.scheduled_at), 'mk-muted'));
    (post.deliveries || []).forEach(delivery => {
      const section = V.node('section', null, 'mk-delivery'); section.append(V.network(delivery.platform), V.badge(delivery.status));
      if (delivery.error_code) section.appendChild(V.node('p', p.mpErrorText({ message: delivery.error_code }), 'mk-muted'));
      const url = V.safeUrl(delivery.post_url, true);
      if (url) { const a = V.node('a', 'Ver na rede ↗', 'mk-link'); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; section.appendChild(a); }
      if (delivery.status === 'uncertain') section.appendChild(V.button('Conferir na rede', () => M.openReconciliation(post, delivery), 'mk-outline'));
      body.appendChild(section);
    });
    if (post.status === 'scheduled') body.appendChild(V.button('Alterar horário', () => reschedule(post), 'mk-primary', 'calendar'));
    if (['scheduled', 'draft'].includes(post.status)) body.appendChild(V.button('Cancelar publicação', () => void M.run(async () => { await p.mpAction(post, 'cancel'); if (!p.mpError) M.closeDialog(); }), 'mk-link is-danger'));
    if (['failed', 'partial'].includes(post.status) && post.deliveries?.some(d => d.status === 'failed')) {
      const retry = V.button('Repetir somente redes com falha', () => void M.run(async () => { await p.mpAction(post, 'retry'); if (!p.mpError) M.closeDialog(); }), 'mk-outline');
      V.disabled(retry, !p.mpConfig?.sending); body.appendChild(retry);
    }
    const result = V.button('Ver resultado deste conteúdo', async () => {
      M.closeDialog(); await M.loadResults();
      const row = M.state.results?.rows.find(row => row.publisher_id === post.id);
      if (row) M.openResult(row); else { p.mpMessage = 'O conteúdo ainda não apareceu nos resultados. Confira as confirmações de envio.'; M.status(); }
    }, 'mk-link', 'chart');
    if (['published', 'partial'].includes(post.status)) body.appendChild(result);
  }
  function reschedule(post) {
    const body = V.dialog('Alterar horário'), parts = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }).format(new Date(post.scheduled_at)).split(' ');
    const day = V.field('Data', 'date', parts[0]), time = V.field('Horário', 'time', parts[1]);
    day.input.min = window.FarejadorTime.dateKey(new Date()); day.input.required = true; time.input.required = true;
    const form = V.node('form'), pair = V.node('div', null, 'mk-field-pair'); pair.append(day.wrap, time.wrap); form.append(pair, V.node('p', 'Horário de Brasília. A alteração só é permitida antes do início do envio.', 'mk-muted'));
    let attempt;
    const confirm = V.node('button', 'Confirmar novo horário', 'mk-primary'); confirm.type = 'submit'; form.appendChild(confirm); body.appendChild(form);
    V.disabled(confirm, !M.publisher.mpConfig?.sending);
    form.addEventListener('submit', event => {
      event.preventDefault(); if (!form.reportValidity() || M.busy()) return;
      void M.run(async () => {
        if (!attempt) attempt = { version: post.version, scheduled_at: new Date(day.input.value + 'T' + time.input.value + ':00-03:00').toISOString() };
        day.input.readOnly = true; time.input.readOnly = true;
        await M.request('/admin/api/marketing/publisher/posts/' + post.id + '/reschedule', 'POST', attempt);
        M.publisher.mpMessage = 'Horário atualizado.'; await M.publisher.mpLoad(true); M.closeDialog();
      });
    });
  }
  M.pages.home = () => {
    const p = M.publisher, unavailable = !p.mpConfig?.enabled || !p.mpConfig?.schema_ready || p.mpWarnings.includes('publisher_posts_unavailable');
    document.querySelectorAll('[data-mk-filter]').forEach(button => {
      const selected = button.dataset.mkFilter, title = ({ draft: 'Rascunhos', scheduled: 'Agendados', published: 'Publicados' })[selected];
      const rows = p.mpPosts.filter(post => group(post) === selected);
      button.textContent = title + ' · ' + (unavailable ? '—' : rows.length); button.setAttribute('aria-pressed', String(selected === M.state.filter));
    });
    V.disabled(M.el('new'), !p.mpConfig?.enabled || !p.mpConfig?.schema_ready);
    const list = M.el('posts'); list.replaceChildren();
    if (unavailable) { V.empty(list, 'Não foi possível conferir as publicações. Atualize ou confira as configurações.'); return; }
    const term = M.el('search').value.trim().toLocaleLowerCase('pt-BR');
    const rows = p.mpPosts.filter(post => group(post) === M.state.filter && (!term || (post.title + ' ' + post.caption).toLocaleLowerCase('pt-BR').includes(term)));
    if (M.state.filter === 'scheduled') rows.sort((a, b) => Date.parse(a.scheduled_at) - Date.parse(b.scheduled_at));
    M.el('posts-title').textContent = ({ draft: 'Continue de onde parou', scheduled: 'Próximos envios', published: 'Histórico de publicações' })[M.state.filter];
    if (!rows.length) V.empty(list, 'Nenhum conteúdo encontrado nesta seleção.');
    rows.forEach((post, i) => list.appendChild(postCard(post, i === 0 && M.state.filter === 'scheduled')));
    if (p.mpPosts.length >= 200) list.appendChild(V.node('p', 'Exibindo as 200 publicações mais recentes da Central.', 'mk-muted'));
    if (p.mpWarnings.length) list.prepend(V.node('p', 'Algumas informações estão indisponíveis. Atualize para conferir.', 'mk-notice'));
  };
  M.pages.connections = () => {
    const p = M.publisher, list = M.el('connections-list'); list.replaceChildren();
    const config = p.mpConfig;
    if (config) {
      const status = V.node('section', null, 'mk-card'); status.append(V.node('h3', 'Central de Publicações'));
      [['Central habilitada', config.enabled], ['Estrutura disponível', config.schema_ready], ['Biblioteca disponível', config.storage_ready], ['Envio habilitado', config.sending], ['Sugestão de legenda disponível', config.ai_ready]].forEach(([label, enabled]) => {
        const row = V.node('div', null, 'mk-value-line'); row.append(V.node('span', label), V.node('strong', enabled ? 'Sim' : 'Não')); status.appendChild(row);
      }); list.appendChild(status);
    }
    p.mpConnections.forEach(connection => {
      const card = V.node('section', null, 'mk-card'); card.append(V.network(connection.platform), V.node('p', p.mpConnectionLabel(connection.platform)));
      if (connection.error_code) card.appendChild(V.node('p', p.mpConnectionError(connection.platform), 'mk-notice'));
      if (connection.missing_permissions?.length) card.appendChild(V.node('p', 'Permissões pendentes: ' + p.mpMissingPermissions(connection.platform), 'mk-muted'));
      list.appendChild(card);
    });
    if (!p.mpConnections.length) list.appendChild(V.node('p', 'Toque em Conferir conexões para consultar as permissões atuais.', 'mk-empty'));
  };
  M.openPost = openPost; M.postCard = postCard; M.reschedule = reschedule; M.mediaFor = mediaFor;
  document.querySelectorAll('[data-mk-filter]').forEach(button => button.addEventListener('click', () => { M.state.filter = button.dataset.mkFilter; M.render(); }));
  M.el('search').addEventListener('input', () => M.pages.home());
  M.el('search-toggle').addEventListener('click', () => { const field = M.el('search-field'); field.classList.toggle('hidden'); M.el('search-toggle').setAttribute('aria-expanded', String(!field.classList.contains('hidden'))); if (!field.classList.contains('hidden')) M.el('search').focus(); });
}());
