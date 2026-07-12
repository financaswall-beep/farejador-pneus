// TELA DO BOT (2026-07-06): dados e ações da aba Bot — campainha (cliente esperando),
// visão (cards/mapa/radar) e deep-link pro Chatwoot. O DESENHO do mapa mora em
// app.bot.mapa.js; aqui é só estado/carregadores/getters.
// Montado em app.js via getOwnPropertyDescriptors — NUNCA usar spread (congela getter).
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.bot = function () {
  return {
    // Leve de propósito: roda no boot e no refresh de 15s em QUALQUER página —
    // cliente esperando é alarme, não estatística. Badge acende na aba do menu.
    async loadBotCampainha() {
      this.ensureCredentials();
      if (!this.adminAuthenticated || !location.pathname.startsWith('/admin/painel')) return;
      try {
        this.botCampainha = await this.apiGet('/admin/api/bot/campainha');
      } catch (err) {
        this.botCampainha = null; // sem resposta = sem alarme inventado
      }
      const item = this.liveMenu.find((i) => i.id === 'bot');
      if (item) {
        const n = this.botMudas.length + this.botEscalados.length;
        item.badge = n > 0 ? String(n) : null;
      }
    },

    async loadBotVisao() {
      this.ensureCredentials();
      if (!this.adminAuthenticated || !location.pathname.startsWith('/admin/painel')) return;
      this.botLoading = true;
      try {
        this.botVisao = await this.apiGet(
          '/admin/api/bot/visao?period=' + encodeURIComponent(this.botPeriodo),
        );
        if (!this.botMapaSel && this.botMapaRows.length) {
          const destaque = [...this.botMapaRows]
            .sort((a, b) => Number(b.chamou || 0) - Number(a.chamou || 0))[0];
          this.botMapaSel = {
            municipio: destaque.municipio,
            chamou: destaque.chamou,
            pediu: destaque.pediu,
            efetivou: destaque.efetivou,
            faltou: destaque.faltou,
          };
        }
      } catch (err) {
        this.botVisao = null;
      }
      this.botLoading = false;
      this.$nextTick(() => {
        lucide.createIcons();
        this.renderBotMapa();
      });
    },

    setBotPeriodo(p) {
      this.botPeriodo = p;
      this.botMapaSel = null;
      void this.loadBotVisao();
    },

    atualizarBotFila() {
      void this.loadBotCampainha();
    },

    // ─── getters derivados (nada de estado duplicado) ───
    get botMudas() {
      return (this.botCampainha && this.botCampainha.mudas) || [];
    },
    get botEscalados() {
      return (this.botCampainha && this.botCampainha.escalados) || [];
    },
    get botConversasFila() {
      const mudas = this.botMudas.map((m) => ({
        id: 'm-' + m.conversation_id,
        chatwoot_id: m.chatwoot_conversation_id,
        nome: m.contact_name || 'Cliente',
        mensagem: m.preview || '(sem texto)',
        tipo: 'esperando',
        minutos: Number(m.minutos || 0),
      }));
      const agora = Date.now();
      const escalados = this.botEscalados.map((e) => ({
        id: 'e-' + e.conversation_id,
        chatwoot_id: e.chatwoot_conversation_id,
        nome: e.contact_name || 'Cliente',
        mensagem: e.motivo || 'Sem motivo registrado',
        tipo: 'humano',
        minutos: e.quando ? Math.max(0, Math.floor((agora - new Date(e.quando).getTime()) / 60000)) : 0,
      }));
      return [...mudas, ...escalados].sort((a, b) => a.minutos - b.minutos);
    },
    get botConversasFiltradas() {
      const busca = String(this.botConversaBusca || '').trim().toLowerCase();
      return this.botConversasFila.filter((c) => {
        if (this.botConversaFiltro !== 'todos' && c.tipo !== this.botConversaFiltro) return false;
        return !busca || c.nome.toLowerCase().includes(busca) || c.mensagem.toLowerCase().includes(busca);
      });
    },
    get botRespondidas48h() {
      // SÓ do servidor (régua real de 48h em queries-bot-visao) — sem conta
      // inventada no front; servidor calado = travessão honesto.
      if (this.botCards && this.botCards.respondidas_bot_48h != null) return Number(this.botCards.respondidas_bot_48h);
      return '—';
    },
    get botEsperaMediaSeg() {
      // Espera média da FILA DE AGORA (média dos minutos exibidos linha a linha
      // na própria fila) — o rótulo na tela diz isso; não é métrica do período.
      const filas = this.botConversasFila;
      return filas.length ? Math.round((filas.reduce((s, c) => s + c.minutos, 0) / filas.length) * 60) : 0;
    },
    get botCards() {
      return (this.botVisao && this.botVisao.cards) || null;
    },
    get botRadar() {
      return (this.botVisao && this.botVisao.radar) || [];
    },
    get botSemRegiao() {
      return (this.botVisao && this.botVisao.sem_regiao) || 0;
    },
    get botMapaRows() {
      return (this.botVisao && this.botVisao.mapa) || [];
    },
    // Horário de pico: barrinhas proporcionais (madrugada/manhã/tarde/noite).
    get botHorarios() {
      const c = this.botCards;
      if (!c) return [];
      const itens = [
        { label: 'Madrugada', n: Number(c.conv_madrugada || 0) },
        { label: 'Manhã', n: Number(c.conv_manha || 0) },
        { label: 'Tarde', n: Number(c.conv_tarde || 0) },
        { label: 'Noite', n: Number(c.conv_noite || 0) },
      ];
      const max = Math.max(1, ...itens.map((i) => i.n));
      return itens.map((i) => ({ ...i, pct: Math.round((i.n / max) * 100) }));
    },

    // Funil ACUMULADO: o servidor manda onde cada conversa PAROU (stage_reached);
    // aqui vira "chegaram ATÉ AQUI ou além" — a leitura natural de funil.
    get botFunil() {
      const ETAPAS = [
        ['abriu_conversa', 'Chamaram'],
        ['mostrou_interesse', 'Mostraram interesse'],
        ['recebeu_cotacao', 'Receberam preço'],
        ['forneceu_bairro', 'Deram o bairro'],
        ['frete_calculado', 'Frete na mesa'],
        ['pedido_criado', 'Pedido criado'],
      ];
      const dist = (this.botVisao && this.botVisao.funil) || [];
      const porEtapa = Object.fromEntries(dist.map((f) => [f.etapa, Number(f.n || 0)]));
      let acum = 0;
      const deBaixoPraCima = [...ETAPAS].reverse().map(([id, label]) => {
        acum += porEtapa[id] || 0;
        return { id, label, n: acum };
      });
      const linhas = deBaixoPraCima.reverse();
      const total = Math.max(1, linhas[0] ? linhas[0].n : 0);
      return linhas.map((l) => ({ ...l, pct: Math.round((l.n / total) * 100) }));
    },
    get botPerdas() {
      const NOMES = {
        objecao_preco: 'Achou caro',
        mencionou_concorrente: 'Citou concorrente',
        desistiu_apos_frete: 'Sumiu depois do frete',
        desistiu_apos_bairro: 'Sumiu depois do bairro',
        desistiu_cedo: 'Desistiu cedo',
        escalado_humano: 'Foi pro humano',
        abandonou_sem_motivo_claro: 'Sumiu sem motivo claro',
      };
      return (((this.botVisao && this.botVisao.perdas) || []))
        .map((p) => ({ label: NOMES[p.motivo] || p.motivo, n: Number(p.n || 0) }));
    },
    // Boca do cliente: ordem FIXA (zero também aparece — sensor vivo mostrando calmaria).
    get botBoca() {
      const TIPOS = [
        ['objecao_preco', 'Falou "tá caro"'],
        ['mencao_concorrente', 'Citou concorrente'],
        ['pergunta_parcelamento', 'Pediu parcelado/fiado'],
        ['pergunta_garantia', 'Perguntou de garantia'],
        ['pediu_instalacao', 'Pediu instalação'],
        ['urgencia', 'Tá com pressa'],
      ];
      const dados = (this.botVisao && this.botVisao.boca) || [];
      const porTipo = Object.fromEntries(dados.map((b) => [b.tipo, Number(b.convs || 0)]));
      return TIPOS.map(([id, label]) => ({ id, label, n: porTipo[id] || 0 }));
    },
    get botMedidasTop() {
      return (this.botVisao && this.botVisao.medidas_top) || [];
    },

    // ─── Chatwoot: a conversa se resolve LÁ; aqui só o atalho ───
    chatwootConvUrl(chatwootId) {
      if (!this.chatwootBaseUrl || !this.chatwootAccountId || !chatwootId) return null;
      return this.chatwootBaseUrl + '/app/accounts/' + this.chatwootAccountId +
        '/conversations/' + chatwootId;
    },
    abrirNoChatwoot(chatwootId) {
      const url = this.chatwootConvUrl(chatwootId);
      if (url) window.open(url, '_blank', 'noopener');
    },

    botMinutosLabel(min) {
      if (min == null) return '';
      if (min >= 60) return Math.floor(min / 60) + 'h' + String(min % 60).padStart(2, '0');
      return min + ' min';
    },
    botQuandoLabel(iso) {
      if (!iso) return '';
      const d = new Date(iso);
      return isNaN(d) ? '' : d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) +
        ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    },
  };
};
