import { stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export async function findProjectRoot(projectDir: string): Promise<string> {
  let current = projectDir
  while (true) {
    try {
      await stat(join(current, '.git'))
      return current
    } catch (error) {
      if (!isMissingPath(error)) throw error
    }
    const parent = dirname(current)
    if (parent === current) return projectDir
    current = parent
  }
}

function isMissingPath(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR'),
  )
}
