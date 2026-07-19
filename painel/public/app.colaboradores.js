// Obra 300 (2026-07-05): fatia do painel da MATRIZ — colaboradores da matriz (0124): criar/função/senha/revogar.
// VERBATIM das linhas 1531-1629 do app.js pré-obra (commit dd64a35).
// Montado em app.js via getOwnPropertyDescriptors — NUNCA usar spread (congela getter).
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.colaboradores = function () {
  return {
    async loadColaboradores() {
      if (!this.adminAuthenticated || !location.pathname.startsWith('/admin/painel')) return;
      this.colabLoading = true;
      this.colabLoadError = null;
      this.colabLoaded = false;
      try {
        const payload = await this.apiGet(`/admin/api/colaboradores/gestao?competencia=${encodeURIComponent(this.colabMes + '-01')}`);
        this.colaboradores = payload.collaborators || [];
        this.colabAdjustments = (payload.adjustments || []).map((adjustment) => ({
          ...adjustment, review_amount: adjustment.amount ?? '',
        }));
        this.colabSummary = payload.summary || {};
        this.colabLoaded = true;
        this.$nextTick(() => window.lucide && window.lucide.createIcons());
      } catch (err) {
        this.colabLoadError = 'Não foi possível carregar a equipe e a folha. Tente novamente.';
        console.error('colaboradores load failed', err);
      } finally {
        this.colabLoading = false;
      }
    },
    colabJobLabel(value) {
      if (value && typeof value === 'object') return value.job_title || 'Colaborador';
      return value === 'entregador' ? 'Entregador' : value === 'vendedor' ? 'Vendedor' : 'Colaborador';
    },
    colabAreaLabel(area) {
      return ({ sales: 'Vendas', delivery: 'Entregas', administrative: 'Administrativo', workshop: 'Oficina', other: 'Outros' })[area] || 'Outros';
    },
    colabOperationalJob(area) {
      return area === 'sales' ? 'vendedor' : area === 'delivery' ? 'entregador' : 'colaborador';
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
    get colabCargosCount() {
      return new Set(this.colabAtivos.map((c) => c.job_title)).size;
    },
    get colabAcessoCount() {
      return this.colabAtivos.filter((c) => c.panel_role).length;
    },
    /** Quantos proprietários ATIVOS existem — com 1 só, o select dele tranca
     *  (espelho visual da trava last_owner_required do servidor, 0132). */
    get colabOwnersAtivos() {
      return this.colabAtivos.filter((c) => c.panel_role === 'owner').length;
    },
    get colabFiltrados() {
      const base = this.colabView === 'revogados' ? this.colabRevogadosLista : this.colabAtivos;
      const busca = String(this.colabBusca || '').trim().toLowerCase();
      return base.filter((c) => (!this.colabCargoFiltro || c.job_title === this.colabCargoFiltro)
        && (!this.colabAcessoFiltro || (this.colabAcessoFiltro === 'sim' ? !!c.panel_role : !c.panel_role))
        && (!busca || (
        String(c.display_name || '').toLowerCase().includes(busca)
        || String(c.username || '').toLowerCase().includes(busca)
        || String(c.job_title || '').toLowerCase().includes(busca))));
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
      if (!f.job_title.trim()) {
        this.colabMsg = { ok: false, text: 'Informe o cargo do colaborador.' };
        return;
      }
      this.colabSaving = true;
      this.colabMsg = null;
      try {
        await this.apiPost('/admin/api/colaboradores', {
          display_name: f.display_name.trim(),
          username: f.username.trim(),
          password: f.password,
          job: this.colabOperationalJob(f.work_area),
          job_title: f.job_title.trim(),
          work_area: f.work_area,
          panel_role: f.panel_role || null,
        });
        this.colabMsg = { ok: true, text: `${f.display_name.trim()} cadastrado como ${f.job_title.trim()}.` };
        this.colabForm = { display_name: '', username: '', password: '', job_title: '', work_area: 'other', panel_role: null };
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
    async mudarFuncaoColaborador(c, jobTitle, workArea) {
      if (!jobTitle || !jobTitle.trim()) return;
      this.colabSaving = true;
      try {
        await this.apiPost('/admin/api/colaboradores/funcao', {
          id: c.id, job: this.colabOperationalJob(workArea), job_title: jobTitle.trim(), work_area: workArea,
        });
        this.colabMsg = { ok: true, text: `Cargo de ${c.display_name} atualizado.` };
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
    trocarSenhaColaborador(c) {
      this.abrirColabDialog('password', c);
    },
    revogarColaborador(c) {
      this.abrirColabDialog('revoke', c);
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
