import { createAdapterIntegrationTests } from './adapter-contract.js';
import { ClaudeCodeAdapter } from '../claude-code.js';

createAdapterIntegrationTests(() => new ClaudeCodeAdapter(), {
  spawnOverrides: { permissionMode: 'auto' },
});
