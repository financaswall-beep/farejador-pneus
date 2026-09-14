# Marketing — Geografia e demanda

Tela de apoio à decisão de investimento, com seleção de região e campanha. Sem mapa.
Os números vêm de consultas determinísticas. Não há geração de recomendações por LLM.

## Ativação

- Aplicar `db/migrations/0229_marketing_geography.sql` antes do deploy desta versão.
- Não há variável nova. A integração usa as variáveis existentes `MARKETING_META_ENABLED`,
  `META_ADS_ACCOUNT_ID`, `META_ADS_ACCESS_TOKEN` e `META_GRAPH_API_VERSION`.
- A sincronização existente (`MARKETING_SYNC_ENABLED`) coleta gastos; a atribuição existente
  (`MARKETING_ATTRIBUTION`) vincula vendas. Indicadores indisponíveis não são tratados como zero.
- Classificar as campanhas da operação como **Matriz** na aba Campanhas.
- Em **Vincular campanhas**, registrar a validade do recorte, a região, as ofertas e o atendimento.
  A verba dedicada exige confirmação humana de que a campanha inteira serve à região no intervalo.
  Não se presume que a cidade do cliente seja a segmentação geográfica do anúncio.

A migration adiciona três tabelas em `marketing`: vínculos versionados, observações da Meta
e rascunhos de planos. RLS habilitada, acesso de parceiro bloqueado e atualizações de histórico
recusadas. Nenhuma alteração em pedidos, estoque, bot, webhooks ou CAPI.

## Critérios e fontes

- Gastos: somente insights no nível **campanha**, no ambiente e na conta configurados.
  Não soma novamente os registros dos anúncios.
- Cidade: localização atualmente identificada da conversa no Farejador. Não é histórico do endereço.
- Verba regional: somente BRL, vínculo dedicado vigente em cada dia e origem compatível de todas
  as conversas e vendas identificadas. Campanha compartilhada ou origem divergente não recebe rateio.
- Vendas: atribuições ativas, não substituídas, de pedidos da Matriz confirmados/pagos/entregues.
  Cancelamentos, pedidos de parceiros e entregas ainda não realizadas ficam fora.
- Margem após anúncios: receita atribuída menos custos registrados dos itens e mídia identificada.
  Não é lucro líquido. Item sem custo impede calcular a margem.
- Conversão: conversas do período com venda atribuída dentro de sete dias da entrada registrada.
  Uma conversa conta uma vez, inclusive entre campanhas na visão da região. O número de pedidos
  pode ser maior que o número de conversas convertidas. Vendas são contadas pela data de realização;
  a conversão acompanha a coorte de entradas e pode amadurecer depois do fim do período.
- Estoque: saldo da Matriz descontando reservas, pela medida, marca e condição do produto anunciado.
  Atendimento depende da configuração vigente e da confirmação da área da oferta ou da retirada.
  Anúncio com gasto no período e sem produto vinculado impede sugerir aumento da campanha.
- Frequência e CTR do link: agregados nativos Meta de cada período, no nível campanha.
  Não se soma alcance diário nem se apresenta essa métrica como exclusiva do município.

## Indicações

As regras são critérios de triagem, não um teste de significância estatística:

- Dados de gasto com mais de 48 horas, custo ausente, aprendizado não concluído ou campanha
  sem entrega ativa confirmada impedem sugerir aumento.
- A base mínima é de 10 conversas com janela de sete dias encerrada e cinco vendas.
  Por isso, o filtro de sete dias normalmente pede mais histórico.
- **Testar aumento**: pelo menos 10 vendas, CPA até 80% da meta, margem positiva nos dois períodos,
  CPA atual no máximo 10% acima do anterior, frequência/CTR disponíveis e estoque/atendimento confirmados.
- **Revisar investimento**: CPA acima da meta, margem não positiva ou frequência subindo mais de 20%
  junto com queda superior a 20% no CTR. Prejuízo nos dois períodos reforça a revisão da verba.
- **Revisar oferta sem estoque**: as ofertas vinculadas estão sem saldo; considerar apenas anúncios afetados.
- **Manter**: base suficiente e resultado dentro da meta, sem critérios para ampliar.
- **Aguardar dados**: as condições anteriores não podem ser verificadas.

O comparativo depois do aumento só aparece após uma elevação de orçamento **observada**,
com sete dias de dados completos em cada lado. A data da observação não é a hora exata da edição,
o dia detectado é excluído e a comparação não prova causalidade. O histórico começa a ser observado
após ativar esta versão, pelo ciclo de sincronização ou pelo botão de atualização.

## Planos

O plano guarda um rascunho com orçamento atual/proposto, campanha, região, indicadores e critérios.
O servidor recalcula a recomendação ao salvar e usa uma chave para não duplicar a mesma solicitação.
O orçamento vem da campanha ou de um único conjunto ativo; vários conjuntos não têm orçamentos somados.
**Nenhum botão desta tela altera verba, pausa ou publica anúncios na Meta.**

## Validação desta implementação

- 124 testes do módulo Marketing passaram, incluindo 45 testes novos de geografia.
- Build e TypeScript passaram; manifesto das migrations validado.
- Migration e consultas executadas em PostgreSQL local isolado (PGlite), com validação de ambiente,
  conta, cancelamentos, entregas, janela de atribuição, custo ausente, reservas e histórico.
- Interface conferida no navegador em desktop e celular: seleção, filtros, plano, vínculos e estado vazio.
- Os campos adicionais da Meta foram verificados com respostas simuladas. Não havia credencial Meta
  nos arquivos locais para fazer a validação da conexão real nesta sessão.
- A verificação global de tamanho já apresenta 12 violações em arquivos anteriores a esta alteração;
  os módulos novos ficam abaixo do limite de 300 linhas.
