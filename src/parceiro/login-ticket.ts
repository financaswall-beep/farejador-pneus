/**
 * Ticket do "escolhe a loja" — porta única de login (0095).
 *
 * Quando a pessoa tem MAIS de uma loja, o POST /api/login não emite sessão na
 * hora: devolve um TICKET de curta duração (2 min, uso único). O front mostra
 * as lojas e troca o ticket por uma sessão da loja escolhida em
 * POST /api/login/escolher. Assim a senha é digitada UMA vez e nenhuma sessão
 * nasce sem o usuário ter apontado a loja.
 *
 * Em memória, por instância (mesma decisão consciente do rate-limit.ts: o
 * Coolify roda 1 instância; restart no meio do fluxo = a pessoa refaz o login).
 * Guardado por sha256 do ticket — um dump de memória não entrega tickets vivos
 * em texto (paranoia barata, mesmo padrão do banco com tokens).
 */

import { randomBytes, createHash } from 'node:crypto';

const TICKET_PREFIX = 'lt_';
const TICKET_TTL_MS = 2 * 60 * 1000;
const SWEEP_THRESHOLD = 500;

export interface TicketStore {
  token_id: string;
  slug: string;
  store_name: string;
  role: string;
}

interface TicketData {
  environment: string;
  personId: string;
  stores: TicketStore[];
  expiresAt: number;
}

const tickets = new Map<string, TicketData>();

function hashTicket(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Emite um ticket de escolha de loja (texto devolvido UMA vez). */
export function newLoginTicket(environment: string, personId: string, stores: TicketStore[]): string {
  const token = TICKET_PREFIX + randomBytes(32).toString('hex');
  tickets.set(hashTicket(token), {
    environment,
    personId,
    stores,
    expiresAt: Date.now() + TICKET_TTL_MS,
  });
  maybeSweep();
  return token;
}

/**
 * Consome o ticket (USO ÚNICO: some do cofre mesmo se expirado/inválido).
 * null = não existe, já usado ou venceu.
 */
export function consumeLoginTicket(token: string): Omit<TicketData, 'expiresAt'> | null {
  if (!token.startsWith(TICKET_PREFIX)) return null;
  const key = hashTicket(token);
  const data = tickets.get(key);
  tickets.delete(key);
  if (!data || Date.now() >= data.expiresAt) return null;
  const { expiresAt: _expiresAt, ...rest } = data;
  return rest;
}

// Limpa vencidos quando o cofre cresce — evita vazamento de memória sob flood.
function maybeSweep(): void {
  if (tickets.size < SWEEP_THRESHOLD) return;
  const now = Date.now();
  for (const [k, v] of tickets) {
    if (now >= v.expiresAt) tickets.delete(k);
  }
}

// Só pra teste: zera o cofre entre casos.
export function __resetLoginTickets(): void {
  tickets.clear();
}
