import type { Pool } from 'pg';
import { partnerPool, withPartnerContext } from './db.js';
import type { PartnerContext } from './auth.js';
import { partnerActor } from './actor.js';
import { readWeeklyStoreHours, weeklyStoreHoursStatus, weeklyStoreHoursText, type WeeklyStoreHours } from '../shared/weekly-store-hours.js';

export async function getPartnerStoreHours(ctx: PartnerContext, db: Pool = partnerPool) {
  return withPartnerContext(ctx.partnerUnitId, async client => {
  const result = await client.query<{ hours: unknown; legacy_text: string | null; schema_ready: boolean }>(
    `SELECT to_jsonb(pu)->'opening_hours_weekly' hours,pu.opening_hours_text legacy_text,
       EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='network.partner_units'::regclass
         AND attname='opening_hours_weekly' AND NOT attisdropped) schema_ready
     FROM network.partner_units pu WHERE pu.id=$1 AND pu.environment=$2 AND pu.deleted_at IS NULL`,
    [ctx.partnerUnitId, ctx.environment]);
  const row = result.rows[0];
  if (!row) return null;
  const hours = readWeeklyStoreHours(row.hours);
  return { hours, legacy_text: row.legacy_text, schema_ready: row.schema_ready, status: weeklyStoreHoursStatus(hours) };
  }, db);
}

export async function savePartnerStoreHours(ctx: PartnerContext, hours: WeeklyStoreHours, db: Pool = partnerPool) {
  return withPartnerContext(ctx.partnerUnitId, async client => {
    const before = await client.query(
      `SELECT opening_hours_weekly,opening_hours_text FROM network.partner_units
       WHERE id=$1 AND environment=$2 AND deleted_at IS NULL FOR UPDATE`, [ctx.partnerUnitId, ctx.environment]);
    if (!before.rowCount) return null;
    const sorted = [...hours].sort((a, b) => a.day - b.day);
    const text = weeklyStoreHoursText(sorted);
    await client.query(`UPDATE network.partner_units SET opening_hours_weekly=$3::jsonb,opening_hours_text=$4
      WHERE id=$1 AND environment=$2 AND deleted_at IS NULL`, [ctx.partnerUnitId, ctx.environment, JSON.stringify(sorted), text]);
    await client.query(`INSERT INTO audit.events(environment,domain,entity_table,entity_id,event_type,actor_label,payload_before,payload_after)
      VALUES($1,'partner_config','network.partner_units',$2,'partner_store_hours_updated',$3,$4::jsonb,$5::jsonb)`,
    [ctx.environment, ctx.partnerUnitId, partnerActor(ctx), JSON.stringify(before.rows[0]),
      JSON.stringify({ opening_hours_weekly: sorted, opening_hours_text: text })]);
    return { hours: sorted, legacy_text: text, schema_ready: true, status: weeklyStoreHoursStatus(sorted) };
  }, db);
}
