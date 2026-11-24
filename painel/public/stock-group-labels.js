(function () {
  'use strict';

  const inspectionLabels = {
    located: 'Somente localização',
    pending: 'Aguardando inspeção',
    blocked: 'Bloqueado',
  };

  function kind(group) {
    if (group.origin_pending) return 'Origem a conferir';
    const physical = group.quantity_on_hand;
    if (physical === 0) return 'Sem unidades';
    if (group.inspection_status !== 'approved') {
      return inspectionLabels[group.inspection_status] || 'Inspeção não informada';
    }
    // A formação é do grupo inteiro. Reservas e quantidades por pilha são exibidas à parte.
    if (group.matched_set && physical >= 2) {
      return physical === 2 ? 'Par conferido' : 'Conjunto conferido';
    }
    return physical === 1 ? 'Avulso' : 'Avulsos';
  }

  window.StockGroupLabels = { kind };
}());
