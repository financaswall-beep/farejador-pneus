export const reasoningItem = { type: 'reasoning', id: 'rs_fixture', summary: [], encrypted_content: 'opaque-fixture-only' };
export const functionItem = (callId = 'call_fixture', name = 'buscar_produto', args = '{}') => ({
  type: 'function_call', id: `fc_${callId}`, call_id: callId, name, arguments: args, status: 'completed',
});
export const textItem = (text = 'Olá! Como posso ajudar?', phase = 'final_answer') => ({
  type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed', phase,
  content: [{ type: 'output_text', text, annotations: [] }],
});
export const responseBody = (output: unknown[] = [textItem()]) => ({
  id: 'resp_fixture', object: 'response', status: 'completed', output,
  usage: { input_tokens: 100, output_tokens: 25, input_tokens_details: { cached_tokens: 80 } },
});
export const jsonResponse = (body: unknown) => new Response(JSON.stringify(body));
