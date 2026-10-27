(function () {
  'use strict';
  const C = window.Caixa, M = C.marketing;
  const paths = { back: 'm15 5-7 7 7 7', chevron: 'm9 5 7 7-7 7', close: 'm6 6 12 12M6 18 18 6',
    plus: 'M12 4v16M4 12h16', arrow: 'M4 12h16m-6-6 6 6-6 6', refresh: 'M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 14 6M4 12a8 8 0 0 0 14 6',
    camera: 'M8 5l2-2h4l2 2h4v16H4V5h4ZM8 13a4 4 0 1 0 8 0 4 4 0 0 0-8 0',
    image: 'M3 3h18v18H3zM3 17l6-6 5 5 3-3 4 4M7 7h.01', folder: 'M3 6V4h7l2 3h9v14H3V6Z',
    search: 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14M15 15l6 6', play: 'm9 5 11 7-11 7V5Z',
    calendar: 'M4 5h16v16H4V5ZM8 3v4m8-4v4M4 10h16', chart: 'M5 20V10h3v10M11 20V4h3v16M17 20V8h3v12',
    link: 'm10 13 4-4M8 16l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0M16 8l2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0',
    settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z',
    wand: 'm4 20 13-13 3 3L7 23 4 20ZM15 2v4M13 4h4M5 3v4M3 5h4M21 15v4m-2-2h4', check: 'm5 12 4 4L19 6', trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7' };
  function node(tag, text, cls) { const item = document.createElement(tag); if (text != null) item.textContent = text; if (cls) item.className = cls; return item; }
  function icon(name) { return C.createSvg([{ d: paths[name] || paths.image }]); }
  function button(text, action, cls = 'mk-link', glyph) {
    const b = node('button', null, cls); b.type = 'button'; b.dataset.mkLock = '';
    if (glyph) b.appendChild(icon(glyph)); b.appendChild(node('span', text));
    b.addEventListener('click', action); return b;
  }
  function disabled(el, value) { el.dataset.mkDisabled = String(Boolean(value)); el.disabled = Boolean(value) || M.busy(); }
  function safeUrl(value, social = false) {
    try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password
      && (!social || /(^|\.)(instagram\.com|facebook\.com)$/.test(u.hostname)) ? u.href : null; } catch { return null; }
  }
  function image(url, alt, cls = 'mk-thumb') {
    const frame = node('span', null, cls), src = safeUrl(url);
    if (src) { const img = node('img'); img.src = src; img.alt = alt || 'Prévia do conteúdo'; img.loading = 'lazy';
      img.addEventListener('error', () => frame.replaceChildren(icon('image')), { once: true }); frame.appendChild(img); }
    else frame.appendChild(icon('image'));
    return frame;
  }
  const platform = value => ({ instagram: 'Instagram', facebook: 'Facebook' })[value] || 'Rede';
  function network(value) {
    const line = node('span', null, 'mk-network');
    if (['instagram', 'facebook'].includes(value)) { const img = node('img'); img.src = '/operacao/assets/brands/' + value + '.svg'; img.alt = ''; line.appendChild(img); }
    line.appendChild(node('span', platform(value))); return line;
  }
  function networks(rows) { const wrap = node('div', null, 'mk-networks'); [...new Set((rows || []).map(r => r.platform))].filter(p => ['instagram', 'facebook'].includes(p)).forEach(p => wrap.appendChild(network(p))); return wrap; }
  const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  const count = value => number(value) == null ? '—' : value.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
  const money = value => number(value) == null ? '—' : C.currency.format(value);
  const date = (value, time = true) => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', ...(time ? { timeStyle: 'short' } : {}) }).format(new Date(value)) : 'Data indisponível';
  function badge(status) { const span = node('span', M.publisher.mpStatus(status), 'mk-badge'); span.dataset.status = status; return span; }
  function empty(host, text) { host.replaceChildren(node('p', text, 'mk-empty')); }
  function metric(label, value, cls = '') { const wrap = node('div', null, 'mk-metric ' + cls); wrap.append(node('span', label), node('strong', value)); return wrap; }
  function field(label, type, value, change) {
    const wrap = node('label', null, 'mk-field'), input = node(type === 'textarea' ? 'textarea' : 'input');
    if (type !== 'textarea') input.type = type; input.value = value || ''; input.setAttribute('aria-label', label);
    wrap.append(node('span', label), input); if (change) input.addEventListener('input', () => change(input.value)); return { wrap, input };
  }
  function postContext(post) {
    const el = node('div', null, 'mk-post-context'), copy = node('div');
    copy.append(node('strong', post?.title || 'Conteúdo'), node('small', post?.published_at ? 'Publicado em ' + date(post.published_at) : ''));
    el.append(image(post?.image_url, post?.title), copy); return el;
  }
  let origin;
  function dialog(title) {
    if (!M.active()) return node('div');
    M.publisher.mpError = ''; M.el('dialog-error').classList.add('hidden');
    const d = M.el('dialog'); origin = document.activeElement; M.el('dialog-title').textContent = title; M.el('dialog-body').replaceChildren();
    if (!d.open) d.show(); M.el('content').inert = true; M.el('form-actions').inert = true; M.el('dialog-close').focus({ preventScroll: true }); return M.el('dialog-body');
  }
  M.closeDialog = () => {
    M.el('dialog-body').querySelectorAll('video').forEach(video => { video.pause(); video.removeAttribute('src'); video.load(); });
    M.el('dialog').close(); M.el('content').inert = false; M.el('form-actions').inert = false;
  };
  M.el('dialog').addEventListener('close', () => { M.el('content').inert = false; M.el('form-actions').inert = false; if (M.active() && origin?.isConnected && !origin.closest('.hidden')) origin.focus({ preventScroll: true }); origin = null; });
  M.el('dialog-close').addEventListener('click', () => { if (!M.busy()) M.closeDialog(); });
  document.addEventListener('keydown', event => { if (M.active() && M.el('dialog').open && event.key === 'Escape') { event.preventDefault(); if (!M.busy()) M.closeDialog(); } });
  M.V = { node, icon, button, disabled, safeUrl, image, network, networks, platform, number, count, money, date, badge, empty, metric, field, postContext, dialog };
  M.el('form-actions').append(M.el('continue'), M.el('submit'));
  document.querySelectorAll('[data-mk-icon]').forEach(el => el.appendChild(icon(el.dataset.mkIcon)));
}());
