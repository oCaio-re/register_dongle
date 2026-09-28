# Nonius Dongle Registrar Automation

Bot de automação em **TypeScript** e **Playwright** para registrar e associar dispositivos (*Customer Devices*) em lote na plataforma **Nonius Registrar Admin** a partir de um arquivo `.csv`.

## 📌 Funcionalidades

- **Autenticação com Google SSO + 2FA**: Executa em modo visível (`headless: false`) para permitir a autenticação manual no primeiro uso e salva a sessão em `session.json`.
- **Preenchimento Inteligente de Dropdowns**: Suporte a componentes Select2/Django Admin para os campos **Device** (`serial_number`) e **Customer** (`ncm`).
- **Navegação em Lote**: Clica em *"Save and add another"* para os itens intermediários e em *"SAVE"* no último item do lote.
- **Relatório Consolidado**: Exibe resumo de sucessos, falhas e detalhes no terminal ao concluir a execução.

---

## 🚀 Como Executar

### 1. Instalação de Dependências

```bash
npm install
npx playwright install chromium
```

### 2. Configuração de Variáveis de Ambiente (`.env`)

Copie o `.env.example` para `.env` se ainda não o fez:

```bash
cp .env.example .env
```

Conteúdo do `.env`:
```env
REGISTRAR_URL=https://registrar.nonius.cloud/admin/registrar/customerdevice/add/
CSV_PATH=Gen 4 registration hotel - Carmel Taiba - Página1.csv
HEADLESS=false
```

### 3. Execução

Para iniciar a automação:

```bash
npm start
```

---

## 🛠️ Tecnologias Utilizadas

- **Node.js** & **TypeScript**
- **Playwright** (Navegação Web)
- **tsx** (Executor TypeScript de alta velocidade)
- **csv-parse** (Leitor e parser de arquivos CSV)
