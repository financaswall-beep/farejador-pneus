/** Famílias usadas pelo Farejador que aceitam reasoning na Responses API. */
export function isReasoningModel(model: string): boolean {
  return /^gpt-[56](?:[.-]|$)/.test(model);
}
