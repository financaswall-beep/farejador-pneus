import { createHash, randomBytes } from 'node:crypto';
import type { PartnerContext } from './auth.js';

const PREFIX = 'st_';
const TTL_MS = 60_000;

interface TicketEntry {
  context: PartnerContext;
  expiresAt: number;
}

const tickets = new Map<string, TicketEntry>();

function hashTicket(ticket: string): string {
  return createHash('sha256').update(ticket, 'utf8').digest('hex');
}

export function mintPartnerSseTicket(context: PartnerContext): { ticket: string; expiresInSeconds: number } {
  const ticket = PREFIX + randomBytes(32).toString('hex');
  tickets.set(hashTicket(ticket), { context: { ...context }, expiresAt: Date.now() + TTL_MS });
  sweepExpired();
  return { ticket, expiresInSeconds: TTL_MS / 1000 };
}

/** Consome primeiro: ticket e de uso unico inclusive quando slug/validade falham. */
export function consumePartnerSseTicket(ticket: string, slug: string): PartnerContext | null {
  if (!/^st_[a-f0-9]{64}$/.test(ticket)) return null;
  const key = hashTicket(ticket);
  const entry = tickets.get(key);
  tickets.delete(key);
  if (!entry || entry.expiresAt <= Date.now() || entry.context.slug !== slug) return null;
  return { ...entry.context };
}

function sweepExpired(): void {
  if (tickets.size < 1000) return;
  const now = Date.now();
  for (const [key, entry] of tickets) {
    if (entry.expiresAt <= now) tickets.delete(key);
  }
}

export function __resetPartnerSseTickets(): void {
  tickets.clear();
}
