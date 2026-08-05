import { createHash, randomBytes } from 'node:crypto';

const PREFIX = 'ct_';
const TTL_MS = 60_000;

interface CaixaSseContext {
  unitId: string;
  subject: string;
}

const tickets = new Map<string, { context: CaixaSseContext; expiresAt: number }>();

function hashTicket(ticket: string): string {
  return createHash('sha256').update(ticket, 'utf8').digest('hex');
}

export function mintCaixaSseTicket(context: CaixaSseContext): { ticket: string; expiresInSeconds: number } {
  const ticket = PREFIX + randomBytes(32).toString('hex');
  tickets.set(hashTicket(ticket), { context: { ...context }, expiresAt: Date.now() + TTL_MS });
  if (tickets.size >= 1000) sweepExpired();
  return { ticket, expiresInSeconds: TTL_MS / 1000 };
}

/** Ticket opaco, de uso único e sem sessão na URL. */
export function consumeCaixaSseTicket(ticket: string): CaixaSseContext | null {
  if (!/^ct_[a-f0-9]{64}$/.test(ticket)) return null;
  const key = hashTicket(ticket);
  const entry = tickets.get(key);
  tickets.delete(key);
  if (!entry || entry.expiresAt <= Date.now()) return null;
  return { ...entry.context };
}

function sweepExpired(): void {
  const now = Date.now();
  for (const [key, entry] of tickets) {
    if (entry.expiresAt <= now) tickets.delete(key);
  }
}

export function __resetCaixaSseTickets(): void {
  tickets.clear();
}
