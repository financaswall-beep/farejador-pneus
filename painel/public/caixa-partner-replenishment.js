(function () {
  'use strict';
  const C = window.Caixa;
  const U = C.partnerUI;
  let loading = false;
  let generation = 0;
  async function refresh() {
    if (loading) return;
    const current = ++generation;
    loading = true; render();
    await C.partnerData.load();
    if (current !== generation) return;
    loading = false;
    if (C.partnerHome.currentTab() === 'partner-replenishment') render();
  }
  function render() {
    const page = U.section('Na 2W', () => C.partnerHome.open('partner-home'));
    const D = C.partnerData.state;
    if (loading) page.appendChild(U.node('p', 'Conferindo disponibilidade…', 'ps-copy'));
    else if (D.errors.includes('replenishment')) {
      page.append(U.node('p', 'Não consegui atualizar a 2W.', 'ps-copy'), U.button('TENTAR DE NOVO', refresh));
    } else if (!D.replenishment || !D.offers.length) {
      page.appendChild(U.node('p', 'Nenhuma oportunidade de reposição agora.', 'ps-copy'));
    } else {
      page.append(U.node('strong', D.replenishment.measure, 'ps-size'),
        U.node('p', 'Disponíveis para repor sua loja', 'ps-copy'));
      D.offers.forEach(offer => {
        const item = U.node('article', null, 'ps-item');
        item.append(U.node('strong', U.condition(offer.tire_condition)),
          U.node('p', offer.brand), U.node('b', offer.quantity_available + ' disponíveis'));
        page.appendChild(item);
      });
      page.appendChild(U.node('p', 'Disponibilidade atual. Preço e compra com a 2W.', 'ps-copy'));
    }
    if (!loading && !D.errors.includes('replenishment')) page.appendChild(U.button('ATUALIZAR', refresh, 'secondary'));
    U.mount(page, 'replenishment');
  }
  function reset() { ++generation; loading = false; }
  C.partnerReplenishment = { render, refresh, reset };
}());
