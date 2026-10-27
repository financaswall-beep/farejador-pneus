(function () {
  'use strict';
  const M = window.Caixa.marketing, V = M.V;
  M.pages.library = () => {
    const p = M.publisher, host = M.el('library-items'); host.replaceChildren();
    V.disabled(M.el('library-upload'), !p.mpConfig?.enabled || !p.mpConfig?.storage_ready);
    M.el('library-note').textContent = p.mpConfig?.storage_ready ? 'Fotos: até ' + p.mpBytes(p.mpConfig.max_photo_bytes || Math.min(8388608, p.mpConfig.max_file_bytes)) + '. Vídeos: até ' + p.mpBytes(p.mpConfig.max_file_bytes) + '. O ajuste para cada rede é automático. Envios interrompidos podem ser retomados.' : 'A biblioteca está indisponível. Confira a Central e tente atualizar.';
    document.querySelectorAll('[data-mk-kind]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mkKind === p.mpKind)));
    if (p.mpWarnings.includes('publisher_library_unavailable')) { V.empty(host, 'Não foi possível carregar a biblioteca. Atualize para conferir seus arquivos.'); return; }
    const items = p.mpVisibleMedia();
    if (!items.length) V.empty(host, 'Nenhum arquivo encontrado. Adicione uma foto ou um vídeo.');
    items.forEach(media => {
      const card = V.node('article', null, 'mk-card mk-library-item'), ready = !p.mpMediaNeedsRecovery(media);
      const preview = V.button('', () => void M.preview(media), 'mk-library-preview'); preview.replaceChildren(V.image(media.thumbnail_url, media.name, 'mk-library-image')); preview.setAttribute('aria-label', 'Ver ' + media.name); V.disabled(preview, !ready);
      card.append(preview, V.node('strong', media.name), V.node('small', p.mpMediaSize(media) + (media.duration ? ' · ' + Math.round(Number(media.duration)) + 's' : ''), 'mk-muted'));
      if (ready) card.appendChild(V.button('Usar esta mídia', () => { p.mpSelectMedia(media); M.go('compose'); }, 'mk-primary'));
      else {
        card.appendChild(V.badge(media.status));
        if (p.mpMediaCanFinalize(media)) card.appendChild(V.button('Conferir arquivo', () => void M.run(() => p.mpReprocessMedia(media)), 'mk-outline'));
        else card.appendChild(V.button('Continuar envio', () => { p.mpResumeMedia = media; M.el('resume-file').click(); }, 'mk-outline'));
      }
      if (media.error_code) card.appendChild(V.node('p', p.mpErrorText({ message: media.error_code }), 'mk-muted'));
      card.appendChild(V.button('Remover', () => void M.run(() => p.mpRemoveMedia(media)), 'mk-link is-danger', 'trash')); host.appendChild(card);
    });
    if (p.mpMedia.length >= 100) host.appendChild(V.node('p', 'Exibindo os 100 arquivos mais recentes.', 'mk-muted'));
  };
  M.preview = async (media, format) => {
    if (!M.active() || M.busy()) return;
    const id = M.nextRequest(), p = M.publisher, page = M.state.page; p.mpPreview = null;
    const operation = p.mpOpenPreview(media, format); M.status(); await operation;
    if (!M.isCurrent(id) || p !== M.publisher || M.state.page !== page) return;
    M.status();
    const preview = p.mpPreview;
    if (!preview || !V.safeUrl(preview.url)) return;
    const body = V.dialog((format ? p.mpFormat(format) + ' · ' : '') + media.name);
    if (media.kind === 'video') { const video = V.node('video'); video.controls = true; video.playsInline = true; video.preload = 'metadata'; video.src = preview.url; video.setAttribute('aria-label', media.name); body.appendChild(video); }
    else body.appendChild(V.image(preview.url, media.name, 'mk-full-image'));
    if (preview.width && preview.height) body.appendChild(V.node('p', preview.width + ' × ' + preview.height + ' · Ajustado sem cortes', 'mk-muted'));
    M.status();
  };
  function open() { M.state.libraryReturn = ['compose', 'review'].includes(M.state.page) ? M.state.page : 'home'; M.go('library'); }
  M.el('library').addEventListener('click', open); M.el('library-home').addEventListener('click', open);
  M.el('media-search').addEventListener('input', () => { M.publisher.mpSearch = M.el('media-search').value; M.pages.library(); });
  document.querySelectorAll('[data-mk-kind]').forEach(button => button.addEventListener('click', () => { M.publisher.mpKind = button.dataset.mkKind; M.render(); }));
}());
