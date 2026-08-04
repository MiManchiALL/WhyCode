export interface EmbeddedOfficeSkillFile {
  relativePath: string
  content: string
}

export function officeSkillDocument(...lines: string[]): string {
  return `${lines.join('\n')}\n`
}
