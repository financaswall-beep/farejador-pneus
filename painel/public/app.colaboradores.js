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
        const owner = this.adminUser?.role === 'owner';
        const payload = owner
          ? await this.apiGet(`/admin/api/colaboradores/gestao?competencia=${encodeURIComponent(this.colabMes + '-01')}`)
          : await this.apiGet('/admin/api/colaboradores');
        this.colaboradores = (payload.collaborators || []).map((row) => ({
          ...row,
          // A rota de diretório não fornece números financeiros ou resultados.
          // Defaults locais mantêm os componentes de leitura determinísticos.
          sales_count: Number(row.sales_count || 0),
          deliveries_count: Number(row.deliveries_count || 0),
          trips_count: Number(row.trips_count || 0),
        }));
        this.colabAdjustments = owner ? (payload.adjustments || []).map((adjustment) => ({
          ...adjustment, review_amount: adjustment.amount ?? '',
        })) : [];
        this.colabSummary = owner ? (payload.summary || {}) : {};
        this.colabPayrollHistory = owner ? (payload.payroll_history || []) : [];
        this.colabLoaded = true;
        this.$nextTick(() => window.lucide && window.lucide.createIcons());
      } catch (err) {
        this.colabLoadError = this.adminUser?.role === 'owner'
          ? 'Não foi possível carregar a equipe e a folha. Tente novamente.'
          : 'Não foi possível carregar a equipe. Tente novamente.';
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
    colabNormalizeUsername(value) {
      return String(value || '').trim().normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '').toLowerCase()
        .replace(/\s+/g, '.').replace(/[^a-z0-9._-]+/g, '')
        .replace(/\.{2,}/g, '.').replace(/^[._-]+|[._-]+$/g, '')
        .slice(0, 60);
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
    get colabEmOperacaoCount() {
      return this.colabAtivos.filter((c) => Number(c.sales_count || 0) > 0
        || Number(c.deliveries_count || 0) > 0 || Number(c.trips_count || 0) > 0).length;
    },
    get colabBenefitsTotal() {
      return this.colabAtivos.reduce((sum, c) => sum + Number(c.benefits_total || 0), 0);
    },
    get colabPredictedCost() {
      return Number(this.colabSummary.base_salary_total || 0) + this.colabBenefitsTotal
        + Number(this.colabSummary.commission_total || 0);
    },
    get colabSemRemuneracaoCount() {
      return this.colabAtivos.filter((c) => !c.employment_type).length;
    },
    get colabSemComissaoCount() {
      return this.colabAtivos.filter((c) => c.work_area === 'sales' && !c.commission_active).length;
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
    colabAccessChips(c) {
      const chips = [];
      if (c.panel_role === 'owner') chips.push('Todos os módulos');
      else if (c.panel_role === 'admin') chips.push('Painel administrativo');
      if (c.allow_vendas) chips.push('Vendas');
      if (c.allow_estoque) chips.push('Estoque');
      if (c.allow_entregas) chips.push('Logística');
      if (c.allow_retiradas) chips.push('Retiradas');
      if (c.allow_financeiro) chips.push('Financeiro');
      return [...new Set(chips)].slice(0, 3);
    },
    colabResultLabel(c) {
      if (Number(c.sales_count || 0) > 0) return `${c.sales_count} vendas · ${this.formatCurrency(c.revenue || 0)}`;
      if (Number(c.deliveries_count || 0) > 0) return `${c.deliveries_count} entregas`;
      if (Number(c.trips_count || 0) > 0) return `${c.trips_count} rotas`;
      return 'Sem movimento no mês';
    },
    colabCompetenceLabel() {
      const [year, month] = String(this.colabMes || '').split('-').map(Number);
      if (!year || !month) return 'Competência atual';
      return new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric', timeZone: 'America/Sao_Paulo' })
        .format(new Date(Date.UTC(year, month - 1, 1)));
    },
    abrirNovoColaborador() {
      this.colabMsg = null;
      this.colabSenhaVisivel = false;
      this.colabShowForm = true;
    },

    async criarColaborador() {
      const f = this.colabForm;
      const username = this.colabNormalizeUsername(f.username);
      f.username = username;
      if (!f.display_name.trim() || username.length < 3 || !f.password) {
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
          username,
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
          : err.message === 'usuario_invalido'
            ? { ok: false, text: 'Usuário inválido. Use letras, números, ponto, traço ou sublinhado.' }
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
