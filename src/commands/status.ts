import { ContractStore } from '../core/store.js';
import { renderStatus } from '../reporters/terminal.js';
import { renderJson } from '../reporters/json.js';
import { loadConfig } from '../utils/config.js';

export function statusCommand(rootDir: string, options: { reporter?: string } = {}): void {
  const config = loadConfig(rootDir);
  const store = new ContractStore(rootDir);
  const stats = store.stats();
  const reporter = options.reporter ?? config.reporter;
  process.stdout.write(reporter === 'json' ? renderJson(stats) : `${renderStatus(stats)}\n`);
}
