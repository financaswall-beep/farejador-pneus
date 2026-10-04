(function () {
  'use strict';
  const C = window.Caixa;
  const U = C.partnerUI;
  let selected = '';
  let previews = [];
  let busy = false;
  let error = '';
  function clear() {
    previews.forEach(item => URL.revokeObjectURL(item.url)); previews = [];
  }
  function list() {
    const page = U.section('Pedidos de foto', () => C.partnerHome.open('partner-home'));
    const rows = C.state.photoRequests || [];
    if (!rows.length) page.appendChild(U.node('p', 'Nenhuma foto para enviar.', 'ps-copy'));
    rows.forEach(item => {
      const row = U.node('article', null, 'ps-order-row');
      row.append(U.node('h4', item.tire_size), U.node('p', item.brand || 'Cliente aguardando foto'));
      row.appendChild(U.button('TIRAR FOTO', () => {
        clear(); selected = item.id; error = ''; C.partnerHome.open('partner-photo');
      }, 'primary', 'camera')); page.appendChild(row);
    });
    U.mount(page, 'photos');
  }
  async function take(file) {
    if (!file || busy) return;
    busy = true; error = ''; render();
    const session = C.sessionFingerprint(); const itemId = selected;
    try {
      const blob = await C.compressPhoto(file);
      if (session !== C.sessionFingerprint() || selected !== itemId) return;
      previews.push({ blob, url: URL.createObjectURL(blob) });
    } catch (_) { if (session === C.sessionFingerprint()) error = 'Não consegui ler essa foto. Tente outra.'; }
    finally { if (session === C.sessionFingerprint()) { busy = false; C.partnerHome.render(); } }
  }
  async function send() {
    if (busy || !previews.length) return;
    busy = true; error = ''; render();
    const session = C.sessionFingerprint(); const itemId = selected;
    try {
      // Mesmo upload validado: reencodificação, RLS e envio ao cliente.
      while (previews.length) {
        const preview = previews[0];
        const response = await C.authenticatedFetch(C.photoUploadPath(itemId), {
          method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: preview.blob,
        });
        const payload = await C.json(response);
        if (session !== C.sessionFingerprint()) return;
        if (!response.ok) throw new Error(payload.error || 'request_failed');
        if (payload.attached === false) throw new Error('photo_request_not_found');
        URL.revokeObjectURL(preview.url); previews.shift();
      }
      await C.loadPhotoRequests();
      if (session !== C.sessionFingerprint()) return;
      selected = ''; C.showToast('Foto enviada ao cliente.'); C.partnerHome.open('partner-home', true);
    } catch (failure) {
      if (session === C.sessionFingerprint()) error = failure?.message === 'photo_request_not_found' ? 'Este pedido de foto não está mais disponível.' : 'Não consegui enviar. Tente novamente.';
    } finally { if (session === C.sessionFingerprint()) { busy = false; C.partnerHome.render(); } }
  }
  function render() {
    const item = (C.state.photoRequests || []).find(row => row.id === selected);
    if (!item) { clear(); return list(); }
    const page = U.section('Foto do pneu', () => {
      if (busy) return; clear(); selected = ''; C.partnerHome.open('partner-photos');
    });
    page.append(U.node('strong', item.tire_size, 'ps-size'), U.node('p', item.brand || '', 'ps-copy'));
    if (item.note) page.appendChild(U.node('p', item.note, 'ps-copy'));
    const gallery = U.node('div', null, 'ps-photo-gallery');
    previews.forEach((preview, index) => {
      const remove = U.node('button', null, 'ps-photo-preview'); remove.type = 'button'; remove.disabled = busy;
      remove.setAttribute('aria-label', 'Apagar foto ' + (index + 1));
      const image = U.node('img'); image.src = preview.url; image.alt = 'Prévia da foto ' + (index + 1);
      remove.append(image, U.node('span', '×'));
      remove.addEventListener('click', () => { URL.revokeObjectURL(preview.url); previews.splice(index, 1); render(); });
      gallery.appendChild(remove);
    });
    page.appendChild(gallery);
    const remaining = Math.max(0, 3 - Number(item.photo_count || 0) - previews.length);
    const input = U.node('input'); input.type = 'file'; input.accept = 'image/*'; input.capture = 'environment'; input.hidden = true; input.disabled = busy;
    input.addEventListener('change', () => { const file = input.files?.[0]; input.value = ''; void take(file); });
    if (previews.length) page.appendChild(U.button(busy ? 'ENVIANDO…' : 'ENVIAR', () => void send(), 'primary', 'check'));
    if (remaining > 0) page.appendChild(U.button(previews.length ? '+ OUTRA FOTO' : 'TIRAR FOTO', () => input.click(), previews.length ? 'secondary' : 'primary', 'camera'));
    page.appendChild(input);
    if (!previews.length && remaining === 0) page.appendChild(U.node('p', 'Este pedido já recebeu 3 fotos.', 'ps-copy'));
    if (previews.length) page.appendChild(U.node('p', 'Toque na foto para apagar.', 'ps-copy'));
    if (error) { const el = U.node('p', error, 'ps-error'); el.setAttribute('role', 'alert'); page.appendChild(el); }
    page.querySelectorAll('button').forEach(el => { el.disabled = busy; });
    U.mount(page, 'photo');
  }
  function reset() { clear(); selected = ''; busy = false; error = ''; }
  function open(id) { clear(); selected = id; error = ''; C.partnerHome.open('partner-photo'); }
  C.partnerPhoto = { list, render, reset, open, busy: () => busy };
}());
