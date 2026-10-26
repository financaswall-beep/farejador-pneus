(function () {
  'use strict';
  const C = window.Caixa, V = C.catalogMetalView, e = V.e, icon = V.iconHTML;
  const button = (text, action, primary = false, symbol = '', disabled = false) => '<button type="button" class="mcg-button mcg-' + (primary ? 'primary' : 'secondary') + '" data-action="' + action + '"' + (disabled ? ' disabled' : '') + '>' + (symbol ? icon(symbol) : '') + '<span>' + e(text) + '</span></button>';
  const head = (title, action = 'back') => '<header class="mcg-heading">' + button('', action, false, 'back') + '<h2 tabindex="-1">' + e(title) + '</h2></header>';
  function identity(row) { return '<section class="mcg-plate mcg-media-product"><img src="/operacao/assets/partner-replenishment-tire-v1.webp" alt=""><div><strong>' + e(row.tire_size) + '</strong><p>' + e([row.brand, C.operationCatalogUtils.conditionLabel(row.tire_condition)].filter(Boolean).join(' · ')) + '</p><small>' + e(row.product_code || row.product_name) + '</small></div></section>'; }
  function photoTag(photo, ctx, className = '') { return '<img class="' + className + '" data-mcph-image="' + e(photo.id) + '" src="' + e(ctx.image(photo)) + '" alt="Foto do pneu">'; }
  const photoName = angle => ({ front: 'Frente', side: 'Lateral', detail: 'Detalhe' })[angle];
  function mediaCount(row) { const parts = []; if (row.photos?.length) parts.push(row.photos.length + (row.photos.length === 1 ? ' foto' : ' fotos')); if (row.video) parts.push('1 vídeo'); return parts.join(' e ') || 'Sem fotos ou vídeo'; }
  function usage(row, busy) { return '<label class="mcg-media-switch mcg-plate"><span>Liberar fotos e vídeo no bot</span><input id="mcph-app-enabled" type="checkbox"' + (row.enabled ? ' checked' : '') + (busy ? ' disabled' : '') + '></label>'; }
  function gallery(ctx) {
    const { app } = ctx, s = app.matrixPhotos;
    let html = '<div class="mcg-media-search"><input id="mcph-app-search" type="search" maxlength="100" placeholder="Medida, marca ou modelo" aria-label="Buscar mídia do pneu" value="' + e(s.search) + '"></div><nav class="mcg-filters" aria-label="Situação das mídias">';
    [['all', 'Todos'], ['missing', 'Sem mídia'], ['ready', 'Prontos'], ['error', 'Com erro']].forEach(([value, label]) => { html += '<button type="button" class="mcg-button' + (s.filter === value ? ' active' : '') + '" data-filter="' + value + '" aria-pressed="' + (s.filter === value) + '">' + label + '</button>'; }); html += '</nav>';
    if (s.loading) return html;
    html += '<div class="mcg-cards">'; app.mcphPageRows().forEach(row => {
      const has = row.photos?.length || row.video;
      html += '<article class="mcg-plate mcg-media-card"><img src="/operacao/assets/partner-replenishment-tire-v1.webp" alt=""><div><strong>' + e(row.tire_size) + '</strong><p>' + e([row.brand, C.operationCatalogUtils.conditionLabel(row.tire_condition)].filter(Boolean).join(' · ')) + '</p><span class="mcg-badge' + (has ? '' : ' mcg-amber') + '">' + e(mediaCount(row)) + '</span>';
      if (has && !row.enabled) html += '<small>Uso no bot pausado</small>';
      html += '<button type="button" class="mcg-button mcg-' + (has ? 'secondary' : 'primary') + '" data-product="' + e(row.product_id) + '">' + (has ? 'Ver mídia' : 'Adicionar') + icon('next') + '</button></div></article>';
    }); html += '</div>';
    if (!app.mcphFiltered().length) html += '<p class="mcg-notice">Nenhum pneu encontrado. Cadastre o produto antes de adicionar fotos.</p>';
    if (app.mcphFiltered().length > 12) html += '<nav class="mcg-media-pager">' + '<button type="button" class="mcg-button" data-page="-1"' + (s.page <= 1 ? ' disabled' : '') + '>Anterior</button><span>Página ' + s.page + '</span><button type="button" class="mcg-button" data-page="1"' + (s.page * 12 >= app.mcphFiltered().length ? ' disabled' : '') + '>Próxima</button></nav>';
    return html;
  }
  function photos(ctx, row) {
    const { app } = ctx, s = app.matrixPhotos, photo = app.mcphPhoto(), busy = s.busy || !s.storageReady;
    let html = head('Fotos do pneu') + identity(row) + '<section class="mcg-plate mcg-media-viewer">';
    if (photo) html += photoTag(photo, ctx, 'mcg-photo-hero') + (photo.is_primary ? '<span class="mcg-photo-primary">' + icon('check') + 'Principal</span>' : '');
    else html += '<div class="mcg-no-photo">' + icon('camera') + '<strong>Adicione uma foto</strong><p>Uma foto basta. Os outros ângulos são opcionais.</p></div>';
    html += '</section><nav class="mcg-thumbnails" aria-label="Ângulo da foto">';
    ['front', 'side', 'detail'].forEach(angle => { const image = app.mcphPhoto(row, angle); html += '<button type="button" class="mcg-angle' + (s.angle === angle ? ' active' : '') + '" data-angle="' + angle + '" aria-pressed="' + (s.angle === angle) + '"' + (s.busy ? ' disabled' : '') + '>' + (image ? photoTag(image, ctx) : icon('camera')) + '<span>' + photoName(angle) + '</span></button>'; });
    html += '</nav>';
    if (photo?.is_primary) html += '<p class="mcg-badge mcg-primary-notice">' + icon('check') + 'Foto principal do atendimento</p>';
    else if (photo) html += button('Usar como principal', 'primary', false, 'check', s.busy);
    html += '<div class="mcg-media-actions">' + button('Tirar foto', 'camera', true, 'camera', busy) + button('Escolher foto', 'file', false, 'photo', busy) + '</div>';
    html += '<p class="mcg-hint">Marca d’água e tamanho ajustados automaticamente.</p>' + usage(row, s.busy);
    html += button(row.video ? 'Ver vídeo do pneu' : 'Adicionar vídeo', 'media-video', false, 'video', s.busy) + button('Prévia para o cliente', 'preview', false, 'photo', s.busy || !app.mcphPrimary());
    return html;
  }
  function video(ctx, row) {
    const s = ctx.app.matrixPhotos, busy = s.busy || !s.storageReady;
    let html = head('Vídeo do pneu', 'media-photos') + identity(row);
    if (row.video) {
      const src = ctx.videoSource(row.video);
      html += '<section class="mcg-plate mcg-video-viewer"><video data-mcph-video="' + e(row.video.id) + '"' + (src ? ' src="' + e(src) + '"' : '') + ' controls playsinline preload="metadata" aria-label="Vídeo do pneu"></video><p class="mcg-badge">' + icon('check') + 'Vídeo pronto · ' + e(ctx.app.mcphVideoSize(row.video)) + '</p></section>';
    } else html += '<section class="mcg-plate mcg-no-photo">' + icon('video') + '<strong>Nenhum vídeo cadastrado</strong><p>Grave ou escolha um vídeo deste pneu.</p></section>';
    html += button('Gravar vídeo', 'video-camera', true, 'video', busy) + button('Escolher vídeo', 'video-file', false, 'photo', busy);
    html += '<p class="mcg-hint">Até 15 segundos. Marca d’água e redução do tamanho automáticas.</p>' + usage(row, s.busy) + '<p class="mcg-hint">O bot envia o vídeo quando o cliente pede.</p>';
    return html;
  }
  function preview(ctx, row) {
    const photo = ctx.app.mcphPrimary();
    return head('Prévia do envio', 'close-preview') + identity(row) + '<div class="mcg-preview"><p class="mcg-preview-in">Pode me mandar a foto desse pneu?</p><p class="mcg-preview-out">Olha a foto aí, amigo.</p>' + (photo ? photoTag(photo, ctx, 'mcg-preview-image') : '') + '</div><p class="mcg-notice">Somente prévia. Nenhuma mensagem foi enviada.</p>' + button('Voltar às fotos', 'close-preview', true, 'back');
  }
  function render(ctx) {
    const { app, host } = ctx, s = app.matrixPhotos, row = s.selected;
    C.matrixCatalogMetal?.mediaChanged(s);
    const mode = !row ? 'gallery' : s.preview ? 'preview' : s.screen || 'photos', same = host.dataset.mediaView === mode && host.dataset.product === row?.product_id;
    const panel = C.elements.catalogPanel, scroll = panel.scrollTop;
    const focused = host.contains(document.activeElement) ? document.activeElement.id : '', caret = document.activeElement?.selectionStart;
    let html = '';
    if (s.error) html += '<p class="mcg-error" role="alert">' + e(s.error) + '</p>';
    if (s.notice) html += '<p class="mcg-notice" role="status">' + e(s.notice) + '</p>';
    if (s.loading) html += '<p class="mcg-notice" role="status">Carregando fotos e vídeos…</p>';
    if (!s.enabled && !s.loading && !s.error) html += '<p class="mcg-notice">A galeria ainda precisa ser ativada para esta Matriz.</p>';
    if (s.enabled && !s.storageReady) html += '<p class="mcg-error">O envio de arquivos está indisponível. Confira a configuração da galeria.</p>';
    if (s.enabled && !s.botReady) html += '<p class="mcg-notice">As mídias podem ser cadastradas, mas o envio pelo bot está indisponível.</p>';
    if (s.enabled) html += !row ? gallery(ctx) : mode === 'preview' ? preview(ctx, row) : mode === 'video' ? video(ctx, row) : photos(ctx, row);
    html += '<input id="mcph-app-camera" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" hidden><input id="mcph-app-file" type="file" accept="image/jpeg,image/png,image/webp" hidden><input id="mcph-app-video-camera" type="file" accept="video/mp4,video/quicktime,video/webm" capture="environment" hidden><input id="mcph-app-video-file" type="file" accept="video/mp4,video/quicktime,video/webm" hidden>';
    host.innerHTML = '<div class="mcg-page mcg-media-page"' + (s.busy ? ' aria-busy="true"' : '') + '>' + html + '</div>';
    if (s.busy) host.querySelectorAll('button,input').forEach(n => { n.disabled = true; });
    host.dataset.mediaView = mode; host.dataset.product = row?.product_id || '';
    panel.scrollTop = same ? scroll : 0;
    if (focused) { const input = document.getElementById(focused); input?.focus({ preventScroll: true }); if (typeof caret === 'number' && input?.type === 'search') input.setSelectionRange(caret, caret); }
    else if (!same && row) host.querySelector('h2')?.focus({ preventScroll: true });
  }
  C.catalogMetalMedia = { render };
}());
