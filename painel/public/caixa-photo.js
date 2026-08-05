(function () {
  'use strict';

  const Caixa = window.Caixa;
  const state = Caixa.state;
  const alertButton = document.getElementById('photo-alert');
  const alertCount = document.getElementById('photo-alert-count');
  const modal = document.getElementById('photo-modal');
  const list = document.getElementById('photo-request-list');
  Object.assign(state, {
    photoRequests: [], photoLastCount: 0, photoPoll: 0, photoES: null,
    photoSseRetry: 0, photoGeneration: 0, photoPreview: null, photoSending: false,
    photoEnabled: true,
  });
  let alertAudio = null;
  let audioContext = null;
  let audioUnlocked = false;
  const originalTitle = document.title;

  function notificationsEnabled() {
    const saved = localStorage.getItem(Caixa.keys.notifications);
    return saved === null || saved === 'true';
  }

  function unlockAudio() {
    if (audioUnlocked) return;
    try {
      alertAudio = new Audio('/caixa/som-pedido-novo.mp3');
      alertAudio.preload = 'auto';
      alertAudio.muted = true;
      const primed = alertAudio.play();
      if (primed && primed.then) {
        primed.then(function () {
          alertAudio.pause(); alertAudio.currentTime = 0; alertAudio.muted = false;
        }).catch(function () { alertAudio.muted = false; });
      }
      const Context = window.AudioContext || window.webkitAudioContext;
      if (Context) { audioContext = audioContext || new Context(); void audioContext.resume(); }
      audioUnlocked = true;
    } catch (_) { /* o alerta visual permanece */ }
  }

  function synthBeep() {
    if (!audioContext) return;
    [880, 1320].forEach(function (frequency, index) {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      const start = audioContext.currentTime + index * 0.22;
      oscillator.frequency.value = frequency;
      oscillator.type = 'square';
      gain.gain.setValueAtTime(0.18, start);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.2);
      oscillator.connect(gain).connect(audioContext.destination);
      oscillator.start(start); oscillator.stop(start + 0.22);
    });
  }

  function photoBeep() {
    if (!notificationsEnabled() || !audioUnlocked) return;
    try {
      alertAudio.currentTime = 0;
      const played = alertAudio.play();
      if (played && played.catch) played.catch(synthBeep);
    } catch (_) { synthBeep(); }
  }

  function renderAlert() {
    const count = state.photoRequests.length;
    alertButton.classList.toggle('hidden', count === 0);
    alertCount.textContent = String(count);
    alertButton.querySelector('strong').lastChild.textContent = count === 1 ? ' pedido de foto' : ' pedidos de foto';
    document.title = count ? '(' + count + ') FOTO · ' + originalTitle : originalTitle;
    if (!modal.classList.contains('hidden')) renderModal();
  }

  async function loadPhotoRequests() {
    if (!Caixa.token()) return false;
    try {
      const response = await Caixa.authenticatedFetch('/api/caixa/photo-requests');
      const payload = await Caixa.json(response);
      if (!response.ok) throw new Error(payload.error || 'request_failed');
      state.photoEnabled = payload.enabled !== false;
      state.photoRequests = Array.isArray(payload.photo_requests) ? payload.photo_requests : [];
      if (state.photoPreview && !state.photoRequests.some(function (item) {
        return item.id === state.photoPreview.id;
      })) {
        URL.revokeObjectURL(state.photoPreview.url);
        state.photoPreview = null;
      }
      if (state.photoRequests.length > state.photoLastCount) {
        photoBeep();
        Caixa.showToast('📷 Cliente esperando foto de pneu. Toque no aviso para atender.');
      }
      state.photoLastCount = state.photoRequests.length;
      renderAlert();
      return state.photoEnabled;
    } catch (error) {
      if (error instanceof Error && error.message === 'invalid_session') return false;
      console.warn('caixa_photo_load_failed', error);
      return false;
    }
  }

  function scheduleSse(generation) {
    window.clearTimeout(state.photoSseRetry);
    state.photoSseRetry = window.setTimeout(function () { void startSse(generation); }, 5000);
  }

  async function startSse(generation) {
    if (generation !== state.photoGeneration || !Caixa.token() || !window.EventSource) return;
    try {
      const response = await Caixa.authenticatedFetch('/api/caixa/photo-stream-ticket', { method: 'POST' });
      const payload = await Caixa.json(response);
      if (!response.ok) throw new Error(payload.error || 'request_failed');
      if (generation !== state.photoGeneration) return;
      const stream = new EventSource('/api/caixa/photo-stream?ticket=' + encodeURIComponent(payload.ticket));
      state.photoES = stream;
      stream.addEventListener('message', function (event) {
        try {
          const data = JSON.parse(event.data || '{}');
          if (data.kind === 'photo_request') void loadPhotoRequests();
        } catch (_) { /* ignora evento inválido */ }
      });
      stream.onerror = function () {
        stream.close();
        if (state.photoES === stream) state.photoES = null;
        scheduleSse(generation);
      };
    } catch (error) {
      if (error instanceof Error && error.message === 'feature_off') {
        state.photoEnabled = false;
        return;
      }
      scheduleSse(generation);
    }
  }

  function startPhotoNotifications() {
    stopPhotoNotifications();
    const generation = state.photoGeneration;
    void loadPhotoRequests().then(function (enabled) {
      if (!enabled || generation !== state.photoGeneration) return;
      void startSse(generation);
      state.photoPoll = window.setInterval(function () { void loadPhotoRequests(); }, 25000);
    });
  }

  function stopPhotoNotifications() {
    state.photoGeneration += 1;
    window.clearInterval(state.photoPoll);
    window.clearTimeout(state.photoSseRetry);
    state.photoPoll = 0; state.photoSseRetry = 0;
    if (state.photoES) state.photoES.close();
    state.photoES = null;
    if (state.photoPreview) URL.revokeObjectURL(state.photoPreview.url);
    state.photoPreview = null;
    state.photoRequests = []; state.photoLastCount = 0;
    alertButton.classList.add('hidden');
    modal.classList.add('hidden');
    document.title = originalTitle;
  }

  async function compressPhoto(file) {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) { if (blob) resolve(blob); else reject(new Error('compress_failed')); }, 'image/jpeg', 0.8);
    });
  }

  function photoInput(item) {
    const label = document.createElement('label');
    label.className = 'photo-shoot-button';
    label.textContent = state.photoPreview && state.photoPreview.id === item.id ? 'TIRAR OUTRA' : 'TIRAR FOTO';
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*'; input.capture = 'environment'; input.hidden = true;
    input.addEventListener('change', async function () {
      const file = input.files && input.files[0]; input.value = '';
      if (!file) return;
      try {
        const blob = await compressPhoto(file);
        if (state.photoPreview) URL.revokeObjectURL(state.photoPreview.url);
        state.photoPreview = { id: item.id, blob: blob, url: URL.createObjectURL(blob) };
        renderModal();
      } catch (_) { Caixa.showToast('Não consegui ler essa foto. Tente novamente.'); }
    });
    label.appendChild(input);
    return label;
  }

  async function sendPhoto(item) {
    const preview = state.photoPreview;
    if (!preview || preview.id !== item.id || state.photoSending) return;
    state.photoSending = true; renderModal();
    try {
      const response = await Caixa.authenticatedFetch('/api/caixa/photo-requests/' + item.id + '/photo', {
        method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: preview.blob,
      });
      const payload = await Caixa.json(response);
      if (!response.ok) throw new Error(payload.error || 'request_failed');
      URL.revokeObjectURL(preview.url); state.photoPreview = null;
      Caixa.showToast('✅ Foto enviada para o cliente.');
      await loadPhotoRequests();
      if (!state.photoRequests.length) modal.classList.add('hidden');
    } catch (_) { Caixa.showToast('Não consegui enviar a foto. Tente novamente.'); }
    finally { state.photoSending = false; renderModal(); }
  }

  function renderModal() {
    list.replaceChildren();
    state.photoRequests.forEach(function (item) {
      const card = document.createElement('article'); card.className = 'caixa-photo-card';
      const tag = document.createElement('small'); tag.textContent = '📷 PEDIDO DE FOTO';
      const title = document.createElement('strong'); title.textContent = item.tire_size;
      const meta = document.createElement('p');
      const minutes = Math.max(1, Math.ceil((new Date(item.expires_at).getTime() - Date.now()) / 60000));
      meta.textContent = [item.brand, item.customer_name, minutes + ' min restantes'].filter(Boolean).join(' · ');
      card.append(tag, title, meta);
      if (state.photoPreview && state.photoPreview.id === item.id) {
        const image = document.createElement('img'); image.src = state.photoPreview.url; image.alt = 'Prévia da foto';
        const actions = document.createElement('div'); actions.className = 'caixa-photo-actions';
        const send = document.createElement('button'); send.type = 'button';
        send.textContent = state.photoSending ? 'ENVIANDO…' : 'ENVIAR AO CLIENTE'; send.disabled = state.photoSending;
        send.addEventListener('click', function () { void sendPhoto(item); });
        actions.append(photoInput(item), send); card.append(image, actions);
      } else card.appendChild(photoInput(item));
      list.appendChild(card);
    });
  }

  function openModal() { modal.classList.remove('hidden'); renderModal(); }
  function closeModal() { modal.classList.add('hidden'); }
  function setPhotoSoundEnabled(enabled) { if (enabled) unlockAudio(); }

  Object.assign(Caixa, { startPhotoNotifications, stopPhotoNotifications, setPhotoSoundEnabled });
  alertButton.addEventListener('click', openModal);
  document.querySelectorAll('[data-close-photo]').forEach(function (button) { button.addEventListener('click', closeModal); });
  document.addEventListener('pointerdown', unlockAudio, { once: true });
}());
