(function () {
  'use strict';
  const M = window.Caixa.marketing, V = M.V, ns = 'http://www.w3.org/2000/svg';
  function svg(tag, attributes, text) { const el = document.createElementNS(ns, tag); Object.entries(attributes).forEach(([key, value]) => el.setAttribute(key, String(value))); if (text != null) el.textContent = text; return el; }
  M.pages.history = () => {
    M.el('history-post').replaceChildren(V.postContext(M.state.selected));
    const host = M.el('history-chart'), data = M.el('history-data'); host.replaceChildren(); data.replaceChildren();
    if (M.state.detailLoading) { V.empty(host, 'Carregando o histórico…'); return; }
    const metrics = M.state.metrics;
    if (!metrics?.history_ready) { V.empty(host, 'Histórico indisponível. As métricas atuais continuam acessíveis.'); return; }
    const count = Number(M.el('history-days').value), today = window.FarejadorTime.dateKey(new Date());
    const end = Date.parse(today + 'T12:00:00Z'), dates = Array.from({ length: count }, (_, i) => new Date(end - (count - 1 - i) * 86400000).toISOString().slice(0, 10));
    const networks = metrics.networks.filter(n => M.resultPlatforms().includes(n.platform) && ((M.state.detailNetwork || 'all') === 'all' || M.state.detailNetwork === n.platform));
    const series = networks.map(n => ({ platform: n.platform, points: dates.map(date => {
      const row = metrics.history.find(r => r.date === date && r.platform === n.platform && r.account_id === n.account_id && r.post_id === n.post_id); return V.number(row?.views);
    }) }));
    const known = series.flatMap(s => s.points).filter(v => v != null);
    if (!known.length) { V.empty(host, 'O histórico começa na primeira coleta. Nenhum valor anterior será estimado.'); return; }
    const plot = svg('svg', { viewBox: '0 0 380 220', role: 'img', 'aria-label': 'Evolução das visualizações acumuladas por rede' });
    const max = Math.max(1, ...known), left = 45, width = 320, height = 150;
    for (let i = 0; i <= 3; i++) { const y = 15 + i * 50; plot.append(svg('path', { d: 'M45 ' + y + 'h320', stroke: '#d8dfdb', fill: 'none' }), svg('text', { x: 39, y: y + 4, 'text-anchor': 'end', 'font-size': 11 }, V.count(Math.round(max * (1 - i / 3))))); }
    series.forEach((s, index) => {
      const color = index ? '#2869a8' : '#08764f'; let segment = [];
      const flush = () => { if (segment.length > 1) plot.appendChild(svg('polyline', { points: segment.join(' '), fill: 'none', stroke: color, 'stroke-width': 2.5 })); segment = []; };
      s.points.forEach((value, i) => { if (value == null) { flush(); return; } const x = left + width * i / (count - 1), y = 15 + height * (1 - value / max); segment.push(x + ',' + y); plot.appendChild(svg('circle', { cx: x, cy: y, r: 3, fill: color })); }); flush();
      const label = V.node('span', V.platform(s.platform), 'mk-chart-legend'); label.style.color = color; host.appendChild(label);
    });
    [0, Math.floor((count - 1) / 2), count - 1].forEach(i => plot.appendChild(svg('text', { x: left + width * i / (count - 1), y: 190, 'text-anchor': 'middle', 'font-size': 11 }, dates[i].slice(8) + '/' + dates[i].slice(5, 7))));
    host.append(plot, V.node('p', 'Acumulado observado em cada dia. Dias sem coleta ficam sem ponto, sem interpolação.', 'mk-muted'));
    const details = V.node('details'), table = V.node('table'), head = V.node('tr'); head.appendChild(V.node('th', 'Data')); series.forEach(s => head.appendChild(V.node('th', V.platform(s.platform)))); const thead = V.node('thead'); thead.appendChild(head); table.appendChild(thead);
    const tbody = V.node('tbody'); dates.forEach((date, i) => { const row = V.node('tr'); row.appendChild(V.node('th', window.FarejadorTime.formatDate(date))); series.forEach(s => row.appendChild(V.node('td', V.count(s.points[i])))); tbody.appendChild(row); }); table.appendChild(tbody);
    details.append(V.node('summary', 'Ver valores do gráfico'), table); data.appendChild(details);
  };
  M.el('evolution').addEventListener('click', () => M.go('history'));
  M.el('history-days').addEventListener('change', () => void M.loadDetail());
}());
