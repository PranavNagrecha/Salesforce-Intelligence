// Bundles the sfi CLI into a single self-contained dist/index.js.
//
// Only @sf-intelligence/* internal packages are inlined. Third-party deps stay
// external (npm installs them at consume time); @duckdb/node-api is a native
// module and MUST stay external. Keep EXTERNAL in sync with package.json
// "dependencies". Run AFTER `tsc --build` (this bundles the compiled dist/src).
import { build } from 'esbuild';
import { cpSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
);

const EXTERNAL_PACKAGES = [
  '@inquirer/prompts',
  'commander',
  'fast-xml-parser',
  '@duckdb/node-api',
  '@modelcontextprotocol/sdk',
  'zod',
];
// Externalize each package and its subpath imports (e.g. .../sdk/server/index.js).
const external = EXTERNAL_PACKAGES.flatMap((name) => [name, `${name}/*`]);

await build({
  entryPoints: ['dist/src/index.js'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external,
  define: { SFI_BUILD_VERSION: JSON.stringify(pkg.version ?? '0.0.0') },
  logLevel: 'info',
});

console.log(`bundled -> dist/index.js (version ${pkg.version})`);

// Ship the synthetic demo org source so `sfi demo` (and `npx sf-intelligence demo`)
// can build + serve a no-org demo vault. The single source of truth lives at the repo
// root (examples/demo-vault/source); copy it into the package's whitelisted demo-source/
// at build time. The copy is gitignored and shipped via package.json "files".
const demoSrc = fileURLToPath(new URL('../../examples/demo-vault/source/main/default', import.meta.url));
const demoDestRoot = fileURLToPath(new URL('./demo-source', import.meta.url));
const demoDest = fileURLToPath(new URL('./demo-source/main/default', import.meta.url));
rmSync(demoDestRoot, { recursive: true, force: true });
cpSync(demoSrc, demoDest, { recursive: true });
console.log('copied demo source -> demo-source/');
