(function () {
  'use strict';
  const Caixa = window.Caixa, panel = Caixa.elements.catalogPanel;
  if (!panel) return;
  const products = document.createElement('div'); products.style.display = 'contents';
  while (panel.firstChild) products.appendChild(panel.firstChild);
  const nav = document.createElement('nav'); nav.className = 'mcph-tabs hidden'; nav.setAttribute('aria-label', 'Seções do Catálogo');
  nav.innerHTML = '<button type="button" data-gallery="products" aria-selected="true">Produtos e preços</button><button type="button" data-gallery="photos" aria-selected="false">Fotos e vídeos</button>';
  const host = document.createElement('section'); host.className = 'mcph-shell hidden'; host.setAttribute('aria-label', 'Fotos para o bot da Matriz');
  panel.append(nav, products, host);
  let app = null, session = '', active = false;
  const images = new Map(), pendingImages = new Set(), failedImages = new Set();
  const base = '/api/caixa/operacao/catalogo';
  const placeholder = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="#f3f6f4"/></svg>');
  const allowed = () => !Caixa.isPartner() && Caixa.canModule('estoque') && Caixa.operationCatalogUtils.isOwner();
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
      }).catch(() => { if (instance === app) { failedImages.add(photo.id); app.matrixPhotos.error = 'Não foi possível abrir a foto. Atualize para tentar novamente.'; render(); } }).finally(() => { if (instance === app) pendingImages.delete(photo.id); });
    }
    return placeholder;
  }
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
    Caixa.catalogMetalMedia.render({ app, host, image, videoSource });
  }
  function close() {
    active = false; app = null; Caixa.matrixCatalogMetal?.mediaChanged(null); clearImages(); host.replaceChildren(); host.classList.add('hidden'); products.style.display = 'contents';
    nav.querySelectorAll('button').forEach(button => button.setAttribute('aria-selected', String(button.dataset.gallery === 'products')));
  }
  function sync() { nav.classList.toggle('hidden', !allowed()); if (!allowed() || session && session !== Caixa.sessionFingerprint()) close(); }
  async function open(productId) {
    if (!allowed()) return;
    session = Caixa.sessionFingerprint(); app = createApp(); active = true; products.style.display = 'none'; host.classList.remove('hidden');
    nav.querySelectorAll('button').forEach(button => button.setAttribute('aria-selected', String(button.dataset.gallery === 'photos')));
    const current = app;
    await action(() => current.mcphLoad());
    if (productId && app === current && active) {
      current.mcphOpen(current.matrixPhotos.rows.find(row => row.product_id === productId) || null);
      current.matrixPhotos.angle = current.mcphPrimary()?.angle || 'front'; render();
    }
  }
  nav.addEventListener('click', event => { const button = event.target.closest('[data-gallery]'); if (button) void (button.dataset.gallery === 'photos' ? open() : close()); });
  host.addEventListener('click', event => {
    const button = event.target.closest('button'); if (!button || !app || app.matrixPhotos.busy) return;
    const s = app.matrixPhotos, dataset = button.dataset;
    if (dataset.product) { app.mcphOpen(s.rows.find(row => row.product_id === dataset.product)); s.screen = 'photos'; s.angle = app.mcphPrimary()?.angle || 'front'; }
    if (dataset.filter) { s.filter = dataset.filter; s.page = 1; }
    if (dataset.angle) s.angle = dataset.angle;
    if (dataset.page) s.page += Number(dataset.page);
    if (dataset.action === 'refresh') { failedImages.clear(); return void action(() => app.mcphLoad()); }
    if (dataset.action === 'back') app.mcphOpen(null);
    if (dataset.action === 'media-video' || dataset.action === 'media-photos') { s.preview = false; s.screen = dataset.action === 'media-video' ? 'video' : 'photos'; }
    if (dataset.action === 'preview') app.mcphPreview();
    if (dataset.action === 'close-preview') { s.preview = false; s.screen = 'photos'; }
    if (dataset.action === 'primary') return void action(() => app.mcphSave({ primary_id: app.mcphPhoto().id }));
    if (dataset.action === 'camera' || dataset.action === 'file') { document.getElementById('mcph-app-' + dataset.action).click(); return; }
    if (dataset.action === 'video-camera' || dataset.action === 'video-file') { document.getElementById('mcph-app-' + dataset.action).click(); return; }
    render();
  });
  host.addEventListener('input', event => {
    if (!app) return;
    if (event.target.id === 'mcph-app-search') { app.matrixPhotos.search = event.target.value; app.matrixPhotos.page = 1; render(); }
  });
  host.addEventListener('change', event => {
    if (!app) return;
    if (event.target.type === 'file') void action(() => event.target.id.startsWith('mcph-app-video-') ? app.mcphUploadVideo(event) : app.mcphUpload(event));
    if (event.target.id === 'mcph-app-enabled') void action(() => app.mcphSave({ enabled: event.target.checked }));
  });
  window.addEventListener('pagehide', clearImages);
  Caixa.matrixPhotoGallery = { sync, close, open,
    refresh() { if (!app || !active) return; failedImages.clear(); return action(() => app.mcphLoad()); },
    mediaView: () => app?.matrixPhotos.selected ? 'media-' + (app.matrixPhotos.preview ? 'preview' : app.matrixPhotos.screen || 'photos') : 'gallery',
  };
}());
