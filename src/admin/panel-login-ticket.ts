import { createHash, randomBytes } from 'node:crypto';
import type { OperationWorkplace } from './caixa/operation-auth.js';

const PREFIX = 'pt_';
const TTL_MS = 2 * 60 * 1000;
const tickets = new Map<string, PanelLoginTicket>();

interface PanelLoginTicket {
  environment: string;
  personId: string;
  username: string;
  workplaces: OperationWorkplace[];
  expiresAt: number;
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function newPanelLoginTicket(
  environment: string,
  personId: string,
  username: string,
  workplaces: OperationWorkplace[],
): string {
  const token = PREFIX + randomBytes(32).toString('hex');
  const now = Date.now();
  tickets.set(hash(token), { environment, personId, username, workplaces, expiresAt: now + TTL_MS });
  if (tickets.size >= 500) {
    for (const [key, value] of tickets) if (now >= value.expiresAt) tickets.delete(key);
  }
  return token;
}

export function consumePanelLoginTicket(
  token: string,
): Omit<PanelLoginTicket, 'expiresAt'> | null {
  if (!token.startsWith(PREFIX)) return null;
  const key = hash(token);
  const data = tickets.get(key);
  tickets.delete(key);
  if (!data || Date.now() >= data.expiresAt) return null;
  const { expiresAt: _expiresAt, ...publicData } = data;
  return publicData;
}

export function __resetPanelLoginTickets(): void {
  tickets.clear();
}
