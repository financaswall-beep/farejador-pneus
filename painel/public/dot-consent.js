(function () {
  const requestToken = document.querySelector('meta[name="dot-request"]').content;
  const message = document.getElementById('message');
  async function api(path, options) {
    const response = await fetch(path, { credentials: 'same-origin', ...options });
    if (!response.ok) throw new Error(response.status === 401 ? 'Entre novamente na Matriz para continuar.'
      : 'Não consegui concluir. Atualize esta página e tente novamente.');
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
  if (requestToken) {
    document.getElementById('allow').addEventListener('click', () => consent('allow'));
    document.getElementById('deny').addEventListener('click', () => consent('deny'));
  } else { void loadConnections(); }
}());
