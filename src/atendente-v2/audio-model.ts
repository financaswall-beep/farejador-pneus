/** Contratos diferentes: GPT-Transcribe não aceita language nem logprobs. */
export function appendTranscriptionOptions(form: FormData, model: string): void {
  form.append('model', model);
  form.append('response_format', 'json');
  if (model === 'gpt-transcribe') {
    form.append('languages[]', 'pt');
    form.append('prompt', 'Mensagem de cliente de uma loja de pneus de carro e moto no Brasil.');
    // Vocabulário geral; medidas, preços e quantidades não são sugestões ao transcritor.
    for (const word of ['pneu', 'meia-vida', 'aro', 'borracharia']) form.append('keywords[]', word);
  } else {
    form.append('language', 'pt');
    form.append('include[]', 'logprobs');
  }
}

/** Ausência de logprobs não comprova erro nem permite fabricar certeza. */
export function transcriptionConfidence(model: string, raw: unknown): 'low' | 'medium' {
  if (model === 'gpt-transcribe' || !Array.isArray(raw) || !raw.length) return 'low';
  return raw.every(item => typeof item?.logprob === 'number' && Number.isFinite(item.logprob)
    && item.logprob <= 0 && item.logprob > -2) ? 'medium' : 'low';
}
