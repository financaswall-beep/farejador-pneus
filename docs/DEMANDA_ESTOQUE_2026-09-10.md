# Demanda e estoque — 10/09/2026

Implementação do modelo aprovado: mapa municipal em destaque e quadro da cidade selecionada, com conversas, pedidos, entregas, conversão e medidas procuradas. Filtros Hoje/7 dias/30 dias, camadas Procura/Pedidos/Entregas/Faltas, seleção por mapa ou lista e zoom. Layout empilhado no celular.

## Dados

- Mantém a malha oficial IBGE já existente, sem chave ou API externa para desenhar o mapa.
- O total da demanda soma as conversas dos municípios e as conversas sem município. Usa a população do mapa, não os cards gerais de conversas iniciadas.
- As medidas são agrupadas por município resolvido em `analytics.v_bot_demand_location`. Conta uma conversa distinta por medida no período, ignora facts substituídos e mantém os ambientes separados.
- Mostra até dez medidas por município, ordenadas pela procura. A janela das medidas respeita o horário de São Paulo.
- Estoque é a soma atual de `commerce.wholesale_stock.quantity_on_hand` entre as marcas e condições da medida, no mesmo ambiente. É saldo físico, não uma promessa de disponibilidade para entrega nem estoque histórico. Não desconta reservas.
- Zero aparece como **Zerado**. Ausência de registro de saldo aparece como **Sem registro**, sem afirmar que a medida não existe no catálogo.
- Falhas de carregamento e de atualização são explícitas. Uma consulta de medidas indisponível não aparece como ausência de procura. Município fora da malha continua disponível no seletor.

Não altera prompts, ferramentas de atendimento, roteamento, pedidos ou registros do banco. Não exige migration nem variável de ambiente nova. O relatório histórico por loja ficou para a próxima etapa, sem link para uma página ainda inexistente.

## Validação

- Build e TypeScript aprovados.
- Suíte unitária completa aprovada: 333 arquivos, 1.775 testes. A asserção antiga que prendia a versão do asset agora verifica a presença de versionamento.
- 16 testes de integração aprovados em PostgreSQL 17 descartável: município, período, ambientes, deduplicação por conversa, soma entre marcas, zero/ausência, falha parcial e criação de pedidos Matriz/parceiro. O setup foi atualizado para incluir a migration 0223 já existente.
- `scripts/prova-bot-demanda-ui.cjs`: renderiza os trechos e módulos reais em navegador com APIs fictícias; aprova seleção por lista/teclado, camadas, zoom, períodos, falha/recuperação, vazio, estoque, navegação e ausência de rolagem horizontal no celular. Capturas em `artifacts/bot-demanda/`.
- O verificador de paridade segue com nove propriedades preexistentes de catálogo/ficha de cliente fora do baseline; nenhuma divergência nova da demanda. O fiscal de tamanho segue com violações preexistentes em outros módulos; os arquivos desta alteração ficam dentro do limite.

Validação local; nenhuma consulta ao banco de produção ou deploy feito nesta etapa.
