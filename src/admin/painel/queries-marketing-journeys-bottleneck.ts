import type { MarketingJourneysPayload } from './queries-marketing-journeys.js';

interface BottleneckInput {
  metaStatus: 'connected' | 'disabled' | 'not_configured' | 'error';
  conversations: number | null;
  operationalAvailable: boolean;
  tracked: number;
  attributionEnabled: boolean;
  ledgerAvailable: boolean;
}

export function marketingJourneyBottleneck(
  input: BottleneckInput,
): MarketingJourneysPayload['bottleneck'] {
  if (input.metaStatus !== 'connected') {
    return {
      id: 'meta_connection',
      severity: 'high',
      title: 'A coleta da Meta precisa ser conectada',
      detail: 'Sem Insights não existe uma entrada confiável para a jornada.',
      target: 'integracoes',
    };
  }
  if ((input.conversations ?? 0) === 0) {
    return {
      id: 'no_conversations',
      severity: 'info',
      title: 'Nenhuma conversa de anúncio no período',
      detail: 'A jornada será preenchida quando houver entrega com conversa registrada pela Meta.',
      target: 'campanhas',
    };
  }
  if (input.operationalAvailable && input.tracked === 0) {
    return {
      id: 'ctwa_missing',
      severity: 'high',
      title: 'Rastreio interrompido antes do Farejador',
      detail: `${input.conversations ?? 0} conversa(s) e nenhuma referência rastreável de WhatsApp, Messenger ou Instagram.`,
      target: 'integracoes',
    };
  }
  if (!input.attributionEnabled || !input.ledgerAvailable) {
    return {
      id: 'attribution_disabled',
      severity: 'attention',
      title: input.attributionEnabled
        ? 'Ledger de atribuição ainda indisponível'
        : 'Referência encontrada; validação da atribuição ainda está desligada',
      detail: input.attributionEnabled
        ? 'Aplique a migration e execute a reconciliação explícita.'
        : 'Ative MARKETING_ATTRIBUTION somente depois de conferir o vínculo em produção.',
      target: 'integracoes',
    };
  }
  return {
    id: 'journey_active',
    severity: 'ok',
    title: 'Jornada rastreável ativa',
    detail: 'As vendas usam a última referência de mensagem em até 7 dias e cada clique é consumido uma única vez.',
    target: 'jornadas',
  };
}
