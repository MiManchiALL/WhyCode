import type {
  OfficeInspectOptions,
  OfficeInspection,
  OfficeInspectionUnit,
  OfficeValidation,
} from '@whycode/core/office'
import type { OfficeArchive } from './archive.ts'
import { sortedEntries } from './archive.ts'
import { readRelationships } from './relationships.ts'
import { selectInspectionUnits } from './selection.ts'

type InspectionWithoutValidation = Omit<OfficeInspection, 'validation'>

export async function relationshipView(
  archive: OfficeArchive,
  inspection: InspectionWithoutValidation,
  options: OfficeInspectOptions,
): Promise<InspectionWithoutValidation> {
  const units: OfficeInspectionUnit[] = []
  for (const entry of sortedEntries(archive.zip, /(?:^|\/)_[Rr]els\/[^/]*\.rels$/)) {
    const relationships = await readRelationships(archive, entry.name)
    for (const relationship of relationships) {
      const index = units.length + 1
      units.push({
        index,
        label: `关系 ${index}：${relationship.id}`,
        kind: 'relationship',
        locator: `${entry.name}#${relationship.id}`,
        text: [
          `类型：${relationship.type}`,
          `目标：${relationship.target}`,
          `模式：${relationship.external ? '外部' : '包内'}`,
        ].join('\n'),
      })
    }
  }
  return selectViewUnits(inspection, units, options)
}

export function validationView(
  inspection: InspectionWithoutValidation,
  validation: OfficeValidation,
  options: OfficeInspectOptions,
): InspectionWithoutValidation {
  const units: OfficeInspectionUnit[] = validation.issues.length > 0
    ? validation.issues.map((issue, position) => ({
      index: position + 1,
      label: `${issue.severity === 'error' ? '错误' : '警告'}：${issue.code}`,
      kind: 'validation-issue',
      locator: issue.location,
      text: issue.message,
    }))
    : [{
      index: 1,
      label: '深层校验通过',
      kind: 'validation-summary',
      locator: '[Content_Types].xml',
      text: `已检查 ${validation.checkedPartCount} 个 XML/关系部件、${validation.relationshipCount} 条关系，没有发现错误或警告。`,
    }]
  return selectViewUnits(inspection, units, options)
}

export function selectViewUnits(
  inspection: InspectionWithoutValidation,
  units: readonly OfficeInspectionUnit[],
  options: OfficeInspectOptions,
): InspectionWithoutValidation {
  const selected = selectInspectionUnits(units, options.startUnit, options.unitCount)
  return {
    ...inspection,
    unitKind: 'object',
    unitCount: units.length,
    units: selected.units,
    nextUnit: selected.nextUnit,
  }
}
