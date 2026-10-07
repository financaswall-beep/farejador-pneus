// Pessoas e pneus ilustrativos; usados exclusivamente pelo servidor local de prévia.
function pickupFixtures(scenario) {
  const item = (id, measure, brand) => ({ order_item_id: id, tire_size: measure, brand,
    quantity: 1, tire_condition: 'meia_vida', photo_request_id: id });
  const row = (id, number, name, face, items) => ({ order_id: id, order_number: 'Pedido #' + number,
    awaiting_pickup: true, customer_name: name, status: 'confirmed', payment_method: null,
    total_amount: 180, created_at: new Date().toISOString(), pickup_services: [], items,
    customer_avatar_url: '/_preview-assets/pickup-demo.webp#' + face });
  const a = item('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '90/90-18', 'Pirelli');
  const b = item('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '80/100-14', 'Levorin');
  const joao = row('11111111-1111-4111-8111-111111111111', 248, 'João Silva', 'joao', [a, b]);
  if (scenario === 'retirada-uma') return [{ ...joao, items: [a] }];
  if (scenario === 'retiradas') return [joao,
    row('22222222-2222-4222-8222-222222222222', 249, 'Carlos Souza', 'carlos', [item('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '100/90-18', 'Pirelli')]),
    row('33333333-3333-4333-8333-333333333333', 250, 'Ana Costa', 'ana', [item('dddddddd-dddd-4ddd-8ddd-dddddddddddd', '2.75-18', 'Pirelli')]),
  ];
  return ['avisos', 'retirada'].includes(scenario) ? [joao] : [];
}
const pickupPreviewCss = `<style>
  .pu-avatar img[src*="pickup-demo.webp"],.pu-tire-photo img { width:200%!important;height:200%!important;max-width:none;object-fit:fill!important; }
  .pu-avatar img[src$="#carlos"] { left:-100%; }
  .pu-avatar img[src$="#ana"] { top:-100%; }
  .pu-tire-photo img { top:-100%!important;left:-100%!important; }
</style>`;
module.exports = { pickupFixtures, pickupPreviewCss };
