// 用 esbuild 把验证脚本连同 @ 别名依赖一起打包后在 node 中运行。
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { writeFileSync, rmSync } from 'node:fs'

const storage = new Map()
const localStorageShim = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
  clear: () => storage.clear(),
}

const result = await build({
  entryPoints: ['scripts-test/verify.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  alias: { '@': new URL('../src', import.meta.url).pathname },
})
const outfile = 'scripts-test/.verify.bundle.mjs'
writeFileSync(outfile, result.outputFiles[0].text)

globalThis.window = { localStorage: localStorageShim }
globalThis.localStorage = localStorageShim

try {
  await import(pathToFileURL(new URL('.verify.bundle.mjs', import.meta.url).pathname).href)
} finally {
  rmSync(outfile, { force: true })
}
