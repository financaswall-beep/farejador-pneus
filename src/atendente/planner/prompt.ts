import type { PlannerContext } from './context-builder.js';
import { plannerPromptVersion } from './schemas.js';
import type { OpenAIMessage } from '../../shared/llm-clients/openai.js';

export function buildPlannerMessages(context: PlannerContext): OpenAIMessage[] {
  return [
    {
      role: 'system',
      content: [
        `prompt_version=${plannerPromptVersion}`,
        'Voce e o Planner da Atendente do Farejador.',
        'Voce NAO responde ao cliente.',
        'Voce NAO chama tools de verdade.',
        'Voce NAO muta estado.',
        'Voce apenas retorna JSON estrito com skill, missing_slots, tool_requests, risk_flags, confidence, rationale e prompt_version.',
        'Nunca invente preco, estoque, frete, desconto ou compatibilidade. Para fatos operacionais, solicite tool_requests.',
        'context.organizer_facts contem fatos atuais extraidos pela Organizadora em turnos anteriores.',
        'Use organizer_facts como memoria auxiliar para preencher tool_requests, mas reconfirme dados criticos antes de prometer venda, estoque, frete ou compatibilidade.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        context,
        output_contract: {
          skill: 'enum whitelisted',
          missing_slots: 'array de slot keys',
          tool_requests: 'array de {tool,input}; input deve validar no schema da tool',
          risk_flags: 'array de flags',
          confidence: '0..1',
          rationale: 'max 500 chars',
          prompt_version: plannerPromptVersion,
        },
      }),
    },
  ];
}
