# Fotos semânticas

Catálogo incremental local de fotos em Node.js 24 e TypeScript, com SQLite, Sharp, embeddings multimodais SigLIP 2, índice HNSW USearch e integração WhatsApp via Baileys. Descobre arquivos, extrai dimensões/vetores e retoma trabalho pendente em Worker Thread. Indexação, tokenização e inferência são offline; somente comandos explícitos de preparação baixam pesos ou exemplos públicos.

## Preparação no PowerShell

### Instalação em outro PC

Instale Git e Node.js **24.x**. No PowerShell:

```powershell
git clone https://github.com/JeffersonDeylane/bot_fotos_internas.git
cd bot_fotos_internas
npm ci
Copy-Item config/settings.example.json config/settings.json
New-Item -ItemType Directory -Force photos, data/database, data/index, data/cache, data/auth
```

Edite `config/settings.json`: ajuste `photos.directories` para as pastas existentes no novo PC e preencha `whatsapp.allowedNumbers` com seu número no formato internacional. Se quiser usar apenas os treinos, mantenha `./photos` e `inference.enabled=false`. As metas estão em `config/treinos.json`.

```powershell
npm run build
npm start
```

Vincule o novo PC pelo QR Code em **WhatsApp > Aparelhos conectados > Conectar aparelho**. O Git não transporta a sessão do WhatsApp, configurações locais, fotos, banco, índices nem modelos. Para busca de fotos por IA, siga a preparação do modelo abaixo. Mantenha somente um PC executando o bot de treinos para evitar enquetes duplicadas.

Execute dentro desta pasta:

```powershell
npm ci
Copy-Item config/settings.example.json config/settings.json
Copy-Item .env.example .env
New-Item -ItemType Directory -Force photos, data/database, data/index, data/cache, data/auth
```

Edite `config/settings.json`: informe suas pastas em `photos.directories`. O diretório `photos` vazio é apenas uma opção para experimentar a estrutura. Caminhos relativos são resolvidos a partir da raiz deste projeto, independentemente do diretório de onde o programa é iniciado. Caminhos absolutos são aceitos somente na configuração local. No JSON do Windows, use `/` ou escape as barras como `\\`.

Todos os diretórios precisam existir. Pastas de fotos precisam permitir leitura; armazenamento precisa permitir leitura e escrita. Pastas configuradas não podem coincidir nem conter outras pastas configuradas. A aplicação falha com código de saída 1 e erro estruturado se a configuração for inválida.

`PHOTO_CONFIG` seleciona outro arquivo; `LOG_LEVEL` aceita `debug`, `info`, `warn` ou `error`. Variáveis de ambiente existentes têm precedência sobre `.env`. `maxWorkers` aceita 1–16 e `batchSize` 1–32; mantenha ambos em 1 neste computador. Nesta etapa existe um worker proprietário do catálogo; leituras simultâneas são limitadas ao menor valor entre `maxWorkers`, `batchSize` e 4. A concorrência interna do Sharp é 1 e seu cache é limitado a 16 MB.

`whatsapp.allowedNumbers` aceita números internacionais, por exemplo `+5511999999999`. Lista vazia desativa o transporte. Com ao menos um número, `npm start` exibe um QR no terminal na primeira execução; vincule-o pelo menu **Aparelhos conectados** do WhatsApp. Credenciais ficam somente em `storage.whatsAppSessionDirectory`. Baileys usa o protocolo do WhatsApp Web e não é uma API oficial da Meta; use uma conta dedicada e respeite os termos aplicáveis.

Comandos: `/fotos <descrição>`, `/data [quantidade] DD/MM/AAAA`, `/data MM/AAAA`, `/data AAAA`, `/data DD/MM/AAAA a DD/MM/AAAA`, `/mais`, `/mostrar-pastas`, `/abrir-<pasta>`, `/abrir <número>`, `/pastas`, `/mostrar`, `/mostrar-<pasta>`, `/mais-pastas`, `/voltar`, `/onde`, `/status` e `/ajuda`. Usuários fora da lista são ignorados. Caminhos absolutos, traversal, junctions externas e arquivos fora das raízes autorizadas são recusados.

## Comandos

```powershell
npm run build
npm test
npm start
```

Diagnóstico e recuperação local:

```powershell
npm run status
npm run doctor
npm run retry-failed
npm run reindex
```

`doctor` é somente leitura e termina com código diferente de zero quando encontra inconsistências. `reindex` invalida explicitamente metadados/embeddings ativos e os gera novamente; não apaga fotos nem o histórico de tombstones. Embeddings novos permanecem em estado de processamento até a geração HNSW ser persistida e publicada atomicamente; somente então o SQLite os promove para `INDEXED`.

`npm start` executa o build já gerado, faz uma reconciliação inicial e monitora continuamente as pastas de fotos até Ctrl+C. Eventos duplicados são agregados e arquivos precisam permanecer com tamanho e data estáveis antes da indexação. Cada rajada dispara no máximo uma reconciliação por vez em Worker Thread. `npm run dev` executa os arquivos TypeScript com reinício automático ao editar módulos importados; execute o build para validar tipos. `npm run typecheck` confere tipos sem emitir arquivos.

`npm run index` compila, descobre e indexa metadados e, se habilitados, embeddings nas pastas autorizadas. Encerra ao terminar. `npm run index:retry` também recoloca imagens com falha na fila. Equivalente: `npm run index -- --retry-failed`. Ctrl+C interrompe com segurança; execute o mesmo comando para retomar. No modo de serviço, os eventos do watcher nativo do Windows são tratados apenas como avisos; o scan incremental persistente continua sendo a fonte de verdade para criações, alterações, renames e remoções, inclusive as ocorridas com o programa desligado.

## Embeddings locais

```powershell
npm run model:prepare
# Depois do download, configure inference.enabled=true em config/settings.json.
npm run index
npm run embed:text -- "gato preto"
npm run benchmark -- --limit 8
```

O modelo já foi baixado e habilitado na configuração local deste ambiente. Em uma instalação nova, o exemplo começa com `enabled=false` para permitir preparar os arquivos antes de ativar a inferência. Quando habilitado, o diretório do modelo deve existir e não pode sobrepor as pastas de fotos/dados. `model:prepare` baixa aproximadamente 413 MB, de uma revisão fixa, e verifica tamanho e hash de cada arquivo. Arquivos válidos são reutilizados; um download interrompido repete apenas o arquivo incompleto. Não baixa modelo automaticamente ao indexar ou gerar vetores. Não usa Python, serviços de IA, CUDA ou APIs pagas.

Configuração:

```json
"inference": {
  "enabled": true,
  "modelDirectory": "./models/siglip2-base-int8",
  "intraOpThreads": 2,
  "batchSize": 1
}
```

`inference.batchSize` limita o lote de inferência de 1 a 4; `intraOpThreads` limita as threads nativas de CPU de 1 a 4. Com IA habilitada, o worker proprietário do catálogo mantém uma sessão visual reutilizada; não replica os pesos conforme `maxWorkers`. Cada lote é inferido sequencialmente, preparando uma imagem de cada vez no tensor do lote. A sessão textual e o tokenizer são carregados sob demanda e reutilizados durante a vida do worker. A chamada de texto e o benchmark também executam em Worker Thread. Entre threads passam caminhos, configurações e vetores pequenos, não pixels da imagem original. Ao encerrar, os tensores e sessões são liberados. Não há cache ilimitado de consultas nem carregamento dos vetores de todo o catálogo em RAM.

Modelo: `onnx-community/siglip2-base-patch16-256-ONNX`, revisão `d1114256522a37ffa257a0a58017348ab0058db2`, arquivos `vision_model_int8.onnx` e `text_model_int8.onnx`. Ambos geram `pooler_output` de 768 dimensões no mesmo espaço. Não usamos `last_hidden_state`, logits ou médias improvisadas dos tokens. Normalização L2 transforma similaridade por cosseno em produto escalar. O score não é probabilidade.

Contrato de imagem verificado contra `preprocessor_config.json`: orientação EXIF aplicada, conversão para RGB/sRGB e remoção do canal alfa; resize direto para **256×256**, sem crop nem letterbox; filtro bilinear/triangular (`resample=2`, Sharp `kernel=linear`, sem Lanczos padrão); reescala `1/255`, média `[0.5,0.5,0.5]`, desvio `[0.5,0.5,0.5]`; tensor FP32 em **NCHW**. Sharp decodifica/redimensiona antes de entregar o buffer RGB pequeno ao JavaScript. Detalhes de arredondamento do libvips podem diferir em pixels dos da implementação Pillow: não há alegação de igualdade bit a bit entre decodificadores. Essa implementação de preprocessing é versionada junto dos pesos.

Texto usa `@huggingface/tokenizers` com `tokenizer.json` e configuração Gemma do mesmo checkpoint. Mantém acentos, usa minúsculas conforme a configuração, não adiciona BOS, trunca conteúdo para 63 tokens e adiciona EOS=1; padding à direita com PAD=0 completa exatamente **64 tokens**, em `int64`. Consultas limitadas a 4096 caracteres e lotes textuais a 8 consultas. Não há tradução nem LLM intermediário. `embed:text` imprime o vetor e seu identificador de modelo em JSON.

No SQLite, `embedding` é BLOB float32 little-endian (3.072 bytes por foto), `embedding_dimension` guarda 768 e `model_version` identifica checkpoint, quantização, preprocessing e runtime. `embedding_target` registra a versão desejada para controlar retentativas. A migração automática do esquema 1 para 2 preserva o catálogo. Metadados e vetor são confirmados na mesma transação. Mudança no arquivo invalida o vetor; mudança na versão/dimensão recoloca os registros necessários na fila. Modelos ausentes ou corrompidos impedem a inferência, em vez de produzir vetores falsos. Para futuros modelos, atualizar o adaptador/definição e o identificador; vetores de versões diferentes não devem ser comparados.

Dependências de inferência fixadas: ONNX Runtime 1.24.3 e Tokenizers.js 0.2.0. Usamos o tokenizer diretamente para evitar carregar todo o Transformers.js e outro backend ONNX. `skipLibCheck` contorna imports sem extensão nos arquivos `.d.ts` publicados pelo Tokenizers.js sob NodeNext; o código do projeto continua com `strict` e é compilado/testado. O provedor homologado aqui é CPU; GPU permanece para uma etapa posterior.

Fontes do contrato: [checkpoint ONNX](https://huggingface.co/onnx-community/siglip2-base-patch16-256-ONNX), [modelo Google](https://huggingface.co/google/siglip2-base-patch16-256), [Tokenizers.js](https://github.com/huggingface/tokenizers.js), [ONNX Runtime Node](https://onnxruntime.ai/docs/get-started/with-javascript/node.html).

## Benchmark e teste real

`npm run benchmark -- --limit 8` seleciona até 8 fotos das raízes autorizadas (máximo permitido: 128). Faz aquecimento separado, compara lotes de 1 e 2 imagens com sessões reutilizadas e informa quantidade, imagens/s, tempo médio, RSS inicial/final e pico amostrado a cada 50 ms. RSS inclui memória nativa e todo o processo. Grava o relatório em `cacheDirectory/embedding-benchmark.json`; não modifica o catálogo. A amostra pequena é um teste de funcionamento/desempenho, não uma garantia para todo o acervo. Lotes de 2 só devem ser ativados para indexação se a medição compensar o aumento de memória.

Para repetir o teste com fotos públicas, sem usar o acervo pessoal:

```powershell
npm run model:prepare
npm run test:fixtures
npm run test:inference
```

`test:fixtures` baixa três imagens públicas (gatos, cachorro e ônibus) para `cacheDirectory/embedding-fixtures`; as origens estão em `src/inference/fixtures.ts`. `test:inference` não acessa a rede: usa os arquivos já preparados, confere normas, dimensões, ranking em português, equivalência aproximada de lotes e persistência incremental numa pasta temporária. Os arquivos de teste/modelo não são enviados ao Git. `npm test` executa os testes rápidos sem exigir downloads.

## Organização

- `src/config`: esquema tipado e validação de configuração/diretórios.
- `src/logging`: logs JSON em stdout/stderr, sem dados privados nos erros.
- `src/core`: aplicação, erros e ciclo de vida com cancelamento e limpeza.
- `src/security`: validação de caminhos reais dentro das raízes autorizadas.
- `src/indexing`: formatos, scanner incremental, metadados, progresso e coordenação do worker.
- `src/storage/catalog.ts`: esquema SQLite versionado, transações, fila e reconciliação.
- `src/inference`: pesos versionados, download explícito, preprocessing, tokenizer, sessões e benchmark.
- `src/workers/indexing.worker.ts`: executa scanner, SQLite e Sharp fora do event loop principal.
- `tests`: configuração, restrição de acesso, CLI, descoberta, alterações, remoções, falhas e retomada após crash.
- `data/database`, `data/index`, `data/cache`, `data/auth`: dados locais separados.

O ciclo de vida libera recursos em ordem inversa, tenta todas as limpezas mesmo após falhas, trata SIGINT/SIGTERM e impõe prazo de 10 segundos para encerramento. O worker recebe cancelamento, termina o lote corrente e fecha o SQLite. Fechar o processo à força pelo Windows não garante execução das limpezas; a próxima execução recupera a fila persistida.

## Indexação incremental e limites

O scanner reconhece `.jpg`, `.jpeg`, `.png` e `.webp`, sem diferenciar maiúsculas e minúsculas nas extensões. A lista fica centralizada em `src/indexing/formats.ts`. Usa `opendir` como iterador e percorre em profundidade: até 32 entradas por nível e limite de 128 níveis, sem armazenar todos os caminhos. Links simbólicos e junctions encontrados dentro das raízes são ignorados. O limite de profundidade e falhas de acesso tornam a varredura incompleta e impedem a confirmação de remoções dessa raiz.

As observações são gravadas em transações de até 256 entradas. A fila no SQLite é consultada por ID crescente em janelas de até 128 itens. Resultados são persistidos a cada 32 itens ou aproximadamente um segundo, entre leituras; o lote final também é salvo. Apenas pequenas janelas ficam em RAM. Sharp lê cabeçalhos para obter dimensões e decodifica/redimensiona somente as imagens que precisam de embeddings. Limite de entrada: 100 milhões de pixels. Largura/altura no catálogo são as dimensões armazenadas, antes da orientação EXIF.

O banco `databaseDirectory/catalog.sqlite` usa WAL, transações, sincronização FULL, cache SQLite de 8 MiB e índices para caminho único, fila/status, raiz/varredura e datas. A memória nativa e o cache do sistema operacional também fazem parte do consumo total. A escala foi preparada estruturalmente; não há promessa de tempo ou RAM total para 100 mil fotos sem medir o acervo real.

Para detectar alterações, compara caminho normalizado, tamanho, `mtime` com precisão de nanossegundos quando disponível, `ctime` e identidade do arquivo (`dev`/`ino`). Não calcula hashes. Assim, uma segunda execução lê diretórios e faz `stat`, mas **não lê novamente os metadados de imagem das fotos INDEXED inalteradas**. Alterações de permissões/ctime podem provocar trabalho conservador adicional. Alterações que preservem todos esses atributos podem passar despercebidas; uma auditoria de conteúdo por hash pode ser adicionada depois. Não há deduplicação por conteúdo nesta etapa. Renomear gera um novo registro e marca o caminho antigo como removido. No Windows, a chave única considera caminhos sem distinção de maiúsculas, destinada ao uso convencional do NTFS.

O arquivo é conferido antes e depois de extrair dimensões e, quando habilitada, da inferência. Se mudar nesse intervalo, permanece PENDING para a próxima execução, sem ciclo infinito de tentativas. A alteração invalida dimensões antigas e o vetor. `metadata_version=metadata-v1` identifica a extração de metadados. Com IA desabilitada, INDEXED significa apenas metadados concluídos e o vetor pode estar ausente; com IA habilitada, só confirma o trabalho após gerar/persistir o vetor. Trocar a versão dos metadados ou do modelo recoloca o trabalho necessário na fila.

## Retomada, remoções e falhas

- `PENDING`: aguardando metadados e/ou embeddings.
- `PROCESSING`: reservado pelo worker; recuperado como PENDING após interrupção.
- `INDEXED`: processamento configurado persistido com sucesso (metadados e, quando habilitados, embeddings).
- `FAILED`: diagnóstico e tentativas persistidos; nova tentativa com `index:retry` ou após alteração do arquivo.

Ao reiniciar, o scanner reconcilia novamente os atributos baratos do acervo, mas o processamento continua a partir da fila persistida. Se 23.482 fotos já foram confirmadas, elas não são processadas novamente por estarem no começo da árvore. Em queda abrupta, apenas resultados ainda não confirmados na pequena janela transacional podem ser repetidos. O banco não depende de um contador volátil de posição em RAM.

Cada raiz recebe uma geração de varredura. Somente varreduras COMPLETED marcam arquivos não vistos com `deleted_at`; registros não são apagados fisicamente, preservando IDs e consistência. Interrupções ou erros de leitura deixam a varredura INTERRUPTED/INCOMPLETE e não confirmam remoções. Uma raiz removida da configuração fica inativa: seus registros são preservados, mas não participam da fila nem dos contadores ativos. Um arquivo que reaparece no mesmo caminho é reativado com o mesmo ID. `scan_errors` guarda erros de descoberta; `photos.error` guarda código e diagnóstico local de falha na imagem. `last_indexed_at` é a data da última conclusão bem-sucedida, não da última tentativa.

Há exclusão de escritores concorrentes com PID e token no próprio SQLite. Após um crash, um PID comprovadamente encerrado permite recuperação automática; PID ainda existente, falta de permissão para verificá-lo ou host diferente bloqueiam a recuperação por segurança. Use o banco em disco local, não compartilhado por rede.

O log `index.progress` mostra encontradas nesta varredura, já indexadas e inalteradas, pendentes, processadas nesta execução, falhas persistidas ativas, erros de descoberta e imagens/s. A velocidade mede sucessos por tempo da fase de processamento; não inclui o scan. Falhas individuais não interrompem outras imagens. Confira `failed` e `scanErrors` no resumo final mesmo quando o comando termina normalmente; erros estruturais do banco/worker encerram com código não zero.

A indexação extrai `DateTimeOriginal` do EXIF para `taken_at`. Quando esse campo não existe ou é inválido, usa a modificação do arquivo e registra a origem em `taken_at_source` como `EXIF` ou `FILE_MODIFIED`. `created_at` continua sendo a criação do arquivo no sistema de arquivos, não a captura. A busca `/data` aceita dia, mês, ano e intervalo inclusivo.

## Dados privados

O `.gitignore` permite na raiz apenas código, testes, manifests, documentação e exemplos. Configuração real, `.env`, dependências, build, banco, índice, cache, sessão, modelos e formatos comuns de fotos ficam ignorados. Guarde arquivos privados em `private/` ou fora do projeto, nunca em `src/` ou `tests/`. `.gitignore` não remove arquivos que já tenham sido versionados. Revise `git status` antes de publicar; esta etapa não cria commits nem envia arquivos.

A autorização de caminhos resolve caminhos reais no scanner e novamente antes/depois da leitura de metadados. O futuro envio deverá validá-los novamente. Não há reconhecimento facial, OCR ou envio de fotos nesta estrutura.
# Enquetes de treinos

O bot envia diariamente, a partir das **06:00 no horário de Brasília**, uma enquete por pessoa no grupo **O treino**. Cada título contém o nome e a data (`Jefferson 16/10/2026`) e permite marcar várias opções.

Edite **config/treinos.json** para alterar o grupo, os nomes ou as metas. Cada item de `metas` é uma opção da enquete; informe entre 2 e 12 opções diferentes por pessoa. As alterações são lidas no próximo envio, sem reiniciar o bot. Elas não alteram enquetes já publicadas.

Use **/treinos** no grupo configurado ou no privado do bot com um número autorizado para enviar novamente todas as enquetes do dia ao grupo. O comando manual pode gerar novas enquetes mesmo após o envio automático.

O bot precisa estar conectado ao WhatsApp e participar de um único grupo com o nome configurado. A conexão do WhatsApp depende de haver números em `whatsapp.allowedNumbers`, como no funcionamento existente. Execute o bot a partir da pasta do projeto e reinicie-o após instalar esta funcionalidade.

O agendamento verifica o horário a cada 30 segundos. Se o bot estiver desligado às 06:00, ele envia as pendências do dia ao conectar depois desse horário. O progresso automático fica em `treinos-enviados.json` no diretório do banco de dados; preserve esse arquivo para evitar reenvios após reiniciar. Uma interrupção entre a confirmação do WhatsApp e a gravação local pode repetir a última enquete. Não há reposição de dias anteriores.
