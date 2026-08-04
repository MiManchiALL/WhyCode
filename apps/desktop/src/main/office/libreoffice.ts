import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'

export async function findLibreOffice(): Promise<string | null> {
  for (const candidate of libreOfficeCandidates(process.env, process.platform)) {
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {}
  }
  return null
}

export function libreOfficeCandidates(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string[] {
  const executableNames = platform === 'win32'
    ? ['soffice.exe', 'libreoffice.exe']
    : ['libreoffice', 'soffice']
  const fromPath = (environment.PATH ?? '').split(delimiter)
    .filter(Boolean)
    .flatMap((directory) => executableNames.map((name) => resolve(directory, name)))
  const common = platform === 'win32'
    ? [environment.ProgramFiles, environment['ProgramFiles(x86)']]
      .filter((value): value is string => Boolean(value))
      .map((directory) => join(directory, 'LibreOffice', 'program', 'soffice.exe'))
    : platform === 'darwin'
      ? ['/Applications/LibreOffice.app/Contents/MacOS/soffice']
      : ['/usr/bin/libreoffice', '/usr/bin/soffice', '/snap/bin/libreoffice']
  return [...new Set([...fromPath, ...common])]
}
