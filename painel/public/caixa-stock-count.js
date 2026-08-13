(function () {
  'use strict';

  const Caixa = window.Caixa;
  const byId = function (id) { return document.getElementById(id); };
  const modal = byId('stock-count-modal');
  const form = byId('stock-count-form');
  const list = byId('stock-count-list');
  const error = byId('stock-count-error');
  const submit = byId('stock-count-submit');
  const reasonLabels = {
    mercadoria_encontrada: 'Mercadoria encontrada',
    mercadoria_faltando: 'Mercadoria faltando',
    avaria_descarte: 'Avaria ou descarte',
    erro_contagem: 'Erro na contagem anterior',
    inventario: 'Inventário',
    outro: 'Outro motivo',
  };
  let entries = [];
  let batchId = '';
  let query = '';

  function uuid() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    const bytes = new Uint8Array(16); window.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, function (byte) { return byte.toString(16).padStart(2, '0'); });
    return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
  }

  function systemQuantity(entry) {
    return Number(entry.row.quantity_on_hand || 0);
  }

  function difference(entry) {
    return entry.counted == null ? null : entry.counted - systemQuantity(entry);
  }

  function checkedEntries() {
    return entries.filter(function (entry) { return entry.counted != null; });
  }

  function reasonPayload(entry) {
    if (difference(entry) === 0) return { reason: 'rotina', detail: null };
    const choice = entry.reasonChoice;
    return {
      reason: choice === 'inventario' ? 'inventario' : (choice === 'outro' ? 'outro' : 'divergencia'),
      detail: reasonLabels[choice] || null,
    };
  }

  function canSubmit() {
    const checked = checkedEntries();
    return checked.length > 0 && checked.every(function (entry) {
      return difference(entry) === 0 || Boolean(entry.reasonChoice);
    });
  }

  function updateSummary() {
    const checked = checkedEntries();
    const total = entries.length;
    const percent = total ? Math.round((checked.length / total) * 100) : 0;
    const system = checked.reduce(function (sum, entry) { return sum + systemQuantity(entry); }, 0);
    const counted = checked.reduce(function (sum, entry) { return sum + entry.counted; }, 0);
    const diff = counted - system;
    byId('stock-count-progress').textContent = `${checked.length} de ${total} produtos conferidos`;
    byId('stock-count-progress-percent').textContent = `${percent}%`;
    byId('stock-count-progress-bar').style.width = `${percent}%`;
    byId('stock-count-summary-system').textContent = String(system);
    byId('stock-count-summary-counted').textContent = String(counted);
    byId('stock-count-summary-diff').textContent = `${diff > 0 ? '+' : ''}${diff}`;
    byId('stock-count-summary-diff-wrap').className = diff === 0 ? '' : (diff > 0 ? 'positive' : 'negative');
    submit.disabled = !canSubmit();
    submit.textContent = checked.length
      ? `Enviar ${checked.length} ${checked.length === 1 ? 'contagem' : 'contagens'} para aprovação`
      : 'Enviar contagem para aprovação';
  }

  function setCount(entry, value) {
    const parsed = Number(value);
    entry.counted = Number.isInteger(parsed) && parsed >= 0 && parsed <= 999999 ? parsed : null;
    render();
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
      canvas.toBlob(function (blob) {
        if (blob) resolve(blob); else reject(new Error('compress_failed'));
      }, 'image/jpeg', 0.8);
    });
  }

  function createReason(entry) {
    const area = document.createElement('div');
    area.className = 'stock-count-difference-fields';
    const select = document.createElement('select');
    select.setAttribute('aria-label', 'Motivo da diferença');
    select.appendChild(new Option('Selecione o motivo da diferença', ''));
    Object.entries(reasonLabels).forEach(function (pair) { select.appendChild(new Option(pair[1], pair[0])); });
    select.value = entry.reasonChoice;
    select.addEventListener('change', function () { entry.reasonChoice = select.value; updateSummary(); });
    const photo = document.createElement('label');
    photo.className = 'stock-count-photo';
    photo.textContent = entry.photo ? 'Trocar foto' : 'Adicionar foto';
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*'; input.capture = 'environment'; input.hidden = true;
    input.addEventListener('change', async function () {
      const file = input.files && input.files[0]; input.value = '';
      if (!file) return;
      try {
        const blob = await compressPhoto(file);
        if (entry.preview) URL.revokeObjectURL(entry.preview);
        entry.photo = blob; entry.preview = URL.createObjectURL(blob); render();
      } catch (_) { Caixa.showToast('Não consegui ler essa foto. Tente novamente.'); }
    });
    photo.appendChild(input);
    area.append(select, photo);
    if (entry.preview) {
      const preview = document.createElement('img');
      preview.src = entry.preview; preview.alt = 'Foto da contagem'; preview.className = 'stock-count-photo-preview';
      area.appendChild(preview);
    }
    return area;
  }

  function createCard(entry) {
    const row = entry.row;
    const card = document.createElement('article');
    card.className = 'stock-count-card' + (entry.counted != null ? ' checked' : '');
    card.dataset.stockId = row.stock_id;
    let visual;
    if (row.item_type === 'pneu') {
      visual = document.createElement('img'); visual.src = '/operacao/catalog-tire.webp'; visual.alt = '';
    } else {
      visual = document.createElement('div'); visual.className = 'stock-count-package';
      visual.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m4 7 8-4 8 4-8 4-8-4Z"/><path d="M4 7v10l8 4 8-4V7M12 11v10"/></svg>';
    }
    const content = document.createElement('div'); content.className = 'stock-count-card-content';
    const primary = document.createElement('strong'); primary.className = 'stock-count-primary';
    primary.textContent = row.item_type === 'pneu' && row.tire_size ? row.tire_size : row.item_name;
    const brand = document.createElement('span'); brand.className = 'stock-count-brand';
    brand.textContent = row.brand || 'Sem marca';
    const code = document.createElement('span'); code.className = 'stock-count-code';
    code.textContent = row.local_sku ? `Código ${row.local_sku}` : 'Sem código';
    const systemLabel = document.createElement('small'); systemLabel.className = 'stock-count-field-label stock-count-system-label';
    systemLabel.textContent = 'Saldo no sistema';
    const countedLabel = document.createElement('small'); countedLabel.className = 'stock-count-field-label stock-count-counted-label';
    countedLabel.textContent = 'Quantidade contada';
    const current = document.createElement('button'); current.type = 'button'; current.className = 'stock-count-system-box';
    current.title = 'Usar o saldo do sistema como quantidade contada';
    current.setAttribute('aria-label', `Usar saldo do sistema para ${row.item_name}`);
    const currentValue = document.createElement('b'); currentValue.textContent = row.quantity_on_hand == null ? '—' : String(row.quantity_on_hand);
    current.appendChild(currentValue);
    current.addEventListener('click', function () { setCount(entry, systemQuantity(entry)); });
    const stepper = document.createElement('div'); stepper.className = 'stock-count-stepper';
    const minus = document.createElement('button'); minus.type = 'button'; minus.textContent = '−'; minus.disabled = entry.counted == null || entry.counted === 0;
    const input = document.createElement('input'); input.type = 'number'; input.min = '0'; input.max = '999999'; input.inputMode = 'numeric';
    input.placeholder = '—'; input.value = entry.counted == null ? '' : String(entry.counted);
    input.setAttribute('aria-label', `Quantidade contada de ${row.item_name}`);
    input.addEventListener('input', function () {
      const value = input.value === '' ? null : Number(input.value);
      entry.counted = Number.isInteger(value) && value >= 0 && value <= 999999 ? value : null;
      updateSummary();
    });
    input.addEventListener('change', render);
    const plus = document.createElement('button'); plus.type = 'button'; plus.textContent = '+';
    minus.addEventListener('click', function () { setCount(entry, Math.max(0, entry.counted - 1)); });
    plus.addEventListener('click', function () { setCount(entry, (entry.counted == null ? 0 : entry.counted) + 1); });
    stepper.append(minus, input, plus);
    content.append(primary, brand, code, systemLabel, countedLabel, current, stepper);
    if (entry.counted != null) {
      const diff = difference(entry);
      const status = document.createElement('p');
      status.className = diff === 0 ? 'stock-count-status ok' : 'stock-count-status warning';
      status.textContent = diff === 0 ? '✓ Sem diferença' : `! Diferença: ${diff > 0 ? '+' : ''}${diff}`;
      content.appendChild(status);
      if (diff !== 0) content.appendChild(createReason(entry));
    }
    card.append(visual, content);
    return card;
  }

  function render() {
    const normalized = query.toLocaleLowerCase('pt-BR');
    const visible = entries.filter(function (entry) {
      return !normalized || [entry.row.item_name, entry.row.brand, entry.row.tire_size, entry.row.local_sku]
        .filter(Boolean).join(' ').toLocaleLowerCase('pt-BR').includes(normalized);
    });
    list.replaceChildren(...visible.map(createCard));
    byId('stock-count-empty').classList.toggle('hidden', visible.length > 0);
    updateSummary();
  }

  function closeCount() {
    entries.forEach(function (entry) { if (entry.preview) URL.revokeObjectURL(entry.preview); });
    entries = []; query = ''; error.textContent = ''; modal.classList.add('hidden');
  }

  function openCount(stockId) {
    const rows = Caixa.stockState.rows.filter(function (row) { return row.is_tracked && row.item_type !== 'servico'; });
    if (!rows.length) return Caixa.showToast('Não há produto controlado disponível para contagem.');
    if (stockId) rows.sort(function (left, right) {
      return Number(right.stock_id === stockId) - Number(left.stock_id === stockId);
    });
    entries = rows.map(function (row) {
      return { row: row, counted: null, reasonChoice: '', photo: null, preview: '' };
    });
    batchId = uuid(); query = ''; error.textContent = '';
    byId('stock-count-search').value = '';
    byId('stock-count-unit').textContent = Caixa.stored(Caixa.keys.store) || 'Unidade logada';
    byId('stock-count-actor-note').textContent = `Solicitação registrada em nome de ${Caixa.stored(Caixa.keys.name) || 'quem está logado'}.`;
    modal.classList.remove('hidden'); render();
    if (stockId) window.setTimeout(function () { list.querySelector('[data-stock-id] input')?.focus(); }, 50);
  }

  async function submitBatch(event) {
    event.preventDefault();
    const checked = checkedEntries();
    if (!canSubmit()) { error.textContent = 'Conte ao menos um produto e informe o motivo de cada diferença.'; return; }
    submit.disabled = true; error.textContent = ''; submit.textContent = 'Enviando contagem…';
    try {
      const response = await Caixa.authenticatedFetch(Caixa.operationPath('operacao/estoque/contagens/lote'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batch_id: batchId, items: checked.map(function (entry) {
          const reason = reasonPayload(entry);
          return { stock_id: entry.row.stock_id, counted_quantity: entry.counted, reason: reason.reason,
            reason_detail: reason.detail, idempotency_key: `count-${batchId}-${entry.row.stock_id}` };
        }) }),
      });
      const result = await Caixa.json(response);
      if (!response.ok) throw new Error(result.error || 'request_failed');
      const requests = new Map((result.requests || []).map(function (item) { return [item.stock_id, item.id]; }));
      const failedPhotos = [];
      for (const entry of checked.filter(function (item) { return item.photo && difference(item) !== 0; })) {
        const requestId = requests.get(entry.row.stock_id);
        const upload = await Caixa.authenticatedFetch(Caixa.operationPath(`operacao/estoque/contagens/${requestId}/foto`), {
          method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: entry.photo,
        });
        if (!upload.ok) failedPhotos.push(entry.row.item_name);
      }
      if (failedPhotos.length) throw new Error('photo_upload_failed');
      closeCount(); Caixa.showToast('Contagem enviada. O dono recebeu os itens para aprovação.');
      void Caixa.loadStock();
    } catch (failure) {
      const code = failure instanceof Error ? failure.message : '';
      error.textContent = code === 'photo_upload_failed'
        ? 'A contagem foi enviada, mas uma foto falhou. Toque novamente para tentar anexá-la.'
        : (code === 'stock_unavailable_for_count'
          ? 'Um produto mudou ou não está mais disponível. Atualize o estoque e tente novamente.'
          : 'Não foi possível enviar a contagem. Tente novamente.');
      updateSummary();
    }
  }

  byId('stock-count-search').addEventListener('input', function (event) { query = event.target.value.trim(); render(); });
  byId('stock-count-scan').addEventListener('click', function () { byId('stock-count-scan-file').click(); });
  byId('stock-count-scan-file').addEventListener('change', async function (event) {
    const file = event.target.files && event.target.files[0]; event.target.value = '';
    if (!file || !window.BarcodeDetector) {
      Caixa.showToast('Leitor indisponível. Busque pelo nome ou código.'); byId('stock-count-search').focus(); return;
    }
    try {
      const bitmap = await createImageBitmap(file); const codes = await new BarcodeDetector().detect(bitmap); bitmap.close();
      if (!codes[0]?.rawValue) throw new Error('not_found');
      byId('stock-count-search').value = codes[0].rawValue; query = codes[0].rawValue; render();
    } catch (_) { Caixa.showToast('Código não identificado. Tente aproximar a câmera.'); }
  });
  form.addEventListener('submit', submitBatch);
  document.querySelectorAll('[data-close-stock-count]').forEach(function (button) { button.addEventListener('click', closeCount); });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !modal.classList.contains('hidden')) closeCount();
  });
  Caixa.openStockCount = openCount;
}());
