(function () {
  'use strict';
  const M = window.Caixa.marketing, V = M.V;
  M.openReconciliation = (post, delivery) => {
    const p = M.publisher; p.mpOpenReconciliation(post, delivery);
    if (!p.mpReconciliation) return;
    const data = p.mpReconciliation, body = V.dialog('Conferir envio no ' + V.platform(delivery.platform)), form = V.node('form');
    form.appendChild(V.node('p', 'O resultado deste envio ainda é incerto. Confira a conta antes de registrar a situação. Um envio incerto não será repetido automaticamente.', 'mk-notice'));
    const decision = V.node('select'); decision.setAttribute('aria-label', 'Situação conferida');
    [['published', 'Encontrei a publicação'], ['not_published', 'Não foi publicada'], ['abandon', 'Encerrar sem reenviar']].forEach(([value, label]) => { const option = V.node('option', label); option.value = value; decision.appendChild(option); });
    const label = V.node('label', null, 'mk-field'); label.append(V.node('span', 'Situação conferida'), decision); form.appendChild(label);
    const provider = V.field('Link ou ID da publicação', 'text', data.provider_id, value => { data.provider_id = value; }); provider.input.maxLength = 2048;
    const note = V.field('O que você conferiu?', 'textarea', data.note, value => { data.note = value; }); note.input.required = true; note.input.minLength = 10; note.input.maxLength = 500;
    const check = V.node('label', null, 'mk-check'), confirmed = V.node('input'); confirmed.type = 'checkbox'; confirmed.required = true; confirmed.addEventListener('change', () => { data.confirmed = confirmed.checked; }); check.append(confirmed, V.node('span', 'Conferi na conta conectada e confirmo estas informações.'));
    decision.addEventListener('change', () => { data.decision = decision.value; provider.wrap.classList.toggle('hidden', data.decision !== 'published'); provider.input.required = data.decision === 'published'; });
    provider.input.required = true;
    const send = V.node('button', 'Confirmar conferência', 'mk-primary'); send.type = 'submit';
    form.append(provider.wrap, note.wrap, check, send); body.appendChild(form);
    form.addEventListener('submit', event => { event.preventDefault(); if (form.reportValidity()) void M.run(async () => { await p.mpReconcile(); if (!p.mpError && !p.mpReconciliation) M.closeDialog(); }); });
  };
}());
