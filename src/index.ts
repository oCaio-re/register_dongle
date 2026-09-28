import { chromium, Page, BrowserContext } from 'playwright';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';

dotenv.config();

const REGISTRAR_URL = process.env.REGISTRAR_URL || 'https://registrar.nonius.cloud/admin/registrar/customerdevice/add/';
const CSV_PATH_ENV = process.env.CSV_PATH;
const HEADLESS = process.env.HEADLESS === 'true';
const CONCURRENCY = Math.max(1, parseInt(process.env.CONCURRENCY || '3', 10));
const SESSION_FILE = path.join(process.cwd(), 'session.json');

interface CsvRow {
  serial_number: string;
  product_model?: string;
  ncm: string;
}

interface ProcessResult {
  index: number;
  serialNumber: string;
  ncm: string;
  status: 'SUCCESS' | 'FAILED';
  details?: string;
}

interface ChunkItem {
  item: CsvRow;
  globalIndex: number;
}

/**
 * Localiza o arquivo CSV no diretório raiz do projeto.
 */
function resolveCsvFilePath(): string {
  if (CSV_PATH_ENV && fs.existsSync(CSV_PATH_ENV)) {
    return CSV_PATH_ENV;
  }

  const files = fs.readdirSync(process.cwd());
  const csvFile = files.find(f => f.endsWith('.csv') && !f.startsWith('.'));

  if (!csvFile) {
    throw new Error('Nenhum arquivo .csv foi encontrado no diretório do projeto.');
  }

  return path.join(process.cwd(), csvFile);
}

/**
 * Lê e valida os itens do arquivo CSV.
 */
function loadCsvItems(filePath: string): CsvRow[] {
  console.log(`[CSV] Lendo arquivo: ${path.basename(filePath)}`);
  const content = fs.readFileSync(filePath, 'utf-8');
  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as CsvRow[];

  if (!records || records.length === 0) {
    throw new Error('O arquivo CSV está vazio ou não possui registros válidos.');
  }

  console.log(`[CSV] Total de ${records.length} item(ns) encontrado(s).`);
  return records;
}

/**
 * Verifica se a página atual requer autenticação (ex: tela de login do Google SSO).
 */
async function handleAuthenticationIfNeeded(context: BrowserContext, page: Page): Promise<void> {
  console.log('[AUTH] Verificando estado de autenticação...');
  await page.goto(REGISTRAR_URL, { waitUntil: 'domcontentloaded' });

  const needsLogin = () => {
    const currentUrl = page.url().toLowerCase();
    return currentUrl.includes('google.com') ||
           currentUrl.includes('accounts') ||
           currentUrl.includes('login') ||
           currentUrl.includes('sso');
  };

  if (needsLogin()) {
    console.log('\n================================================================');
    console.log('[AUTH] Login necessário! Por favor, realize o login via Google SSO + 2FA na janela do navegador aberta.');
    console.log('O script aguardará o redirecionamento de volta para a página do Registrar Admin...');
    console.log('================================================================\n');

    while (needsLogin()) {
      await page.waitForTimeout(1000);
    }

    await page.waitForLoadState('domcontentloaded');
    console.log('[AUTH] Login realizado com sucesso!');
    
    await context.storageState({ path: SESSION_FILE });
    console.log(`[AUTH] Sessão salva em: ${SESSION_FILE}`);
  } else {
    console.log('[AUTH] Sessão autenticada ativa detectada.');
  }
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Encontra o índice da melhor opção correspondente considerando regras rígidas de correspondência exata
 * e limites de palavra (\b) para evitar correspondências parciais (ex: "855" vs "5855", "2855", "1855").
 */
function findBestMatchingOptionIndex(optionsTexts: string[], searchValue: string): number {
  const cleanSearch = searchValue.trim().toLowerCase();
  if (!cleanSearch) return -1;

  // Tier 1: Exata no texto completo OU no código/prefixo antes de hífen, dois-pontos ou espaço (ex: "855" ou "855 - Hotel")
  for (let i = 0; i < optionsTexts.length; i++) {
    const rawText = optionsTexts[i].trim();
    const textLower = rawText.toLowerCase();

    if (!rawText || textLower.includes('searching') || textLower.includes('buscando') || textLower.includes('no results')) {
      continue;
    }

    if (textLower === cleanSearch) {
      return i;
    }

    const codePart = textLower.split(/[\s\-:\t]/)[0];
    if (codePart === cleanSearch) {
      return i;
    }
  }

  // Tier 2: Palavra exata com limite de palavra (\b855\b)
  const regexBoundary = new RegExp(`\\b${escapeRegExp(cleanSearch)}\\b`, 'i');
  for (let i = 0; i < optionsTexts.length; i++) {
    const rawText = optionsTexts[i].trim();
    const textLower = rawText.toLowerCase();

    if (!rawText || textLower.includes('searching') || textLower.includes('buscando') || textLower.includes('no results')) {
      continue;
    }

    if (regexBoundary.test(rawText)) {
      return i;
    }
  }

  // Tier 3: Prefixo que inicia com "855" (ex: "855...")
  for (let i = 0; i < optionsTexts.length; i++) {
    const rawText = optionsTexts[i].trim();
    const textLower = rawText.toLowerCase();

    if (!rawText || textLower.includes('searching') || textLower.includes('buscando') || textLower.includes('no results')) {
      continue;
    }

    if (textLower.startsWith(cleanSearch)) {
      return i;
    }
  }

  // Tier 4: Sub-string contida (fallback)
  for (let i = 0; i < optionsTexts.length; i++) {
    const rawText = optionsTexts[i].trim();
    const textLower = rawText.toLowerCase();

    if (!rawText || textLower.includes('searching') || textLower.includes('buscando') || textLower.includes('no results')) {
      continue;
    }

    if (textLower.includes(cleanSearch)) {
      return i;
    }
  }

  return -1;
}

/**
 * Preenche um campo dropdown no Django Admin (Select2 ou HTML padrão).
 */
async function fillDropdownField(
  page: Page,
  fieldLabel: string,
  searchValue: string,
  workerId?: number
): Promise<void> {
  const tag = workerId !== undefined ? `[ABA #${workerId}]` : '[BOT]';
  const fieldName = fieldLabel.toLowerCase().replace(/[^a-z0-9]/g, ''); // 'device' ou 'customer'
  console.log(`${tag}  -> Processando campo "${fieldLabel}" (alvo: "${searchValue}")...`);

  // Lista de locatores priorizados para encontrar a caixa do dropdown
  const potentialTriggerSelectors = [
    `#select2-id_${fieldName}-container`,
    `label[for="id_${fieldName}"] + .select2-container`,
    `label[for="id_${fieldName}"] ~ .select2-container`,
    `.field-${fieldName} .select2-container`,
    `.field-${fieldName} .select2-selection`,
    `[data-select2-id*="${fieldName}"]`,
    `.form-row:has-text("${fieldLabel}") .select2-container`,
    `tr:has-text("${fieldLabel}") .select2-container`,
    `div:has-text("${fieldLabel}") .select2-container`,
    `.form-row:has-text("${fieldLabel}") [role="combobox"]`,
    `tr:has-text("${fieldLabel}") [role="combobox"]`,
    `.form-row:has-text("${fieldLabel}") select`,
  ];

  let triggerFound = false;

  for (const selector of potentialTriggerSelectors) {
    const loc = page.locator(selector).first();
    if (await loc.isVisible().catch(() => false)) {
      console.log(`${tag}     [SELECT2] Container encontrado com seletor: ${selector}`);
      await loc.click().catch(() => {});
      triggerFound = true;
      break;
    }
  }

  // Fallback: tentar clicar no próprio <label> se nada funcionou
  if (!triggerFound) {
    const labelLoc = page.locator(`label:has-text("${fieldLabel}")`).first();
    if (await labelLoc.isVisible().catch(() => false)) {
      console.log(`${tag}     [FALLBACK] Clicando no label "${fieldLabel}"`);
      await labelLoc.click().catch(() => {});
      triggerFound = true;
    }
  }

  if (!triggerFound) {
    throw new Error(`Não foi possível localizar ou clicar no dropdown do campo "${fieldLabel}".`);
  }

  // Localizar a caixa de entrada/busca que é aberta no overlay do Select2
  const searchInputSelectors = [
    'input.select2-search__field',
    '.select2-search__field',
    'input[type="search"]',
    '.select2-dropdown input',
    'body > .select2-container--open input',
    'input[role="searchbox"]',
  ];

  let searchInputLoc = null;

  for (const sSelector of searchInputSelectors) {
    const sLoc = page.locator(sSelector).first();
    if (await sLoc.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)) {
      searchInputLoc = sLoc;
      break;
    }
  }

  if (searchInputLoc) {
    console.log(`${tag}     [SEARCH] Digitando "${searchValue}" no campo de busca...`);
    await searchInputLoc.fill('');
    await searchInputLoc.fill(searchValue);

    // Aguarda o Select2 responder a busca e popular as opções no DOM
    const optionsContainerLoc = page.locator('.select2-results__option:not(.loading-results), [role="option"]:not(.loading-results), .select2-results li:not(.loading-results)');
    
    // Aguarda a visibilidade de ao menos um item de resultado
    await optionsContainerLoc.first().waitFor({ state: 'visible', timeout: 3500 }).catch(() => {});
    await page.waitForTimeout(400); // Pausa para garantir finalização do filtro Select2/AJAX

    const optionLocators = await optionsContainerLoc.all();
    const optionsTexts: string[] = [];

    for (const optLoc of optionLocators) {
      const txt = await optLoc.textContent().catch(() => '');
      optionsTexts.push(txt || '');
    }

    const matchedIndex = findBestMatchingOptionIndex(optionsTexts, searchValue);
    let optionClicked = false;

    if (matchedIndex !== -1 && matchedIndex < optionLocators.length) {
      const selectedText = optionsTexts[matchedIndex].trim();
      console.log(`${tag}     [OPTION MATCH STRICT] Opção correspondente selecionada [${matchedIndex + 1}/${optionsTexts.length}]: "${selectedText}"`);
      await optionLocators[matchedIndex].click().catch(() => {});
      optionClicked = true;
    }

    if (!optionClicked) {
      console.warn(`${tag}     [AVISO] Nenhuma opção exata ou por palavra (\\b) para "${searchValue}" foi encontrada nas opções:`, optionsTexts);
      const highlightedLoc = page.locator('.select2-results__option--highlighted, .select2-results__option[aria-selected="true"]').first();
      if (await highlightedLoc.isVisible().catch(() => false)) {
        console.log(`${tag}     [FALLBACK] Clicando na opção destacada...`);
        await highlightedLoc.click().catch(() => {});
        optionClicked = true;
      } else {
        throw new Error(`A busca por "${searchValue}" no campo "${fieldLabel}" não retornou nenhuma opção válida que corresponda exatamente ao NCM/Serial.`);
      }
    }
  } else {
    // Se for um elemento <select> HTML padrão sem Select2 ativo
    const selectElem = page.locator(`#id_${fieldName}, select[name="${fieldName}"]`).first();
    if (await selectElem.isVisible().catch(() => false)) {
      console.log(`${tag}     [SELECT STANDARD] Selecionando no <select> padrão...`);
      const options = await selectElem.locator('option').allTextContents();
      const matchedIndex = findBestMatchingOptionIndex(options, searchValue);

      if (matchedIndex !== -1) {
        await selectElem.selectOption({ label: options[matchedIndex] });
      } else {
        throw new Error(`Opção exata contendo "${searchValue}" não foi encontrada no <select> de "${fieldLabel}".`);
      }
    } else {
      throw new Error(`O campo de busca do dropdown "${fieldLabel}" não ficou visível após o clique.`);
    }
  }

  await page.waitForTimeout(300);
}

/**
 * Processa um lote (chunk) de itens em uma aba isolada do navegador.
 */
async function processWorkerChunk(
  workerId: number,
  context: BrowserContext,
  itemsChunk: ChunkItem[],
  totalGlobalItems: number,
  results: ProcessResult[]
): Promise<void> {
  console.log(`[ABA #${workerId}] Iniciada. Lote alocado: ${itemsChunk.length} item(ns).`);
  let page = await context.newPage();

  for (let i = 0; i < itemsChunk.length; i++) {
    const { item, globalIndex } = itemsChunk[i];

    console.log(`\n[ABA #${workerId}] [ITEM ${globalIndex + 1}/${totalGlobalItems}] Processando Serial: "${item.serial_number}" | NCM: "${item.ncm}"`);

    try {
      if (page.isClosed()) {
        console.log(`[ABA #${workerId}] [RECOVERY] A aba estava fechada. Recriando nova aba...`);
        page = await context.newPage();
      }

      if (!page.url().includes('/customerdevice/add/')) {
        await page.goto(REGISTRAR_URL, { waitUntil: 'domcontentloaded' });
      }

      // 1. Preencher Device (Serial Number)
      await fillDropdownField(page, 'Device', item.serial_number, workerId);

      // 2. Preencher Customer (NCM)
      await fillDropdownField(page, 'Customer', item.ncm, workerId);

      // 3. Salvar item
      console.log(`[ABA #${workerId}]   -> Clicando em "Save and add another"...`);
      const saveAndAddBtn = page.locator('input[name="_addanother"], button[name="_addanother"], button:has-text("Save and add another"), input[value*="Save and add another" i]').first();
      
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
        saveAndAddBtn.click(),
      ]);

      results.push({
        index: globalIndex + 1,
        serialNumber: item.serial_number,
        ncm: item.ncm,
        status: 'SUCCESS',
      });
      console.log(`[ABA #${workerId}] [ITEM ${globalIndex + 1}/${totalGlobalItems}] Concluído com sucesso!`);

    } catch (err: any) {
      console.error(`[ABA #${workerId}] [ERRO ITEM ${globalIndex + 1}] Falha ao processar: ${err.message}`);
      results.push({
        index: globalIndex + 1,
        serialNumber: item.serial_number,
        ncm: item.ncm,
        status: 'FAILED',
        details: err.message,
      });

      if (page.isClosed()) {
        console.log(`[ABA #${workerId}] [RECOVERY] Recriando aba após erro...`);
        page = await context.newPage().catch(() => page);
      }

      await page.goto(REGISTRAR_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    }
  }

  await page.close().catch(() => {});
  console.log(`[ABA #${workerId}] Concluída com sucesso! (${itemsChunk.length} itens processados).`);
}

/**
 * Função principal de execução da automação.
 */
async function main() {
  console.log('=== Iniciando Automação Nonius Dongle Registrar (Multi-Tab Concurrency) ===\n');

  const csvPath = resolveCsvFilePath();
  const items = loadCsvItems(csvPath);

  console.log(`[CONCURRENCY] Configuração de paralelismo: ${CONCURRENCY} aba(s) simultânea(s).`);

  const hasSession = fs.existsSync(SESSION_FILE);
  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ['--start-maximized'],
  });

  const context = await browser.newContext({
    storageState: hasSession ? SESSION_FILE : undefined,
    viewport: null,
  });

  // Aba temporária para verificar/realizar autenticação no SSO
  const authPage = await context.newPage();
  await handleAuthenticationIfNeeded(context, authPage);
  await authPage.close().catch(() => {});

  const total = items.length;
  const numWorkers = Math.min(CONCURRENCY, total);
  const itemsPerWorker = Math.ceil(total / numWorkers);

  console.log(`\n[DISTRIBUIÇÃO] Alocando ${total} itens entre ${numWorkers} aba(s) (~${itemsPerWorker} por aba)...`);

  const results: ProcessResult[] = [];
  const workerPromises: Promise<void>[] = [];

  for (let w = 0; w < numWorkers; w++) {
    const start = w * itemsPerWorker;
    const end = Math.min(start + itemsPerWorker, total);
    if (start >= end) break;

    const chunk: ChunkItem[] = items.slice(start, end).map((item, idx) => ({
      item,
      globalIndex: start + idx,
    }));

    workerPromises.push(
      processWorkerChunk(w + 1, context, chunk, total, results)
    );
  }

  // Executa todas as abas em paralelo
  await Promise.all(workerPromises);

  // Ordena os resultados finais pela ordem original do CSV
  results.sort((a, b) => a.index - b.index);

  // Atualiza sessão salva no disco
  if (results.some(r => r.status === 'SUCCESS')) {
    await context.storageState({ path: SESSION_FILE }).catch(() => {});
  }

  console.log('\n==================================================');
  console.log('              RELATÓRIO DE EXECUÇÃO               ');
  console.log('==================================================');
  const successes = results.filter(r => r.status === 'SUCCESS').length;
  const failures = results.filter(r => r.status === 'FAILED').length;

  console.log(`Total de itens no CSV : ${results.length}`);
  console.log(`Sucessos              : ${successes}`);
  console.log(`Falhas                : ${failures}`);

  if (failures > 0) {
    console.log('\nDetalhamento das Falhas:');
    results.filter(r => r.status === 'FAILED').forEach(r => {
      console.log(` - Item #${r.index} [Serial: ${r.serialNumber}, NCM: ${r.ncm}]: ${r.details}`);
    });
  }
  console.log('==================================================\n');

  await browser.close().catch(() => {});
}

main().catch(err => {
  console.error('[ERRO CRÍTICO]', err);
  process.exit(1);
});

