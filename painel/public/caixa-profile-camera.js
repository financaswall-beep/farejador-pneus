(function () {
  'use strict';
  const C = window.Caixa, T = C.profilePhoto, app = C.elements.app;
  const panel = document.createElement('section'); panel.id = 'profile-camera-panel'; panel.className = 'app-panel hidden';
  panel.setAttribute('aria-labelledby', 'profile-camera-title');
  panel.innerHTML = `<header class="profile-camera-heading"><button id="profile-camera-back" type="button" aria-label="Voltar ao perfil"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg></button><h2 id="profile-camera-title">Tirar foto</h2></header>
    <div id="profile-camera-live" class="profile-camera-live"><video id="profile-camera-video" autoplay playsinline muted aria-label="Prévia da câmera"></video><div class="profile-face-guide" aria-hidden="true"></div><p id="profile-camera-status" role="status">Abrindo a câmera…</p></div>
    <div id="profile-camera-controls" class="profile-camera-controls"><button id="profile-gallery" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="2"/><path d="m3 18 6-6 4 4 3-3 5 5"/></svg>Galeria</button><button id="profile-shutter" type="button" disabled aria-label="Tirar foto"><span></span></button><button id="profile-camera-flip" type="button" aria-label="Inverter câmera"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9a9 9 0 0 1 15-4l2 2m0-5v5h-5M20 15a9 9 0 0 1-15 4l-2-2m0 5v-5h5"/></svg>Inverter</button></div>
    <div id="profile-camera-fallback" hidden><button id="profile-camera-retry" type="button">Tentar novamente</button><button id="profile-native-camera" type="button">Abrir câmera do celular</button></div>
    <div id="profile-camera-preview" class="profile-camera-preview" hidden><img id="profile-camera-photo" alt="Foto escolhida para seu perfil"/><img id="profile-camera-avatar" alt="Recorte circular do avatar"/><p>Assim aparece no seu perfil</p><button id="profile-photo-save" class="profile-photo-primary" type="button">✓ Usar esta foto</button><button id="profile-photo-retake" class="profile-photo-secondary" type="button">Tirar outra</button><button id="profile-photo-cancel" class="profile-photo-cancel" type="button">Cancelar</button></div>
    <p id="profile-camera-error" role="alert"></p><input id="profile-gallery-file" type="file" accept="image/jpeg,image/png,image/webp" hidden/><input id="profile-native-file" type="file" accept="image/jpeg,image/png,image/webp" capture="user" hidden/>`;
  C.elements.sessionView.insertBefore(panel, C.elements.sessionView.querySelector('.bottom-nav'));
  const el = id => document.getElementById('profile-' + id), video = el('camera-video');
  let stream = null, generation = 0, active = false, phase = 'camera', facing = 'user', draft = null, previewUrl = '';
  function stop() { generation++; if (stream) stream.getTracks().forEach(track => track.stop()); stream = null; video.srcObject = null; }
  function clearDraft() {
    draft = null; if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = '';
    ['camera-photo', 'camera-avatar'].forEach(id => el(id).removeAttribute('src'));
    el('gallery-file').value = ''; el('native-file').value = '';
  }
  function setPhase(value) {
    phase = value; const preview = value === 'preview';
    el('camera-live').hidden = preview; el('camera-controls').hidden = preview;
    el('camera-preview').hidden = !preview; el('camera-fallback').hidden = value !== 'error';
    el('camera-title').textContent = preview ? 'Sua foto' : 'Tirar foto';
    app.classList.toggle('is-profile-live', active && !preview);
    el('shutter').disabled = value !== 'live'; el('camera-flip').disabled = value === 'opening';
  }
  function message(error) {
    if (error?.name === 'NotAllowedError') return 'Autorize a câmera nas permissões do navegador ou escolha uma foto da galeria.';
    if (error?.name === 'NotFoundError') return 'Nenhuma câmera disponível. Você pode escolher uma foto da galeria.';
    if (error?.message === 'photo_too_large') return 'Escolha uma imagem de até 12 MB e 30 megapixels.';
    if (error?.message === 'invalid_session') return 'Entre novamente para salvar sua foto.';
    if (error?.message === 'too_many_attempts') return 'Aguarde um minuto antes de tentar novamente.';
    return 'Não foi possível usar esta foto. Tente novamente ou escolha outra imagem.';
  }
  async function start() {
    if (!T.active() || !active || T.busy()) return;
    stop(); clearDraft(); setPhase('opening'); el('camera-error').textContent = ''; el('camera-status').textContent = 'Abrindo a câmera…';
    const ticket = generation, key = T.key();
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw Error('camera_unavailable');
      const opened = await navigator.mediaDevices.getUserMedia({ audio: false,
        video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 1280 } } });
      if (!active || ticket !== generation || key !== T.key()) { opened.getTracks().forEach(track => track.stop()); return; }
      stream = opened; video.srcObject = stream; video.classList.toggle('is-front', facing === 'user'); await video.play();
      if (!active || ticket !== generation || key !== T.key()) return;
      setPhase('live'); el('camera-status').textContent = 'Enquadre seu rosto';
    } catch (error) {
      if (!active || ticket !== generation || key !== T.key()) return;
      stop(); setPhase('error'); el('camera-status').textContent = 'Câmera indisponível';
      el('camera-error').textContent = message(error);
    }
  }
  function square(source, width, height, mirror = false) {
    if (!width || !height || width * height > 30_000_000) return Promise.reject(Error('photo_too_large'));
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 512;
    const context = canvas.getContext('2d'); const side = Math.min(width, height);
    if (!context) return Promise.reject(Error('invalid_photo'));
    context.fillStyle = '#fff'; context.fillRect(0, 0, 512, 512);
    if (mirror) { context.translate(512, 0); context.scale(-1, 1); }
    context.drawImage(source, (width - side) / 2, (height - side) / 2, side, side, 0, 0, 512, 512);
    return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(Error('invalid_photo')), 'image/jpeg', .9));
  }
  function preview(blob) {
    stop(); clearDraft(); draft = blob; previewUrl = URL.createObjectURL(blob);
    ['camera-photo', 'camera-avatar'].forEach(id => { el(id).src = previewUrl; });
    el('camera-error').textContent = ''; setPhase('preview'); el('photo-save').focus({ preventScroll: true });
  }
  async function capture() {
    if (phase !== 'live') return; const key = T.key(), ticket = generation; el('shutter').disabled = true;
    try {
      const blob = await square(video, video.videoWidth, video.videoHeight, facing === 'user');
      if (active && key === T.key() && ticket === generation) preview(blob);
    } catch (error) { if (active && key === T.key() && ticket === generation) { el('camera-error').textContent = message(error); el('shutter').disabled = false; } }
  }
  async function selected(event) {
    const file = event.target.files?.[0]; if (!file || !active || T.busy()) return;
    stop(); const key = T.key(), ticket = generation, source = URL.createObjectURL(file);
    try {
      if (file.size > 12 * 1024 * 1024) throw Error('photo_too_large');
      const image = new Image(); image.src = source; await image.decode();
      const blob = await square(image, image.naturalWidth, image.naturalHeight);
      if (active && key === T.key() && ticket === generation) preview(blob);
    } catch (error) { if (active && key === T.key() && ticket === generation) { setPhase('error'); el('camera-status').textContent = 'Escolha outra foto'; el('camera-error').textContent = message(error); } }
    finally { URL.revokeObjectURL(source); event.target.value = ''; }
  }
  function back() { if (!T.busy()) { C.showTab('profile'); document.getElementById('profile-photo-button').focus({ preventScroll: true }); } }
  const camera = C.profileCamera = {
    open: () => { if (!T.active()) return; active = true; C.showTab('profile-camera'); el('camera-back').focus({ preventScroll: true }); void start(); },
    sync: tab => {
      if (tab === 'profile-camera' && T.active()) { active = true; setPhase(phase); return; }
      active = false; stop(); clearDraft(); phase = 'camera'; app.classList.remove('is-profile-live');
    },
    reset: () => { active = false; stop(); clearDraft(); panel.querySelectorAll('button').forEach(button => { button.disabled = false; }); setPhase('camera'); el('photo-save').textContent = '✓ Usar esta foto'; el('camera-error').textContent = ''; },
  };
  el('camera-back').addEventListener('click', back); el('photo-cancel').addEventListener('click', back);
  el('camera-retry').addEventListener('click', start); el('photo-retake').addEventListener('click', start);
  el('camera-flip').addEventListener('click', () => { facing = facing === 'user' ? 'environment' : 'user'; void start(); });
  el('gallery').addEventListener('click', () => el('gallery-file').click());
  el('native-camera').addEventListener('click', () => el('native-file').click());
  el('gallery-file').addEventListener('change', selected); el('native-file').addEventListener('change', selected);
  el('shutter').addEventListener('click', capture);
  el('photo-save').addEventListener('click', async () => {
    if (!draft || T.busy()) return; const key = T.key();
    const controls = [...panel.querySelectorAll('button')]; controls.forEach(button => { button.disabled = true; }); el('photo-save').textContent = 'Salvando…';
    try { await T.save(draft); if (key === T.key()) { C.showTab('profile'); C.showToast('Foto do perfil atualizada.'); } }
    catch (error) { if (key === T.key()) el('camera-error').textContent = error?.message === 'too_many_attempts' ? message(error) : 'Não foi possível salvar a foto agora. Tente novamente.'; }
    finally { if (key === T.key()) { controls.forEach(button => { button.disabled = false; }); el('photo-save').textContent = '✓ Usar esta foto'; } }
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && active) back(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && active && ['opening', 'live'].includes(phase)) { stop(); setPhase('error'); el('camera-status').textContent = 'Câmera pausada'; el('camera-error').textContent = 'Toque em Tentar novamente para reabrir a câmera.'; }
  });
  window.addEventListener('pagehide', () => camera.reset());
}());
