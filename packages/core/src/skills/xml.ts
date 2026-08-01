/** Skill 提示容器的 XML 转义；正文保持原文，结构字段不得突破标签边界。 */
export function escapeSkillXmlText(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '\uFFFD')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

export function escapeSkillXmlAttribute(value: string): string {
  return escapeSkillXmlText(value)
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
    .replaceAll('\r', '&#13;')
    .replaceAll('\n', '&#10;')
    .replaceAll('\t', '&#9;')
}
