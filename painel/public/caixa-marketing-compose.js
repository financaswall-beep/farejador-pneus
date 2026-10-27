(function () {
  'use strict';
  const M = window.Caixa.marketing, V = M.V, T = window.FarejadorTime;
  const mark = () => { M.publisher.mpDirty = true; };
  function mediaPreview(host, compact = false) {
    const p = M.publisher, media = p.mpSelectedMedia(); host.replaceChildren();
    if (!media) { V.empty(host, 'Escolha uma foto ou um vídeo para começar.'); return; }
    const picture = V.image(media.thumbnail_url, media.name, compact ? 'mk-thumb' : 'mk-compose-image');
    picture.classList.toggle('is-video', media.kind === 'video');
    const preview = V.button('', () => void M.preview(media), compact ? 'mk-preview-small' : 'mk-preview-button'); preview.replaceChildren(picture); preview.setAttribute('aria-label', 'Ver ' + media.name);
    if (media.kind === 'video') { const badge = V.node('span', null, 'mk-video-label'); badge.append(V.icon('play'), V.node('span', media.duration ? Math.round(Number(media.duration)) + 's' : 'Vídeo')); picture.appendChild(badge); }
    host.appendChild(preview);
    if (compact) {
      const copy = V.node('div'); copy.append(V.node('strong', p.mpForm.title || media.name), V.node('small', media.kind === 'video' ? 'Vídeo' + (media.duration ? ' · ' + Math.round(Number(media.duration)) + ' segundos' : '') : 'Foto'));
      host.append(copy, V.button('Editar', () => M.go('compose'), 'mk-link'));
    } else host.appendChild(V.button('Trocar arquivo', () => { M.state.libraryReturn = 'compose'; M.go('library'); }, 'mk-link', 'refresh'));
  }
  M.pages.compose = () => {
    const p = M.publisher;
    M.el('post-title').value = p.mpForm.title; M.el('caption').value = p.mpForm.caption;
    M.el('caption-count').textContent = p.mpForm.caption.length + '/2200';
    mediaPreview(M.el('media-preview'));
    V.disabled(M.el('ai'), !p.mpConfig?.ai_ready);
    ['camera', 'gallery'].forEach(id => V.disabled(M.el(id), !p.mpConfig?.storage_ready || !p.mpConfig?.enabled));
  };
  function reviewControls() {
    const p = M.publisher, scheduled = p.mpWhen === 'schedule';
    document.querySelectorAll('[data-mk-when]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mkWhen === p.mpWhen)));
    M.el('schedule-fields').classList.toggle('hidden', !scheduled);
    M.el('submit').textContent = scheduled ? 'Confirmar agendamento' : 'Publicar agora';
    const destinations = p.mpForm.destinations.filter(d => d.selected).map(d => V.platform(d.platform));
    M.el('review-summary').textContent = destinations.length ? destinations.join(' e ') + (scheduled && p.mpDate ? ' · ' + T.formatDate(p.mpDate) + ', às ' + p.mpTime : ' · publicar agora') : 'Escolha onde publicar.';
  }
  M.pages.review = () => {
    const p = M.publisher, media = p.mpSelectedMedia(), host = M.el('destinations');
    mediaPreview(M.el('review-preview'), true); host.replaceChildren(); M.el('custom-fields').replaceChildren();
    p.mpForm.destinations.forEach(destination => {
      const row = V.node('div', null, 'mk-destination'), label = V.node('label', null, 'mk-check');
      const checkbox = V.node('input'); checkbox.type = 'checkbox'; checkbox.checked = destination.selected;
      checkbox.setAttribute('aria-label', 'Publicar no ' + V.platform(destination.platform));
      checkbox.addEventListener('change', () => { destination.selected = checkbox.checked; mark(); reviewControls(); });
      label.append(checkbox, V.network(destination.platform));
      const format = V.node('select'); format.setAttribute('aria-label', 'Formato no ' + V.platform(destination.platform));
      (media?.kind === 'video' ? ['reel', 'story'] : ['feed', 'story']).forEach(value => { const option = V.node('option', p.mpFormat(value)); option.value = value; format.appendChild(option); });
      format.value = destination.format; format.addEventListener('change', () => { destination.format = format.value; mark(); });
      row.append(label, format); host.appendChild(row);
      const caption = V.field('Legenda no ' + V.platform(destination.platform), 'textarea', destination.caption || '', value => { destination.caption = value; mark(); });
      caption.input.maxLength = 2200; M.el('custom-fields').appendChild(caption.wrap);
    });
    M.el('custom-enabled').checked = p.mpCustom; M.el('custom-fields').classList.toggle('hidden', !p.mpCustom);
    M.el('date').min = T.dateKey(new Date()); M.el('date').value = p.mpDate; M.el('time').value = p.mpTime;
    M.el('cleanup').checked = p.mpForm.delete_after_publish;
    reviewControls();
    host.appendChild(V.node('p', 'Feed e Story para fotos; Reel e Story para vídeos. No Story, o texto deve estar na própria mídia.', 'mk-muted'));
  };
  function validate() {
    const p = M.publisher;
    if (!p.mpSelectedMedia()) return 'Escolha uma foto ou um vídeo antes de continuar.';
    if (!p.mpForm.title.trim()) return 'Informe um nome para organizar este conteúdo.';
    return null;
  }
  M.el('new').addEventListener('click', () => { if (!M.busy()) { M.publisher.mpNew(); M.go('compose'); } });
  M.el('post-title').addEventListener('input', () => { M.publisher.mpForm.title = M.el('post-title').value; mark(); });
  M.el('caption').addEventListener('input', () => { M.publisher.mpForm.caption = M.el('caption').value; M.el('caption-count').textContent = M.el('caption').value.length + '/2200'; mark(); });
  M.el('continue').addEventListener('click', () => {
    const error = validate(); if (error) { M.publisher.mpError = error; M.status(); return; } M.go('review');
  });
  M.el('save').addEventListener('click', () => void M.run(async () => {
    if (!M.publisher.mpForm.title.trim()) throw Error('invalid_publisher_request');
    await M.publisher.mpSave();
  }));
  M.el('submit').addEventListener('click', () => {
    const p = M.publisher, error = validate();
    if (error) { p.mpError = error; M.status(); return; }
    const scheduled = p.mpWhen === 'schedule', id = p.mpForm.id;
    void M.run(async () => {
      await p.mpSubmit();
      if (!p.mpError && p.mpForm.id !== id) {
        M.state.page = scheduled ? 'calendar' : 'home';
        M.state.filter = scheduled ? 'scheduled' : 'published';
        const post = p.mpPosts.find(post => post.id === id);
        if (scheduled && post?.scheduled_at) { M.state.day = T.dateKey(new Date(post.scheduled_at)); M.state.month = M.state.day.slice(0, 7); }
        history.replaceState(null, '', '#marketing' + (scheduled ? '/agenda' : ''));
        M.el('content').scrollTop = 0;
      }
    });
  });
  document.querySelectorAll('[data-mk-when]').forEach(button => button.addEventListener('click', () => { M.publisher.mpWhen = button.dataset.mkWhen; mark(); reviewControls(); }));
  ['date', 'time'].forEach(id => M.el(id).addEventListener('input', () => { M.publisher[id === 'date' ? 'mpDate' : 'mpTime'] = M.el(id).value; mark(); reviewControls(); }));
  M.el('cleanup').addEventListener('change', () => { M.publisher.mpForm.delete_after_publish = M.el('cleanup').checked; mark(); });
  M.el('custom-enabled').addEventListener('change', () => { M.publisher.mpCustom = M.el('custom-enabled').checked; mark(); M.el('custom-fields').classList.toggle('hidden', !M.publisher.mpCustom); });
  M.el('camera').addEventListener('click', () => {
    const body = V.dialog('Capturar conteúdo');
    body.append(V.button('Tirar foto', () => { M.closeDialog(); M.el('photo-file').click(); }, 'mk-primary', 'camera'), V.button('Gravar vídeo', () => { M.closeDialog(); M.el('video-file').click(); }, 'mk-outline', 'play'));
  });
  M.el('gallery').addEventListener('click', () => M.el('gallery-file').click());
  M.el('library-upload').addEventListener('click', () => M.el('gallery-file').click());
  ['photo-file', 'video-file', 'gallery-file', 'resume-file'].forEach(id => M.el(id).addEventListener('change', event => void M.run(async () => {
    await M.publisher.mpUploadFiles(event, id === 'resume-file' ? M.publisher.mpResumeMedia : null);
    if (!M.publisher.mpError && M.state.page === 'library') M.state.page = 'compose';
  })));
  M.el('ai').addEventListener('click', () => {
    const p = M.publisher, body = V.dialog('Me ajude com a legenda'), brief = V.field('O que você quer divulgar?', 'textarea', p.mpBrief, value => { p.mpBrief = value; });
    brief.input.minLength = 5; brief.input.maxLength = 1200; brief.input.placeholder = 'Ex.: novidades da loja para quem usa moto';
    const form = V.node('form'), send = V.node('button', 'Gerar sugestão', 'mk-primary'); send.type = 'submit'; brief.input.required = true;
    form.append(brief.wrap, V.node('p', 'A sugestão só entra no rascunho. Confira as informações antes de publicar.', 'mk-muted'), send); body.appendChild(form);
    form.addEventListener('submit', event => { event.preventDefault(); if (form.reportValidity()) void M.run(async () => { await p.mpGenerateCaption(); if (!p.mpError) M.closeDialog(); }); });
  });
}());
