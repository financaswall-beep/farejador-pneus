/**
 * Trava anti-requentado do Atendente (revisada 06-27).
 *
 * Um job fica OBSOLETO quando a mensagem que o disparou JÁ FOI RESPONDIDA — isto é, o bot
 * já entregou resposta a uma mensagem IGUAL ou MAIS NOVA que o gatilho deste job.
 *
 * Antes a trava olhava só o RELÓGIO da última resposta (saiu depois do gatilho?). Isso
 * ENGOLIA uma pergunta nova quando uma resposta anterior (ex.: a saudação) saía atrasada,
 * DEPOIS dela — bug 06-27: cliente manda "Olá" + "tem pneu 90/90-12?", a saudação responde
 * tarde e a pergunta do pneu era descartada como "já respondida". Agora a trava olha QUAL
 * mensagem foi de fato respondida (o gatilho do último turn ENTREGUE), não o horário da
 * resposta.
 *
 * Mantém a proteção original (06-16, caso Vitor Fernando): a mensagem reenfileirada pela
 * rede de segurança de 60s que JÁ foi respondida continua descartada — o gatilho dela é
 * igual (ou anterior) à última respondida, então NÃO repete.
 *
 * Regra: obsoleto se thisTriggerAt <= lastAnsweredTriggerAt. Defensivo: faltando qualquer
 * horário, NÃO marca obsoleto — nunca cala uma resposta por falta de dado.
 */
export function isStaleTrigger(
  thisTriggerAt: Date | null,
  lastAnsweredTriggerAt: Date | null,
): boolean {
  if (!thisTriggerAt || !lastAnsweredTriggerAt) return false;
  return thisTriggerAt.getTime() <= lastAnsweredTriggerAt.getTime();
}
