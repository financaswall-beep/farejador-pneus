// Demanda geográfica: malha oficial IBGE; somente dados agregados do painel.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.botMapa = function () {
  let mapObserver;
  let mapSize = '';
  const RAMPS = {
    chamou: ['#a8d8c1', '#78bc9f', '#439c7a', '#187455', '#05543e'],
    pediu: ['#b1dcb9', '#7dc292', '#48a76b', '#237e48', '#105b32'],
    efetivou: ['#a1decd', '#69c3a9', '#37a78c', '#158369', '#075e49'],
    faltou: ['#fbd2c6', '#f2a58f', '#de775f', '#bb4c3d', '#892f27'],
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
      // Preenche a superfície inteira: a faixa superior também recebe a terra
      // vizinha, em vez de uma sobra azul causada pelo letterbox do SVG.
      const ratio = el.clientWidth && el.clientHeight ? el.clientWidth / el.clientHeight : dados.W / dados.H;
      const frameWidth = Math.max(dados.W + 16, (dados.H + 42) * ratio);
      const frameHeight = frameWidth / ratio;
      const left = (dados.W - frameWidth) / 2, top = -18;
      const width = frameWidth / this.botMapaZoom, height = frameHeight / this.botMapaZoom;
      const x = Math.max(left, Math.min(left + frameWidth - width, (selected?.cx ?? dados.W / 2) - width / 2));
      const y = Math.max(top, Math.min(top + frameHeight - height, (selected?.cy ?? dados.H / 2) - height / 2));
      const svg = node('svg', { viewBox: x + ' ' + y + ' ' + width + ' ' + height, role: 'group', 'aria-label': 'Mapa da procura por município' });
      const land = node('g', { class: 'bot-demand-map-land', 'aria-hidden': 'true', 'pointer-events': 'none',
        fill: '#e8efe9', stroke: '#d2e0d6', 'stroke-width': 0.65, 'fill-rule': 'evenodd' });
      for (const m of dados.contexto?.municipios || []) {
        land.appendChild(node('path', { d: m.d, 'vector-effect': 'non-scaling-stroke' }));
      }
      svg.appendChild(land);
      const focusName = document.activeElement?.getAttribute('data-municipio');
      for (const m of dados.munis) {
        const row = this.botMapaRowDe(m.n);
        const v = row ? Number(row[camada] || 0) : 0;
        const sel = selected === m;
        const p = node('path', {
          d: m.d, fill: v > 0 ? this.botLegenda[Math.min(4, Math.floor(v / max * 4.999))] : '#d9e9df',
          stroke: sel ? '#07513e' : '#9bbdaf', 'stroke-width': sel ? 2.2 : 0.75,
          'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke', tabindex: '0', role: 'button',
          'aria-label': m.n + ' — ' + v + ' ' + this.botCamadaAtual().unidade,
          'aria-pressed': String(sel), 'data-municipio': m.n,
        });
        p.addEventListener('click', () => this.botSelecionarMunicipio(m.n));
        p.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.botSelecionarMunicipio(m.n); }
        });
        svg.appendChild(p);
      }
      el.replaceChildren(svg);
      if (focusName) [...svg.querySelectorAll('[data-municipio]')]
        .find(p => p.getAttribute('data-municipio') === focusName)?.focus({ preventScroll: true });
      mapSize = el.clientWidth + 'x' + el.clientHeight;
      if (!mapObserver && typeof ResizeObserver === 'function') {
        mapObserver = new ResizeObserver(() => {
          if (this.currentPage === 'bot' && this.botTab === 'demanda' && mapSize !== el.clientWidth + 'x' + el.clientHeight) this.renderBotMapa();
        });
        mapObserver.observe(el);
      }
    },
  };
};
