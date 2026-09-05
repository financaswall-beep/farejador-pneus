// Controle exclusivamente interno da Matriz. Não cria mensagens no Chatwoot.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.botControle = function () {
  return {
    botControlesHumanos: [],
    botControleDialog: null,
    botControleErro: '',
    botControleSalvando: false,
    botControleCarregando: false,
    async carregarBotControles() {
      try {
        const data = await this.apiGet('/admin/api/bot/controle');
        this.botControlesHumanos = data.conversations || [];
      } catch { /* Preserva a lista já confirmada; não inventa retomada em falha de rede. */ }
    },
    botMesclarConversas(rows) {
      const map = new Map(rows.map((row) => [row.conversation_id,row]));
      for (const state of this.botControlesHumanos) {
        map.set(state.conversation_id,{
          id:'h-'+state.conversation_id,conversation_id:state.conversation_id,
          chatwoot_id:state.chatwoot_conversation_id,nome:state.contact_name || 'Cliente',
          mensagem:'Bot pausado — atendimento humano',tipo:'humano',
          minutos:Math.max(0,Math.floor((Date.now()-new Date(state.updated_at).getTime())/60000)),
        });
      }
      return [...map.values()].sort((a,b) => a.minutos-b.minutos);
    },
    async abrirControleBot(conversationId,nome) {
      if (!conversationId || !this.hasPanelModule('bot') || this.botControleSalvando) return;
      this.botControleDialog = { conversationId,nome:nome || 'Cliente',state:null };
      this.botControleErro = '';
      this.botControleCarregando = true;
      try {
        const state = await this.apiGet('/admin/api/bot/conversations/'+encodeURIComponent(conversationId)+'/controle');
        if (this.botControleDialog?.conversationId===conversationId) this.botControleDialog.state = state;
      } catch {
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
        await this.carregarBotControles();
      } catch {
        dialog.state = null; // Estado incerto: obriga nova leitura antes de outra ação.
        this.botControleErro = 'Não confirmei a mudança. Atualize o controle antes de tentar novamente.';
      } finally { this.botControleSalvando = false; }
    },
  };
};
