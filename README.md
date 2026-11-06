# RAG Demo

Prova de conceito de RAG inspirada em um marketplace de peças e componentes para makers. Você pergunta em português no terminal, e o assistente recomenda apenas produtos cadastrados no PostgreSQL, com preço e estoque lidos do banco no momento da consulta.

Preços, estoques e anúncios são fictícios.

## Requisitos

- Node.js 20.12 ou superior
- Docker com Docker Compose
- Uma chave da API do Gemini ([criar chave](https://aistudio.google.com/apikey))

## Como executar

**1. Instale as dependências e crie o `.env`**

```powershell
npm install
Copy-Item .env.example .env   # no Linux/macOS: cp .env.example .env
```

Depois, preencha `GEMINI_API_KEY` no `.env`.

**2. Suba o banco, crie o schema e cadastre os produtos**

```powershell
npm run db:up
npm run db:init
npm run seed
```

**3. Indexe os produtos e calibre a relevância**

```powershell
npm run index
npm run calibrate
```

Ajuste `RELEVANCE_MIN_SIMILARITY` no `.env` conforme o resultado de `calibrate` (veja [Critério de relevância](#critério-de-relevância)).

**4. Converse**

```powershell
npm run chat
```

Para encerrar, digite `sair` ou `exit`. Para ver o RAG acontecendo, use `npm run chat:debug`.

O banco é dedicado à demonstração: projeto Compose `makerswap-rag-demo`, porta `127.0.0.1:5544` e volume próprio. Os comandos recusam qualquer `DATABASE_URL` que não seja um banco local chamado `makerswap_rag_demo`.

## Como funciona

```text
Pergunta
  │
  ├─ Catálogo sem produtos disponíveis? ───────► avisa, sem chamar a IA
  ├─ "Placa Wi-Fi" sem contexto de uso? ───────► pergunta se é projeto ou adaptador para PC
  │
  ▼
Interpretação pela IA (intenção, consulta autônoma, filtros propostos)
  │
  ▼
Validação dos filtros (faixa de preço, categoria existente)
  │
  ▼
Embedding da consulta + busca no pgvector, com SQL fixo e parametrizado
  │    ativos; com estoque e sem estoque separados; filtros de preço e categoria
  ▼
Etapa 1: piso de similaridade ─ ninguém passou ► "não encontrei", sem chamar a IA
  │
  ▼
Etapa 2: a IA avalia só os candidatos e aponta as especificações que sustentam cada escolha
  │
  ▼
Etapa 3: o código verifica a resposta e monta a saída com os dados do banco
```

"E tem uma mais barata?" usa o menor preço atual dos produtos mostrados, relido do banco. "Qual a diferença entre essas duas?" relê os produtos e monta a comparação a partir do cadastro. O histórico guarda só o texto da conversa e os nomes dos produtos, nunca preços ou estoque.

### Indexação

`npm run index` monta um texto com nome, categoria, descrição e especificações de cada produto, gera o embedding e grava vetor, modelo e hash SHA-256 desse texto.

- Só gera embedding de novo se o vetor faltar, o modelo mudar ou o hash mudar.
- Preço, estoque e status ficam fora do texto indexado. Mudar qualquer um deles não exige reindexar.
- Produtos inativos ou sem estoque também são indexados; a disponibilidade é decidida na consulta.

### Critério de relevância

Uma busca vetorial sempre encontra vizinhos, por isso o produto só é recomendado depois de passar por três etapas:

| Etapa                     | Onde         | O que faz                                                                                                                                                                                  | Como ajustar                                        |
| ------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| 1. Piso de similaridade   | SQL + código | Descarta candidatos abaixo de `RELEVANCE_MIN_SIMILARITY`. Se nenhum passar, a resposta é "não encontrei", sem chamar o modelo de geração.                                                  | `.env`                                              |
| 2. Avaliação de evidência | Modelo       | Cada requisito explícito precisa estar nos dados cadastrados. Assunto parecido não basta: "placa de vídeo" não é atendida por "placa de desenvolvimento".                                  | `ANSWER_SYSTEM` em [src/prompts.ts](src/prompts.ts) |
| 3. Verificação            | Código       | Só aceita IDs candidatos com estoque e ao menos uma chave de especificação que exista no produto. Remove textos com preços que não estejam nos dados. Na dúvida, responde "não encontrei". | `enforceAnswer` em [src/rag.ts](src/rag.ts)         |

O score é a similaridade de cosseno. Ele serve só para ordenar e cortar, não é probabilidade de acerto, não é enviado ao modelo e só aparece no modo de depuração.

**O piso depende do modelo.** O padrão `0.35` é apenas um ponto de partida e **ainda não foi validado com embeddings reais**. Rode `npm run calibrate`: ele mede os scores de perguntas com e sem produto adequado e sugere um valor. Perguntas como "placa de vídeo" podem pontuar tão alto quanto as legítimas, porque compartilham termos com o catálogo. Nesse caso, mantenha o piso abaixo dos produtos esperados e deixe as etapas 2 e 3 rejeitarem o resto.

### Proteções

- **SQL:** a IA não produz SQL. Ela só propõe valores, que são validados e enviados como parâmetros de consultas fixas.
- **Dados como conteúdo:** produtos e histórico vão em blocos JSON delimitados, com `<` neutralizado, para que um anúncio não consiga fechar o bloco. O prompt manda ignorar instruções ali dentro, e a etapa 3 vale mesmo que o modelo obedeça a um texto malicioso.
- **Campos do banco:** nome, preço, disponibilidade, descrição e valores das especificações são exibidos pelo código diretamente do banco. Do modelo vêm só o texto da mensagem e o motivo.
- **Credenciais:** o modo de depuração não mostra credenciais, e a chave é removida de mensagens de erro.

## Se o modelo de embeddings mudar

Vetores de modelos diferentes não são comparáveis.

**Mudou o modelo ou a dimensão:**

1. Altere `EMBEDDING_MODEL` e `EMBEDDING_DIMENSIONS` no `.env`.
2. Recrie a indexação:

   ```powershell
   npm run index:rebuild
   ```

   O comando descarta apenas os vetores e recria a coluna com a nova dimensão. O catálogo e o volume do Docker não são afetados.

3. Calibre de novo, porque os scores mudam de escala:

   ```powershell
   npm run calibrate
   ```

**Mudou só o modelo, com a mesma dimensão:** `npm run index` já basta, porque o modelo diferente é detectado. Até terminar, a busca ignora os vetores do modelo anterior.

A dimensão precisa ser aceita pelo modelo. Os modelos atuais do Gemini aceitam de 128 a 3072; a documentação recomenda 768, 1536 ou 3072. Se ela divergir da coluna, `chat` e `index` param com uma mensagem clara.

## Casos de aceitação

Com a chave configurada e o banco indexado, execute todos de uma vez, com a IA real:

```powershell
npm run acceptance
```

Cada cenário roda em uma transação desfeita ao final. O comando verifica os resultados e termina com código 1 se algo falhar. Para ver os detalhes, defina `RAG_DEBUG=true` no `.env`.

Para reproduzir no chat, envie na mesma conversa as perguntas 1 a 3. Para as demais, comece uma conversa nova com `npm run chat`, porque o histórico também conta como contexto.

| #   | Pergunta                                                  | Esperado                                                     |
| --- | --------------------------------------------------------- | ------------------------------------------------------------ |
| 1   | Preciso de uma placa com Wi-Fi para automação.            | Recomenda placas com Wi-Fi cadastrado                        |
| 2   | Tem alguma por até R$ 50?                                 | Herda o pedido e filtra o preço no banco                     |
| 3   | Qual a diferença entre essas duas?                        | Compara os produtos mostrados, com dados atuais              |
| 4   | Preciso de uma placa Wi-Fi.                               | Pergunta se é para projetos eletrônicos ou adaptador para PC |
| 5   | Vocês têm uma placa de vídeo RTX 4090?                    | Informa que não encontrou opção adequada                     |
| 6   | Qual é o consumo em deep sleep da placa ESP32 DevKit V1?  | Diz que a especificação não foi informada                    |
| 7   | Preciso de um sensor de CO2 para medir a qualidade do ar. | Mostra o MH-Z19C como sem estoque, sem recomendá-lo          |
| 8   | Qualquer pergunta, após `npm run demo:zero-stock`         | Informa que não há produtos disponíveis                      |

Para restaurar o estoque depois do caso 8, rode `npm run seed`.

`npm run acceptance` também cobre um adaptador para PC (nenhuma placa ESP pode ser oferecida), um produto inativo (a ESP32-S2 Mini nunca aparece) e um anúncio com texto malicioso.

## Testes sem chave de API

```powershell
npm run typecheck
npm test
```

`npm test` exige o banco no ar, mas não a chave. Os testes usam o pgvector real, em transações desfeitas ao final, e o SDK real contra um servidor HTTP local. Vetores e respostas falsos existem apenas em `test/`: eles validam SQL, filtros e orquestração, **não a qualidade do RAG**.

## Comandos

| Comando                       | O que faz                                                  |
| ----------------------------- | ---------------------------------------------------------- |
| `npm run db:up` / `db:down`   | Sobe / para o container, preservando os dados              |
| `npm run db:init`             | Cria o que falta no schema, sem apagar dados               |
| `npm run seed`                | Cadastra ou restaura os produtos, sem duplicar             |
| `npm run index`               | Gera embeddings apenas do que mudou                        |
| `npm run index:rebuild`       | Descarta os vetores, recria a coluna e indexa tudo         |
| `npm run calibrate`           | Mede os scores reais e sugere o piso                       |
| `npm run chat` / `chat:debug` | Abre a conversa / com produtos, scores, filtros e contexto |
| `npm run acceptance`          | Roda os cenários com a IA real                             |
| `npm run demo:zero-stock`     | Zera o estoque para o caso 8                               |

Nenhum comando apaga o volume do Docker. Para remover tudo, rode manualmente `docker compose down -v`, sabendo que isso apaga os dados da demonstração.

## Configuração

Todas as variáveis estão comentadas em [.env.example](.env.example). As principais:

| Variável                   | Padrão                  | Função                                                                   |
| -------------------------- | ----------------------- | ------------------------------------------------------------------------ |
| `AI_PROVIDER`              | `gemini`                | Provedor; hoje só há Gemini                                              |
| `GEMINI_API_KEY`           | vazio                   | Credencial, obrigatória para `index`, `chat`, `calibrate` e `acceptance` |
| `GENERATION_MODEL`         | `gemini-3.5-flash-lite` | Modelo das respostas                                                     |
| `EMBEDDING_MODEL`          | `gemini-embedding-2`    | Modelo dos embeddings                                                    |
| `EMBEDDING_DIMENSIONS`     | `768`                   | Dimensão dos vetores e da coluna                                         |
| `RELEVANCE_MIN_SIMILARITY` | `0.35`                  | Piso da etapa 1                                                          |

## Limitações

- O texto livre da mensagem e do motivo tem controle parcial: preços são verificados, mas uma afirmação técnica errada depende das regras do prompt para não aparecer.
- A extração de filtros depende do modelo. Um limite de preço que ele não identifique não é aplicado; os filtros usados aparecem na resposta.
- A regra de "placa Wi-Fi" cobre essa ambiguidade específica. Outras dependem do modelo.
- Não há índice ANN: a varredura exata é adequada para este catálogo. Em um catálogo grande, avalie HNSW; o índice do pgvector para o tipo `vector` aceita até 2000 dimensões.
- Se um produto mudar sem nova indexação, a busca segue com o vetor antigo até rodar `npm run index`. O chat avisa ao iniciar.
- Cada pergunta de busca faz duas chamadas de geração e um embedding, o que pesa em latência e cota.
- A pergunta, o histórico curto e os dados dos produtos candidatos são enviados à API do Gemini.
