import type { buildPurchaseReport } from './queries-purchase-report.js';
import { salesReportCsvCell } from './route-sales-report.js';

const amount = (value: number | null) => value === null ? '' : value.toFixed(2).replace('.', ',');
const condition = (value: string) => ({ novo: 'Novo', meia_vida: 'Meia-vida', remold: 'Remold' })[value] ?? 'Sem condição registrada';
export function purchaseReportCsv(report: ReturnType<typeof buildPurchaseReport>): string {
  const { view } = report.filters, payments = report.can_view_payments;
  let columns: string[], rows: unknown[][];
  if (view === 'suppliers') {
    columns = ['Fornecedor', 'Compras', 'Pneus do recorte', 'Valor do recorte', 'Recebidos', 'Em trânsito', 'Última compra'];
    rows = report.suppliers.map(row => [row.name, row.purchases, row.quantity, amount(row.value), row.received, row.transit, row.last_purchase]);
    if (payments) {
      columns.push('Valor integral das compras', 'Pago das compras inteiras', 'Em aberto das compras inteiras');
      report.suppliers.forEach((row, index) => rows[index]!.push(amount(row.full_total), amount(row.paid), amount(row.open)));
    }
  } else if (view === 'purchases') {
    columns = ['Compra ID', 'Ordem de compra', 'Data (São Paulo)', 'Fornecedor', 'Recebimento', 'Recebida em', 'Pneus do recorte', 'Valor do recorte'];
    rows = report.export_purchases.map(row => [row.id, row.order_code, row.day, row.supplier_name,
      row.status === 'confirmed' ? 'Recebida' : 'Em trânsito', row.received_on, row.quantity, amount(row.value)]);
    if (payments) {
      columns.push('Valor integral da compra', 'Pago da compra inteira', 'Em aberto da compra inteira');
      report.export_purchases.forEach((row, index) => rows[index]!.push(amount(row.full_total), amount(row.paid), amount(row.open)));
    }
  } else {
    columns = ['Medida', 'Marca', 'Condição', 'Quantidade do recorte', 'Recebidos', 'Em trânsito', 'Valor com rateio', 'Custo médio', 'Custo médio anterior', 'Variação percentual', 'Fornecedores'];
    rows = report.products.map(row => [row.measure, row.brand, condition(row.condition), row.quantity, row.received, row.transit,
      amount(row.value), amount(row.average_cost), amount(row.previous_average), amount(row.change_pct), row.suppliers]);
  }
  return '\uFEFF' + [columns, ...rows].map(row => row.map(salesReportCsvCell).join(';')).join('\r\n');
}
