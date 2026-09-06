// Controle exclusivamente interno da Matriz. Não cria mensagens no Chatwoot.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.botControle = function () {
  return {
    botControlesHumanos: [],
    botControleModos: {},
    botControleDialog: null,
    botControleErro: '',
    botControleSalvando: false,
    botControleCarregando: false,
    botFilaPeriodo: 'todos',
    botFilaPagina: 1,
    botFilaPorPagina: 20,
    botFilaAtividade(...datas) {
      const validas = datas.map(data => new Date(data || '').getTime()).filter(Number.isFinite);
      return validas.length ? new Date(Math.max(...validas)).toISOString() : null;
    },
    setBotFilaPeriodo(periodo) {
      this.botFilaPeriodo = ['todos','7','15','30'].includes(periodo) ? periodo : 'todos';
      this.botFilaPagina = 1;
    },
    botFilaDentroPeriodo(row) {
      if (!['7','15','30'].includes(this.botFilaPeriodo)) return true;
      const quando = new Date(row.atividade_em || '').getTime();
      // Sem data comprovada, mantém visível em vez de esconder silenciosamente.
      return !Number.isFinite(quando) || quando >= Date.now() - Number(this.botFilaPeriodo) * 86400000;
    },
    get botFilaForaPeriodo() {
      return this.botConversasFila.filter(row => !this.botFilaDentroPeriodo(row)).length;
    },
    get botConversasFiltradas() {
      const busca = String(this.botConversaBusca || '').trim().toLowerCase();
      return this.botConversasFila.filter(c => this.botFilaDentroPeriodo(c)
        && (this.botConversaFiltro === 'todos' || c.tipo === this.botConversaFiltro)
        && (!busca || c.nome.toLowerCase().includes(busca) || c.mensagem.toLowerCase().includes(busca)));
    },
    get botFilaTotalPaginas() { return Math.max(1,Math.ceil(this.botConversasFiltradas.length / this.botFilaPorPagina)); },
    get botFilaPaginaAtual() { return Math.max(1,Math.min(this.botFilaPagina,this.botFilaTotalPaginas)); },
    get botConversasPaginadas() {
      const inicio = (this.botFilaPaginaAtual - 1) * this.botFilaPorPagina;
      return this.botConversasFiltradas.slice(inicio,inicio + this.botFilaPorPagina);
    },
    botControleModo(id, fallback = null) {
      // Lê a chave mesmo quando ausente, para o Alpine acompanhar a resposta assíncrona.
      const mode = this.botControleModos[id];
      return mode === undefined ? fallback : mode;
    },
    botControleClasse(mode) {
      if (mode==='auto') return 'bg-blue-600 border-blue-600 text-white hover:bg-blue-700';
      if (mode==='human') return 'bg-amber-50 border-amber-300 text-amber-900 hover:bg-amber-100';
      return 'bg-white border-gray-300 text-gray-600 hover:bg-gray-50';
    },
    async consultarBotControle(id) {
      const state = await this.apiGet('/admin/api/bot/conversations/'+encodeURIComponent(id)+'/controle');
      this.botControleModos[id] = ['auto','human'].includes(state.mode) ? state.mode : null;
      return state;
    },
    async carregarBotControles() {
      try {
        const data = await this.apiGet('/admin/api/bot/controle');
        this.botControlesHumanos = data.conversations || [];
        for (const state of this.botControlesHumanos) this.botControleModos[state.conversation_id] = 'human';
      } catch { /* Preserva a lista já confirmada; não inventa retomada em falha de rede. */ }
    },
    botMesclarConversas(rows) {
      const map = new Map();
      for (const row of rows) {
        const anterior = map.get(row.conversation_id);
        map.set(row.conversation_id,{ ...row,
          atividade_em:this.botFilaAtividade(anterior?.atividade_em,row.atividade_em),
        });
      }
      for (const state of this.botControlesHumanos) {
        map.set(state.conversation_id,{
          ...map.get(state.conversation_id),
          id:'h-'+state.conversation_id,conversation_id:state.conversation_id,
          lead_conversation_id:state.conversation_id,
          origin:state.channel_type || map.get(state.conversation_id)?.origin,bot_mode:'human',
          chatwoot_id:state.chatwoot_conversation_id,nome:state.contact_name || 'Cliente',
          mensagem:'Bot pausado — atendimento humano',tipo:'humano',
          minutos:Math.max(0,Math.floor((Date.now()-new Date(state.updated_at).getTime())/60000)),
          atividade_em:this.botFilaAtividade(map.get(state.conversation_id)?.atividade_em,state.updated_at,state.last_customer_at),
        });
      }
      return [...map.values()].sort((a,b) => b.minutos-a.minutos || a.conversation_id.localeCompare(b.conversation_id));
    },
    async abrirControleBot(conversationId,nome) {
      if (!conversationId || !this.hasPanelModule('bot') || this.botControleSalvando) return;
      this.botControleDialog = { conversationId,nome:nome || 'Cliente',state:null };
      this.botControleErro = '';
      this.botControleCarregando = true;
      try {
        const state = await this.consultarBotControle(conversationId);
        if (this.botControleDialog?.conversationId===conversationId) this.botControleDialog.state = state;
      } catch {
        this.botControleModos[conversationId] = null;
        if (this.botControleDialog?.conversationId===conversationId) this.botControleErro = 'Não foi possível consultar o controle. Tente novamente.';
      } finally { if (this.botControleDialog?.conversationId===conversationId) this.botControleCarregando = false; }
      this.$nextTick(() => document.getElementById('bot-controle-fechar')?.focus());
    },
    fecharControleBot() { if (!this.botControleSalvando) this.botControleDialog = null; },
    async alterarControleBot(action) {
      const dialog = this.botControleDialog;
      if (!dialog?.state || this.botControleSalvando || this.botControleCarregando) return;
      this.botControleSalvando = true;
      this.botControleErro = '';
      try {
        dialog.state = await this.apiPost('/admin/api/bot/conversations/'+encodeURIComponent(dialog.conversationId)+'/controle',{
          action,expected_version:dialog.state.version,
        });
        this.botControleModos[dialog.conversationId] = dialog.state.mode;
        await this.carregarBotControles();
      } catch {
        this.botControleModos[dialog.conversationId] = null;
        dialog.state = null; // Estado incerto: obriga nova leitura antes de outra ação.
        this.botControleErro = 'Não confirmei a mudança. Atualize o controle antes de tentar novamente.';
      } finally { this.botControleSalvando = false; }
    },
  };
};
