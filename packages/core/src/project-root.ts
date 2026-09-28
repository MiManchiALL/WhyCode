import { localWorkspaceIO, type WorkspaceIO } from './workspace/io.ts'

export async function findProjectRoot(projectDir: string, io: WorkspaceIO = localWorkspaceIO): Promise<string> {
  const { stat } = io.fs
  const { dirname, join } = io.path
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
