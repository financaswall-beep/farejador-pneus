# Status Do Catalogo Commerce De Pneus

Atualizado: 2026-05-14.

Este documento registra o estado operacional do catalogo de pneus em
`commerce.*` para continuidade por proximas IAs.

## Ambiente Auditado

- Banco acessado via `.env` local.
- `FAREJADOR_ENV=test` no momento da auditoria.
- Nao assumir que estes dados ja existem em `prod` sem nova consulta direta.
- Em 2026-05-14 tambem foi feita leitura de `prod` para iniciar testes de
  shadow da Atendente.

## Resumo Executivo

O catalogo tecnico base de pneus foi populado em `commerce.*`.

Estado auditado:

- `commerce.products`: 50 produtos do tipo `tire`.
- `commerce.tire_specs`: 50 especificacoes tecnicas.
- `commerce.vehicle_models`: 138 modelos/variacoes de moto.
- `commerce.vehicle_fitments`: 96 compatibilidades oficiais.
- `commerce.fitment_discoveries`: 84 pendencias `pending`.
- Produtos com preco ativo: 0 no ambiente auditado.
- Produtos com estoque positivo: 0 no ambiente auditado.

Leitura complementar em `prod` em 2026-05-14:

- `commerce.products`: 28 produtos do tipo `tire`.
- `commerce.tire_specs`: 28 especificacoes tecnicas.
- `commerce.vehicle_models`: 145 modelos/variacoes de moto ativos.
- `commerce.vehicle_fitments`: 70 compatibilidades oficiais apos cadastro da
  Honda CG 160 Fan 2016-2024 com 90/90-18 traseiro.
- `commerce.fitment_discoveries`: 115 pendencias `pending`.
- Produtos com preco ativo: 13.
- Produtos com estoque positivo: 12.

Interpretacao importante:

- O banco tem **catalogo tecnico e grafo de compatibilidade**.
- Estoque zero nao e falha por si so: alguns pneus podem existir no catalogo
  tecnico sem disponibilidade comercial no momento.
- Preco pode ser completado depois. A regra operacional e que a Atendente so
  pode falar preco se `buscarProduto` retornar preco ativo, e so pode falar
  estoque/pronta entrega se `verificarEstoque` retornar disponibilidade.
- `vehicle_fitments` permite a Atendente dizer "serve".
- `fitment_discoveries` exige resposta cautelosa: "costuma servir, mas preciso
  confirmar ano, versao ou foto da medida atual".

## Aros Cobertos

Foram cadastrados pneus dos aros:

- Aro 21
- Aro 19
- Aro 18
- Aro 17
- Aro 16
- Aro 15
- Aro 14
- Aro 13
- Aro 12
- Aro 10

Aro 11 foi deliberadamente ignorado por nao ser relevante comercialmente para
o catalogo atual de moto/scooter no Brasil.

## Medidas Cadastradas Por Familia

### Aro 21

- `90/90-21`
- `90/90R21`
- `80/90-21`
- `80/100-21`

Cobertura principal: XRE 300, Sahara 300, Tornado, Falcon, Africa Twin,
Transalp, Lander, Tenere, Himalayan, BMW GS, Tiger Rally, V-Strom 800DE,
DesertX, CRF 230F/250F e TT-R 230.

### Aro 19

- `90/90-19`
- `100/90-19`
- `100/90B19`
- `110/80R19`

Cobertura principal: Bros, XRE 190, Crosser, Royal Enfield 350/Scram,
Kawasaki Versys-X 300, Harley Sportster/Iron/Street Bob e Suzuki V-Strom 650.

### Aro 18

- `2.75-18`
- `90/90-18`

No ambiente auditado, estes foram cadastrados na camada final de excecoes para
motos antigas. Se a proxima IA esperar os pneus 18 populares cadastrados em
outra conversa, deve auditar o banco atual antes de assumir.

### Aro 17

- `2.50-17`
- `2.75-17`
- `90/90-17`
- `100/80-17`
- `100/80R17`
- `110/70R17`
- `130/70-17`
- `130/70R17`
- `140/70R17`
- `160/60R17`
- `180/55R17`

Cobertura principal: Bajaj, Zontes, Haojue DL/DR, Dafra Apache, e varias
naked/sport/adventure leves.

### Aro 16

- `90/80-16`
- `110/70-16`
- `140/70-16`

Cobertura principal: Sundown Web 100 e Dafra Citycom 300i.

### Aro 15

- `120/70-15`
- `130/90-15`
- `140/90-15`
- `170/80-15`
- `170/80B15`
- `180/70-15`

Cobertura principal: scooter/custom/cruiser, incluindo Yamaha XMAX 250,
Suzuki Boulevard, Triumph America/Speedmaster, Kawasaki Vulcan e Kasinski
Mirage.

### Aro 14

- `80/100-14`
- `80/80-14`
- `90/80-14`
- `100/80-14`
- `110/70-14`
- `110/80-14`
- `120/70-14`
- `130/70-14`
- `140/70-14`

Cobertura principal: Biz, Pop, PCX, ADV, Neo, Aerox e aplicacoes de scooter.

### Aro 13

- `110/70-13`
- `130/70-13`

Cobertura principal: NMAX, PCX 160 e ADV 160.

### Aro 12

- `90/90-12`
- `100/90-12`
- `110/90-12`

Cobertura principal: Honda Elite 125, Honda Lead 110 e Yamaha Fluo 125.

### Aro 10

- `3.00-10`
- `3.50-10`
- `90/90-10`
- `100/90-10`

Cobertura principal: Dafra Smart 125, Haojue Lindy, Suzuki Burgman 125i e
Shineray Phoenix como pendencia.

## Marcas Com Fitments Oficiais

O ambiente auditado tem fitments oficiais para:

- Bajaj
- BMW
- Dafra
- Ducati
- Haojue
- Harley-Davidson
- Honda
- Kasinski
- Kawasaki
- Royal Enfield
- Shineray
- Sundown
- Suzuki
- Triumph
- Yamaha
- Zontes

Tambem ha discoveries pendentes para marcas/modelos mais raros, incluindo
Aprilia, GasGas, Garinni, Husqvarna, KTM, MVK e Traxx.

## Regras De Uso Pela Atendente

- Se a compatibilidade veio de `commerce.vehicle_fitments`, a Atendente pode
  dizer que serve, respeitando ano, modelo, posicao e medida.
- Se a compatibilidade veio de `commerce.fitment_discoveries`, a Atendente nao
  pode afirmar. Deve pedir confirmacao de ano, versao ou foto da medida atual.
- Nao promover `fitment_discoveries` para `vehicle_fitments` sem validacao
  humana.
- Medidas com `R` e `B` foram separadas de medidas sem letra. Exemplo:
  `100/90-19`, `100/90B19`, `90/90-21` e `90/90R21` nao sao a mesma coisa.
- Preco e estoque devem vir de `commerce.current_prices` e
  `commerce.stock_levels`. Estoque zero significa "nao prometer disponibilidade",
  nao significa que o cadastro tecnico esteja errado.

## Proximas Pendencias

- Completar preco, marca comercial e fotos dos produtos conforme a operacao
  comercial for exigindo.
- Auditar se o seed deve ser promovido/replicado para `prod`.
- Revisar duplicatas antigas em `fitment_discoveries` antes de qualquer
  promocao humana em massa.
- Continuar tratando motos raras, importadas ou adaptadas como excecao: pedir
  foto da medida atual quando houver duvida.
