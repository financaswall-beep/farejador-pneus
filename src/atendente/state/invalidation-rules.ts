import type { SessionSlotKey, SlotSource, StaleFlag } from '../../shared/zod/agent-state.js';

export interface SlotInvalidationEffect {
  slot_key: SessionSlotKey;
  if_source: SlotSource[];
  action: 'delete' | 'mark_stale' | 'mark_stale_strong';
}

export interface InvalidationRule {
  trigger_scope: 'global' | 'item';
  trigger_slot: SessionSlotKey;
  effects: SlotInvalidationEffect[];
  invalidate_offer: boolean;
}

export const INVALIDATION_RULES: InvalidationRule[] = [
  {
    trigger_scope: 'item',
    trigger_slot: 'moto_modelo',
    effects: [
      {
        slot_key: 'medida_pneu',
        if_source: ['inferred', 'inferred_from_history', 'inferred_from_organizadora'],
        action: 'delete',
      },
      {
        slot_key: 'moto_cilindrada',
        if_source: ['inferred', 'inferred_from_history', 'inferred_from_organizadora'],
        action: 'delete',
      },
      {
        slot_key: 'medida_pneu',
        if_source: ['observed'],
        action: 'mark_stale',
      },
      {
        slot_key: 'moto_cilindrada',
        if_source: ['observed'],
        action: 'mark_stale',
      },
      {
        slot_key: 'medida_pneu',
        if_source: ['confirmed'],
        action: 'mark_stale_strong',
      },
    ],
    invalidate_offer: true,
  },
  {
    trigger_scope: 'item',
    trigger_slot: 'moto_ano',
    effects: [
      {
        slot_key: 'medida_pneu',
        if_source: ['inferred', 'inferred_from_history', 'inferred_from_organizadora'],
        action: 'delete',
      },
    ],
    invalidate_offer: true,
  },
  {
    trigger_scope: 'item',
    trigger_slot: 'moto_cilindrada',
    effects: [
      {
        slot_key: 'medida_pneu',
        if_source: ['inferred', 'inferred_from_history', 'inferred_from_organizadora'],
        action: 'delete',
      },
      {
        slot_key: 'medida_pneu',
        if_source: ['observed', 'confirmed'],
        action: 'mark_stale',
      },
    ],
    invalidate_offer: true,
  },
  {
    trigger_scope: 'global',
    trigger_slot: 'bairro',
    effects: [],
    invalidate_offer: true,
  },
  {
    trigger_scope: 'global',
    trigger_slot: 'municipio',
    effects: [],
    invalidate_offer: true,
  },
  {
    trigger_scope: 'global',
    trigger_slot: 'forma_pagamento',
    effects: [],
    invalidate_offer: true,
  },
  {
    trigger_scope: 'item',
    trigger_slot: 'medida_pneu',
    effects: [],
    invalidate_offer: true,
  },
  {
    trigger_scope: 'item',
    trigger_slot: 'posicao_pneu',
    effects: [],
    invalidate_offer: true,
  },
  {
    trigger_scope: 'item',
    trigger_slot: 'quantidade',
    effects: [],
    invalidate_offer: true,
  },
  {
    trigger_scope: 'item',
    trigger_slot: 'marca_preferida',
    effects: [],
    invalidate_offer: true,
  },
  {
    trigger_scope: 'item',
    trigger_slot: 'marca_recusada',
    effects: [],
    invalidate_offer: true,
  },
  {
    trigger_scope: 'item',
    trigger_slot: 'faixa_preco_max',
    effects: [],
    invalidate_offer: true,
  },
];

export function staleLevelForAction(action: SlotInvalidationEffect['action']): StaleFlag {
  return action === 'mark_stale_strong' ? 'stale_strong' : 'stale';
}
