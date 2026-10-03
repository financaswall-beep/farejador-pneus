import type { PoolClient } from 'pg';
import { env } from '../../shared/config/env.js';
import { pendingCommissionFacts, lockCommissionSources, type CommissionFact } from './commission-batch.js';
import { closeWeeklyCommissionBucket } from './weekly-commission-close.js';

function localDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}
function addDays(value: string, count: number) {
  const date = new Date(value + 'T12:00:00Z');
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

export async function closeMatrizWeeklyCommissions(
  db: PoolClient, now = new Date(),
): Promise<{ periods_created: number }> {
  const today = localDate(now), environment = env.FAREJADOR_ENV;
  const candidates = await pendingCommissionFacts(db, environment, today, 'weekly');
  await lockCommissionSources(db, environment, candidates);
  await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`matriz-weekly-commission:${environment}`]);
  const keys = new Set(candidates.map(f => f.fact_key));
  const facts = (await pendingCommissionFacts(db, environment, today, 'weekly')).filter(f => keys.has(f.fact_key));
  const closed = await db.query<{ collaborator_id: string; period_start: string }>(
    `SELECT collaborator_id,period_start::text FROM finance.matriz_commission_periods WHERE environment=$1`, [environment]);
  const existing = new Set(closed.rows.map(r => `${r.collaborator_id}:${r.period_start}`));
  const buckets = new Map<string, { collaborator: string; start: string; end: string; facts: CommissionFact[] }>();
  for (const fact of facts) {
    const day = localDate(new Date(fact.occurred_at));
    let start = addDays(day, -new Date(day + 'T12:00:00Z').getUTCDay());
    while (existing.has(`${fact.collaborator_id}:${start}`)) start = addDays(start, 7);
    const end = addDays(start, 6);
    if (end >= today) continue;
    const key = `${fact.collaborator_id}:${start}`;
    const bucket = buckets.get(key) ?? { collaborator: fact.collaborator_id, start, end, facts: [] };
    bucket.facts.push(fact);
    buckets.set(key, bucket);
  }
  let created = 0;
  for (const bucket of [...buckets.values()].sort((a, b) => a.start.localeCompare(b.start)
    || a.collaborator.localeCompare(b.collaborator))) {
    if (bucket.facts.some(f => f.commission_basis === 'margin' && f.items_without_cost > 0)) continue;
    await closeWeeklyCommissionBucket(db, environment, bucket.collaborator, bucket.start, bucket.end, bucket.facts, now);
    created++;
  }
  return { periods_created: created };
}
