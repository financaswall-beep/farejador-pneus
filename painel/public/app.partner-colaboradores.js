// Gestão da equipe da unidade no painel moderno. Cadeado visual owner-only; o
// servidor repete a trava. Usa exclusivamente APIs do parceiro e nunca a Matriz.
window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.partnerColaboradores = function () {
  const permissions = () => ({
    vendas: false, estoque: false, pedidos: false, clientes: false,
    entregas: false, retiradas: false, batepapo: false, resumo: false, financeiro: false,
    compras: false, colaboradores: false, catalogo: false,
  });
  const rules = () => ({
    tire: { kind: 'none', value: 0 }, service: { kind: 'none', value: 0 },
    other: { kind: 'none', value: 0 },
  });
  const today = () => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const emptyDetail = () => ({
    permissions: permissions(), job_role: 'colaborador',
    compensation: {
      employment_type: 'outro', base_salary: 0, salary_frequency: 'monthly',
      payment_day: 5, payment_method: 'pix', starts_on: today(), benefits: [],
    },
    commission: {
      kind: 'percent', basis: 'revenue', value: 0, active: false, starts_on: today(),
      settlement_frequency: 'monthly', itemized: false, item_rules: rules(),
    },
  });
  return {
    partnerColaboradores: {
      rows: [], activeCount: 0, loading: false, error: null, notice: '', request: 0,
      unitName: '', commissionTotal: 0,
      tab: 'equipe', q: '', filter: 'active', remunerationFilter: 'all',
      permissionModel: 'custom',
      selected: null, detail: emptyDetail(),
      detailLoading: false, detailError: null, saving: false,
      create: { open: false, name: '', username: '', password: '', role: 'colaborador', error: '' },
      password: { open: false, value: '', error: '' },
    },

    partnerColaboradoresOwner() {
      return this.isPartnerPanel() && this.panelWorkplace?.role === 'owner';
    },
    partnerColaboradoresCanView() {
      return this.isPartnerPanel() && (this.partnerColaboradoresOwner()
        || this.hasPanelModule?.('colaboradores'));
    },

    async loadPartnerColaboradores() {
      if (!this.partnerColaboradoresCanView()) return;
      const state = this.partnerColaboradores;
      const request = ++state.request;
      state.loading = true;
      state.error = null;
      try {
        const [team, accounts] = await Promise.all([
          this.partnerApiGet('equipe'),
          this.partnerColaboradoresOwner() ? this.partnerApiGet('funcionarios') : Promise.resolve({ rows: [] }),
        ]);
        if (request !== state.request) return;
        const byId = new Map((accounts.rows || []).map((row) => [row.id, row]));
        state.rows = (team.members || []).map((member) => ({
          ...member, ...(byId.get(member.id) || {}), active: member.active !== false && !byId.get(member.id)?.revoked_at,
        }));
        state.unitName = team.unit_name || this.panelWorkplace?.unit_name || this.panelWorkplace?.name || 'Unidade';
        state.commissionTotal = Number(team.commission_total || 0);
        state.activeCount = state.rows.filter((row) => row.active).length;
        if (state.selected?.id) state.selected = state.rows.find((row) => row.id === state.selected.id) || null;
      } catch (_) {
        if (request === state.request) state.error = 'Não foi possível carregar os colaboradores.';
      } finally {
        if (request === state.request) state.loading = false;
        this.$nextTick(() => lucide.createIcons());
      }
    },

    partnerColaboradoresFiltered() {
      const state = this.partnerColaboradores;
      const query = String(state.q || '').trim().toLocaleLowerCase('pt-BR');
      return state.rows.filter((row) => {
        if (state.filter === 'active' && !row.active) return false;
        if (state.filter === 'inactive' && row.active) return false;
        if (!query) return true;
        return [row.name, row.label, row.username, row.role, row.job_role]
          .filter(Boolean).join(' ').toLocaleLowerCase('pt-BR').includes(query);
      });
    },
    partnerColaboradoresInitials(row) {
      return String(row.name || row.label || row.username || '?').trim().split(/\s+/)
        .slice(0, 2).map((part) => part[0]).join('').toUpperCase();
    },
    partnerColaboradoresAccessCount() {
      return this.partnerColaboradores.rows.filter((row) => row.active && row.username).length;
    },
    partnerColaboradoresConfiguredCount() {
      return this.partnerColaboradores.rows.filter((row) => row.active
        && Boolean(row.compensation_starts_on)).length;
    },
    partnerColaboradoresSalaryTotal() {
      return this.partnerColaboradores.rows.filter((row) => row.active)
        .reduce((sum, row) => sum + Number(row.base_salary || 0), 0);
    },
    partnerColaboradoresBenefitsTotal() {
      return this.partnerColaboradores.rows.filter((row) => row.active)
        .reduce((sum, row) => sum + Number(row.benefits_total || 0), 0);
    },
    partnerColaboradoresPredictedCost() {
      return this.partnerColaboradoresSalaryTotal() + this.partnerColaboradoresBenefitsTotal()
        + Number(this.partnerColaboradores.commissionTotal || 0);
    },
    partnerColaboradoresWithoutCompensation() {
      return this.partnerColaboradores.rows.filter((row) => row.active
        && !row.compensation_starts_on).length;
    },
    partnerColaboradoresWithoutCommission() {
      return this.partnerColaboradores.rows.filter((row) => row.active
        && row.job_role === 'vendedor' && !row.commission_active).length;
    },
    partnerColaboradoresPermissionLabels(row) {
      const labels = { vendas: 'Vendas', estoque: 'Estoque', pedidos: 'Pedidos', clientes: 'Clientes',
        entregas: 'Logística', retiradas: 'Retiradas', batepapo: 'Bate-papo', resumo: 'Resumo',
        financeiro: 'Financeiro', compras: 'Compras', colaboradores: 'Colaboradores', catalogo: 'Catálogo' };
      return Object.entries(row.permissions || {}).filter(([, enabled]) => enabled)
        .map(([key]) => labels[key] || key).slice(0, 3);
    },
    partnerColaboradoresResult(row) {
      const value = Number(row.commission_amount || 0);
      return value > 0 ? `${this.formatCurrency(value)} de comissão` : 'Sem comissão no mês';
    },
    partnerColaboradoresMonthLabel() {
      return new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric', timeZone: 'America/Sao_Paulo' }).format(new Date());
    },
    partnerColaboradoresPermissionCount() {
      return Object.values(this.partnerColaboradores.detail.permissions).filter(Boolean).length;
    },
    async partnerColaboradoresOpen(row) {
      const state = this.partnerColaboradores;
      state.selected = row;
      state.detail = emptyDetail();
      state.detailLoading = true;
      state.detailError = null;
      try {
        const [access, compensation, commission] = await Promise.all([
          this.partnerApiGet(`equipe/${encodeURIComponent(row.id)}/permissoes`),
          this.partnerApiGet(`equipe/${encodeURIComponent(row.id)}/remuneracao`),
          this.partnerApiGet(`equipe/${encodeURIComponent(row.id)}/comissao`),
        ]);
        state.detail = {
          permissions: { ...permissions(), ...(access.permissions || {}) },
          job_role: row.job_role || 'colaborador',
          compensation: {
            employment_type: compensation.employment_type || 'outro',
            base_salary: Number(compensation.base_salary || 0),
            salary_frequency: compensation.salary_frequency || 'monthly',
            payment_day: Number(compensation.payment_day || 5),
            payment_method: compensation.payment_method || 'pix',
            starts_on: String(compensation.starts_on || today()).slice(0, 10),
            benefits: (compensation.benefits || []).map((item) => ({ ...item, amount: Number(item.amount || 0) })),
          },
          commission: {
            kind: commission.kind === 'fixed' ? 'fixed' : 'percent',
            basis: commission.kind === 'fixed' ? 'sale' : 'revenue',
            value: Number(commission.value || 0), active: Boolean(commission.active),
            starts_on: String(commission.starts_on || today()).slice(0, 10),
            settlement_frequency: commission.settlement_frequency || 'monthly',
            itemized: Boolean(commission.itemized),
            item_rules: { ...rules(), ...(commission.item_rules || {}) },
          },
        };
      } catch (_) {
        state.detailError = 'Não foi possível carregar a configuração deste colaborador.';
      } finally {
        state.detailLoading = false;
        this.$nextTick(() => lucide.createIcons());
      }
    },
    partnerColaboradoresClose() {
      if (!this.partnerColaboradores.saving) this.partnerColaboradores.selected = null;
    },
    partnerColaboradoresAddBenefit() {
      const benefits = this.partnerColaboradores.detail.compensation.benefits;
      if (benefits.length < 12) benefits.push({ name: '', amount: 0, active: true });
    },
    partnerColaboradoresRemoveBenefit(index) {
      this.partnerColaboradores.detail.compensation.benefits.splice(index, 1);
    },

    async partnerColaboradoresSave() {
      const state = this.partnerColaboradores;
      const selected = state.selected;
      if (!selected?.id || state.saving) return;
      const detail = state.detail;
      const commission = detail.commission;
      if (commission.active && !commission.itemized && !(Number(commission.value) > 0)) {
        state.detailError = 'Informe o valor da comissão ou desative-a.';
        return;
      }
      state.saving = true;
      state.detailError = null;
      try {
        await this.partnerApiWrite(`equipe/${encodeURIComponent(selected.id)}/configuracao`, 'PUT', {
          job_role: detail.job_role,
          permissions: Object.fromEntries(Object.keys(permissions()).map((key) => [key, Boolean(detail.permissions[key])])),
          compensation: {
            ...detail.compensation,
            base_salary: Number(detail.compensation.base_salary || 0),
            payment_day: Number(detail.compensation.payment_day || 5),
            benefits: detail.compensation.benefits.filter((item) => String(item.name || '').trim())
              .map((item) => ({ name: String(item.name).trim(), amount: Number(item.amount || 0), active: item.active !== false })),
          },
          commission: {
            ...commission, kind: commission.kind === 'fixed' ? 'fixed' : 'percent',
            basis: commission.kind === 'fixed' ? 'sale' : 'revenue',
            value: commission.active ? Number(commission.value || 0) : 0,
          },
        });
        state.notice = 'Configuração do colaborador salva.';
        await this.loadPartnerColaboradores();
      } catch (_) {
        state.detailError = 'Não foi possível salvar a configuração.';
      } finally { state.saving = false; }
    },

    partnerColaboradoresOpenCreate() {
      this.partnerColaboradores.create = {
        open: true, name: '', username: '', password: '', role: 'colaborador', error: '',
      };
    },
    partnerColaboradoresNormalizeUsername(value) {
      return String(value || '').trim().normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '').toLowerCase()
        .replace(/\s+/g, '.').replace(/[^a-z0-9._-]+/g, '')
        .replace(/\.{2,}/g, '.').replace(/^[._-]+|[._-]+$/g, '')
        .slice(0, 60);
    },
    async partnerColaboradoresCreate() {
      const state = this.partnerColaboradores;
      const form = state.create;
      const username = this.partnerColaboradoresNormalizeUsername(form.username);
      form.username = username;
      if (String(form.name).trim().length < 2 || username.length < 3
          || String(form.password).length < 12) {
        form.error = 'Preencha nome, usuário e uma senha com pelo menos 12 caracteres.';
        return;
      }
      state.saving = true;
      form.error = '';
      try {
        await this.partnerApiWrite('equipe', 'POST', {
          name: String(form.name).trim(), username,
          password: form.password, role: form.role,
        });
        form.open = false;
        form.password = '';
        state.notice = 'Colaborador criado.';
        await this.loadPartnerColaboradores();
      } catch (error) {
        const code = error?.code || error?.message;
        form.error = code === 'username_taken' ? 'Este usuário já está em uso.'
          : code === 'usuario_invalido' ? 'Use letras, números, ponto, traço ou sublinhado no usuário.'
            : 'Não foi possível criar o colaborador.';
      } finally { state.saving = false; }
    },

    partnerColaboradoresOpenPassword() {
      this.partnerColaboradores.password = { open: true, value: '', error: '' };
    },
    async partnerColaboradoresResetPassword() {
      const state = this.partnerColaboradores;
      if (!state.selected?.id || String(state.password.value).length < 12) {
        state.password.error = 'A nova senha precisa ter pelo menos 12 caracteres.';
        return;
      }
      state.saving = true;
      try {
        await this.partnerApiWrite(`funcionarios/${encodeURIComponent(state.selected.id)}/reset-senha`, 'POST', {
          password: state.password.value,
        });
        state.password = { open: false, value: '', error: '' };
        state.notice = 'Senha redefinida e sessões antigas encerradas.';
      } catch (_) { state.password.error = 'Não foi possível redefinir a senha.'; }
      finally { state.saving = false; }
    },
    async partnerColaboradoresSetActive(row, active) {
      const state = this.partnerColaboradores;
      if (!row?.id || state.saving) return;
      state.saving = true;
      try {
        if (active) await this.partnerApiWrite(`funcionarios/${encodeURIComponent(row.id)}/reativar`, 'POST', {});
        else await this.partnerApiWrite(`funcionarios/${encodeURIComponent(row.id)}`, 'DELETE', {});
        state.notice = active ? 'Acesso reativado.' : 'Acesso desativado e sessões encerradas.';
        if (state.selected?.id === row.id) state.selected = null;
        await this.loadPartnerColaboradores();
      } catch (_) { state.error = 'Não foi possível alterar o acesso.'; }
      finally { state.saving = false; }
    },
  };
};
