(function () {
  'use strict';
  const C = window.Caixa;
  C.createDeliveryPeople = function (root) {
    const cache = new Map(); let session = '', epoch = 0, running = 0;
    function safe(value) {
      try { const u = new URL(value); return value.length <= 4096 && u.protocol === 'https:' && !u.username && !u.password ? u.href : null; }
      catch (_) { return null; }
    }
    function reset() {
      cache.forEach(entry => entry.controller?.abort());
      epoch++; running = 0; cache.clear(); session = C.sessionFingerprint();
      root.querySelectorAll('.mdf-avatar img').forEach(img => img.remove());
    }
    function update(id) {
      const entry = cache.get(id);
      root.querySelectorAll('[data-customer-order-id]').forEach(box => {
        if (box.dataset.customerOrderId !== id) return;
        box.querySelector('img')?.remove(); if (!entry?.url) return;
        const img = document.createElement('img'); img.alt = ''; img.decoding = 'async';
        img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
        const currentEpoch = epoch, url = entry.url;
        img.onerror = () => {
          if (epoch !== currentEpoch || cache.get(id)?.url !== url) return;
          entry.url = null; entry.expires = Date.now() + 60000; update(id);
        };
        img.src = url; box.appendChild(img);
      });
    }
    function refresh() {
      if (session !== C.sessionFingerprint()) reset();
      if (C.isPartner() || !C.elements.app.classList.contains('is-matrix-deliveries')) return;
      const visible = [...root.querySelectorAll('[data-customer-order-id]')]
        .filter(box => !box.closest('[data-mdf-view]')?.hidden && box.dataset.hasAvatar === 'true');
      for (const box of visible) {
        const id = box.dataset.customerOrderId, entry = cache.get(id);
        if (entry?.pending || entry?.expires > Date.now()) { update(id); continue; }
        if (running >= 4) break;
        const key = epoch, activeSession = session;
        const record = { pending: true, url: null, expires: 0, controller: new AbortController() }; cache.set(id, record); running++;
        C.authenticatedFetch('/api/caixa/entregas/' + encodeURIComponent(id) + '/avatar', { signal: record.controller.signal })
          .then(async response => response.ok ? C.json(response) : null)
          .then(data => {
            if (key !== epoch || activeSession !== C.sessionFingerprint()) return;
            record.url = safe(data?.url); record.expires = Date.now() + (record.url ? 300000 : 60000);
          }).catch(() => { if (key === epoch) record.expires = Date.now() + 30000; })
          .finally(() => {
            if (key !== epoch) return; running--; record.pending = false; update(id);
            if (cache.size > 150) for (const [oldId, old] of cache) {
              if (!old.pending && !visible.some(node => node.dataset.customerOrderId === oldId)) { cache.delete(oldId); break; }
            }
            refresh();
          });
      }
    }
    function avatar(row) {
      const box = document.createElement('span'); box.className = 'mdf-avatar';
      const initials = document.createElement('span'); initials.textContent = (row.customer_name || 'Cliente')
        .trim().split(/\s+/).slice(0, 2).map(word => word[0] || '').join('').toUpperCase();
      box.setAttribute('aria-hidden', 'true'); box.dataset.customerOrderId = row.order_id;
      box.dataset.hasAvatar = String(Boolean(row.has_customer_avatar)); box.appendChild(initials);
      return box;
    }
    return { avatar, refresh, reset };
  };
}());
