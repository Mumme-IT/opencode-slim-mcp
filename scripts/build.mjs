import { build } from 'esbuild'
import { chmod } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'

await build({ entryPoints: { server: 'src/server/index.ts', cli: 'src/cli/index.ts', rpc: 'src/rpc.ts' }, outdir: 'dist', bundle: true, packages: 'external', format: 'esm', platform: 'node', target: 'node24', sourcemap: true })
execFileSync('node_modules/.bin/tsc', ['--declaration', '--emitDeclarationOnly', '--noEmit', 'false', '--outDir', 'dist/types', '--rootDir', 'src', '--project', 'tsconfig.build.json'], { stdio: 'inherit' })
await chmod('dist/cli.js', 0o755)
