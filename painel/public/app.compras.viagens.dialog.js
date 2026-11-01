window.PAINEL_MODULES = window.PAINEL_MODULES || {};
window.PAINEL_MODULES.comprasViagensDialog = function () {
  return {
    viagemDialog: { open: false, target: '', name: '', notes: '', saving: false, error: '' },
    viagemNova(target) {
      this.viagemDialog = { open: true, target: target || '', name: '', notes: '', saving: false, error: '' };
    },
    viagemRenomear() {
      const group = this.viagemDetalhe?.group;
      if (group) this.viagemDialog = { open: true, target: 'rename', name: group.name,
        notes: group.notes || '', group_id: group.id, saving: false, error: '' };
    },
    viagemSelect(target) {
      const form = target === 'compra' ? this.compraForm : target === 'lote' ? this.lotPurchaseForm : this.despesaForm;
      if (form?.group_id === '__nova__') { form.group_id = ''; this.viagemNova(target); }
    },
    async viagemDialogSalvar() {
      const d = this.viagemDialog;
      if (d.saving) return;
      if (d.name.trim().length < 2) { d.error = 'Informe um nome para a viagem.'; return; }
      const rename = d.target === 'rename';
      const domain = rename ? 'purchase-group-rename' : 'purchase-group-create';
      const subject = rename ? d.group_id : 'dialog';
      const operation = window.PAINEL_INTEGRITY.operation(domain, subject);
      d.saving = true; d.error = '';
      try {
        const path = '/admin/api/wholesale/purchase-groups' + (rename ? '/' + d.group_id + '/action' : '');
        const group = await this.apiPost(path, { name: d.name.trim(), notes: d.notes.trim() || null,
          ...(rename ? { action: 'rename' } : {}), idempotency_key: operation.key });
        window.PAINEL_INTEGRITY.complete(domain, subject);
        const form = d.target === 'compra' ? this.compraForm : d.target === 'lote' ? this.lotPurchaseForm : d.target === 'despesa' ? this.despesaForm : null;
        if (form) form.group_id = group.id;
        d.open = false; await this.viagensLoad();
        if (rename) await this.viagemAbrir(group.id);
        else if (!form) await this.viagemAbrir(group.id);
      } catch (error) { d.error = this.viagemErro(error); }
      finally { d.saving = false; }
    },
  };
};
