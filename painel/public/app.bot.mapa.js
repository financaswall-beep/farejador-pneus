// Demanda geográfica: malha oficial IBGE; somente dados agregados do painel.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.botMapa = function () {
  const RAMPS = {
    chamou: ['#dceee6', '#b7d8ca', '#80b6a2', '#438d76', '#075447'],
    pediu: ['#dcf1de', '#b2d9b7', '#77b58b', '#3c865b', '#1b5836'],
    efetivou: ['#d7f0e9', '#a5d9cc', '#69b8a3', '#318b75', '#0b5949'],
    faltou: ['#fbe1dc', '#efb7ae', '#d98d81', '#b75c50', '#8a352f'],
  };
  const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
  return {
    botMapaZoom: 1,
    botCamadas: [
      { id: 'chamou', label: 'Procura', unidade: 'conversas', desc: 'Conversas por município' },
      { id: 'pediu', label: 'Pedidos', unidade: 'conversas com pedido', desc: 'Conversas que viraram pedido' },
      { id: 'efetivou', label: 'Entregas', unidade: 'conversas com entrega', desc: 'Conversas com pedido entregue' },
      { id: 'faltou', label: 'Faltas', unidade: 'conversas com falta', desc: 'Conversas com falta de estoque registrada' },
    ],
    botCamadaAtual() { return this.botCamadas.find(c => c.id === this.botCamada) || this.botCamadas[0]; },
    setBotCamada(id) {
      if (!this.botCamadas.some(c => c.id === id)) return;
      this.botCamada = id;
      this.renderBotMapa();
    },
    botMapaRowDe(nome) { return this.botMapaRows.find(r => norm(r.municipio) === norm(nome)) || null; },
    get botLegenda() { return RAMPS[this.botCamada] || RAMPS.chamou; },
    get botDemandaDisponivel() { return this.botVisao?.demanda_disponivel === true; },
    get botDemandaTotal() {
      return this.botMapaRows.reduce((n, r) => n + Number(r.chamou || 0), 0) + Number(this.botSemRegiao);
    },
    get botMunicipiosComProcura() { return this.botMapaRows.filter(r => Number(r.chamou) > 0).length; },
    get botMunicipiosForaMapa() {
      return this.botMapaRows.filter(r => !window.MAPA_RM?.munis.some(m => norm(m.n) === norm(r.municipio))).length;
    },
    get botMapaMunicipios() {
      const nomes = new Map((window.MAPA_RM?.munis || []).map(m => [norm(m.n), m.n]));
      for (const r of this.botMapaRows) nomes.set(norm(r.municipio), r.municipio);
      return [...nomes.values()].sort((a, b) => a.localeCompare(b, 'pt-BR'));
    },
    get botDemandaPeriodoLabel() {
      return { today: 'Hoje', '7d': 'Últimos 7 dias', '30d': 'Últimos 30 dias', month: 'Este mês' }[this.botPeriodo] || 'No período';
    },
    get botCidadeConversao() {
      const c = this.botMapaSel;
      return c && Number(c.chamou) > 0 ? Math.min(100, Math.round(Number(c.pediu) / Number(c.chamou) * 1000) / 10) : 0;
    },
    get botMedidasCidadeDisponiveis() { return Array.isArray(this.botVisao?.medidas_por_municipio); },
    get botMedidasCidade() {
      const rows = (this.botVisao?.medidas_por_municipio || [])
        .filter(r => norm(r.municipio) === norm(this.botMapaSel?.municipio));
      const max = Math.max(1, ...rows.map(r => Number(r.consultas)));
      return rows.map(r => ({ ...r, pct: Math.round(Number(r.consultas) / max * 100) }));
    },
    botSelecionarMunicipio(nome) {
      if (!nome) return;
      const row = this.botMapaRowDe(nome);
      this.botMapaSel = row ? { ...row } : { municipio: nome, chamou: 0, pediu: 0, efetivou: 0, faltou: 0 };
      this.renderBotMapa();
    },
    botZoomMapa(delta) {
      this.botMapaZoom = delta === 0 ? 1 : Math.max(1, Math.min(2.5, this.botMapaZoom + delta));
      this.renderBotMapa();
    },
    renderBotMapa() {
      const el = document.getElementById('bot-mapa');
      const dados = window.MAPA_RM;
      if (!el || !dados || this.currentPage !== 'bot') return;
      const NS = 'http://www.w3.org/2000/svg';
      const node = (tag, attrs, text) => {
        const n = document.createElementNS(NS, tag);
        for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, String(v));
        if (text != null) n.textContent = text;
        return n;
      };
      const camada = this.botCamada;
      const max = Math.max(1, ...this.botMapaRows.map(r => Number(r[camada] || 0)));
      const selected = dados.munis.find(m => norm(m.n) === norm(this.botMapaSel?.municipio));
      const width = dados.W / this.botMapaZoom, height = dados.H / this.botMapaZoom;
      const x = Math.max(0, Math.min(dados.W - width, (selected?.cx ?? dados.W / 2) - width / 2));
      const y = Math.max(0, Math.min(dados.H - height, (selected?.cy ?? dados.H / 2) - height / 2));
      const svg = node('svg', { viewBox: x + ' ' + y + ' ' + width + ' ' + height, role: 'group', 'aria-label': 'Mapa da procura por município' });
      svg.appendChild(node('title', {}, 'Região metropolitana do Rio de Janeiro — ' + this.botCamadaAtual().desc));
      svg.appendChild(node('rect', { width: dados.W, height: dados.H, fill: '#eef6f6' }));
      const focusName = document.activeElement?.getAttribute('data-municipio');
      for (const m of dados.munis) {
        const row = this.botMapaRowDe(m.n);
        const v = row ? Number(row[camada] || 0) : 0;
        const sel = selected === m;
        const p = node('path', {
          d: m.d, fill: v > 0 ? this.botLegenda[Math.min(4, Math.floor(v / max * 4.999))] : '#f3f6f4',
          stroke: sel ? '#063f35' : '#bed3cc', 'stroke-width': sel ? 2.2 : 0.75,
          'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke', tabindex: '0', role: 'button',
          'aria-label': m.n + ' — ' + v + ' ' + this.botCamadaAtual().unidade,
          'aria-pressed': String(sel), 'data-municipio': m.n,
        });
        p.appendChild(node('title', {}, m.n + ' — ' + v + ' ' + this.botCamadaAtual().unidade));
        p.addEventListener('click', () => this.botSelecionarMunicipio(m.n));
        p.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.botSelecionarMunicipio(m.n); }
        });
        svg.appendChild(p);
      }
      for (const m of dados.munis) {
        if (m === selected || !['Rio de Janeiro', 'Niterói', 'Maricá'].includes(m.n)) continue;
        const v = Number(this.botMapaRowDe(m.n)?.[camada] || 0);
        svg.appendChild(node('text', { x: m.cx, y: m.cy, 'text-anchor': 'middle',
          'font-size': 10, fill: v / max > 0.6 ? '#fff' : '#335d50', 'pointer-events': 'none' }, m.n));
      }
      if (selected && this.botDemandaDisponivel) {
        const boxW = Math.min(210, Math.max(142, selected.n.length * 7));
        const tx = Math.max(x + 5, Math.min(x + width - boxW - 5, selected.cx + 12));
        const ty = Math.max(y + 5, Math.min(y + height - 54, selected.cy - 62));
        const tip = node('g', { 'pointer-events': 'none', class: 'bot-demand-map-tooltip' });
        tip.appendChild(node('circle', { cx: selected.cx, cy: selected.cy, r: 4, fill: '#fff', stroke: '#075447', 'stroke-width': 1.5 }));
        tip.appendChild(node('rect', { x: tx, y: ty, width: boxW, height: 48, rx: 6, fill: '#fff', stroke: '#d8e4df', 'stroke-width': 0.7 }));
        tip.appendChild(node('text', { x: tx + 10, y: ty + 19, 'font-size': 12, 'font-weight': 600, fill: '#102a25' }, selected.n));
        tip.appendChild(node('text', { x: tx + 10, y: ty + 36, 'font-size': 9.5, fill: '#58716a' },
          Number(this.botMapaSel?.[camada] || 0) + ' ' + this.botCamadaAtual().unidade));
        svg.appendChild(tip);
      }
      el.replaceChildren(svg);
      if (focusName) [...svg.querySelectorAll('[data-municipio]')]
        .find(p => p.getAttribute('data-municipio') === focusName)?.focus({ preventScroll: true });
    },
  };
};
