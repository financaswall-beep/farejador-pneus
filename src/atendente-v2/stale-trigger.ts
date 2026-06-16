/**
 * Trava anti-requentado do Atendente.
 *
 * Um job de atendimento fica OBSOLETO quando a mensagem que o disparou JÁ foi
 * superada por uma resposta NOSSA (outgoing) posterior na mesma conversa. Isso
 * acontece quando a rede de segurança (reconcile de 60s) reenfileira uma mensagem
 * que a conversa já passou por cima — sem esta trava, o bot RESPONDE DE NOVO, fora
 * de contexto (caso Vitor Fernando 06-15: "qual pneu" e "só faltou o WhatsApp"
 * repetidos ~1 min depois). Decisão Wallace 06-16: preferir atrasar a repetir.
 *
 * Regra: existe resposta com horário ESTRITAMENTE depois do gatilho.
 * Defensivo: faltando qualquer um dos horários, NÃO marca como obsoleto — nunca
 * cala uma resposta por falta de dado.
 */
export function isStaleTrigger(
  triggerCreatedAt: Date | null,
  latestOutgoingAt: Date | null,
): boolean {
  if (!triggerCreatedAt || !latestOutgoingAt) return false;
  return latestOutgoingAt.getTime() > triggerCreatedAt.getTime();
}
