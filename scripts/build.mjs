/**
 * Build the dsh-remote-hosts client bundle.
 *
 * Produces lib/client.js in the exact wire format the DSH web shell expects:
 * a CJS factory handed to window.__ModuleLoader__.load({ id, factory }), with
 * platform modules resolved through the injected require (the loader module
 * table) and everything else inlined. Pattern copied from dsh-memory-evolve;
 * the only difference is esbuild is resolved from this package's own
 * devDependencies (no DSH_SOURCE checkout required).
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Loader entry name — must equal the patch row `name` EXACTLY. */
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const PLUGIN_ID = MANIFEST.name

/** Platform module table (must stay aligned with packages/client/web/src/platform.ts + the runtime exemption). */
const EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
]

const require = createRequire(join(ROOT, 'package.json'))
const esbuild = require('esbuild')

const banner = [
  `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
  'var module = { exports: {} }; var exports = module.exports;',
].join('\n')
const footer = 'return module.exports; } });'

await esbuild.build({
  entryPoints: [join(ROOT, 'src/client/index.tsx')],
  outfile: join(ROOT, 'lib/client.js'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  external: EXTERNALS,
  define: {
    'process.env.NODE_ENV': '"production"',
    'import.meta.env.MODE': '"production"',
    'import.meta.env': '{"MODE":"production"}',
  },
  loader: { '.css': 'text' },
  banner: { js: banner },
  footer: { js: footer },
})

console.log('lib/client.js built')
