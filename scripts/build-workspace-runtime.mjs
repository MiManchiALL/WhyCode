import { mkdir, readFile, copyFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = join(root, 'workspace-runtime/office')
const target = join(root, 'apps/desktop/resources/office')
const files = ['package.json', 'package-lock.json', 'run.mjs', 'office.mjs', 'check.mjs']
const hash = createHash('sha256')
await mkdir(target, { recursive: true })
for (const file of files) {
  hash.update(file).update(await readFile(join(source, file)))
  await copyFile(join(source, file), join(target, file))
}
await writeFile(join(target, 'source.sha256'), hash.digest('hex'))
