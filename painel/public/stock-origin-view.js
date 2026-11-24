(function () {
  'use strict';
  const keys = new Map();
  function el(tag, value, className) {
    const n = document.createElement(tag);
    if (value != null) n.textContent = value;
    if (className) n.className = className;
    return n;
  }
  function button(label, click, primary) {
    const b = el('button', label, primary ? 'origin-primary' : 'origin-secondary');
    b.type = 'button';
    b.addEventListener('click', click);
    return b;
  }
  function place(c) { return c.location_code || 'Sem pilha cadastrada'; }
  function kind(c) { return c.matched_set ? 'Do conjunto' : 'Avulso'; }
  function optionLabel(c, all) {
    let text = kind(c) + (c.model ? ' · ' + c.model : '');
    if (all.some(other => other.candidate_id !== c.candidate_id && other.location_code === c.location_code &&
        other.matched_set === c.matched_set && other.model === c.model) && c.group_id) text += ' · grupo ' + c.group_id.slice(0,8);
    return text;
  }
  function describe(c, all) {
    return place(c) + (all.some(other => other.candidate_id !== c.candidate_id && other.location_code === c.location_code)
      ? ' (' + optionLabel(c, all) + ')' : '');
  }
  function render(host, rows, { save, onSaved, onDefer, refresh, showOrder = false } = {}) {
    host.replaceChildren();
    for (const row of rows || []) {
      const all = row.candidates || [], total = Number(row.quantity);
      const card = el('details', null, 'origin-card');
      card.open = true;
      const title = 'Confirmar origem' + (showOrder ? ' · Venda ' + row.order_number : '');
      card.append(el('summary', title), el('p', [row.product_name || row.brand, row.measure, total + ' un.'].filter(Boolean).join(' · ')));
      const suggested = all.filter(c => c.suggested_quantity > 0);
      const complete = suggested.reduce((n,c) => n + Number(c.suggested_quantity), 0) === total
        && suggested.every(c => c.suggested_quantity <= c.available);
      if (complete) {
        const protectsSet = all.some(c => c.matched_set) && suggested.every(c => !c.matched_set);
        const locations = suggested.map(c => describe(c, all) + ' · ' + c.suggested_quantity + ' un.').join(', ');
        card.appendChild(el('p', (protectsSet ? 'Para preservar o conjunto, pegue o avulso em ' : 'Sugestão de retirada em ') + locations));
      }
      const status = el('p'); status.setAttribute('role','status');
      const actions = el('div', null, 'origin-actions'), other = el('div', null, 'origin-other');
      let busy = false;
      async function confirm(selections) {
        if (busy || !save) return;
        const fingerprint = row.id + JSON.stringify(selections);
        const key = keys.get(fingerprint) || window.crypto.randomUUID();
        keys.set(fingerprint,key);
        busy = true;
        const controls = [...card.querySelectorAll('button,input,select')];
        controls.forEach(c => { c.disabled = true; }); status.textContent = 'Registrando origem…';
        try {
          await save(row,{ selections, idempotency_key: key });
          keys.delete(fingerprint);
          card.replaceChildren(el('p','Origem confirmada. O saldo total já estava contabilizado.'));
          card.open = true;
          if (onSaved) onSaved(row.id);
        } catch (e) {
          status.textContent = ['stock_origin_changed','stock_origin_not_found'].includes(e.message)
            ? 'A disponibilidade mudou. Atualize antes de confirmar.' : 'Não foi possível confirmar a origem.';
          if (refresh) status.appendChild(button('Atualizar', () => refresh(), false));
        } finally { busy = false; controls.forEach(c => { c.disabled = false; }); }
      }
      function choose() {
        other.replaceChildren();
        const chosen = new Map(), places = [...new Set(all.map(c => c.location_code))];
        const remaining = el('p');
        const submit = button('Confirmar retirada', () => {
          const selections = Array.from(chosen, ([candidate_id, quantity]) => ({candidate_id, quantity})).filter(i => i.quantity > 0);
          if (selections.reduce((n,v) => n+v.quantity,0) === total) void confirm(selections);
        }, true);
        function recount() {
          const sum = Array.from(chosen.values()).reduce((n,v) => n+v,0);
          submit.disabled = sum !== total;
          remaining.textContent = total > 1 ? sum + ' de ' + total + ' unidades indicadas' : '';
        }
        for (const code of places) {
          const at = all.filter(c => c.location_code === code && c.available > 0);
          if (!at.length) continue;
          const pile = el('details'); pile.appendChild(el('summary', place(at[0])));
          if (at.length > 1) pile.appendChild(el('p','Qual pneu saiu desta pilha?'));
          for (const candidate of at) {
            const label = at.length > 1 ? optionLabel(candidate, all) : place(candidate);
            if (total === 1) {
              pile.appendChild(button(at.length > 1 ? label : 'Peguei daqui', () => confirm([{ candidate_id: candidate.candidate_id, quantity: 1 }]), true));
            } else {
              const field = el('label',label), n = el('input');
              n.type = 'number'; n.min = '0'; n.max = String(Math.min(total,candidate.available)); n.step = '1'; n.value = '0';
              n.addEventListener('input', () => {
                const v = n.valueAsNumber;
                chosen.set(candidate.candidate_id, Number.isInteger(v) && v >= 0 && v <= Number(n.max) ? v : NaN);
                recount();
              });
              field.appendChild(n); pile.appendChild(field);
            }
          }
          other.appendChild(pile);
        }
        if (total > 1) { other.append(remaining,submit); recount(); }
      }
      if (save) {
        if (complete) {
          const quick = suggested.length === 1 && suggested[0].location_code ? 'Peguei da ' + describe(suggested[0], all) : 'Peguei conforme a sugestão';
          actions.appendChild(button(quick, () => confirm(suggested.map(c => ({ candidate_id:c.candidate_id, quantity:c.suggested_quantity }))), true));
        }
        actions.append(button(complete ? 'Outra origem' : 'Indicar origem', choose, false),
          button('Deixar para depois', () => { card.open = false; if (onDefer) onDefer(); }, false));
      }
      card.append(actions,other,status); host.appendChild(card);
    }
  }
  function operation(host, row, channel, reload) {
    const C = window.Caixa;
    if (!C || C.isPartner() || !C.canModule(channel) || !row.order_id) return;
    const path = '/api/caixa/origens/' + channel + '/' + encodeURIComponent(row.order_id);
    const session = C.sessionFingerprint();
    let generation = 0;
    async function request(url, options) {
      if (session !== C.sessionFingerprint()) throw new Error('invalid_session');
      const response = await C.authenticatedFetch(url,options), data = await C.json(response);
      if (!response.ok) throw new Error(data.error || 'request_failed');
      return data;
    }
    function draw(rows) {
      render(host,rows,{save: (p,body) => request(path + '/' + encodeURIComponent(p.id),
        {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),
        refresh, onSaved: id => {
          row.stock_origin_pendings = (row.stock_origin_pendings || []).filter(p => p.id !== id);
          if (reload && session === C.sessionFingerprint()) {
            C.showToast('Origem confirmada. O saldo total já estava contabilizado.');
            reload();
          }
        }});
    }
    async function refresh() {
      const run = ++generation;
      try {
        const data = await request(path);
        if (run !== generation || session !== C.sessionFingerprint() || !host.isConnected) return;
        row.stock_origin_pendings = data.rows; draw(data.rows);
      } catch (_) {
        if (run === generation && session === C.sessionFingerprint() && host.isConnected) {
          host.replaceChildren(button('Tentar consultar a origem novamente', refresh, false));
        }
      }
    }
    if (channel === 'vendas' && row.stock_origin_pendings === undefined) void refresh();
    else draw(row.stock_origin_pendings);
  }
  window.StockOrigin = { render, operation };
}());
