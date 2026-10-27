(function () {
  'use strict';
  const C = window.Caixa, profile = document.getElementById('profile-photo');
  const operator = document.getElementById('operator-button'), error = document.getElementById('profile-photo-error');
  const headerPhoto = document.createElement('img'); headerPhoto.alt = ''; headerPhoto.className = 'operator-photo'; headerPhoto.hidden = true; operator.appendChild(headerPhoto);
  let avatarUrl = '', fingerprint = '', epoch = 0, loaded = false, loading = false, saving = false, request = 0;
  const T = C.profilePhoto = {
    backTab: 'cash', key: () => C.sessionFingerprint() + '#' + epoch, busy: () => saving,
    active: () => !!C.token() && !C.isPartner(),
  };
  function avatar(blob) {
    const previous = avatarUrl; avatarUrl = blob ? URL.createObjectURL(blob) : '';
    [profile, headerPhoto].forEach(img => { if (avatarUrl) img.src = avatarUrl; else img.removeAttribute('src'); img.hidden = !avatarUrl; });
    document.getElementById('profile-initials').hidden = !!avatarUrl;
    operator.classList.toggle('has-user-photo', !!avatarUrl);
    if (previous) URL.revokeObjectURL(previous);
  }
  T.reset = () => {
    epoch++; request++; loaded = false; loading = false; saving = false; fingerprint = '';
    C.profileCamera?.reset(); avatar(null); error.textContent = ''; document.getElementById('profile-photo-retry').hidden = true;
    document.getElementById('profile-photo-button').disabled = false;
  };
  T.load = async (force = false) => {
    if (!T.active() || saving || loading || (loaded && !force)) return;
    const key = T.key(), ticket = ++request; loading = true;
    try {
      const response = await C.authenticatedFetch('/api/caixa/profile/photo');
      if (!response.ok) throw Error('photo_unavailable');
      const blob = response.status === 204 ? null : await response.blob();
      if (key !== T.key() || ticket !== request || !T.active()) return;
      if (blob && (!blob.size || blob.type !== 'image/webp')) throw Error('photo_unavailable');
      avatar(blob); loaded = true; error.textContent = ''; document.getElementById('profile-photo-retry').hidden = true;
    } catch (_) {
      if (key === T.key() && T.active()) {
        loaded = true;
        error.textContent = 'Não foi possível carregar a foto. Toque em Tentar novamente.';
        document.getElementById('profile-photo-retry').hidden = false;
      }
    } finally { if (key === T.key()) loading = false; }
  };
  T.save = async blob => {
    if (!T.active() || saving) throw Error('invalid_session');
    const key = T.key(); saving = true; request++; loading = false;
    try {
      const response = await C.authenticatedFetch('/api/caixa/profile/photo', {
        method: 'PUT', headers: { 'Content-Type': blob.type }, body: blob,
      });
      if (!response.ok) { const data = await C.json(response); throw Error(data.error || 'photo_save_failed'); }
      const photo = await response.blob();
      if (key !== T.key() || !T.active()) throw Error('invalid_session');
      if (photo.type !== 'image/webp' || !photo.size) throw Error('photo_save_failed');
      avatar(photo); loaded = true; error.textContent = ''; document.getElementById('profile-photo-retry').hidden = true;
    } finally { if (key === T.key()) saving = false; }
  };
  T.blockNavigation = () => { if (!saving) return false; C.showToast('Aguarde a foto terminar de salvar.'); return true; };
  T.sync = tab => {
    if (fingerprint !== C.sessionFingerprint()) { T.reset(); fingerprint = C.sessionFingerprint(); }
    C.profileCamera?.sync(tab);
    if (!T.active()) return;
    if (!['profile', 'profile-camera'].includes(tab)) T.backTab = tab;
    document.getElementById('profile-unit-name').textContent = C.stored(C.keys.store) || 'Matriz';
    document.getElementById('profile-access-name').textContent = document.getElementById('profile-role-label').textContent;
    if (!loaded && !loading) void T.load();
  };
  document.getElementById('profile-photo-button').addEventListener('click', () => { if (T.active()) void C.profileCamera.open(); });
  document.getElementById('profile-back').addEventListener('click', () => C.showTab(T.backTab));
  document.getElementById('profile-photo-retry').addEventListener('click', () => {
    document.getElementById('profile-photo-retry').hidden = true; void T.load(true);
  });
  document.addEventListener('click', event => {
    if (saving && event.target.closest('.bottom-nav button,#operator-button,#notifications-button,#caixa-logout')) {
      event.preventDefault(); event.stopImmediatePropagation(); T.blockNavigation();
    }
  }, true);
}());
