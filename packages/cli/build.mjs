// Bundles the sfi CLI into a single self-contained dist/index.js.
//
// Only @sf-intelligence/* internal packages are inlined. Third-party deps stay
// external (npm installs them at consume time); @duckdb/node-api is a native
// module and MUST stay external. Keep EXTERNAL in sync with package.json
// "dependencies". Run AFTER `tsc --build` (this bundles the compiled dist/src).
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

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
