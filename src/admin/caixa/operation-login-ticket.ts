import { createHash, randomBytes } from 'node:crypto';
import type { OperationWorkplace } from './operation-auth.js';

const TICKET_PREFIX = 'ot_';
const TICKET_TTL_MS = 2 * 60 * 1000;
const SWEEP_THRESHOLD = 500;

interface OperationTicketData {
  environment: string;
  personId: string;
  username: string;
  workplaces: OperationWorkplace[];
  expiresAt: number;
}

const tickets = new Map<string, OperationTicketData>();

function hashTicket(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function newOperationLoginTicket(
  environment: string,
  personId: string,
  username: string,
  workplaces: OperationWorkplace[],
): string {
  const token = TICKET_PREFIX + randomBytes(32).toString('hex');
  tickets.set(hashTicket(token), {
    environment,
    personId,
    username,
    workplaces,
    expiresAt: Date.now() + TICKET_TTL_MS,
  });
  if (tickets.size >= SWEEP_THRESHOLD) {
    const now = Date.now();
    for (const [key, value] of tickets) {
      if (now >= value.expiresAt) tickets.delete(key);
    }
  }
  return token;
}

/** Uso único: a tentativa consome o ticket inclusive quando já venceu. */
export function consumeOperationLoginTicket(
  token: string,
): Omit<OperationTicketData, 'expiresAt'> | null {
  if (!token.startsWith(TICKET_PREFIX)) return null;
  const key = hashTicket(token);
  const data = tickets.get(key);
  tickets.delete(key);
  if (!data || Date.now() >= data.expiresAt) return null;
  const { expiresAt: _expiresAt, ...rest } = data;
  return rest;
}

export function __resetOperationLoginTickets(): void {
  tickets.clear();
}
