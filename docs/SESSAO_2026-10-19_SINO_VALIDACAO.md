# Sino da Matriz — segunda validação (19/10/2026)

A revisão posterior ao deploy de `b954261e` encontrou dois defeitos reproduzidos:
o menu saía 83 px pela esquerda em celulares e ultrapassava a altura em telas
baixas; os cliques preservavam abas/filtros anteriores, ocultando a pendência.

## Correções

- Menu limitado à altura disponível, com rolagem interna. Em telas pequenas,
  posicionamento fixo com margem de 16 px. Escape fecha e devolve foco ao sino.
- Reposição abre Estoque/Reposição e limpa filtros que poderiam ocultar medidas.
- Reservas próximas abrem Retiradas/Aguardando cliente, sem busca anterior.
- Falhas de expiração abrem Bot/Vendas. Falhas de envio abrem Bot/Conversas
  com os detalhes técnicos expandidos. A conferência financeira abre Visão geral.
- Entrega com problema abre Logística/Visão geral, atualiza a fonte e oferece
  o detalhe do pedido específico somente se ainda estiver com falha. Não abre
  detalhe se a consulta falhar, a pessoa trocar de tela/conta ou o pedido resolver.
- A referência de composição do painel recebeu os 13 membros introduzidos pela
  primeira entrega do sino. Nenhuma propriedade foi removida ou teve seu tipo alterado.

## Evidências

- 67 testes de sino, permissões, autenticação e notificações correlatas passaram.
  Dois testes novos reproduziram os defeitos de navegação antes da correção.
- Chrome de teste com o HTML real do cabeçalho, CSS compilado, Alpine e módulo
  real do sino: 1440×900, 390×844, 320×568 e 844×390. Menu dentro da tela,
  rolagem até o último aviso, Escape/foco e zero erros de JavaScript nesses casos.
  Exercitados os cliques dos 11 tipos, preservação de dados no erro e recuperação.
  O restante da aplicação foi substituído por um cenário isolado com dados fictícios.
- PostgreSQL isolado em memória (PGlite): executadas as consultas extraídas do
  código e a função de elegibilidade de reservas da migration 0255. Dez grupos
  de verificações cobrem vencimento em São Paulo e virada do dia, valores
  ajustados, pagamentos/cancelamentos/exclusões, saldo livre e mínimos, tipos
  de veículo/condição/ambiente, reservas/chegada do cliente/tentativas e falhas do Bot.
  A função de classificação de veículo do estoque foi substituída por uma fixture;
  a classificação do catálogo em si não foi revalidada nesta prova.
- Bateria completa: 3.398 testes passaram e três falharam em dois arquivos.
  As mesmas três falhas foram reproduzidas no checkout anterior `ace6cdec`, sem
  estas mudanças: `marketing-review-composition.test.ts` (mock de DOM sem
  `append`) e dois contratos HTML desatualizados em `painel-runtime-safety.test.ts`.
  Não foram alterados testes ou funcionalidades de Marketing/conversas nesta entrega.
- Fiscal de tamanho e referência de composição do painel passaram.
- TypeScript e geração do CSS passaram. O build completo ficou bloqueado na
  resolução de `tus-js-client` pelo esbuild, que recebeu acesso negado ao percorrer
  diretórios nesta sessão Windows; o código do publicador não foi alterado.
- Produção: `/readyz` saudável no commit `b954261e`, sem avisos; o endpoint
  de notificações sem sessão devolveu 401. Nenhum dado de negócio foi alterado.

## Limites e acompanhamento

A verificação visual foi do sino em cenário isolado, não de uma sessão real da
Matriz. A sessão local disponível é de parceiro; não foi usada como identidade
administrativa. Ainda falta conferir o painel publicado com contas reais de
permissões diferentes após publicar esta segunda correção.

As três falhas anteriores da suíte completa continuam abertas. Integração completa
com Docker não executada: o serviço local estava indisponível. As consultas de
alertas foram verificadas no PostgreSQL isolado acima.

Não foram implementados novos recursos de prioridade, responsável/prazo ou
sincronização de leituras entre aparelhos. Não há migration nesta entrega.
