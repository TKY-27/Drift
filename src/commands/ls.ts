import { ContractStore } from '../core/store.js';
import { renderLs } from '../reporters/terminal.js';
import { renderJson } from '../reporters/json.js';
import { loadConfig } from '../utils/config.js';

export function lsCommand(rootDir: string, file: string | undefined, options: { reporter?: string } = {}): void {
  const config = loadConfig(rootDir);
  const store = new ContractStore(rootDir);
  const loaded = file ? store.load(file) : null;
  if (file && !loaded) {
    process.stderr.write(`No contract file found for ${file}\n`);
    process.exitCode = 1;
    return;
  }
  const files = file ? [loaded].filter((item) => item !== null) : store.listFiles().map((contractPath) => store.load(sourceFromContractPath(store.contractsDir, contractPath))).filter((item) => item !== null);
  const reporter = options.reporter ?? config.reporter;
  process.stdout.write(reporter === 'json' ? renderJson(files) : `${renderLs(files)}\n`);
}

function sourceFromContractPath(contractsDir: string, contractPath: string): string {
  const relative = contractPath.slice(contractsDir.length + 1).replaceAll('\\', '/');
  return relative.endsWith('.json') ? relative.slice(0, -'.json'.length) : relative;
}
