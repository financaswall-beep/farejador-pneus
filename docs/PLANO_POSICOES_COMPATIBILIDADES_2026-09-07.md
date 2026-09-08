# Plano de posições e compatibilidades dos pneus

Atualizado em 07/09/2026 após o teste real da NMAX no Instagram.

## Proteção imediata do bot — concluída

- [x] Pneus sem posição não desaparecem da busca.
- [x] O bot pergunta dianteiro ou traseiro quando a moto usa medidas diferentes.
- [x] NMAX foi testada em conversa real.
- [x] A busca por medida direta continua simples.
- [x] Posição desconhecida fica pendente de confirmação, sem virar falsa falta de estoque.

## 1. Compatibilidades oficiais — concluída operacionalmente

- [x] As 62 pesquisas compatíveis com o catálogo foram reconhecidas como
  referências de fabricante em uso.
- [x] NMAX dianteira e traseira estão disponíveis para a consulta do bot.
- [x] Fonte oficial, referência de ano/versão e evidência permanecem registradas.
- [x] O lote original possui auditoria e foi conferido em modo somente leitura.
- [x] O bot não depende de clique individual para usar as referências verificadas.

Observação: as linhas antigas continuam com o estado histórico `pending` no
banco; o código reconhece 62 de 62 como `active_reference`. Isso evita promover
uma medida oficial da moto como se ela comprovasse a posição de todo SKU
genérico daquela medida.

## 2. Aproveitamento do banco antigo — concluído

- [x] Cruzar as 200 linhas antigas com os 23 tamanhos atuais.
- [x] Tratar o banco antigo apenas como pista, nunca como fonte operacional.
- [x] Confirmar cada correspondência aproveitável em fonte oficial.
- [x] Importar em produção as 15 correspondências seguras, com IDs determinísticos,
  evidência oficial e auditoria; 62 registros anteriores foram preservados.
- [x] Tornar inequívoca a quantidade por produto nas respostas com várias opções;
  por exemplo, não associar o aviso de 1 unidade ao IRC quando a unidade é do
  Maggion.
- [x] Persistir a localização informada pelo lead mesmo quando ele escolher
  retirada ou não concluir a compra.
- [x] Separar localização estimada do lead de endereço confirmado de entrega.
  Rua sem número, bairro, município ou pino ajudam cadastro e mapa de demanda,
  mas nunca viram endereço confirmado de pedido sem validação do cliente.
- [x] Exibir na ficha do cliente a melhor localização conhecida e sua origem.

## 3. Cadastro na entrada da compra — concluído

- [x] Adicionar modelo/desenho, índice de carga, índice de velocidade e posição.
- [x] Reutilizar automaticamente os dados quando o pneu já existir.
- [x] Mostrar produtos sem posição numa fila de conferência.

O cadastro técnico acontece no Catálogo antes da primeira compra. Ao escolher
“Salvar e ir para Compras”, medida, marca e condição são levadas para o item da
compra. Nas reposições seguintes, essa identidade reutiliza a mesma ficha
técnica, sem duplicar o produto e sem pedir os índices novamente.

Modelo/desenho, carga, velocidade e posição pertencem ao produto exato. O
sistema não copia esses campos entre marcas diferentes apenas porque a medida é
igual. Quando a posição não estiver comprovada, o produto permanece disponível
para conferência no filtro “Posição pendente”, sem inventar a informação.

Os índices são dados de catálogo/segurança. O bot não deve interrogá-los ao
cliente que já informou a medida; usa-os internamente quando disponíveis.

## 4. Pneus atuais

- [ ] Pesquisar os 48 produtos individualmente.
- [ ] Preencher posição somente quando o modelo/desenho exato estiver comprovado.
- [ ] Manter `Não informado` quando marca e medida não forem suficientes.

## 5. Finalização

- [x] Executar testes completos.
- [x] Conferir o banco em modo somente leitura.
- [x] Fazer commit e push do módulo 2 validado.
- [ ] Realizar um único deploy pelo responsável da operação.

## Fora deste plano

- Entrega da Matriz para Itaipuaçu/Maricá e desenho de uma futura tela de
  entregas da Matriz. Esse assunto será tratado separadamente; não faz parte do
  passo 2 deste plano.
