(function () {
  'use strict';
  const C = window.Caixa, V = C.partnerPhotoUI;
  let items = [], index = 0, reviewing = false, busy = false, error = '', timer = 0;
  function leave() { if (timer) window.clearInterval(timer); timer = 0; }
  function clear() {
    leave(); items.forEach(item => item.photos.forEach(photo => URL.revokeObjectURL(photo.url)));
    items = []; index = 0; reviewing = false; error = '';
  }
  function groups() {
    const result = new Map();
    (C.state.photoRequests || []).forEach(item => {
      const key = item.photo_group_id || item.id;
      if (!result.has(key)) result.set(key, []);
      result.get(key).push(item);
    });
    return [...result.values()].map(rows => rows.sort((a, b) => String(a.created_at || a.id).localeCompare(String(b.created_at || b.id))));
  }
  function startTimer(el, rows) {
    const deadlines = rows.map(row => Date.parse(row.expires_at)).filter(Number.isFinite);
    if (!el || !deadlines.length) return;
    const deadline = Math.min(...deadlines);
    function tick() {
      const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      el.textContent = seconds ? 'Enviar em ' + Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0') : 'Prazo encerrado';
      el.setAttribute('aria-label', el.textContent);
      if (!seconds) leave();
      return seconds;
    }
    if (tick()) timer = window.setInterval(tick, 1000);
  }
  function list() { leave(); V.list(groups(), open); }
  function open(id) {
    if (busy) return;
    const group = groups().find(rows => rows.some(row => row.id === id));
    clear();
    if (group) items = group.map(row => ({ ...row, photos: [], sent: 0 }));
    C.partnerHome.open('partner-photo');
  }
  async function take(file, itemId, replaceIndex) {
    if (!file || busy) return;
    const item = items.find(row => row.id === itemId);
    if (!item || item.sent || (replaceIndex == null && item.photos.length + Number(item.photo_count || 0) >= 3)) return;
    busy = true; error = ''; render();
    const session = C.sessionFingerprint();
    try {
      const blob = await C.compressPhoto(file);
      if (session !== C.sessionFingerprint() || !items.includes(item)) return;
      const photo = { blob, url: URL.createObjectURL(blob) };
      if (replaceIndex != null && item.photos[replaceIndex]) {
        URL.revokeObjectURL(item.photos[replaceIndex].url); item.photos[replaceIndex] = photo;
      } else item.photos.push(photo);
    } catch (_) { if (session === C.sessionFingerprint()) error = 'Não consegui ler essa foto. Tente outra.'; }
    finally { if (session === C.sessionFingerprint()) { busy = false; C.partnerHome.render(); } }
  }
  function remove(itemId, photoIndex) {
    if (busy) return;
    const item = items.find(row => row.id === itemId);
    if (!item || item.sent || !item.photos[photoIndex]) return;
    URL.revokeObjectURL(item.photos[photoIndex].url); item.photos.splice(photoIndex, 1); render();
  }
  function ready() { return items.length > 0 && items.every(item => item.photos.length || item.sent); }
  async function send() {
    if (busy || !ready() || !items.some(item => item.photos.length)) return;
    busy = true; error = ''; render();
    const session = C.sessionFingerprint();
    try {
      // Cada imagem mantém o UUID da sua solicitação. Sucessos saem da fila antes do próximo upload.
      for (const item of items) {
        while (item.photos.length) {
          const photo = item.photos[0];
          const payload = await C.uploadPartnerTirePhoto(item.id, photo, session);
          if (session !== C.sessionFingerprint()) return;
          if (payload.attached === false) throw new Error('photo_request_not_found');
          URL.revokeObjectURL(photo.url); item.photos.shift(); item.sent += 1;
        }
      }
      await C.loadPhotoRequests();
      if (session !== C.sessionFingerprint()) return;
      const plural = items.length > 1;
      clear(); C.showToast(plural ? 'Fotos encaminhadas ao cliente.' : 'Foto encaminhada ao cliente.');
      C.partnerHome.open('partner-home', true);
    } catch (failure) {
      if (session === C.sessionFingerprint()) {
        reviewing = items.length > 1;
        const partial = items.some(item => item.sent);
        error = failure?.message === 'photo_request_not_found'
          ? 'Esta solicitação não aceita mais fotos. As fotos já encaminhadas não serão reenviadas.'
          : (partial ? 'Parte das fotos foi encaminhada. Tente enviar as restantes.' : 'Não consegui enviar. Tente novamente.');
      }
    } finally { if (session === C.sessionFingerprint()) { busy = false; C.partnerHome.render(); } }
  }
  function render() {
    leave();
    if (!items.length) return list();
    const handlers = {
      back: () => {
        if (busy) return;
        if (reviewing) { reviewing = false; index = items.length - 1; render(); }
        else if (index > 0) { index -= 1; render(); }
        else C.partnerHome.open('partner-photos');
      }, take, remove, send,
      next: () => {
        if (busy || !items[index].photos.length) return;
        if (index < items.length - 1) index += 1;
        else if (ready()) reviewing = true;
        render();
      },
    };
    const el = V.render({ items, index, reviewing, busy, error }, handlers);
    startTimer(el, items.filter(item => item.photos.length || !item.sent));
  }
  function reset() { clear(); busy = false; }
  C.partnerPhoto = { list, render, reset, open, leave, busy: () => busy };
}());
