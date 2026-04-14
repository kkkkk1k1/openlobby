import { execSync } from 'node:child_process';
import { cpSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..', '..');

const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8'));
const VERSION = pkg.version;

console.log('[1/5] Building web frontend...');
execSync('pnpm --filter @openlobby/web build', { cwd: rootDir, stdio: 'inherit' });

const commonBanner = {
  js: [
    '// openlobby - Unified AI Agent Session Manager',
    'import { createRequire } from "node:module";',
    'const require = createRequire(import.meta.url);',
  ].join('\n'),
};

const nativeExternals = [
  'better-sqlite3',
  '@homebridge/node-pty-prebuilt-multiarch',
  'fsevents',
];

const workspaceAlias = {
  '@openlobby/core': join(rootDir, 'packages', 'core', 'src', 'index.ts'),
  '@openlobby/server': join(rootDir, 'packages', 'server', 'src', 'index.ts'),
  'openlobby-channel-telegram': join(rootDir, 'packages', 'channel-telegram', 'src', 'index.ts'),
};

console.log(`[2/5] Bundling wrapper (bin.js) — v${VERSION}...`);
await build({
  entryPoints: [join(__dirname, 'src', 'bin.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: join(__dirname, 'dist', 'bin.js'),
  external: nativeExternals,
  banner: commonBanner,
  define: {
    VERSION: JSON.stringify(VERSION),
  },
  sourcemap: true,
  minify: false,
  alias: workspaceAlias,
});

console.log('[3/5] Bundling server-main.js...');
await build({
  entryPoints: [join(__dirname, 'src', 'server-main.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: join(__dirname, 'dist', 'server-main.js'),
  external: nativeExternals,
  banner: commonBanner,
  define: {
    VERSION: JSON.stringify(VERSION),
  },
  sourcemap: true,
  minify: false,
  alias: workspaceAlias,
});

console.log('[4/5] Bundling MCP server...');
await build({
  entryPoints: [join(rootDir, 'packages', 'server', 'src', 'mcp-server.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: join(__dirname, 'dist', 'mcp-server.js'),
  external: [],
  banner: {
    js: [
      'import { createRequire } from "node:module";',
      'const require = createRequire(import.meta.url);',
    ].join('\n'),
  },
  sourcemap: false,
  minify: false,
});

console.log('[5/5] Copying web assets...');
const webDist = join(rootDir, 'packages', 'web', 'dist');
const cliWeb = join(__dirname, 'web');
if (existsSync(cliWeb)) {
  rmSync(cliWeb, { recursive: true });
}
cpSync(webDist, cliWeb, { recursive: true });

cpSync(join(rootDir, 'README.md'), join(__dirname, 'README.md'));

console.log('✓ Build complete!');
console.log(`  Version:      ${VERSION}`);
console.log(`  Wrapper:      ${join(__dirname, 'dist', 'bin.js')}`);
console.log(`  Server:       ${join(__dirname, 'dist', 'server-main.js')}`);
console.log(`  Web:          ${cliWeb}`);
