(function () {
  'use strict';
  const Caixa = window.Caixa, panel = Caixa.elements.catalogPanel;
  if (!panel) return;
  const products = document.createElement('div'); products.style.display = 'contents';
  while (panel.firstChild) products.appendChild(panel.firstChild);
  const nav = document.createElement('nav'); nav.className = 'mcph-tabs hidden'; nav.setAttribute('aria-label', 'Seções do Catálogo');
  nav.innerHTML = '<button type="button" data-gallery="products" aria-selected="true">Produtos e preços</button><button type="button" data-gallery="photos" aria-selected="false">Fotos e vídeos para o bot</button>';
  const host = document.createElement('section'); host.className = 'mcph-shell hidden'; host.setAttribute('aria-label', 'Fotos para o bot da Matriz');
  panel.append(nav, products, host);
  let app = null, session = '', active = false;
  const images = new Map(), pendingImages = new Set(), failedImages = new Set();
  const base = '/api/caixa/operacao/catalogo';
  const placeholder = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="#f3f6f4"/></svg>');
  const e = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const allowed = () => !Caixa.isPartner() && Caixa.operationCatalogUtils.isOwner();
  function clearImages() { images.forEach(url => URL.revokeObjectURL(url)); images.clear(); pendingImages.clear(); failedImages.clear(); }
  async function request(url, options) {
    const instance = app, own = session;
    if (!allowed() || own !== Caixa.sessionFingerprint()) throw Error('invalid_session');
    const response = await Caixa.authenticatedFetch(url.replace('/admin/api/catalog', base), options);
    if (instance !== app || own !== Caixa.sessionFingerprint()) throw Error('invalid_session');
    if (!response.ok) throw Error((await response.json().catch(() => ({}))).error || 'api_' + response.status);
    return response;
  }
  function image(photo) {
    if (!photo?.id) return placeholder;
    if (images.has(photo.id)) return images.get(photo.id);
    if (!pendingImages.has(photo.id) && !failedImages.has(photo.id)) {
      const own = session, instance = app;
      pendingImages.add(photo.id);
      request(base + '/photos/' + encodeURIComponent(photo.id) + '/image').then(response => response.blob()).then(blob => {
        if (!active || !allowed() || instance !== app || own !== Caixa.sessionFingerprint()) return;
        const url = URL.createObjectURL(blob); images.set(photo.id, url);
        if (images.size > 48) { const oldest = images.keys().next().value; URL.revokeObjectURL(images.get(oldest)); images.delete(oldest); }
        host.querySelectorAll('[data-mcph-image]').forEach(node => { if (node.dataset.mcphImage === photo.id) node.src = url; });
      }).catch(() => { if (instance === app) failedImages.add(photo.id); }).finally(() => { if (instance === app) pendingImages.delete(photo.id); });
    }
    return placeholder;
  }
  const img = (photo, className) => '<img class="' + className + '" data-mcph-image="' + e(photo?.id) + '" src="' + e(image(photo)) + '" alt="Foto do pneu" loading="lazy">';
  function videoSource(video) {
    const key = 'video:' + video.id;
    if (images.has(key)) return images.get(key);
    if (!pendingImages.has(key) && !failedImages.has(key)) {
      const own = session, instance = app; pendingImages.add(key);
      request(base + '/videos/' + encodeURIComponent(video.id) + '/file').then(response => response.blob()).then(blob => {
        if (!active || !allowed() || instance !== app || own !== Caixa.sessionFingerprint()) return;
        const url = URL.createObjectURL(blob); images.set(key, url);
        const cachedVideos = [...images.keys()].filter(value => value.startsWith('video:'));
        if (cachedVideos.length > 2) { const oldest = cachedVideos[0]; URL.revokeObjectURL(images.get(oldest)); images.delete(oldest); }
        host.querySelectorAll('[data-mcph-video]').forEach(node => { if (node.dataset.mcphVideo === video.id) node.src = url; });
      }).catch(() => { if (instance === app) { failedImages.add(key); app.matrixPhotos.error = 'Não foi possível abrir o vídeo. Atualize para tentar novamente.'; render(); } }).finally(() => { if (instance === app) pendingImages.delete(key); });
    }
    return '';
  }
  function createApp() {
    const current = window.PAINEL_MODULES.catalogPhotos();
    Object.assign(current, { adminUser: { role: 'owner' }, isMatrixPanel: allowed,
      apiGet: async url => (await request(url)).json(), apiHeaders: () => ({ 'Content-Type': 'application/json' }),
      adminUnauthorized: () => Caixa.showLogin('Sua sessão expirou.'),
      catalogoConditionLabel: value => Caixa.operationCatalogUtils.conditionLabel(value),
      mcphRequest: async (url, options) => (await request(url, options)).json(), mcphImage: image });
    return current;
  }
  async function action(run) {
    const current = app;
    try { const promise = run(); render(); await promise; }
    catch (error) { if (current === app) app.matrixPhotos.error = app.mcphError(error.message); }
    if (current === app) render();
  }
  function render() {
    if (!app || !active) return;
    const s = app.matrixPhotos, row = s.selected, disabled = s.busy ? ' disabled' : '';
    const focused = host.contains(document.activeElement) ? document.activeElement.id : '', caret = document.activeElement?.selectionStart;
    let html = '<header class="mcph-header"><div><h2>Fotos e vídeos para o bot</h2><p>Pneus da Matriz, prontos para o atendimento.</p></div><button type="button" class="mcph-secondary" data-action="refresh"' + disabled + '>Atualizar</button></header>';
    if (s.error) html += '<p class="mcph-alert mcph-error" role="alert">' + e(s.error) + '</p>';
    if (s.notice) html += '<p class="mcph-alert mcph-success" role="status">' + e(s.notice) + '</p>';
    if (s.loading) html += '<p class="mcph-muted" role="status">Carregando fotos…</p>';
    if (!s.enabled && !s.loading && !s.error) html += '<p class="mcph-alert">A galeria ainda precisa ser ativada no servidor.</p>';
    if (s.enabled && !s.storageReady) html += '<p class="mcph-alert">O armazenamento de fotos precisa ser configurado no servidor.</p>';
    if (s.enabled && !s.botReady) html += '<p class="mcph-alert">O envio pelo bot ainda precisa ser ativado no servidor.</p>';
    if (s.enabled && !row) {
      html += '<label class="mcph-field" for="mcph-app-search">Buscar pneu</label><input class="mcph-search" id="mcph-app-search" type="search" placeholder="Medida, marca ou modelo" value="' + e(s.search) + '"><nav class="mcph-tabs" aria-label="Situação das fotos">';
      [{ id: 'all', label: 'Todos' }, { id: 'missing', label: 'Sem fotos ou vídeo' }, { id: 'ready', label: 'Prontos' }, { id: 'error', label: 'Com erro' }].forEach(filter => {
        html += '<button type="button" data-filter="' + filter.id + '" aria-selected="' + (s.filter === filter.id) + '">' + filter.label + '</button>';
      });
      html += '</nav><div class="mcph-list">';
      app.mcphPageRows().forEach(product => {
        const primary = app.mcphPrimary(product);
        const hasMedia = !!primary || !!product.video;
        html += '<article class="mcph-row">' + (primary ? img(primary, 'mcph-thumb') : '<span class="mcph-thumb mcph-placeholder">' + (product.video ? 'Vídeo' : 'Sem foto') + '</span>')
          + '<div class="mcph-identity"><h3>' + e(product.tire_size) + '</h3><p>' + e(product.brand + ' · ' + app.catalogoConditionLabel(product.tire_condition))
          + '</p><p>' + e(product.product_name) + '</p><span class="mcph-status' + (hasMedia && product.enabled ? ' is-ready' : '') + '">' + e(app.mcphStatus(product))
          + '</span></div><button type="button" class="' + (hasMedia ? 'mcph-secondary' : 'mcph-primary') + '" data-product="' + e(product.product_id) + '">' + (hasMedia ? 'Ver fotos e vídeo' : 'Cadastrar fotos e vídeo') + '</button></article>';
      });
      if (!app.mcphFiltered().length && !s.loading) html += '<p class="mcph-empty">Nenhum pneu encontrado. Cadastre o produto antes de adicionar fotos.</p>';
      html += '</div>';
      if (app.mcphFiltered().length > 12) html += '<div class="mcph-pager"><button class="mcph-secondary" data-page="-1"' + (s.page <= 1 ? ' disabled' : '') + '>Anterior</button><span>Página ' + s.page + '</span><button class="mcph-secondary" data-page="1"' + (s.page * 12 >= app.mcphFiltered().length ? ' disabled' : '') + '>Próxima</button></div>';
      if (s.truncated) html += '<p class="mcph-alert">Consulta limitada a 2.000 produtos.</p>';
    } else if (s.enabled && row) {
      const photo = app.mcphPhoto(), primary = app.mcphPrimary();
      html += '<button class="mcph-secondary" data-action="back"' + disabled + '>← Voltar aos pneus</button><header class="mcph-header"><div><h2>' + e(row.tire_size) + '</h2><p>' + e(row.product_name + ' · ' + app.catalogoConditionLabel(row.tire_condition)) + '</p></div></header><div class="mcph-detail"><article class="mcph-panel"><nav class="mcph-tabs" aria-label="Ângulo da foto">';
      ['front', 'side', 'detail'].forEach(angle => { html += '<button data-angle="' + angle + '" aria-selected="' + (s.angle === angle) + '"' + disabled + '>' + e(app.mcphAngleLabel(angle)) + (app.mcphPhoto(row, angle) ? ' ✓' : '') + '</button>'; });
      html += '</nav>' + (photo ? img(photo, 'mcph-viewer') : '<div class="mcph-photo-empty"><strong>Adicione uma foto</strong><span>Uma foto basta. Os outros ângulos são opcionais.</span></div>');
      html += '<input id="mcph-app-camera" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" hidden><input id="mcph-app-file" type="file" accept="image/jpeg,image/png,image/webp" hidden><div class="mcph-actions"><button class="mcph-primary" data-action="camera"' + (s.busy || !s.storageReady ? ' disabled' : '') + '>Fotografar</button><button class="mcph-secondary" data-action="file"' + (s.busy || !s.storageReady ? ' disabled' : '') + '>Escolher foto</button></div><p class="mcph-muted">Marca 2W automática. JPG, PNG ou WebP, até 10 MB.</p>';
      if (photo?.is_primary) html += '<p class="mcph-status is-ready">✓ Foto principal do atendimento</p>';
      else if (photo) html += '<button class="mcph-secondary" data-action="primary"' + disabled + '>Usar como principal</button>';
      html += '<section class="mcph-video" aria-busy="' + s.busy + '"><h3>Vídeo do pneu</h3><p class="mcph-notice">Até 15 segundos. Marca 2W e redução do tamanho automáticas.</p>';
      if (row.video) html += '<video class="mcph-video-player" data-mcph-video="' + e(row.video.id) + '"' + (images.has('video:' + row.video.id) ? ' src="' + e(videoSource(row.video)) + '"' : '') + ' controls playsinline preload="metadata" aria-label="Vídeo do pneu com marca 2W"></video><p class="mcph-status is-ready">✓ Vídeo pronto · ' + e(app.mcphVideoSize(row.video)) + '</p>';
      else html += '<p class="mcph-muted">Nenhum vídeo cadastrado para este pneu.</p>';
      if (row.video) videoSource(row.video);
      html += '<input id="mcph-app-video-camera" type="file" accept="video/mp4,video/quicktime,video/webm" capture="environment" hidden><input id="mcph-app-video-file" type="file" accept="video/mp4,video/quicktime,video/webm" hidden><div class="mcph-actions"><button class="mcph-primary" data-action="video-camera"' + (s.busy || !s.storageReady ? ' disabled' : '') + '>Gravar vídeo</button><button class="mcph-secondary" data-action="video-file"' + (s.busy || !s.storageReady ? ' disabled' : '') + '>' + (s.busy ? 'Processando…' : 'Escolher vídeo') + '</button></div><p class="mcph-muted">MP4, MOV ou WebM, até 80 MB na entrada. Só a versão final fica guardada, com até 8 MB.</p></section>';
      html += '</article><aside class="mcph-panel"><h3 style="font-size:21px;font-weight:700">Uso no atendimento</h3><label class="mcph-switch"><span>Permitir fotos e vídeo no bot</span><input id="mcph-app-enabled" type="checkbox"' + (row.enabled ? ' checked' : '') + disabled + '></label><p class="mcph-notice">Quando o cliente pede uma foto, o bot envia a principal. Outros ângulos, se solicitados. Sem foto cadastrada, a loja recebe o pedido.</p><p class="mcph-notice">O vídeo é enviado quando solicitado; sem vídeo, o bot oferece foto.</p><p class="mcph-notice" style="margin-top:12px">As imagens são de referência. Pedidos de foto atual ou do desgaste continuam com a loja.</p><button class="mcph-primary" data-action="preview" style="width:100%;margin-top:16px"' + (!primary || s.busy ? ' disabled' : '') + '>Testar envio</button>';
      html += '<details class="mcph-drive" id="mcph-app-drive"' + (s.driveOpen ? ' open' : '') + '><summary>Importar do Google Drive</summary><p class="mcph-notice">Compartilhe uma pasta exclusiva deste pneu como leitor com:</p><code>' + e(s.drive.email || 'Conexão do Drive pendente no servidor') + '</code><label class="mcph-field" for="mcph-app-folder">Link da pasta deste pneu</label><input id="mcph-app-folder" class="mcph-search" value="' + e(s.folder) + '" placeholder="Cole o link da pasta do Drive"><label class="mcph-switch"><span>Importação automática</span><input id="mcph-app-drive-enabled" type="checkbox"' + (s.driveEnabled ? ' checked' : '') + '></label><p class="mcph-notice">Use principal.jpg, lateral.jpg ou detalhe.jpg. PNG e WebP também funcionam. Não são gerados ângulos novos.</p><button class="mcph-secondary" data-action="drive"' + disabled + '>Salvar pasta e importação</button>';
      html += '<p class="mcph-notice">Para o vídeo, use video.mp4, video.mov ou video.webm, até 15 segundos. Um vídeo por pneu.</p>';
      if (row.drive_checked_at) html += '<p class="mcph-muted">Última verificação: ' + e(new Date(row.drive_checked_at).toLocaleString('pt-BR')) + '</p>';
      if (row.drive_error) html += '<p class="mcph-alert">' + e(app.mcphError(row.drive_error)) + '</p>';
      html += '</details></aside></div>';
      if (s.preview && primary) html += '<section class="mcph-preview"><h3>Prévia para o cliente</h3><figure>' + img(primary, '') + '<figcaption>' + e(app.mcphCaption()) + '</figcaption></figure><p class="mcph-muted">Esta é uma prévia. Nenhuma mensagem foi enviada.</p><button class="mcph-secondary" data-action="close-preview">Fechar prévia</button></section>';
    }
    host.innerHTML = html;
    if (focused) { const input = document.getElementById(focused); input?.focus({ preventScroll: true }); if (typeof caret === 'number') input?.setSelectionRange?.(caret, caret); }
  }
  function close() {
    active = false; app = null; clearImages(); host.replaceChildren(); host.classList.add('hidden'); products.style.display = 'contents';
    nav.querySelectorAll('button').forEach(button => button.setAttribute('aria-selected', String(button.dataset.gallery === 'products')));
  }
  function sync() { nav.classList.toggle('hidden', !allowed()); if (!allowed() || session && session !== Caixa.sessionFingerprint()) close(); }
  async function open() {
    if (!allowed()) return;
    session = Caixa.sessionFingerprint(); app = createApp(); active = true; products.style.display = 'none'; host.classList.remove('hidden');
    nav.querySelectorAll('button').forEach(button => button.setAttribute('aria-selected', String(button.dataset.gallery === 'photos')));
    await action(() => app.mcphLoad());
  }
  nav.addEventListener('click', event => { const button = event.target.closest('[data-gallery]'); if (button) void (button.dataset.gallery === 'photos' ? open() : close()); });
  host.addEventListener('click', event => {
    const button = event.target.closest('button'); if (!button || !app || app.matrixPhotos.busy) return;
    const s = app.matrixPhotos, dataset = button.dataset;
    if (dataset.product) app.mcphOpen(s.rows.find(row => row.product_id === dataset.product));
    if (dataset.filter) { s.filter = dataset.filter; s.page = 1; }
    if (dataset.angle) s.angle = dataset.angle;
    if (dataset.page) s.page += Number(dataset.page);
    if (dataset.action === 'refresh') { failedImages.clear(); return void action(() => app.mcphLoad()); }
    if (dataset.action === 'back') app.mcphOpen(null);
    if (dataset.action === 'preview') app.mcphPreview();
    if (dataset.action === 'close-preview') s.preview = false;
    if (dataset.action === 'primary') return void action(() => app.mcphSave({ primary_id: app.mcphPhoto().id }));
    if (dataset.action === 'drive') return void action(() => app.mcphSave({ drive_folder_id: s.folder, drive_enabled: s.driveEnabled }));
    if (dataset.action === 'camera' || dataset.action === 'file') { document.getElementById('mcph-app-' + dataset.action).click(); return; }
    if (dataset.action === 'video-camera' || dataset.action === 'video-file') { document.getElementById('mcph-app-' + dataset.action).click(); return; }
    render();
  });
  host.addEventListener('input', event => {
    if (!app) return;
    if (event.target.id === 'mcph-app-search') { app.matrixPhotos.search = event.target.value; app.matrixPhotos.page = 1; render(); }
    if (event.target.id === 'mcph-app-folder') app.matrixPhotos.folder = event.target.value;
  });
  host.addEventListener('change', event => {
    if (!app) return;
    if (event.target.type === 'file') void action(() => event.target.id.startsWith('mcph-app-video-') ? app.mcphUploadVideo(event) : app.mcphUpload(event));
    if (event.target.id === 'mcph-app-enabled') void action(() => app.mcphSave({ enabled: event.target.checked }));
    if (event.target.id === 'mcph-app-drive-enabled') app.matrixPhotos.driveEnabled = event.target.checked;
  });
  host.addEventListener('toggle', event => { if (app && event.target.id === 'mcph-app-drive') app.matrixPhotos.driveOpen = event.target.open; }, true);
  window.addEventListener('pagehide', clearImages);
  Caixa.matrixPhotoGallery = { sync, close };
}());
