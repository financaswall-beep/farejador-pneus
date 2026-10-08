// Somente prévia local: pessoas, endereço e valores fictícios.
const { pickupFixtures } = require('./prova-parceiro-retiradas-dados.cjs');
function deliveryFixtures(scenario) {
  if (!['avisos', 'entrega', 'entregas'].includes(scenario)) return [];
  return pickupFixtures('retiradas').map((row, index) => ({
    ...row, order_status: 'confirmed', awaiting_pickup: false,
    delivery_address: 'Rua Exemplo, 120\nMéier • Rio de Janeiro',
    delivery_status: index ? 'pending' : 'dispatched',
    delivery_courier: index === 1 ? null : 'João Meier',
    photo_request_id: row.items[0].photo_request_id,
  })).slice(0, scenario === 'avisos' ? 2 : 3);
}
module.exports = { deliveryFixtures };
