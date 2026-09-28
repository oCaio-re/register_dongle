# Context & Glossário do Projeto Nonius Dongle Registrar Automation

## Glossário

### Nonius Registrar
Plataforma web de administração (Django Admin) para registro e associação de dispositivos (Customer Device) a clientes, acessada via URL `https://registrar.nonius.cloud/admin/registrar/customerdevice/add/`.

### Device (Dispositivo / Serial Number)
Identificador único de hardware registrado na plataforma Nonius Registrar (ex: `44021HFGN7J7DS`). Corresponde à coluna `serial_number` do arquivo CSV. No dropdown da página, é exibido no formato `<serial_number> - <modelo>`.

### Customer (Cliente / NCM)
Código ou identificador do cliente associado ao dispositivo. Corresponde à coluna `ncm` do arquivo CSV. No dropdown da página, é exibido no formato `<ncm> - <nome_do_cliente>`.

### Autenticação & Sessão (Google SSO + 2FA)
Acesso controlado por conta Google com 2FA. O bot opera com navegador visível (`headless: false`) no primeiro acesso para permitir a autenticação manual e persiste o estado da sessão em `storageState.json` para reutilização automática nas execuções seguintes.

### Leitura do CSV
O bot identifica a localização do arquivo CSV via variável de ambiente `CSV_PATH` no `.env` ou autodetecta arquivos `.csv` na raiz do projeto (ex: `Gen 4 registration hotel - Carmel Taiba - Página1.csv`).

### Fluxo de Salvamento e Resiliência
- **Save and add another**: Botão acionado para os itens do 1º ao penúltimo (`N-1`) do arquivo CSV.
- **SAVE**: Botão acionado para o último item (`N`) do arquivo CSV para concluir a operação e gerar o relatório consolidado.
- **Tratamento de Falhas**: Se um item falhar (ex: serial/NCM não encontrado ou erro de validação), a falha é registrada no log e o bot retorna à URL de adição para continuar com os demais itens sem parar o lote.
