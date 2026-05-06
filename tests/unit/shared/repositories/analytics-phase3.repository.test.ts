import { describe, expect, it, vi } from 'vitest';
import {
  shouldSupersedeFact,
  writeFactWithEvidence,
} from '../../../../src/shared/repositories/analytics-phase3.repository.js';

describe('analytics-phase3.repository', () => {
  it('lets stronger truth_type supersede current fact', () => {
    expect(
      shouldSupersedeFact(
        { truth_type: 'observed', confidence_level: 0.70 },
        { truth_type: 'inferred', confidence_level: '0.95' },
      ),
    ).toBe(true);
  });

  it('does not let weak inferred fact supersede strong observed fact', () => {
    expect(
      shouldSupersedeFact(
        { truth_type: 'inferred', confidence_level: 0.58 },
        { truth_type: 'observed', confidence_level: '0.97' },
      ),
    ).toBe(false);
  });

  it('supersedes when truth rank is equal and confidence is not lower', () => {
    expect(
      shouldSupersedeFact(
        { truth_type: 'observed', confidence_level: 0.97 },
        { truth_type: 'observed', confidence_level: '0.90' },
      ),
    ).toBe(true);
  });

  it('inserts weak fact already superseded by the active fact', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{ id: 'active-id', truth_type: 'observed', confidence_level: '0.97' }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'new-id' }] })
      .mockResolvedValueOnce({ rows: [] });

    await writeFactWithEvidence(
      { query } as never,
      {
        environment: 'prod',
        conversation_id: 'conversation-id',
        fact_key: 'moto_modelo',
        fact_value: 'Honda',
        observed_at: new Date('2026-04-29T10:00:00Z'),
        message_id: 'message-id',
        truth_type: 'inferred',
        source: 'llm_openai_organizadora_v1',
        confidence_level: 0.58,
        extractor_version: 'moto-pneus-v1',
      },
      {
        from_message_id: 'message-id',
        evidence_text: 'Honda',
        evidence_type: 'literal',
        extractor_version: 'moto-pneus-v1',
      },
    );

    const insertParams = query.mock.calls[1]![1] as unknown[];
    expect(insertParams[10]).toBe('active-id');
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('updates active fact only when incoming fact supersedes it', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{ id: 'active-id', truth_type: 'inferred', confidence_level: '0.70' }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'new-id' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await writeFactWithEvidence(
      { query } as never,
      {
        environment: 'prod',
        conversation_id: 'conversation-id',
        fact_key: 'moto_modelo',
        fact_value: 'Bros',
        observed_at: new Date('2026-04-29T10:00:00Z'),
        message_id: 'message-id',
        truth_type: 'observed',
        source: 'llm_openai_organizadora_v1',
        confidence_level: 0.80,
        extractor_version: 'moto-pneus-v1',
      },
      {
        from_message_id: 'message-id',
        evidence_text: 'Bros',
        evidence_type: 'literal',
        extractor_version: 'moto-pneus-v1',
      },
    );

    const updateSql = query.mock.calls[2]![0] as string;
    expect(updateSql).toContain('UPDATE analytics.conversation_facts');
  });

  it('dedup: skip insert quando active fact tem mesmo valor, mesma truth_type e conf >= novo', async () => {
    const query = vi
      .fn()
      // findActiveFact retorna fact existente com mesmo valor
      .mockResolvedValueOnce({
        rows: [{
          id: 'active-id',
          truth_type: 'observed',
          confidence_level: '0.99',
          fact_value: 'consultar_entrega',
        }],
      })
      // insert evidence (ON CONFLICT DO NOTHING)
      .mockResolvedValueOnce({ rows: [] });

    const factId = await writeFactWithEvidence(
      { query } as never,
      {
        environment: 'prod',
        conversation_id: 'conv-id',
        fact_key: 'intencao_cliente',
        fact_value: 'consultar_entrega',
        observed_at: new Date('2026-04-29T10:00:00Z'),
        message_id: 'msg-id-2',
        truth_type: 'observed',
        source: 'llm_openai_organizadora_v1',
        confidence_level: 0.99,
        extractor_version: 'moto-pneus-v1',
      },
      {
        from_message_id: 'msg-id-2',
        evidence_text: 'mando pra Niteroi',
        evidence_type: 'literal',
        extractor_version: 'moto-pneus-v1',
      },
    );

    expect(factId).toBe('active-id');
    expect(query).toHaveBeenCalledTimes(2); // findActive + insert evidence; SEM insert fact
    // Confirma que segunda chamada e o INSERT em fact_evidence
    expect(query.mock.calls[1]![0]).toContain('INSERT INTO analytics.fact_evidence');
  });
});
