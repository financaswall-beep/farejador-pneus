(function () {
  'use strict';
  const M = window.Caixa.marketing, V = M.V;
  const base = '/admin/api/marketing/organic/results';
  const platforms = () => (M.state.results?.active_platforms || M.state.metrics?.active_platforms || []).filter(p => ['instagram', 'facebook'].includes(p));
  function deliveries(post, network = M.state.network) { return (post.deliveries || []).filter(d => platforms().includes(d.platform) && (network === 'all' || d.platform === network) && d.status === 'published'); }
  function views(post, network) {
    const rows = deliveries(post, network), known = rows.filter(d => V.number(d.views) != null);
    return { value: known.length ? known.reduce((sum, d) => sum + d.views, 0) : null, partial: known.length < rows.length };
  }
  function total(rows, network) {
    const values = rows.flatMap(post => deliveries(post, network)), known = values.filter(d => V.number(d.views) != null);
    const sources = (M.state.results?.sources || []).filter(s => network === 'all' || s.platform === network);
    const partial = known.length < values.length || Boolean(M.state.results?.central_truncated || M.state.results?.central_available === false || sources.some(s => s.status !== 'ready' || s.truncated));
    return { value: known.length ? known.reduce((sum, d) => sum + d.views, 0) : values.length === 0 && sources.length && !partial ? 0 : null, partial };
  }
  function display(value) { return V.count(value.value) + (value.value != null && value.partial ? ' · parcial' : ''); }
  function networkButtons(host, selected, action, available = platforms()) {
    host.replaceChildren(); ['all', ...available].forEach(value => {
      const b = V.button(value === 'all' ? 'Todas' : V.platform(value), () => action(value), 'mk-chip'); b.setAttribute('aria-pressed', String(value === selected)); host.appendChild(b);
    });
  }
  M.loadResults = async () => {
    if (!M.active()) return;
    const id = M.nextRequest(), period = M.state.period; M.state.resultsLoading = true; M.state.resultsError = false; M.render();
    try {
      const data = await M.request(base + '?period=' + period);
      if (!M.isCurrent(id) || period !== M.state.period) return;
      if (!Array.isArray(data.rows) || !Array.isArray(data.active_platforms) || !data.period) throw Error('invalid_results');
      M.state.results = data;
      if (M.state.network !== 'all' && !platforms().includes(M.state.network)) M.state.network = 'all';
    } catch (error) { if (M.isCurrent(id) && error.message !== 'invalid_session') { M.state.results = null; M.state.resultsError = true; } }
    finally { if (M.isCurrent(id)) { M.state.resultsLoading = false; M.render(); } }
  };
  M.pages.results = () => {
    const state = M.state, host = M.el('results-posts'), summary = M.el('results-summary'); host.replaceChildren(); summary.replaceChildren();
    M.el('results-range').textContent = ''; M.el('results-updated').textContent = '';
    M.el('results-period').value = state.period; M.el('results-sort').value = state.sort;
    networkButtons(M.el('results-networks'), state.network, value => { state.network = value; M.render(); });
    if (state.resultsLoading) { V.empty(host, 'Consultando os resultados…'); return; }
    if (state.resultsError || !state.results) { V.empty(host, 'Resultados indisponíveis. Atualize para consultar novamente.'); return; }
    const data = state.results, available = platforms();
    if (!available.length) { V.empty(host, 'Nenhuma rede habilitada para consulta. Confira as conexões da Matriz.'); return; }
    const period = data.period; M.el('results-range').textContent = period.since && period.until ? V.date(period.since + 'T12:00:00-03:00', false) + ' a ' + V.date(period.until + 'T12:00:00-03:00', false) : '';
    const rows = data.rows.filter(post => deliveries(post).length > 0), result = total(rows, state.network);
    summary.append(V.metric('Visualizações acumuladas', display(result), 'is-hero'), V.node('p', 'Dos ' + rows.length + ' conteúdos publicados no período' + (result.partial ? ' · consulta parcial' : ''), 'mk-muted'));
    const split = V.node('div', null, 'mk-metric-pair'); available.filter(p => state.network === 'all' || p === state.network).forEach(p => {
      const item = V.metric(V.platform(p), display(total(rows, p))); split.appendChild(item);
    }); summary.appendChild(split);
    rows.sort((a, b) => state.sort === 'recent' ? Date.parse(b.published_at) - Date.parse(a.published_at) : (views(b).value ?? -1) - (views(a).value ?? -1));
    if (!rows.length) V.empty(host, 'Nenhum conteúdo publicado encontrado para esta seleção.');
    rows.forEach(post => {
      const card = V.button('', () => M.openResult(post), 'mk-result-card');
      const copy = V.node('span', null, 'mk-result-copy'); copy.append(V.node('strong', post.title), V.networks(deliveries(post)), V.node('b', display(views(post)) + ' visualizações'), V.node('small', 'Ver resultado →'));
      card.append(V.image(post.image_url, post.title), copy, V.icon('chevron')); host.appendChild(card);
    });
    M.el('results-updated').textContent = 'Última consulta: ' + V.date(data.fetched_at) + ' · Brasília. Contadores acumulados; visualizações não são pessoas únicas.';
  };
  M.openResult = post => {
    if (!M.active() || M.busy()) return;
    M.clearSales?.(); M.el('sales-search').value = '';
    M.state.selected = post; M.state.detailNetwork = M.state.network; M.state.detail = null; M.state.metrics = null;
    M.go('insights'); void M.loadDetail();
  };
  M.loadDetail = async (refresh = false) => {
    if (!M.state.selected?.key || !M.active()) return;
    const id = M.nextRequest(), key = M.state.selected.key, network = M.state.detailNetwork || 'all';
    M.state.detailLoading = true; M.state.detail = null; M.state.metrics = null; M.render();
    const encoded = encodeURIComponent(key), query = new URLSearchParams({ window: M.state.window, network });
    const results = await Promise.allSettled([
      M.request(base + '/' + encoded + '?' + query),
      M.request(base + '/' + encoded + '/metrics?' + new URLSearchParams({ days: M.el('history-days').value || '7', refresh: String(refresh) })),
    ]);
    if (!M.isCurrent(id) || M.state.selected?.key !== key) return;
    M.state.detailError = results[0].status === 'rejected'; M.state.metricsError = results[1].status === 'rejected';
    if (results[0].status === 'fulfilled') { const data = results[0].value; if (data.publication?.key === key) { M.state.detail = data; M.state.selected = data.publication; } else M.state.detailError = true; }
    if (results[1].status === 'fulfilled' && Array.isArray(results[1].value.networks)) M.state.metrics = results[1].value;
    M.state.detailLoading = false; M.render();
  };
  M.detailNetworks = host => {
    const wrap = V.node('div', null, 'mk-segment'), available = [...new Set((M.state.selected?.deliveries || []).map(d => d.platform))].filter(p => platforms().includes(p));
    networkButtons(wrap, M.state.detailNetwork || 'all', value => { M.state.detailNetwork = value; void M.loadDetail(); }, available); host.appendChild(wrap);
  };
  M.pages.insights = () => {
    M.el('insights-post').replaceChildren(V.postContext(M.state.selected));
    const host = M.el('insights-values'); host.replaceChildren();
    if (M.state.detailLoading) { V.empty(host, 'Consultando as redes…'); return; }
    M.detailNetworks(host);
    const metrics = M.state.metrics, filter = M.state.detailNetwork || 'all';
    if (!metrics) { V.empty(host, 'Métricas indisponíveis. Atualize para tentar novamente.'); return; }
    const rows = metrics.networks.filter(n => platforms().includes(n.platform) && (filter === 'all' || n.platform === filter)), published = rows.filter(n => n.status === 'published');
    const known = published.filter(n => V.number(n.views) != null);
    host.append(V.metric('Visualizações acumuladas', display({ value: known.length ? known.reduce((sum, n) => sum + n.views, 0) : null, partial: known.length < published.length }), 'is-hero'), V.node('h3', 'Por rede'));
    rows.forEach(network => {
      const card = V.node('section', null, 'mk-card mk-network-card'), header = V.node('header'); header.append(V.network(network.platform), V.node('strong', V.count(network.views) + ' visualizações')); card.appendChild(header);
      const grid = V.node('dl', null, 'mk-network-metrics');
      [['likes', 'Curtidas'], ['comments', 'Comentários'], ['shares', 'Compartilhamentos'], ['saved', 'Salvamentos']].forEach(([key, label]) => {
        const metric = network.insights?.rows?.find(row => row.metric === key), pair = V.node('div'); pair.append(V.node('dt', label), V.node('dd', V.count(metric?.value))); grid.appendChild(pair);
      }); card.appendChild(grid);
      if (network.error || network.status !== 'published') card.appendChild(V.node('p', network.error ? 'Não foi possível consultar esta rede.' : 'Aguardando confirmação da publicação.', 'mk-notice'));
      if (network.insights?.notice) card.appendChild(V.node('p', network.insights.notice, 'mk-muted'));
      host.appendChild(card);
    });
    host.appendChild(V.node('p', '— indica métrica indisponível. Os contadores podem incluir impulsionamento.', 'mk-muted'));
  };
  M.resultViews = views; M.resultTotal = total; M.resultPlatforms = platforms;
  M.el('results-period').addEventListener('change', () => { M.state.period = M.el('results-period').value; void M.loadResults(); });
  M.el('results-sort').addEventListener('change', () => { M.state.sort = M.el('results-sort').value; M.render(); });
  M.el('results-refresh').addEventListener('click', () => void M.loadResults());
  M.el('metrics-refresh').addEventListener('click', () => void M.loadDetail(true));
  document.querySelectorAll('[data-mk-detail]').forEach(button => button.addEventListener('click', () => { M.go(button.dataset.mkDetail); if (!M.state.detail && !M.state.detailLoading) void M.loadDetail(); }));
}());
