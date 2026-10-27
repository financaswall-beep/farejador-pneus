(function () {
  'use strict';
  const C = window.Caixa;
  C.createMatrixDeliveryReceipts = function (state, ui, paint, run) {
    const byId = ui.byId; const images = new Map(); let epoch = 0; let previewEpoch = 0; let returnFocus = null;
    const context = () => JSON.stringify([C.sessionFingerprint(), state.generation, state.route?.trip_id, epoch]);
    function node(tag, text, cls) {
      const el = document.createElement(tag); if (text != null) el.textContent = text;
      if (cls) el.className = cls; return el;
    }
    function closePreview() {
      previewEpoch++;
      const modal = byId('mdf-receipt-preview'); if (modal.open) modal.close();
      ui.closeOverlay?.();
      byId('mdf-receipt-photo').removeAttribute('src');
      if (returnFocus?.isConnected) returnFocus.focus(); returnFocus = null;
    }
    function reset() {
      epoch++; closePreview();
      images.forEach(promise => promise.then(url => { if (url) URL.revokeObjectURL(url); })); images.clear();
      byId('mdf-receipts').replaceChildren(); byId('matrix-route-receipt-status').textContent = '';
      for (const id of ['matrix-route-receipt', 'mdf-receipt-gallery']) byId(id).value = '';
    }
    function imageUrl(id) {
      if (!images.has(id)) {
        const key = context();
        const pending = C.authenticatedFetch('/api/caixa/entregas/rota/comprovantes/' + encodeURIComponent(id))
          .then(response => { if (!response.ok) throw new Error('receipt_image_failed'); return response.blob(); })
          .then(blob => {
            if (key !== context()) return null;
            return URL.createObjectURL(blob);
          }).catch(() => { if (images.get(id) === pending) images.delete(id); return null; });
        images.set(id, pending);
      }
      return images.get(id);
    }
    function render() {
      if (state.view !== 'close') return;
      const receipts = state.route?.receipts || [];
      byId('mdf-receipt-help').hidden = receipts.length > 0;
      byId('mdf-receipt-camera-label').textContent = receipts.length ? '+ Fotografar outra nota' : 'Fotografar nota';
      byId('mdf-receipts').replaceChildren(...receipts.map((receipt, index) => {
        const card = node('article', null, 'mdf-receipt-card');
        const copy = node('div'); copy.appendChild(node('strong', receipts.length === 1 ? '✓ Nota anexada' : '✓ Nota ' + (index + 1) + ' anexada'));
        const reviewed = ['linked', 'legacy_linked'].includes(receipt.workflow_status);
        const rejected = receipt.workflow_status === 'rejected';
        copy.appendChild(node('span', reviewed ? 'Conferida pelo escritório' : rejected ? 'Rejeitada pelo escritório' : 'Aguardando conferência',
          'mdf-receipt-state' + (reviewed ? ' is-reviewed' : rejected ? ' is-rejected' : '')));
        if (receipt.has_image) {
          const image = node('img'); image.alt = 'Foto da nota ' + (index + 1); card.appendChild(image);
          const key = context(); imageUrl(receipt.receipt_id).then(url => {
            if (url && key === context() && image.isConnected) image.src = url;
            else if (!url && key === context() && image.isConnected) { image.hidden = true; copy.appendChild(node('small', 'Foto indisponível. Atualize para tentar novamente.')); }
          });
          const button = node('button', 'Ver foto', 'mdf-button mdf-secondary'); button.type = 'button';
          button.dataset.receiptId = receipt.receipt_id; button.disabled = state.busy || state.loading; copy.appendChild(button);
        } else copy.appendChild(node('small', 'Foto indisponível. Procure o escritório.'));
        card.appendChild(copy); return card;
      }));
    }
    async function uploadReceipt(input) {
      const file = input.files?.[0]; if (!file || !state.route || state.busy || state.loading || C.isPartner()) return;
      const key = context(); byId('matrix-route-receipt-status').textContent = 'Enviando nota…';
      const ok = await run(async () => {
        const response = await C.authenticatedFetch('/api/caixa/entregas/rota/comprovante', {
          method: 'POST', headers: { 'Content-Type': file.type || 'image/jpeg' }, body: file,
        });
        const payload = await C.json(response);
        if (!response.ok) throw new Error(payload.error || 'receipt_upload_failed');
        if (!payload.receipt_id) throw new Error('receipt_upload_unconfirmed'); return payload;
      }, async payload => {
        if (key !== context()) return;
        const receipts = state.route.receipts ||= [];
        if (!receipts.some(row => row.receipt_id === payload.receipt_id)) receipts.push({
          receipt_id: payload.receipt_id, workflow_status: payload.workflow_status || 'review_required', has_image: true,
        });
        byId('matrix-route-receipt-status').textContent = payload.duplicate ? 'Esta nota já estava anexada à rota.' : 'Nota enviada para conferência.';
        await state.reload();
      });
      if (key === context()) {
        if (!ok) byId('matrix-route-receipt-status').textContent = 'Não consegui confirmar o envio. Atualize para conferir antes de tentar novamente.';
        input.value = '';
      }
    }
    async function openPreview(id) {
      if (state.busy || state.loading || state.view !== 'close' || C.isPartner()
        || !state.route?.receipts?.some(row => row.receipt_id === id && row.has_image)) return;
      const key = context(), preview = ++previewEpoch; const url = await imageUrl(id);
      if (key !== context() || preview !== previewEpoch || state.view !== 'close') return;
      if (!url) { state.error = 'Não consegui abrir a foto. Atualize para tentar novamente.'; paint(); return; }
      returnFocus = document.activeElement;
      byId('mdf-receipt-photo').src = url; const modal = byId('mdf-receipt-preview');
      if (!modal.open) { if (ui.showOverlay) ui.showOverlay(modal); else modal.showModal(); }
    }
    for (const id of ['matrix-route-receipt', 'mdf-receipt-gallery']) {
      const input = byId(id); input.addEventListener('change', () => uploadReceipt(input));
    }
    byId('mdf-receipts').addEventListener('click', event => {
      const button = event.target.closest('[data-receipt-id]'); if (button) void openPreview(button.dataset.receiptId);
    });
    byId('mdf-receipt-preview-close').addEventListener('click', closePreview);
    byId('mdf-receipt-preview').addEventListener('cancel', event => { event.preventDefault(); closePreview(); });
    return { render, reset, leave: closePreview };
  };
}());
