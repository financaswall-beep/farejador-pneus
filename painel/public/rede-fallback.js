(function () {
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[char]);
  }

  function money(value) {
    return Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  function statusLabel(value) {
    if (value === 'active') return 'Ativo';
    if (value === 'credentialing') return 'Credenciamento';
    if (value === 'suspended') return 'Suspenso';
    return value || '-';
  }

  function formatDate(value) {
    if (!value) return '-';
    return new Date(value).toLocaleString('pt-BR');
  }

  function renderFallback(rows) {
    const partners = rows || [];
    const totalSales = partners.reduce((sum, row) => sum + Number(row.sales_month || 0), 0);
    const totalOrders = partners.reduce((sum, row) => sum + Number(row.orders_month || 0), 0);
    const totalStock = partners.reduce((sum, row) => sum + Number(row.stock_items || 0), 0);
    const activeCount = partners.filter((row) => row.unit_status === 'active').length;

    const cards = [
      ['Parceiros ativos', `${activeCount}/${partners.length}`, 'unidades carregadas da API'],
      ['Vendas da rede', money(totalSales), 'mês atual'],
      ['Pedidos', String(totalOrders), 'vendas registradas'],
      ['Itens em estoque', String(totalStock), 'estoque local dos parceiros'],
    ];

    document.body.innerHTML = `
      <div class="fallback-shell">
        <aside class="fallback-sidebar">
          <div class="fallback-logo">Farejador</div>
          <div class="fallback-nav active">Rede</div>
          <div class="fallback-note">Fallback local<br>Dados reais da API</div>
        </aside>
        <main class="fallback-main">
          <div class="fallback-header">
            <div>
              <h1>Rede de parceiros</h1>
              <p>Painel carregado sem CDN externo. Dados vindos de /admin/api/dashboard/rede.</p>
            </div>
            <span class="fallback-pill">dados reais</span>
          </div>

          <section class="fallback-kpis">
            ${cards.map(([label, value, detail]) => `
              <div class="fallback-card">
                <div class="fallback-label">${label}</div>
                <div class="fallback-value">${value}</div>
                <div class="fallback-detail">${detail}</div>
              </div>
            `).join('')}
          </section>

          <section class="fallback-grid">
            <div class="fallback-panel">
              <h2>Parceiros da rede</h2>
              <table>
                <thead>
                  <tr>
                    <th>Parceiro</th>
                    <th>Responsável</th>
                    <th>Status</th>
                    <th>Vendas</th>
                    <th>Pedidos</th>
                    <th>Estoque</th>
                    <th>Resultado</th>
                  </tr>
                </thead>
                <tbody>
                  ${partners.map((row) => `
                    <tr>
                      <td>
                        <strong>${escapeHtml(row.display_name || row.partner_name || 'Unidade')}</strong>
                        <small>${escapeHtml(row.slug || '-')}</small>
                      </td>
                      <td>${escapeHtml(row.responsible_name || '-')}</td>
                      <td><span class="fallback-status">${escapeHtml(statusLabel(row.unit_status || row.partner_status))}</span></td>
                      <td>${money(row.sales_month)}</td>
                      <td>${Number(row.orders_month || 0)}</td>
                      <td>${Number(row.stock_items || 0)} itens</td>
                      <td class="${Number(row.estimated_result_month || 0) >= 0 ? 'pos' : 'neg'}">${money(row.estimated_result_month)}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>

            <div class="fallback-panel">
              <h2>Detalhe da primeira unidade</h2>
              ${partners[0] ? renderPartnerDetail(partners[0]) : '<p>Nenhum parceiro retornado pela API.</p>'}
            </div>
          </section>
        </main>
      </div>
    `;
  }

  function renderPartnerDetail(row) {
    const stock = Array.isArray(row.stock_rows) ? row.stock_rows : [];
    const events = Array.isArray(row.recent_events) ? row.recent_events : [];
    const topItems = Array.isArray(row.top_items) ? row.top_items : [];

    return `
      <div class="fallback-detail-grid">
        <div><span>Vendas mês</span><strong>${money(row.sales_month)}</strong></div>
        <div><span>Compras pneus</span><strong>${money(row.purchases_month)}</strong></div>
        <div><span>Despesas</span><strong>${money(row.expenses_month)}</strong></div>
        <div><span>Venda hoje</span><strong>${money(row.sales_today)}</strong></div>
      </div>
      <h3>Top pneus vendidos</h3>
      <ul>${topItems.map((item) => `<li>${escapeHtml(item.label)}: ${Number(item.quantity || 0)} un.</li>`).join('') || '<li>Sem venda registrada.</li>'}</ul>
      <h3>Estoque local</h3>
      <ul>${stock.slice(0, 6).map((item) => `<li>${escapeHtml(item.item_name)} ${escapeHtml(item.tire_size || '')} - ${item.is_tracked ? `${Number(item.quantity_on_hand || 0)} un.` : 'não controlado'}</li>`).join('') || '<li>Sem estoque cadastrado.</li>'}</ul>
      <h3>Últimos lançamentos</h3>
      <ul>${events.slice(0, 6).map((event) => `<li>${escapeHtml(formatDate(event.event_at))} - ${escapeHtml(event.type)}: ${escapeHtml(event.description)} (${money(event.amount)})</li>`).join('') || '<li>Sem lançamentos recentes.</li>'}</ul>
    `;
  }

  async function loadFallback() {
    if (window.Alpine) return;

    try {
      const response = await fetch('/admin/api/dashboard/rede', {
        credentials: 'same-origin',
      });
      if (response.status === 401) { location.replace('/admin/login'); return; }
      if (!response.ok) throw new Error(`api_${response.status}`);
      const payload = await response.json();
      renderFallback(payload.rows || []);
    } catch (err) {
      document.body.innerHTML = `
        <main class="fallback-error">
          <h1>Não consegui carregar a Rede</h1>
          <p>${escapeHtml(err instanceof Error ? err.message : String(err))}</p>
        </main>
      `;
    }
  }

  window.addEventListener('DOMContentLoaded', () => {
    setTimeout(loadFallback, 1200);
  });
}());
