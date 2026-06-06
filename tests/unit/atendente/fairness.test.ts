import { describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import {
  DEFAULT_FAIRNESS_PARAMS,
  rankCandidatesByFairness,
  rankUnitsByFairnessFromDb,
  type FairnessCandidate,
  type FairnessParams,
} from '../../../src/atendente-v2/fairness.js';

interface QueryCall {
  text: string;
  values: unknown[];
}

function clientWithRows(rowSets: unknown[][]): PoolClient & { calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  return {
    calls,
    async query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      return { rows: rowSets.shift() ?? [] };
    },
  } as unknown as PoolClient & { calls: QueryCall[] };
}

const NOW = new Date('2026-06-06T12:00:00Z');
const DAY = 86_400_000;
/** Veterano: criado antes da janela de 7d (não recebe semente). */
const VETERAN_CREATED = new Date(NOW.getTime() - 90 * DAY);
/** Novato: criado dentro da janela. */
const NEWCOMER_CREATED = new Date(NOW.getTime() - 1 * DAY);

function params(overrides: Partial<Omit<FairnessParams, 'now'>> = {}): FairnessParams {
  return { now: NOW, ...DEFAULT_FAIRNESS_PARAMS, ...overrides };
}

function vet(unitId: string, leadCount: number, lastLeadAt: Date | null = null): FairnessCandidate {
  return { unitId, leadCount, lastLeadAt, unitCreatedAt: VETERAN_CREATED };
}

const order = (cs: FairnessCandidate[], p = params()) =>
  rankCandidatesByFairness(cs, p).map((c) => c.unitId);

describe('rankCandidatesByFairness', () => {
  it('lista vazia → vazia; um candidato → ele mesmo', () => {
    expect(rankCandidatesByFairness([], params())).toEqual([]);
    expect(order([vet('A', 5)])).toEqual(['A']);
  });

  it('quem recebeu MENOS leads vai primeiro', () => {
    expect(order([vet('A', 3), vet('B', 1), vet('C', 7)])).toEqual(['B', 'A', 'C']);
  });

  it('dois iguais same-city alternam: o que acabou de receber cai pro fim', () => {
    // Estado inicial empatado (0/0) → desempate por unitId.
    expect(order([vet('A', 0), vet('B', 0)])).toEqual(['A', 'B']);
    // A recebeu 1 lead → agora B (que recebeu menos) vai primeiro.
    expect(order([vet('A', 1), vet('B', 0)])).toEqual(['B', 'A']);
    // B empata em 1 → volta pro desempate determinístico.
    expect(order([vet('A', 1), vet('B', 1)])).toEqual(['A', 'B']);
  });

  it('NÃO domina: novato com 0 leads NÃO varre tudo — entra semeado na mediana', () => {
    // Sem semente, o novato (0) seria sempre o 1º. Com semente = mediana(10) ele
    // empata com os veteranos e disputa por desempate, em vez de afogá-los.
    const veterans = [vet('A', 10, new Date(NOW.getTime() - 2 * DAY)), vet('B', 10, new Date(NOW.getTime() - 2 * DAY))];
    const newcomer: FairnessCandidate = { unitId: 'N', leadCount: 0, lastLeadAt: null, unitCreatedAt: NEWCOMER_CREATED };
    const ranked = rankCandidatesByFairness([...veterans, newcomer], params());
    const n = ranked.find((c) => c.unitId === 'N')!;
    expect(n.isNewcomer).toBe(true);
    expect(n.credit).toBe(10); // seed(mediana=10) + 0
    // anti-seca: o novato nunca recebeu (lastLeadAt null) → ganha o desempate sobre
    // os veteranos de crédito igual, mas NÃO porque entrou em 0.
    expect(ranked.map((c) => c.unitId)).toEqual(['N', 'A', 'B']);
  });

  it('NÃO é esquecido: novato cai no MEIO da fila, não no fim', () => {
    // Veteranos 2 e 4 → mediana 3. Novato semeado em 3 fica entre eles.
    const ranked = rankCandidatesByFairness(
      [vet('A', 2), vet('C', 4), { unitId: 'N', leadCount: 0, lastLeadAt: null, unitCreatedAt: NEWCOMER_CREATED }],
      params(),
    );
    expect(ranked.find((c) => c.unitId === 'N')!.credit).toBe(3);
    expect(ranked.map((c) => c.unitId)).toEqual(['A', 'N', 'C']); // 2 < 3 < 4
  });

  it('rede fria (todos veteranos em 0): novato disputa igual (semente 0)', () => {
    const ranked = rankCandidatesByFairness(
      [vet('A', 0), { unitId: 'N', leadCount: 0, lastLeadAt: null, unitCreatedAt: NEWCOMER_CREATED }],
      params(),
    );
    expect(ranked.find((c) => c.unitId === 'N')!.credit).toBe(0);
  });

  it('TETO da semente limita mediana distorcida (seedCapFactor)', () => {
    // Veteranos 2 e 100 → mediana 51. Com teto 0.1×max(=10), a semente cai pra 10.
    const ranked = rankCandidatesByFairness(
      [vet('A', 2), vet('C', 100), { unitId: 'N', leadCount: 0, lastLeadAt: null, unitCreatedAt: NEWCOMER_CREATED }],
      params({ seedCapFactor: 0.1 }),
    );
    expect(ranked.find((c) => c.unitId === 'N')!.credit).toBe(10);
  });

  it('anti-seca: crédito igual → quem recebeu há mais tempo vai primeiro', () => {
    const older = vet('A', 5, new Date(NOW.getTime() - 6 * DAY));
    const recent = vet('B', 5, new Date(NOW.getTime() - 1 * DAY));
    expect(order([recent, older])).toEqual(['A', 'B']); // A recebeu há mais tempo
  });

  it('determinístico: mesma entrada → mesma ordem (sem random/relógio interno)', () => {
    const cs = [vet('A', 3), vet('B', 3, new Date(NOW.getTime() - 2 * DAY)), vet('C', 1)];
    expect(order(cs)).toEqual(order(cs));
    // C(1) primeiro; entre A e B (3 cada), A nunca recebeu (null) → NULLS FIRST → A antes de B.
    expect(order(cs)).toEqual(['C', 'A', 'B']);
  });

  it('não muta a lista de entrada', () => {
    const cs = [vet('A', 5), vet('B', 1)];
    const snapshot = cs.map((c) => c.unitId);
    rankCandidatesByFairness(cs, params());
    expect(cs.map((c) => c.unitId)).toEqual(snapshot);
  });
});

describe('rankUnitsByFairnessFromDb (fonte de contagem)', () => {
  it('<= 1 candidato: devolve como veio, sem tocar o banco', async () => {
    const client = clientWithRows([]);
    expect(await rankUnitsByFairnessFromDb(client, 'test', [])).toEqual([]);
    expect(await rankUnitsByFairnessFromDb(client, 'test', ['u1'])).toEqual(['u1']);
    expect(client.calls).toHaveLength(0);
  });

  it('conta leads e ordena: quem recebeu menos vai primeiro (count string → number)', async () => {
    const client = clientWithRows([
      [
        { unit_id: 'A', unit_created_at: VETERAN_CREATED, lead_count: '5', last_lead_at: new Date(NOW.getTime() - DAY) },
        { unit_id: 'B', unit_created_at: VETERAN_CREATED, lead_count: '2', last_lead_at: new Date(NOW.getTime() - DAY) },
      ],
    ]);
    expect(await rankUnitsByFairnessFromDb(client, 'test', ['A', 'B'], { now: NOW })).toEqual(['B', 'A']);
  });

  it('conta a fatia certa: source_tag 2w, não-cancelado, por created_at, na janela', async () => {
    const client = clientWithRows([
      [
        { unit_id: 'A', unit_created_at: VETERAN_CREATED, lead_count: '0', last_lead_at: null },
        { unit_id: 'B', unit_created_at: VETERAN_CREATED, lead_count: '0', last_lead_at: null },
      ],
    ]);
    await rankUnitsByFairnessFromDb(client, 'test', ['A', 'B'], { now: NOW, windowDays: 7 });
    const call = client.calls[0]!;
    expect(call.text).toContain("source_tag = '2w'");
    expect(call.text).toContain("status <> 'cancelled'");
    expect(call.text).toContain('po.created_at >=');
    expect(call.text).toContain('make_interval(days =>');
    expect(call.values).toEqual(['test', NOW.toISOString(), 7, ['A', 'B']]);
  });

  it('novato semeado na mediana via banco: 1º por anti-seca, NÃO por entrar em zero', async () => {
    const client = clientWithRows([
      [
        { unit_id: 'A', unit_created_at: VETERAN_CREATED, lead_count: '10', last_lead_at: new Date(NOW.getTime() - 2 * DAY) },
        { unit_id: 'B', unit_created_at: VETERAN_CREATED, lead_count: '10', last_lead_at: new Date(NOW.getTime() - 2 * DAY) },
        { unit_id: 'N', unit_created_at: NEWCOMER_CREATED, lead_count: '0', last_lead_at: null },
      ],
    ]);
    expect(await rankUnitsByFairnessFromDb(client, 'test', ['A', 'B', 'N'], { now: NOW })).toEqual(['N', 'A', 'B']);
  });
});
