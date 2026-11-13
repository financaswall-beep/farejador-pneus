(function () {
  const requestToken = document.querySelector('meta[name="dot-request"]').content;
  const message = document.getElementById('message');
  async function api(path, options) {
    const response = await fetch(path, { credentials: 'same-origin', ...options });
    if (!response.ok) {
      const { error } = await response.json().catch(() => ({}));
      const message = {
        parcela_alterada: 'A parcela mudou ou foi encerrada. Peça uma nova consulta à Milly.',
        sale_installment_changed: 'A parcela mudou ou foi encerrada. Consulte a venda.',
        proposta_indisponivel: 'Proposta indisponível. Confira a conexão ou peça uma nova proposta.',
        proposta_expirada: 'A proposta expirou. Peça uma nova proposta à Milly.',
      }[error];
      throw new Error(message || (response.status === 401 ? 'Entre novamente na Matriz para continuar.'
        : 'Não consegui concluir. Atualize esta página e tente novamente.'));
    }
    return response.json();
  }
  async function consent(decision) {
    document.querySelectorAll('button').forEach(button => { button.disabled = true; });
    message.textContent = '';
    try {
      const result = await api('/admin/dot/authorize', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({request_token: requestToken, decision}) });
      location.replace(result.redirect);
    } catch (error) {
      message.textContent = error.message;
      document.querySelectorAll('button').forEach(button => { button.disabled = false; });
    }
  }
  async function loadConnections() {
    const container = document.getElementById('connections');
    try {
      const result = await api('/admin/api/dot/connections');
      container.textContent = '';
      if (!result.connections.length) container.textContent = 'Nenhuma conexão autorizada.';
      for (const row of result.connections) {
        const box = document.createElement('div'); box.className = 'connection';
        const label = document.createElement('p');
        const active = !row.revoked_at && Date.parse(row.expires_at) > Date.now();
        label.textContent = (active ? 'Conectado' : 'Desconectado ou expirado') + ' · autorizado em '
          + new Date(row.created_at).toLocaleString('pt-BR');
        box.append(label);
        if (active) {
          if (typeof row.installment_reviews_enabled === 'boolean') {
            const enabled = row.installment_reviews_enabled;
            const mode = document.createElement('p');
            mode.textContent = enabled ? 'Propostas de vencimento habilitadas' : 'Somente consulta';
            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.textContent = enabled ? 'Voltar para somente consulta' : 'Permitir propostas de vencimento';
            toggle.addEventListener('click', async () => {
              toggle.disabled = true;
              try {
                await api('/admin/api/dot/connections/' + encodeURIComponent(row.id) + '/installments', {
                  method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:!enabled}),
                });
                message.textContent = enabled ? 'Somente consulta. Propostas pendentes canceladas.' : 'Propostas de vencimento habilitadas.';
                await loadConnections();
              } catch (error) { message.textContent = error.message; toggle.disabled = false; }
            });
            box.append(mode,toggle);
          }
          const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Desconectar Dot';
          button.addEventListener('click', async () => {
            button.disabled = true;
            try { await api('/admin/api/dot/connections/' + encodeURIComponent(row.id) + '/revoke', {method:'POST'}); await loadConnections(); }
            catch (error) { message.textContent = error.message; button.disabled = false; }
          });
          box.append(button);
        }
        container.append(box);
      }
    } catch (error) { message.textContent = error.message; }
  }
  async function showReview(id) {
    document.getElementById('manage').hidden = true;
    document.getElementById('review').hidden = false;
    const confirm = document.getElementById('confirm-date');
    const undo = document.getElementById('undo-date');
    const state = document.getElementById('review-state');
    const path = '/admin/api/dot/installment-reviews/' + encodeURIComponent(id);
    const date = value => value.split('-').reverse().join('/');
    try {
      const row = await api(path);
      const money = Number(row.balance).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
      document.getElementById('review-detail').textContent = row.buyer_name + ' · Venda ' + row.order_id +
        ' · Parcela ' + row.installment_number + ' · Saldo na proposta ' + money +
        ' · De ' + date(row.old_due) + ' para ' + date(row.new_due) + '.';
      const confirmed = () => {
        confirm.hidden = true;
        undo.hidden = false;
        state.textContent = 'Alteração confirmada para ' + date(row.new_due) + '.';
      };
      if (row.status === 'restaurado') state.textContent = 'Vencimento restaurado para '+date(row.old_due)+'.';
      else if (row.status === 'confirmado') confirmed();
      else {
        state.textContent = 'Confira os dados antes de confirmar.';
        confirm.hidden = false;
      }
      confirm.onclick = async () => {
        confirm.disabled = true;
        try {
          const saved = await api(path+'/confirm',{method:'POST'});
          message.textContent = '';
          if (saved.status === 'restaurado') {
            confirm.hidden = true; state.textContent = 'Vencimento já restaurado para '+date(row.old_due)+'.';
          } else confirmed();
        }
        catch (error) { message.textContent = error.message; confirm.disabled = false; }
      };
      undo.onclick = async () => {
        if (!window.confirm('Restaurar o vencimento desta parcela para '+date(row.old_due)+'?')) return;
        undo.disabled = true;
        try {
          await api(path+'/restore',{method:'POST'});
          undo.hidden = true;
          message.textContent = '';
          state.textContent = 'Vencimento restaurado para '+date(row.old_due)+'.';
        } catch(error) { message.textContent = error.message; undo.disabled = false; }
      };
    } catch(error) { message.textContent = error.message; }
  }
  if (requestToken) {
    document.getElementById('allow').addEventListener('click', () => consent('allow'));
    document.getElementById('deny').addEventListener('click', () => consent('deny'));
  } else {
    const proposal = new URLSearchParams(location.search).get('proposta');
    if (proposal) void showReview(proposal);
    else void loadConnections();
  }
}());
