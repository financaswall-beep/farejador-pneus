(function () {
  'use strict';
  const C = window.Caixa;
  let loading = false;
  let generation = 0;
  async function refresh() {
    if (loading || !C.isPartner() || !C.token() || !C.canModule('estoque')) return;
    const current = ++generation;
    const session = C.sessionFingerprint();
    loading = true; render();
    await Promise.allSettled([C.partnerData.load(), C.partnerBuy.load()]);
    if (current !== generation || session !== C.sessionFingerprint()) return;
    loading = false;
    if (C.partnerHome.currentTab() === 'partner-replenishment') render();
  }
  function render() { C.partnerBuy.render('replenishment'); }
  function reset() { ++generation; loading = false; }
  C.partnerReplenishment = { render, refresh, reset, loading: () => loading };
}());
