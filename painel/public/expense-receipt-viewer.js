(function () {
  'use strict';
  let dialog, controller, url;
  function close() {
    controller?.abort(); controller = null;
    if (url) URL.revokeObjectURL(url); url = null;
    dialog?.remove(); dialog = null;
  }
  async function show(path, authenticatedFetch) {
    close(); const current = new AbortController(); controller = current;
    const modal = document.createElement('dialog'); dialog = modal;
    modal.setAttribute('aria-label', 'Comprovante da despesa');
    Object.assign(modal.style, { width: 'min(94vw, 720px)', maxHeight: '90dvh', boxSizing: 'border-box', padding: '16px', border: '1px solid #ccd9dc', borderRadius: '16px', background: '#fff', color: '#15343d' });
    const button = document.createElement('button'); button.textContent = 'Fechar comprovante'; button.type = 'button';
    Object.assign(button.style, { padding: '10px', borderRadius: '8px', marginBottom: '12px', cursor: 'pointer' });
    const status = document.createElement('p'); status.textContent = 'Carregando comprovante…'; status.setAttribute('role', 'status');
    modal.append(button, status); document.body.appendChild(modal); modal.showModal();
    button.addEventListener('click', close); modal.addEventListener('cancel', e => { e.preventDefault(); close(); });
    try {
      const response = await authenticatedFetch(path, { signal: current.signal });
      if (!response.ok) throw Error('receipt_unavailable');
      const blob = await response.blob(); if (current.signal.aborted) return;
      if (blob.type !== 'image/jpeg') throw Error('invalid_image');
      url = URL.createObjectURL(blob); const image = document.createElement('img'); image.src = url; image.alt = 'Foto do comprovante vinculado à despesa'; image.style.width = '100%';
      status.remove(); modal.appendChild(image);
    } catch { if (!current.signal.aborted) status.textContent = 'Não foi possível abrir o comprovante. Feche e tente novamente.'; }
  }
  window.ExpenseReceiptViewer = { show, close };
}());
