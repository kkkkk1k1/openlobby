import { createAdapterIntegrationTests } from './adapter-contract.js';
import { CodexCliAdapter } from '../codex-cli.js';

createAdapterIntegrationTests(() => new CodexCliAdapter(), {
  spawnOverrides: { permissionMode: 'auto' },
});
