// Obra 300 (2026-07-05): fatia do painel da MATRIZ — colaboradores da matriz (0124): criar/função/senha/revogar.
// VERBATIM das linhas 1531-1629 do app.js pré-obra (commit dd64a35).
// Montado em app.js via getOwnPropertyDescriptors — NUNCA usar spread (congela getter).
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.colaboradores = function () {
  return {
    async loadColaboradores() {
      if (!this.adminAuthenticated || !location.pathname.startsWith('/admin/painel')) return;
      try {
        const payload = await this.apiGet('/admin/api/colaboradores');
        this.colaboradores = payload.collaborators || [];
        this.colabLoaded = true;
        this.$nextTick(() => window.lucide && window.lucide.createIcons());
      } catch (err) {
        console.error('colaboradores load failed', err);
      }
    },
    colabJobLabel(job) {
      return job === 'entregador' ? 'Entregador' : 'Vendedor';
    },
    colabAccessLabel(role) {
      if (role === 'owner') return 'Proprietário';
      if (role === 'admin') return 'Administrador';
      return 'Sem acesso ao painel';
    },

    // ─── redesign 07-12: getters derivados (nada de estado duplicado) ───
    get colabAtivos() {
      return this.colaboradores.filter((c) => c.active);
    },
    get colabRevogadosLista() {
      return this.colaboradores.filter((c) => !c.active);
    },
    get colabVendedoresCount() {
      return this.colabAtivos.filter((c) => c.job === 'vendedor').length;
    },
    get colabEntregadoresCount() {
      return this.colabAtivos.filter((c) => c.job === 'entregador').length;
    },
    /** Quantos proprietários ATIVOS existem — com 1 só, o select dele tranca
     *  (espelho visual da trava last_owner_required do servidor, 0132). */
    get colabOwnersAtivos() {
      return this.colabAtivos.filter((c) => c.panel_role === 'owner').length;
    },
    get colabFiltrados() {
      const base = this.colabView === 'revogados' ? this.colabRevogadosLista : this.colabAtivos;
      const busca = String(this.colabBusca || '').trim().toLowerCase();
      if (!busca) return base;
      return base.filter((c) =>
        String(c.display_name || '').toLowerCase().includes(busca)
        || String(c.username || '').toLowerCase().includes(busca));
    },
    colabIniciais(nome) {
      const partes = String(nome || '?').trim().split(/\s+/);
      return ((partes[0] || '')[0] || '?').toUpperCase() + (partes.length > 1 ? ((partes[partes.length - 1][0]) || '').toUpperCase() : '');
    },
    colabCorAvatar(nome) {
      const paleta = [
        'bg-violet-100 text-violet-700',
        'bg-sky-100 text-sky-700',
        'bg-amber-100 text-amber-700',
        'bg-emerald-100 text-emerald-700',
      ];
      let soma = 0;
      for (const ch of String(nome || '')) soma += ch.charCodeAt(0);
      return paleta[soma % paleta.length];
    },
    abrirNovoColaborador() {
      this.colabMsg = null;
      this.colabSenhaVisivel = false;
      this.colabShowForm = true;
    },

    async criarColaborador() {
      const f = this.colabForm;
      if (!f.display_name.trim() || !f.username.trim() || !f.password) {
        this.colabMsg = { ok: false, text: 'Preenche nome, usuário e senha.' };
        return;
      }
      if (!f.job) {
        this.colabMsg = { ok: false, text: 'Escolhe a função: vendedor ou entregador.' };
        return;
      }
      this.colabSaving = true;
      this.colabMsg = null;
      try {
        await this.apiPost('/admin/api/colaboradores', {
          display_name: f.display_name.trim(),
          username: f.username.trim(),
          password: f.password,
          job: f.job,
          panel_role: f.panel_role || null,
        });
        this.colabMsg = { ok: true, text: `${f.display_name.trim()} cadastrado como ${this.colabJobLabel(f.job).toLowerCase()}.` };
        this.colabForm = { display_name: '', username: '', password: '', job: '', panel_role: null };
        this.colabShowForm = false;
        await this.loadColaboradores();
      } catch (err) {
        this.colabMsg = err.message === 'username_taken'
          ? { ok: false, text: 'Esse usuário já existe na rede — escolhe outro.' }
          : { ok: false, text: `Não consegui cadastrar (${err.message}).` };
      } finally {
        this.colabSaving = false;
      }
    },
    async mudarFuncaoColaborador(c, job) {
      if (c.job === job) return;
      this.colabSaving = true;
      try {
        await this.apiPost('/admin/api/colaboradores/funcao', { id: c.id, job });
        this.colabMsg = { ok: true, text: `${c.display_name} agora é ${this.colabJobLabel(job).toLowerCase()}.` };
        await this.loadColaboradores();
      } catch (err) {
        this.colabMsg = { ok: false, text: `Não consegui mudar a função (${err.message}).` };
        await this.loadColaboradores(); // repõe o select no valor real do banco
      } finally {
        this.colabSaving = false;
      }
    },
    async mudarAcessoColaborador(c, panelRole) {
      const role = panelRole || null;
      if (c.panel_role === role) return;
      this.colabSaving = true;
      try {
        await this.apiPost('/admin/api/colaboradores/acesso', { id: c.id, panel_role: role });
        this.colabMsg = { ok: true, text: `Acesso de ${c.display_name}: ${this.colabAccessLabel(role)}.` };
        await this.loadColaboradores();
      } catch (err) {
        this.colabMsg = err.message === 'last_owner_required'
          ? { ok: false, text: 'Não é possível remover o último proprietário da Matriz.' }
          : { ok: false, text: `Não consegui mudar o acesso (${err.message}).` };
        await this.loadColaboradores();
      } finally {
        this.colabSaving = false;
      }
    },
    async trocarSenhaColaborador(c) {
      const senha = prompt(`Nova senha pra ${c.display_name} (mínimo 12):`);
      if (senha === null) return;
      if (senha.length < 12) { this.colabMsg = { ok: false, text: 'Senha muito curta (mínimo 12).' }; return; }
      this.colabSaving = true;
      try {
        await this.apiPost('/admin/api/colaboradores/senha', { id: c.id, password: senha });
        this.colabMsg = { ok: true, text: `Senha de ${c.display_name} trocada.` };
      } catch (err) {
        this.colabMsg = { ok: false, text: `Não consegui trocar a senha (${err.message}).` };
      } finally {
        this.colabSaving = false;
      }
    },
    async revogarColaborador(c) {
      if (!confirm(`Revogar o acesso de ${c.display_name}? Ele sai da ativa mas fica na trilha (dá pra reativar).`)) return;
      this.colabSaving = true;
      try {
        await this.apiPost('/admin/api/colaboradores/revogar', { id: c.id });
        this.colabMsg = { ok: true, text: `${c.display_name} revogado.` };
        await this.loadColaboradores();
      } catch (err) {
        this.colabMsg = err.message === 'last_owner_required'
          ? { ok: false, text: 'Não é possível revogar o último proprietário da Matriz.' }
          : { ok: false, text: `Não consegui revogar (${err.message}).` };
      } finally {
        this.colabSaving = false;
      }
    },
    async reativarColaborador(c) {
      this.colabSaving = true;
      try {
        await this.apiPost('/admin/api/colaboradores/reativar', { id: c.id });
        this.colabMsg = { ok: true, text: `${c.display_name} reativado (mesma senha de antes).` };
        await this.loadColaboradores();
      } catch (err) {
        this.colabMsg = err.message === 'username_taken'
          ? { ok: false, text: 'O usuário dele foi reaproveitado por outra conta — cadastra de novo com outro usuário.' }
          : { ok: false, text: `Não consegui reativar (${err.message}).` };
      } finally {
        this.colabSaving = false;
      }
    },

    // Barra de participação (perna × maior perna do mês). Mínimo 2% pra barra existir.
  };
};
