/* Shared by the purchase detail in the web and mobile panels. */
(function () {
  'use strict';
  const brl = value => Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const date = value => value.split('-').reverse().join('/');
  function el(tag, text) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function button(text, click) {
    const node = el('button', text); node.type = 'button'; node.onclick = click; return node;
  }
  function field(label, input) { const node = el('label', label); node.append(input); return node; }
  function input(type, value, step) {
    const node = el('input'); node.type = type; node.value = value ?? '';
    if (type === 'number') { node.min = '0'; node.step = step || '0.01'; }
    return node;
  }
  function select(options, selected) {
    const node = el('select');
    options.forEach(([value, title]) => { const opt = el('option', title); opt.value = value; node.append(opt); });
    if (selected !== undefined) node.value = selected;
    return node;
  }
  function section(parent, title, open) {
    const block = el('details'); block.open = !!open; block.append(el('summary', title)); parent.append(block); return block;
  }
  function form(parent, action, submitLabel) {
    const node = el('form');
    const submit = el('button', submitLabel || 'Salvar'); submit.type = 'submit';
    node.onsubmit = event => { event.preventDefault(); action(); };
    node.append(submit); parent.append(node);
    return (...children) => { submit.before(...children); };
  }
  async function open(id, request) {
    const path = '/' + encodeURIComponent(id) + '/sharing';
    const dialog = el('dialog'); dialog.className = 'purchase-sharing'; dialog.setAttribute('aria-label', 'Dividir compra');
    const title = el('h2', 'Dividir compra'), close = button('Fechar', () => dialog.close());
    const header = el('header'); header.append(title, close);
    const notice = el('p'); notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
    const content = el('div'); dialog.append(header, notice, content); document.body.append(dialog);
    let state, busy = false, lastSignature, lastKey;
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    dialog.addEventListener('cancel', e => { if (busy) e.preventDefault(); });
    dialog.showModal();
    async function load() { state = await request(path); render(); }
    async function save(body) {
      if (busy) return;
      busy = true; close.disabled = true; content.inert = true;
      const signature = JSON.stringify([state.revision, body]);
      if (lastSignature !== signature) { lastKey = crypto.randomUUID(); lastSignature = signature; }
      notice.textContent = 'Salvando…';
      try {
        await request(path, { ...body, revision: state.revision, key: lastKey });
        await load(); notice.textContent = 'Alteração salva.'; lastSignature = null;
      } catch (e) { notice.textContent = e.message || 'Falha ao salvar. Tente novamente.'; }
      finally { busy = false; close.disabled = false; content.inert = false; }
    }
    function agreement() {
      const group = section(content, 'Participantes e parte de cada um no custo', !state.shared);
      const rows = el('div'), people = new Map();
      const add = form(group, () => save({ kind: 'agreement', participants: [...people].map(([id, p]) => ({
        id, name: p.name.value.trim(), mode: p.mode.value, value: Number(p.value.value),
      })) }), 'Salvar divisão do custo');
      function person(p) {
        const row = el('fieldset'), name = input('text', p.name), value = input('number', p.value);
        name.required = true; name.maxLength = 80; value.required = true;
        const mode = select([['percent', '% da compra'], ['amount', 'Valor em reais']], p.mode);
        row.append(field('Nome do participante', name), field('Dividir por', mode), field('Parte do participante', value),
          button('Remover', () => { people.delete(p.id); row.remove(); }));
        people.set(p.id, { name, mode, value }); rows.append(row);
      }
      state.participants.forEach(person);
      add(rows, button('Adicionar participante', () => person({ id: crypto.randomUUID(), mode: 'percent' })),
        el('p', 'A loja fica com o restante. Depois informe quem pagou o fornecedor.'));
    }
    function allocations(group, record, kind) {
      const max = kind === 'cash' ? Number(record.gross) - Number(record.other_external) : Math.abs(record.quantity_delta);
      const current = kind === 'cash' ? record.allocations : state.stock_allocations[record.id] || [];
      const fields = new Map(), residual = el('p');
      const remaining = () => {
        const rest = max - [...fields.values()].reduce((n, f) => n + Number(f.value || 0), 0);
        residual.textContent = 'Parte da loja neste movimento · ' + (kind === 'cash' ? brl(rest) : rest + ' pneus');
      };
      const add = form(group, () => save({ kind, [kind === 'cash' ? 'transaction_id' : 'movement_id']: record.id,
        allocations: [...fields].filter(([, f]) => Number(f.value) > 0).map(([id, f]) => ({ id, value: Number(f.value) })) }),
      kind === 'stock' ? 'Salvar titulares deste movimento' : 'Salvar quem movimentou o dinheiro');
      state.participants.forEach(p => {
        const f = input('number', current.find(a => a.id === p.id)?.value ?? 0, kind === 'cash' ? '0.01' : '1');
        f.max = String(max); f.oninput = remaining; fields.set(p.id, f);
        add(field(p.name + (kind === 'cash' ? ' (R$)' : ' (pneus)'), f));
      }); add(residual); remaining();
    }
    function cashFlows() {
      const group = section(content, 'Quem pagou o fornecedor e quem recebeu as vendas', true);
      group.append(el('p', 'Informe o que cada participante pagou direto ao fornecedor ou recebeu direto do cliente. Se passou pelo caixa da loja, deixe o valor do participante em zero.'));
      if (!state.flows.length) group.append(el('p', 'Nenhum pagamento da compra ou recebimento de venda de lote disponível.'));
      const labels = {sale: 'Venda', sale_refund: 'Devolução ao cliente', supplier: 'Fornecedor', supplier_refund: 'Devolução do fornecedor'};
      state.flows.forEach(f => {
        const outside = f.allocations.reduce((n, a) => n + Number(a.value), Number(f.other_external));
        const label = (labels[f.kind] + (f.order_id ? ' ' + f.order_id.slice(-8) : '')) + ' · ' + date(f.day) + ' · ' + brl(f.gross);
        const row = section(group, label, false);
        row.append(el('p', 'Caixa da loja registrado · ' + brl(Number(f.gross) - outside)));
        if (f.order_id) row.append(el('p', 'Valor vendido deste lote · ' + brl(f.lot_total)));
        if (Number(f.other_external)) row.append(el('p', 'Já atribuído em outra compra · ' + brl(f.other_external)));
        allocations(row, f, 'cash');
      });
    }
    function inventory() {
      if (!state.lot_id) return;
      const group = section(content, 'Titulares dos pneus do lote');
      group.append(el('p', 'Saldo físico · ' + state.quantity_on_hand + ' pneus. Identifique os titulares do recebimento e das saídas para ver o saldo por pessoa.'));
      const names = { purchase_receipt: 'Recebimento', sale: 'Venda', transfer_out: 'Transferência', triage_loss: 'Perda', sale_cancel: 'Estorno da venda', transfer_reversal: 'Retorno da transferência' };
      const pending = state.movements.filter(m => !state.stock_allocations[m.id]).length;
      if (pending) group.append(el('p', 'Movimentos a identificar · ' + pending));
      else if (state.movements.length) {
        let outside = 0;
        state.participants.forEach(p => {
          const qty = state.movements.reduce((n, m) => n + Math.sign(m.quantity_delta) *
            (state.stock_allocations[m.id].find(a => a.id === p.id)?.value || 0), 0);
          outside += qty; group.append(el('p', p.name + ' · ' + qty + ' pneus'));
        }); group.append(el('p', 'Loja · ' + (state.quantity_on_hand - outside) + ' pneus'));
      }
      state.movements.forEach(m => {
        const groupTitle = (names[m.source] || m.source) + ' · ' + date(m.day) + ' · ' + m.quantity_delta + ' pneus';
        allocations(section(group, groupTitle), m, 'stock');
      });
    }
    function settlements() {
      const group = section(content, 'Reembolsos da compra e repasses de vendas');
      const who = select(state.participants.map(p => [p.id, p.name]));
      const purpose = select([['purchase', 'Reembolso da compra'], ['sale', 'Repasse de venda']]);
      const direction = select([['in', 'Recebi do participante'], ['out', 'Paguei ao participante']]);
      const amount = input('number'), day = input('date'), account = input('text'), method = input('text');
      [amount, day, account, method].forEach(n => { n.required = true; }); amount.min = '0.01';
      const add = form(group, () => save({ kind: 'settlement', participant_id: who.value, direction: direction.value, purpose: purpose.value,
        amount: Number(amount.value), day: day.value, account: account.value, method: method.value }), 'Registrar dinheiro movimentado');
      add(field('Participante', who), field('Finalidade', purpose), field('Movimento do caixa da loja', direction), field('Valor (R$)', amount),
        field('Data do movimento', day), field('Conta da loja', account), field('Forma de pagamento', method));
      state.settlements.forEach(s => {
        const name = state.participants.find(p => p.id === s.participant_id)?.name || '';
        const row = section(group, (s.purpose === 'sale' ? 'Repasse de venda' : 'Reembolso da compra') + ' · ' + name + ' · ' + date(s.day) + ' · ' + (s.direction === 'in' ? 'Entrada ' : 'Saída ') + brl(s.amount) + (s.reversed ? ' · estornado' : ''));
        if (!s.reversed) {
          const reason = input('text'); reason.required = true; reason.minLength = 3; reason.maxLength = 150;
          form(row, () => save({ kind: 'undo', transaction_id: s.id, reason: reason.value }), 'Estornar lançamento errado')(field('Motivo', reason));
        }
      });
    }
    function render() {
      content.replaceChildren();
      if (state.status === 'cancelled') content.append(el('p', 'Compra cancelada. Confira os movimentos originais e as devoluções.'));
      content.append(el('p', 'Custo integral da compra · ' + brl(state.total_amount)),
        el('p', 'Parte da loja no custo · ' + (state.store_cost === null ? 'Revise a divisão' : brl(state.store_cost))),
        el('p', 'Saída da loja para o fornecedor · ' + brl(state.supplier_cash)));
      state.participants.forEach(p => {
        content.append(el('p', p.name + ' · Custo ' + brl(p.cost) + ' · Pago ao fornecedor ' + brl(p.paid_supplier) +
          ' · Contribuição restante ' + brl(p.remaining_contribution) + ' · Recebido de clientes ' + brl(p.received_sales)));
      });
      if (state.status !== 'cancelled') agreement();
      if (state.participants.length) {
        cashFlows(); inventory();
        settlements();
      }
    }
    notice.textContent = 'Carregando compra…';
    try { await load(); notice.textContent = ''; } catch (e) { notice.textContent = e.message || 'Falha ao carregar a compra.'; }
  }
  window.FarejadorPurchaseSharing = { open };
})();
