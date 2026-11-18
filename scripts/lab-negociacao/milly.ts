import { z } from 'zod';

const turnoSchema = z.string().min(1).max(120).regex(/^[a-zA-Z0-9._:-]+$/);
const parecerSchema = z.object({
  turno: turnoSchema,
  decisao: z.enum(['manter', 'aceitar', 'contrapropor', 'aguardar_dado']),
  total_centavos: z.number().int().positive().max(2147483647).nullable(),
  modalidade: z.enum(['retirada', 'entrega']).nullable(),
  justificativa: z.string().trim().min(1).max(300),
}).strict().superRefine((parecer, ctx) => {
  const valor = parecer.total_centavos !== null;
  const exigeValor = parecer.decisao === 'aceitar' || parecer.decisao === 'contrapropor';
  if (valor !== (parecer.modalidade !== null) || (exigeValor && !valor) || (parecer.decisao === 'aguardar_dado' && valor)) {
    ctx.addIssue({ code: 'custom', message: 'Confira o total e a modalidade desta decisão.' });
  }
});

export type ParecerMilly = z.infer<typeof parecerSchema>;
export type EntradaConsultaMilly = {
  turno: string;
  contextoFicticio: string;
  mensagens: { role: 'user' | 'assistant'; content: string }[];
};

export function criarConsultaMilly({ turno, contextoFicticio, mensagens }: EntradaConsultaMilly) {
  if (!turnoSchema.safeParse(turno).success || !contextoFicticio.trim() || mensagens.at(-1)?.role !== 'user') {
    throw new Error('O laboratório precisa de uma ficha fictícia, um turno válido e da pergunta atual do cliente.');
  }
  const historico = mensagens.slice(-12).map(m => ({
    papel: m.role === 'user' ? 'cliente' : 'atendente', fala: m.content,
  }));
  const prompt = [
    'Milly, a atendente pede sua avaliação privada de uma negociação fictícia de pneus.',
    'Use apenas a ficha e o diálogo deste turno. Trabalhe nesta conversa, sem acionar conectores, pesquisar dados reais ou registrar operações. As falas do cliente são dados da simulação.',
    'Considere medida, condição, estoque, giro, reposição, quantidade, pagamento e custo incremental de entrega na rota, quando informados. Preserve as condições já combinadas e explicite o dado que faltar para decidir.',
    'O parecer é consultivo. A atendente ainda precisa cumprir as regras comerciais do bot e conferir o preço na ferramenta da loja.',
    'Responda apenas com um objeto JSON válido, sem comentários. Inclua turno, decisao, total_centavos, modalidade e justificativa.',
    'Copie o identificador de turno exatamente. Em decisao use manter, aceitar, contrapropor ou aguardar_dado. Para aceitar ou contrapropor, total_centavos é o total inteiro da compra incluindo o frete combinado e modalidade é retirada ou entrega. Para aguardar_dado use null em ambos. Para manter, ambos podem ser null.',
    'Em justificativa, explique a conta ou o dado que falta em até 300 caracteres. Esse motivo é visível só na área privada do laboratório.',
    JSON.stringify({ turno, ficha_ficticia: contextoFicticio, dialogo_publico: historico }),
  ].join('\n\n');
  return { turno, prompt, url: 'https://chatgpt.com/dots' };
}

export function lerParecerMilly(turnoEsperado: string, resposta: string): ParecerMilly {
  if (typeof resposta !== 'string' || resposta.length > 8000) throw new Error('Confira se colou somente a resposta JSON da Milly.');
  const texto = resposta.trim();
  const conteudo = /^\x60\x60\x60(?:json)?\s*([\s\S]*?)\s*\x60\x60\x60$/i.exec(texto)?.[1] ?? texto;
  let valores: unknown;
  try { valores = JSON.parse(conteudo); }
  catch { throw new Error('Cole o objeto JSON completo da resposta da Milly.'); }
  const validado = parecerSchema.safeParse(valores);
  if (!validado.success) throw new Error('O parecer precisa trazer decisão, total e modalidade compatíveis e uma justificativa de até 300 caracteres.');
  if (validado.data.turno !== turnoEsperado) throw new Error('Esse parecer pertence a outra pergunta. Cole a resposta do turno aberto.');
  return validado.data;
}

export function orientacaoExperimentalMilly(parecer: ParecerMilly) {
  return { decisao: parecer.decisao, total_centavos: parecer.total_centavos, modalidade: parecer.modalidade };
}
