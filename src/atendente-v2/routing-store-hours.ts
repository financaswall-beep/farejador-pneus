import { AsyncLocalStorage } from 'node:async_hooks';
import type { PoolClient } from 'pg';
import type { Environment } from '../shared/types/chatwoot.js';
import { readWeeklyStoreHours, weeklyStoreHoursStatus, type WeeklyStoreHours } from '../shared/weekly-store-hours.js';
import { readDeliverySettings, type DeliverySettings } from './matriz-delivery-settings.js';

type StoreStatus = ReturnType<typeof weeklyStoreHoursStatus>;
interface CheckedStore { name: string; hours: WeeklyStoreHours | null; status: StoreStatus }
interface OpeningContext { environment: Environment; now?: Date; checked: Map<string, CheckedStore>; matrixLoaded: boolean }
const contexts = new AsyncLocalStorage<OpeningContext>();
const commercial = new Set(['buscar_produto','buscar_compatibilidade','calcular_frete','verificar_estoque','localizacao_loja','pedir_foto','criar_pedido']);
const context = () => contexts.getStore();
export const currentStoreOpeningTime=()=>context()?.now??new Date();
export const openingFilteringEnabled = () => Boolean(context());
export const openingStatusForStore = (id: string) => context()?.checked.get(id)?.status;
export const storeOpeningBlocked = () => Boolean(context()?.checked.size)
  && ![...(context()?.checked.values() ?? [])].some(store => store.status.state === 'open');
export function withStoreOpeningContext<T>(environment: Environment, run: () => Promise<T>, now?: Date): Promise<T> {
  const existing = context();
  if (existing) {
    if (existing.environment !== environment) throw new Error('store_hours_environment_mismatch');
    return run();
  }
  return contexts.run({ environment, now, checked: new Map(), matrixLoaded: false }, run);
}
function checkedStatus(id: string, name: string, hours: WeeklyStoreHours | null): StoreStatus {
  const state = context()!;
  const status = weeklyStoreHoursStatus(hours, state.now ?? new Date());
  state.checked.set(id, { name, hours, status });
  return status;
}
export async function filterOpeningCandidates<T extends { ctx: { unitId: string; unitName: string } }>(
  client: Pick<PoolClient,'query'>, environment: Environment, candidates: T[]): Promise<T[]> {
  const state = context();
  if (!state || !candidates.length) return candidates;
  if (state.environment !== environment) throw new Error('store_hours_environment_mismatch');
  const missing = candidates.filter(candidate => !state.checked.has(candidate.ctx.unitId));
  if (missing.length) {
    const rows = await client.query<{ unit_id: string; hours: unknown; name?: string }>(
      `SELECT pu.unit_id,to_jsonb(pu)->'opening_hours_weekly' hours,to_jsonb(pu)->>'display_name' name FROM network.partner_units pu
       WHERE pu.environment=$1 AND pu.unit_id=ANY($2::uuid[]) AND pu.deleted_at IS NULL`,
      [environment, missing.map(candidate => candidate.ctx.unitId)]);
    for (const candidate of missing) {
      const row=rows.rows.find(row=>row.unit_id===candidate.ctx.unitId);
      checkedStatus(candidate.ctx.unitId,candidate.ctx.unitName==='Loja'?(row?.name??'Loja'):candidate.ctx.unitName,readWeeklyStoreHours(row?.hours));
    }
  }
  return candidates.filter(candidate => {
    const saved = state.checked.get(candidate.ctx.unitId)!;
    return checkedStatus(candidate.ctx.unitId, saved.name, saved.hours).state === 'open';
  });
}
export async function partnerStoreIsOpen(client: Pick<PoolClient,'query'>, environment: Environment, unitId: string, name='Loja'): Promise<boolean> {
  if(context())await client.query('SELECT unit_id FROM network.partner_units WHERE environment=$1 AND unit_id=$2 AND deleted_at IS NULL FOR SHARE',[environment,unitId]);
  const previousName=context()?.checked.get(unitId)?.name;
  context()?.checked.delete(unitId); // horário pode ter sido editado desde a busca
  return (await filterOpeningCandidates(client, environment, [{ ctx: { unitId, unitName: previousName??name } }])).length > 0;
}
export function matrixStoreOpeningAllowed(settings: DeliverySettings | null): boolean {
  const state = context();
  if (!state) return true;
  state.matrixLoaded = true;
  return checkedStatus('matriz', 'Matriz', readWeeklyStoreHours(settings?.store_hours)).state === 'open';
}
/** Pedidos da Matriz são aceitos 24h se houver uma abertura conhecida. Fotos atuais continuam físicas. */
export function matrixStoreOrdersAllowed(settings:DeliverySettings|null):boolean {
  const state=context();if(!state)return true;
  state.matrixLoaded=true;
  const status=checkedStatus('matriz','Matriz',readWeeklyStoreHours(settings?.store_hours));
  return status.state==='open'||status.next_opening!==null;
}
export async function matrixStoreAcceptsOrders(client:Pick<PoolClient,'query'>,environment:Environment,refresh=false):Promise<boolean>{
  const state=context();if(!state)return true;
  if(state.environment!==environment)throw Error('store_hours_environment_mismatch');
  if(refresh)await client.query('SELECT environment FROM commerce.matriz_delivery_settings WHERE environment=$1 FOR SHARE',[environment]);
  return matrixStoreOrdersAllowed((await readDeliverySettings(client,environment))?.settings??null);
}
export async function matrixStoreIsOpen(client: Pick<PoolClient,'query'>, environment: Environment, refresh=false): Promise<boolean> {
  const state = context();
  if (!state) return true;
  if (state.environment !== environment) throw new Error('store_hours_environment_mismatch');
  if(refresh)await client.query('SELECT environment FROM commerce.matriz_delivery_settings WHERE environment=$1 FOR SHARE',[environment]);
  const previous = state.checked.get('matriz');
  if (!refresh && state.matrixLoaded && previous) return checkedStatus('matriz','Matriz',previous.hours).state === 'open';
  return matrixStoreOpeningAllowed((await readDeliverySettings(client as PoolClient,environment))?.settings ?? null);
}
/** Última defesa antes de inserir foto/pedido; também cobre escolhas por flags antigas. */
export async function selectedStoreIsOpen(client: Pick<PoolClient,'query'>, environment: Environment, unitId: string): Promise<boolean> {
  if (!context()) return true;
  const unit = await client.query<{ slug: string }>('SELECT slug FROM core.units WHERE environment=$1 AND id=$2',[environment,unitId]);
  return unit.rows[0]?.slug === 'main' ? matrixStoreIsOpen(client,environment,true) : partnerStoreIsOpen(client,environment,unitId);
}
export function storeOpeningBlockResponse(): Record<string,unknown> {
  const checked = [...(context()?.checked.entries() ?? [])];
  const blocked = checked.filter(([,store]) => store.status.state !== 'open');
  const unknown = blocked.some(([,store]) => store.status.state === 'unknown');
  const next = blocked.filter(([,store]) => store.status.next_opening).sort((a,b) => {
    const score = (store: CheckedStore) => store.status.next_opening!.days_ahead * 1440
      + Number(store.status.next_opening!.opens_at.slice(0,2)) * 60 + Number(store.status.next_opening!.opens_at.slice(3));
    return score(a[1]) - score(b[1]);
  })[0];
  const opening = next ? { unit_id: next[0], nome_loja: next[1].name, ...next[1].status.next_opening,
    texto: next[1].status.text, time_zone: 'America/Sao_Paulo' } : null;
  return { encontrado: false, disponivel: false, erro: unknown ? 'horario_nao_confirmado' : 'lojas_fechadas',
    atendimento_agora: false, proxima_abertura: opening,
    lojas: blocked.map(([unit_id,store]) => ({ unit_id,nome_loja:store.name,status:store.status })),
    mensagem: unknown ? 'Não consegui confirmar uma loja aberta agora. Há horário de loja ainda não cadastrado.'
      : opening ? `Não encontrei atendimento disponível agora. ${opening.nome_loja}: ${opening.texto}`
        : 'Não encontrei atendimento disponível agora nem próxima abertura cadastrada.',
    orientacao: 'O bot continua atendendo 24 horas. Não prometa atendimento presencial imediato, estoque confirmado, foto nova da equipe ou pedido fechado. Fotos de referência já cadastradas na Matriz podem ser consultadas com pedir_foto e loja=matriz, inclusive fora do expediente. Informe a próxima abertura da loja retornada. Só após aceitar deixar uma solicitação com a equipe use escalar_humano. Horário desconhecido exige confirmação, sem inventar. Não agende entrega nem reserve estoque por conta própria.' };
}
function hasProductAvailability(data: Record<string,unknown>): boolean {
  const products = Array.isArray(data.produtos) ? [...data.produtos] : [];
  if (Array.isArray(data.veiculos)) for (const vehicle of data.veiculos) products.push(...(vehicle.produtos ?? []));
  return products.some(product => Number(product.total_stock_available ?? product.total_stock ?? 0) > 0);
}
function hasQueuedCatalogPhoto(data:Record<string,unknown>):boolean {
  const queued=(row:Record<string,unknown>)=>row.origem==='galeria_matriz' && row.tipo==='referencia'
    && ['foto_enfileirada','foto_ja_enfileirada'].includes(String(row.status));
  return queued(data)||(Array.isArray(data.solicitacoes)&&data.solicitacoes.some(row=>row&&typeof row==='object'&&queued(row)));
}
export async function withStoreOpeningScope(client: PoolClient, environment: Environment, name: string,
  run: () => Promise<string>, now?: Date): Promise<string> {
  if (!commercial.has(name)) return run();
  return withStoreOpeningContext(environment, async () => {
    const raw = await run(), data = JSON.parse(raw) as Record<string,unknown>, state = context()!;
    // A imagem cadastrada já foi enfileirada; não depende de alguém presente na loja.
    if(name==='pedir_foto' && hasQueuedCatalogPhoto(data))return raw;
    // Pedidos existentes continuam consultáveis mesmo depois que a loja fechou.
    if (data.ok === true || data.repetido || data.precisa_localizacao || data.precisa_municipio) return raw;
    if(data.erro && !['store_closed','store_hours_unknown','insufficient_stock'].includes(String(data.erro)))return raw;
    const openPartners = [...state.checked.entries()].some(([id,store]) => id !== 'matriz' && store.status.state === 'open');
    if ((!openPartners && hasProductAvailability(data)) || (name === 'calcular_frete' && data.disponivel && !openPartners)) {
      await matrixStoreIsOpen(client,environment);
    }
    const explicitBlock = data.erro === 'store_closed' || data.erro === 'store_hours_unknown';
    const matrix=state.checked.get('matriz'),deferredMatrix=name!=='pedir_foto'&&matrix?.status.state==='closed'&&matrix.status.next_opening;
    if (explicitBlock || (state.checked.size && !deferredMatrix && ![...state.checked.values()].some(store => store.status.state === 'open'))) {
      const blocked=storeOpeningBlockResponse();
      // Preserva os dados de catálogo para o atendimento 24h, sem prometer atendimento físico.
      if(['buscar_produto','buscar_compatibilidade','verificar_estoque'].includes(name) && !data.erro) {
        return JSON.stringify({...data,atendimento_agora:false,atendimento_presencial:blocked,
          orientacao:'Continue a consulta de catálogo e preços. Loja fechada não significa falta de estoque: a disponibilidade local pode não estar confirmada. Não prometa retirada, entrega ou reserva imediata. Para foto de referência da Matriz use pedir_foto com loja=matriz; a galeria funciona 24 horas.'});
      }
      return JSON.stringify(blocked);
    }
    if(deferredMatrix)return JSON.stringify({...data,pedidos_24h_matriz:true,
      atendimento_matriz:{atendimento_agora:false,proxima_abertura:matrix!.status},
      orientacao_matriz:'A Matriz aceita pedido e reserva 24h com estoque disponível. Retirada/entrega só após a próxima abertura. Siga o horário retornado por criar_pedido, sem prometer atendimento imediato ou foto atual. Não aplique esta regra aos parceiros.'});
    return raw;
  }, now);
}
