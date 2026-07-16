// Obra 300 (2026-07-05): mezanino da portaria da matriz — operatorLabel/sendStatic/mapWriteError/dashboardPayload.
// VERBATIM das linhas 326-375 do route.ts pré-obra + prefixo 'export ' nas declarações
// de topo (transformação mecânica; o gerador prova a reversa). Porta: ./route.js.
import { readFile } from 'node:fs/promises';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { publicDir } from './route-schemas.js';
import { env } from '../../shared/config/env.js';
import path from 'node:path';
import { getAdminContext } from '../auth.js';

export function operatorLabel(request: FastifyRequest): string {
  const context = getAdminContext(request);
  if (context.authType === 'session') {
    return `${context.displayName} (${context.username ?? context.collaboratorId})`.slice(0, 120);
  }
  const raw = request.headers['x-operator-label'];
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
       'name_required', 'supplier_required', 'supplier_not_found', 'items_required',
       'measure_not_found', 'reason_required', 'min_invalid',
       'seller_collaborator_not_found'].includes(err.message)) {
    return { status: 400, error: err.message };
  }

  // Baixa manual (0128): 'baixa_maior_que_estoque:<qtd>' carrega o saldo real no código.
  if (err.message.startsWith('baixa_maior_que_estoque')) {
    return { status: 409, error: err.message };
  }

  if (err.message.includes('payroll_expense_locked')) {
    return { status: 409, error: 'payroll_expense_locked' };
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
