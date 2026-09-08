# Aproveitamento seguro das compatibilidades do legado — 08/09/2026

## Escopo

O banco antigo foi aberto somente para leitura e usado como índice de pesquisa,
nunca como dependência operacional nem como fonte de verdade. O cruzamento encontrou:

- 200 linhas físicas antigas;
- 178 aplicações semanticamente distintas;
- 73 aplicações cujas medidas existem entre as 23 medidas do catálogo atual.

Cada pista aproveitada foi conferida novamente em manual, ficha ou comunicado oficial
do fabricante. Faixas de ano, construção e posição não foram copiadas por aproximação.

## Resultado seguro

Nove configurações adicionais do legado ganharam referência oficial no catálogo
versionado: Honda CB 500F 2023–2024, CB 1000R 2022, Lead 110 2013, NXR 150 Bros
2005, XRE 190 2018 e XRE 300 2019; Haojue NK150; Zontes R310 e V310.

Somadas às duas referências oficiais que ainda estavam apenas no código (Fazer FZ25
2025 e NMAX 2026), a reexecução controlada prepara 15 novos registros de descoberta
que coincidem com produtos atuais. Os 62 registros anteriores permanecem intactos.
A referência oficial funciona no bot sem clique; o registro no banco preserva origem,
evidência e auditoria, mas não homologa automaticamente um SKU genérico.

O catálogo público passa a ter 94 configurações pesquisadas, das quais 83 brasileiras
confirmadas, totalizando 167 aplicações dianteiras/traseiras ativas. Aplicações cuja
medida não existe no estoque atual continuam úteis para identificar a moto, sem criar
produto, preço ou estoque fictício.

## Proteções

- Classic 350 do legado foi recusada: a ficha brasileira atual usa traseiro aro 19,
  não o aro 18 que aparecia na pista antiga.
- CG 160 Fan e Titan continuam separadas; o traseiro não é intercambiado entre versões.
- CB 300R antiga não foi convertida em CB 300F Twister.
- Fontes internacionais, de reposição ou conflitantes continuam bloqueadas.
- O `R`/`ZR` é preservado na evidência técnica e retirado apenas da medida comercial
  usada na consulta nominal, conforme a regra já adotada no catálogo.
- Estoque, preços, pedidos, financeiro, `raw.*` e `core.*` não são alterados pela carga.

## Melhorias associadas ao passo 2

- Em listas com várias marcas, o bot deve atrelar a quantidade ao mesmo produto e preço;
  fica proibido encerrar a lista com um “só resta 1” sem indicar de qual marca.
- Rua, número, bairro ou município digitados passam a ser registrados como localização
  estimada do lead após a resposta ser entregue, inclusive em retirada ou abandono.
- A localização estimada fica separada do endereço confirmado de entrega, alimenta o
  mapa de demanda quando há município e aparece identificada na ficha lateral do cliente.

## Operação

As migrations `0220_lead_location_memory.sql` e
`0221_bot_analytics_trigger_isolation.sql` foram aplicadas em produção e registradas
no controle de schema para habilitar a memória de localização com extração isolada.
A importação de compatibilidades usa transação, trava de concorrência, IDs determinísticos,
snapshot verificável e eventos em `audit.events`. Depois do ensaio com rollback, a carga
foi confirmada em produção: 48 produtos, 77 coincidências, 62 já existentes e 15 novas.
As descobertas permanecem historicamente como candidatas, mas as referências oficiais
versionadas já funcionam no bot sem depender de aprovação manual de SKU genérico.

A regra de entrega da Matriz e Itaipuaçu/Maricá não faz parte desta etapa.
