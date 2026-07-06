// Obra 300 (2026-07-05): mezanino da portaria da matriz — operatorLabel/sendStatic/mapWriteError/dashboardPayload.
// VERBATIM das linhas 326-375 do route.ts pré-obra + prefixo 'export ' nas declarações
// de topo (transformação mecânica; o gerador prova a reversa). Porta: ./route.js.
import { readFile } from 'node:fs/promises';
import type { FastifyReply } from 'fastify';
import { publicDir } from './route-schemas.js';
import { env } from '../../shared/config/env.js';
import path from 'node:path';

export function operatorLabel(headers: Record<string, unknown>): string {
  const raw = headers['x-operator-label'];
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return raw.trim().slice(0, 120);
  }
  return 'admin';
}

export async function sendStatic(reply: FastifyReply, file: string, type: string) {
  const content = await readFile(path.join(publicDir, file));
  return reply.header('Content-Type', type).send(content);
}

export function mapWriteError(err: unknown): { status: number; error: string } {
  if (!(err instanceof Error)) {
    return { status: 500, error: 'internal_server_error' };
  }

  if (err.message.includes('conversation_contact_not_found')) {
    return { status: 400, error: 'conversation_contact_not_found' };
  }

  if (
    err.message.includes('Pedido ja registrado') ||
    err.message.includes('duplicate key') ||
    err.message.includes('unique')
  ) {
    return { status: 409, error: 'already_registered' };
  }

  // Validações de escrita do galpão (atacado) — erro do usuário, não 500.
  if (['measure_not_in_catalog', 'measure_required', 'quantity_invalid', 'cost_invalid',
       'name_required', 'supplier_required', 'supplier_not_found', 'items_required'].includes(err.message)) {
    return { status: 400, error: err.message };
  }

  return { status: 500, error: 'internal_server_error' };
}

export function dashboardPayload(rows: unknown[]) {
  const chatwootBaseUrl = env.CHATWOOT_API_BASE_URL?.replace(/\/api\/v1\/?$/, '').replace(/\/$/, '') ?? null;
  return {
    environment: env.FAREJADOR_ENV,
    chatwoot_account_id: env.CHATWOOT_ACCOUNT_ID ?? null,
    chatwoot_base_url: chatwootBaseUrl,
    agent_v2_worker_enabled: env.AGENT_V2_WORKER_ENABLED,
    rows,
  };
}

