import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'node:test'
import { buildOfficeFile } from './build-engine.ts'

const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })))
})

export async function buildOfficeFixture(
  root: string,
  outputPath: string,
  format: 'docx' | 'pptx' | 'xlsx',
  source: string,
) {
  const scriptPath = join(root, `${format}-builder.js`)
  await writeFile(scriptPath, source, 'utf8')
  return buildOfficeFile({ format, scriptPath, outputPath, assets: [] })
}

export async function officeTempDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'whycode-office-engine-'))
  tempDirectories.push(path)
  return path
}
