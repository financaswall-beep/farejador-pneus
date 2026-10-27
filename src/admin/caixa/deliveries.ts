import { env } from '../../shared/config/env.js';
import {
  getEntregadorRota,
  type EntregadorAuth,
  type EntregadorDeliveryCard,
} from '../entregador/queries.js';
import type { CaixaAuth } from './queries.js';
import { getCaixaDeliveryReceipts } from './delivery-receipts.js';
import { getDeliveryPresentation, type DeliveryPresentation } from './delivery-presentation.js';

export interface CaixaDeliveryRow {
  order_id: string;
  order_number: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  delivery_address: string | null;
  delivery_status: 'pending' | 'dispatched' | 'delivered' | 'failed';
  delivery_courier: string | null;
  payment_method: string | null;
  total_amount: number;
  photo_request_id: string | null;
  in_route: boolean;
  has_customer_avatar?: boolean;
  delivery_failure_reason?: string | null;
  items: DeliveryPresentation['items'] | Array<{ quantity: number; label: string; tire_condition: null }>;
}

function courierAuth(auth: CaixaAuth): EntregadorAuth {
  return {
    personId: auth.personId,
    collaboratorId: auth.collaboratorId,
    displayName: auth.displayName,
  };
}

function mapDelivery(
  row: EntregadorDeliveryCard,
  auth: CaixaAuth,
  inRoute: boolean,
): CaixaDeliveryRow {
  return {
    order_id: row.order_id,
    order_number: row.order_number || null,
    customer_name: row.customer_name,
    customer_phone: row.customer_phone,
    delivery_address: row.delivery_address,
    delivery_status: row.delivery_status,
    delivery_courier: inRoute ? auth.displayName : null,
    payment_method: row.payment_method,
    total_amount: Number(row.cobrar),
    photo_request_id: row.photo_request_id,
    in_route: inRoute,
    items: row.items.map((item) => ({ ...item, tire_condition: null })),
  };
}

/**
 * Adapta a logística existente da Matriz ao contrato visual de /operacao.
 * A seleção, posse e todas as escritas continuam nas queries do entregador.
 */
export async function getCaixaDeliveries(auth: CaixaAuth) {
  const rota = await getEntregadorRota(courierAuth(auth), env.FAREJADOR_ENV);
  const receipts = rota.rota_aberta
    ? await getCaixaDeliveryReceipts(auth, rota.rota_aberta.trip_id, env.FAREJADOR_ENV) : [];
  const routeRows = rota.rota_aberta?.entregas.map(
    (row) => mapDelivery(row, auth, true),
  ) ?? [];
  const queueRows = rota.fila.map((row) => mapDelivery(row, auth, false));
  const rows = [...routeRows, ...queueRows];
  const presentation = await getDeliveryPresentation(auth, rows.map(row => row.order_id));
  for (const row of rows) {
    const extra = presentation.get(row.order_id);
    if (extra) Object.assign(row, { items: extra.items, delivery_failure_reason: extra.delivery_failure_reason,
      has_customer_avatar: Boolean(extra.conversation_id) });
  }
  const unresolved = routeRows.filter(
    (row) => row.delivery_status === 'pending' || row.delivery_status === 'dispatched',
  ).length;

  return {
    rows,
    summary: {
      preparing: queueRows.length,
      dispatched: unresolved,
      delivered: routeRows.filter((row) => row.delivery_status === 'delivered').length,
    },
    matrix_route: rota.rota_aberta ? {
      trip_id: rota.rota_aberta.trip_id,
      trip_number: rota.rota_aberta.trip_number,
      km_start: rota.rota_aberta.km_start,
      started_at: rota.rota_aberta.started_at,
      total: routeRows.length,
      completed: routeRows.filter((row) => row.delivery_status === 'delivered').length,
      unresolved,
      reported: routeRows.filter((row) => row.delivery_status === 'failed').length,
      receipts,
    } : null,
  };
}

export { courierAuth as caixaCourierAuth };
