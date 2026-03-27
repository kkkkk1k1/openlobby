import { execSync } from 'node:child_process';
import { cpSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..', '..');

console.log('[1/3] Building web frontend...');
execSync('pnpm --filter @openlobby/web build', { cwd: rootDir, stdio: 'inherit' });

console.log('[2/3] Bundling server with esbuild...');
await build({
  entryPoints: [join(__dirname, 'src', 'bin.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: join(__dirname, 'dist', 'bin.js'),
  external: [
    'better-sqlite3',
    // Native / optional deps that shouldn't be bundled
    'fsevents',
  ],
  banner: {
    js: [
      '// openlobby - Unified AI Agent Session Manager',
      'import { createRequire } from "node:module";',
      'const require = createRequire(import.meta.url);',
    ].join('\n'),
  },
  sourcemap: true,
  minify: false,
  // Resolve workspace packages
  alias: {
    '@openlobby/core': join(rootDir, 'packages', 'core', 'src', 'index.ts'),
    '@openlobby/server': join(rootDir, 'packages', 'server', 'src', 'index.ts'),
  },
});

console.log('[3/3] Copying web assets...');
const webDist = join(rootDir, 'packages', 'web', 'dist');
const cliWeb = join(__dirname, 'web');
if (existsSync(cliWeb)) {
  rmSync(cliWeb, { recursive: true });
}
cpSync(webDist, cliWeb, { recursive: true });

console.log('✓ Build complete!');
console.log(`  Bundle: ${join(__dirname, 'dist', 'bin.js')}`);
console.log(`  Web:    ${cliWeb}`);
