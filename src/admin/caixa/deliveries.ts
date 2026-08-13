import { env } from '../../shared/config/env.js';
import {
  getEntregadorRota,
  type EntregadorAuth,
  type EntregadorDeliveryCard,
} from '../entregador/queries.js';
import type { CaixaAuth } from './queries.js';

export interface CaixaDeliveryRow {
  order_id: string;
  customer_name: string | null;
  customer_phone: string | null;
  delivery_address: string | null;
  delivery_status: 'pending' | 'dispatched' | 'delivered' | 'failed';
  delivery_courier: string | null;
  payment_method: string | null;
  total_amount: number;
  photo_request_id: string | null;
  in_route: boolean;
  items: Array<{ quantity: number; label: string; tire_condition: null }>;
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
  const routeRows = rota.rota_aberta?.entregas.map(
    (row) => mapDelivery(row, auth, true),
  ) ?? [];
  const queueRows = rota.fila.map((row) => mapDelivery(row, auth, false));
  const unresolved = routeRows.filter(
    (row) => row.delivery_status === 'pending' || row.delivery_status === 'dispatched',
  ).length;

  return {
    rows: [...routeRows, ...queueRows],
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
    } : null,
  };
}

export { courierAuth as caixaCourierAuth };
