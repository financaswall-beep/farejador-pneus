# Custos do estoque

Implementação da referência aprovada em 15/09/2026. Acesso: Estoque → Custos. Lotes fica imediatamente depois de Reposição.

A tela consulta `GET /admin/api/wholesale/stock/costs`, protegido pela autenticação da Matriz e permissão de Estoque. Uma única consulta SQL reúne catálogo e lotes do ambiente configurado, no mesmo snapshot. Não grava dados.

- Capital cadastrado: soma do saldo físico × custo médio por variante, arredondado em centavos por variante. Marcas são agrupadas por medida e condição; o detalhamento abre a composição por marca. A média do grupo é ponderada pelas quantidades.
- Lotes: custo restante registrado dos lotes recebidos, com saldo físico e sem cancelamento. Não usa o valor original integral da compra para avaliar saldo parcial.
- Total físico: catálogo + lotes, incluindo reservas. Disponível: físico − reservado. No exemplo aprovado, 312 + 140 = 452 pneus; R$ 18.720 + R$ 780 = R$ 19.500.
- Separações transferem saldo e custo entre as duas origens. A consulta em um snapshot e o arredondamento por variante preservam os centavos durante a transferência, sem duplicar o capital.
- Custo zerado é mostrado e sinalizado para conferência. O banco permite zero e também o usa como valor inicial; não é possível presumir que todo zero significa cadastro incompleto. Não se estima custo ausente.
- Reservas continuam no capital; compras a caminho não entram. O total inclui o estoque recebido mesmo quando seu pagamento ainda está a vencer.

O gráfico mostra até cinco posições de maior capital. A tabela alterna pneus cadastrados e lotes, com busca e filtro de condição aplicável apenas ao catálogo. Filtros afetam tabela, total do filtro e CSV; os indicadores superiores permanecem globais. O CSV inclui data da consulta, filtros e proteção contra fórmulas em campos de texto. Lotes abrem seu detalhe existente, inclusive quando fora da primeira página da lista anterior.

## Validação

- Testes unitários: permissões, concorrência das consultas, falhas sem valores antigos, filtros, exportação e navegação para um lote específico.
- Integração: banco local PGlite com todas as migrations, custos de múltiplas marcas, condições distintas, reservas, lote parcialmente vendido, compra pendente, isolamento de ambiente, custos zerados e separação com precisão de centavos. Regressão da separação de lotes incluída.
- Navegador: aplicação real servida localmente com API simulada; desktop e celular, seleção, teclado do diálogo, CSV filtrado, abertura do lote, erro/repetição e estado vazio.
- Build e TypeScript passaram. O verificador global de tamanho mantém falhas anteriores em arquivos fora desta alteração; os novos arquivos respeitam o teto. A aplicação completa também apresenta 13 erros iniciais preexistentes de `row is not defined`; não houve novos erros durante os fluxos desta tela.

## Publicação

Esta tela não adiciona migration nem variável. A leitura usa colunas existentes desde a migration 0230. Não foi feita alteração no banco de produção. A migration 0231, pertencente à separação de lotes implementada anteriormente, permanecia pendente de autorização para aplicação em produção nesta sessão.
