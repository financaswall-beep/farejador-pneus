window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.colaboradoresGestao = function () {
  return {
    get colabCargos() {
      return [...new Set(this.colabAtivos.map((c) => c.job_title).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
    },
    get colabSelected() {
      return this.colaboradores.find((c) => c.id === this.colabSelectedId) || null;
    },
    get colabRemuneracaoRows() {
      const term = this.colabBusca.trim().toLowerCase();
      return this.colabAtivos.filter((c) => (!this.colabCargoFiltro || c.job_title === this.colabCargoFiltro)
        && (!term || `${c.display_name} ${c.job_title}`.toLowerCase().includes(term)));
    },
    get colabComissaoRows() {
      return this.colabAtivos.filter((c) => c.commission_active || c.work_area === 'sales' || c.work_area === 'delivery');
    },
    get colabFolhaRows() {
      return this.colaboradores.filter((c) => c.payroll_item_id || (c.active && (c.employment_type || c.commission_active || c.additions || c.deductions)));
    },
    get colabSelectedAdjustments() {
      if (!this.colabSelectedId) return [];
      return this.colabAdjustments.filter((adjustment) => adjustment.collaborator_id === this.colabSelectedId);
    },
    get colabVendasRanking() {
      return this.colabAtivos.filter((c) => c.sales_count > 0 || c.work_area === 'sales').sort((a, b) => b.margin - a.margin);
    },
    get colabEntregasRanking() {
      return this.colabAtivos.filter((c) => c.trips_count > 0 || c.work_area === 'delivery').sort((a, b) => b.deliveries_count - a.deliveries_count);
    },
    colabSetTab(tab) {
      this.colabTab = tab; this.colabDrawer = null; this.colabSelectedId = null;
      this.colabBusca = ''; this.colabCargoFiltro = ''; this.colabAcessoFiltro = '';
      this.$nextTick(() => window.lucide && window.lucide.createIcons());
    },
    async colabMesMudou() {
      this.colabDrawer = null; this.colabSelectedId = null; await this.loadColaboradores();
    },
    colabOpen(c, drawer) {
      this.colabSelectedId = c.id; this.colabDrawer = drawer;
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
      this.colabPerfilForm = { job_title: c.job_title || '', work_area: c.work_area || 'other' };
      this.colabRemForm = {
        employment_type: c.employment_type || 'clt', base_salary: c.monthly_base_salary || c.base_salary || '',
        payment_day: c.payment_day || 5, payment_method: c.payment_method || 'pix',
        payment_note: c.payment_note || '', starts_on: c.compensation_starts_on ? String(c.compensation_starts_on).slice(0, 10) : today,
      };
      this.colabComForm = {
        kind: c.commission_kind || 'percent', basis: c.commission_basis || (c.work_area === 'delivery' ? 'delivery' : 'margin'),
        value: c.commission_value || '', starts_on: c.commission_starts_on ? String(c.commission_starts_on).slice(0, 10) : today,
        active: c.commission_active !== false,
      };
      this.colabAjusteForm = { kind: 'addition', description: '', amount: '' };
      this.$nextTick(() => window.lucide && window.lucide.createIcons());
    },
    colabCloseDrawer() { this.colabDrawer = null; this.colabSelectedId = null; },
    colabNumber(value) {
      if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
      const raw = String(value ?? '').trim();
      const cleaned = raw.includes(',') ? raw.replace(/\./g, '').replace(',', '.') : raw;
      const number = Number(cleaned); return Number.isFinite(number) ? number : 0;
    },
    colabEmploymentLabel(value) {
      return ({ clt: 'CLT', mei: 'MEI', autonomo: 'Autônomo', outro: 'Outro' })[value] || 'Não configurado';
    },
    colabPaymentLabel(value) {
      return ({ pix: 'PIX', transferencia: 'Conta bancária', dinheiro: 'Dinheiro', outro: 'Outro' })[value] || '—';
    },
    colabCommissionLabel(c) {
      if (!c.commission_active || !c.commission_kind) return 'Sem regra';
      const basis = ({ margin: 'margem', revenue: 'faturamento', sale: 'venda', delivery: 'entrega', trip: 'rota' })[c.commission_basis] || '';
      return c.commission_kind === 'percent' ? `${Number(c.commission_value).toLocaleString('pt-BR')}% da ${basis}`
        : `${this.formatCurrency(c.commission_value)} por ${basis}`;
    },
    colabStatusLabel(c) {
      return c.payroll_status === 'paid' ? 'Pago' : c.payroll_status === 'pending' ? 'Pendente' : 'Prévia';
    },
    async colabSalvarPerfil() {
      const c = this.colabSelected; if (!c) return;
      await this.mudarFuncaoColaborador(c, this.colabPerfilForm.job_title, this.colabPerfilForm.work_area);
      this.colabCloseDrawer();
    },
    async colabSalvarRemuneracao() {
      const c = this.colabSelected; if (!c) return;
      const amount = this.colabNumber(this.colabRemForm.base_salary);
      this.colabSaving = true; this.colabMsg = null;
      try {
        await this.apiPost('/admin/api/colaboradores/remuneracao', {
          collaborator_id: c.id, ...this.colabRemForm, base_salary: amount,
          payment_note: this.colabRemForm.payment_note.trim() || null,
        });
        this.colabMsg = { ok: true, text: `Remuneração de ${c.display_name} salva.` };
        await this.loadColaboradores(); this.colabCloseDrawer();
      } catch (err) { this.colabMsg = { ok: false, text: `Não consegui salvar (${err.message}).` }; }
      finally { this.colabSaving = false; }
    },
    colabComKindChanged() {
      const percent = this.colabComForm.kind === 'percent';
      if (percent && !['margin', 'revenue'].includes(this.colabComForm.basis)) this.colabComForm.basis = 'margin';
      if (!percent && !['sale', 'delivery', 'trip'].includes(this.colabComForm.basis)) this.colabComForm.basis = 'sale';
    },
    async colabSalvarComissao() {
      const c = this.colabSelected; if (!c) return;
      this.colabSaving = true; this.colabMsg = null;
      try {
        await this.apiPost('/admin/api/colaboradores/comissao', {
          collaborator_id: c.id, ...this.colabComForm, value: this.colabNumber(this.colabComForm.value),
        });
        this.colabMsg = { ok: true, text: `Regra de ${c.display_name} salva.` };
        await this.loadColaboradores(); this.colabCloseDrawer();
      } catch (err) { this.colabMsg = { ok: false, text: `Não consegui salvar (${err.message}).` }; }
      finally { this.colabSaving = false; }
    },
    async colabAdicionarAjuste() {
      const c = this.colabSelected; if (!c) return;
      this.colabSaving = true; this.colabMsg = null;
      try {
        await this.apiPost('/admin/api/colaboradores/ajustes', {
          collaborator_id: c.id, competence: this.colabMes + '-01', ...this.colabAjusteForm,
          amount: this.colabNumber(this.colabAjusteForm.amount),
        });
        this.colabMsg = { ok: true, text: `Ajuste incluído para ${c.display_name}.` };
        await this.loadColaboradores(); this.colabOpen(this.colaboradores.find((x) => x.id === c.id), 'folha');
      } catch (err) { this.colabMsg = { ok: false, text: `Não consegui incluir (${err.message}).` }; }
      finally { this.colabSaving = false; }
    },
    colabAdjustmentOrigin(adjustment) {
      if (adjustment.source_type === 'delivery_cancellation') return 'Entrega cancelada após a folha';
      if (adjustment.source_type === 'wholesale_sale_cancellation') return 'Venda de atacado cancelada após a folha';
      if (adjustment.source_type === 'retail_sale_cancellation') return 'Venda cancelada após a folha';
      return 'Ajuste manual';
    },
    async colabRevisarAjusteCausal(adjustment) {
      const amount = this.colabNumber(adjustment.review_amount);
      if (amount <= 0) { this.colabMsg = { ok: false, text: 'Informe um valor positivo.' }; return; }
      this.colabSaving = true; this.colabMsg = null;
      try {
        await this.apiPost('/admin/api/colaboradores/ajustes/causal/revisar', {
          id: adjustment.id, amount,
        });
        this.colabMsg = { ok: true, text: 'Ajuste causal revisado e pronto para a folha.' };
        await this.loadColaboradores();
      } catch (err) { this.colabMsg = { ok: false, text: `Não consegui revisar (${err.message}).` }; }
      finally { this.colabSaving = false; }
    },
    abrirColabDialog(kind, collaborator = null) {
      if (!['password', 'revoke', 'close-payroll', 'pay-payroll'].includes(kind)) return;
      this.colabDialog = {
        open: true, kind, collaborator, password: '', showPassword: false, error: null,
      };
      if (kind === 'password') {
        this.$nextTick(() => this.$refs.colabDialogPassword?.focus());
      }
    },
    fecharColabDialog() {
      if (this.colabSaving) return;
      this.colabDialog = {
        open: false, kind: null, collaborator: null, password: '', showPassword: false, error: null,
      };
    },
    colabDialogTitle() {
      return ({
        password: 'Trocar senha', revoke: 'Revogar colaborador',
        'close-payroll': 'Fechar competência', 'pay-payroll': 'Confirmar pagamento',
      })[this.colabDialog.kind] || 'Confirmar ação';
    },
    colabDialogDescription() {
      const c = this.colabDialog.collaborator || {};
      if (this.colabDialog.kind === 'password') {
        return `Defina uma nova senha para ${c.display_name || 'o colaborador'}. Ela precisa ter pelo menos 12 caracteres.`;
      }
      if (this.colabDialog.kind === 'revoke') {
        return `${c.display_name || 'O colaborador'} sairá da equipe ativa e perderá o acesso, mas continuará na trilha e poderá ser reativado.`;
      }
      if (this.colabDialog.kind === 'close-payroll') {
        return `Os valores de ${this.colabMes} serão congelados e entrarão no Financeiro como contas a pagar.`;
      }
      if (this.colabDialog.kind === 'pay-payroll') {
        return `Confirme o pagamento de ${this.formatCurrency(c.total_due || 0)} para ${c.display_name || 'o colaborador'}.`;
      }
      return '';
    },
    colabDialogConfirmLabel() {
      return ({
        password: 'Trocar senha', revoke: 'Revogar acesso',
        'close-payroll': 'Fechar competência', 'pay-payroll': 'Confirmar pagamento',
      })[this.colabDialog.kind] || 'Confirmar';
    },
    colabFecharFolha() {
      this.abrirColabDialog('close-payroll');
    },
    colabPagar(c) {
      if (!c.payroll_item_id) return;
      this.abrirColabDialog('pay-payroll', c);
    },
    async confirmarColabDialog() {
      const dialog = this.colabDialog;
      const c = dialog.collaborator;
      if (!dialog.open || this.colabSaving) return;
      if (dialog.kind === 'password' && (!c || dialog.password.length < 12)) {
        this.colabDialog.error = 'A senha precisa ter pelo menos 12 caracteres.';
        return;
      }
      if (['password', 'revoke', 'pay-payroll'].includes(dialog.kind) && !c) {
        this.colabDialog.error = 'Não foi possível identificar o colaborador. Feche e tente novamente.';
        return;
      }

      this.colabSaving = true;
      this.colabMsg = null;
      this.colabDialog.error = null;
      let succeeded = false;
      try {
        if (dialog.kind === 'password') {
          await this.apiPost('/admin/api/colaboradores/senha', { id: c.id, password: dialog.password });
          this.colabMsg = { ok: true, text: `Senha de ${c.display_name} trocada.` };
        } else if (dialog.kind === 'revoke') {
          await this.apiPost('/admin/api/colaboradores/revogar', { id: c.id });
          this.colabMsg = { ok: true, text: `${c.display_name} revogado.` };
          await this.loadColaboradores();
        } else if (dialog.kind === 'close-payroll') {
          await this.apiPost('/admin/api/colaboradores/folha/fechar', { competence: this.colabMes + '-01' });
          this.colabMsg = { ok: true, text: 'Folha fechada e conciliada com o Financeiro.' };
          await this.loadColaboradores();
        } else if (dialog.kind === 'pay-payroll') {
          const operation = window.PAINEL_INTEGRITY.operation('matriz-payroll-payment', c.payroll_item_id);
          await this.apiPost('/admin/api/colaboradores/folha/pagar', {
            item_id: c.payroll_item_id, idempotency_key: operation.key,
          });
          window.PAINEL_INTEGRITY.complete('matriz-payroll-payment', c.payroll_item_id);
          this.colabMsg = { ok: true, text: 'Pagamento confirmado no Colaboradores e no Financeiro.' };
          await Promise.all([this.loadColaboradores(), this.loadFinanceiro()]);
          this.colabCloseDrawer();
        } else {
          throw new Error('acao_desconhecida');
        }
        succeeded = true;
      } catch (err) {
        const action = dialog.kind === 'password' ? 'trocar a senha'
          : dialog.kind === 'revoke' ? 'revogar'
            : dialog.kind === 'close-payroll' ? 'fechar a folha' : 'confirmar o pagamento';
        const message = err.message === 'last_owner_required'
          ? 'Não é possível revogar o último proprietário da Matriz.'
          : `Não consegui ${action} (${err.message}).`;
        this.colabDialog.error = message;
        this.colabMsg = { ok: false, text: message };
      } finally {
        this.colabSaving = false;
        if (succeeded) this.fecharColabDialog();
      }
    },
  };
};
