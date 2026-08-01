import {
  OFFICE_INSPECT_MAX_TEXT_CHARS,
  OFFICE_INSPECT_MAX_UNITS,
  OfficeProcessingError,
  type OfficeInspectionUnit,
} from '@whycode/core/office'
import { boundedText } from './xml.ts'

export function selectInspectionUnits(
  units: readonly OfficeInspectionUnit[],
  startUnit: number,
  unitCount: number,
): { units: OfficeInspectionUnit[]; nextUnit: number | null } {
  if (!Number.isSafeInteger(startUnit) || startUnit < 1) {
    throw new OfficeProcessingError('invalid-range', 'startUnit 必须是正整数')
  }
  if (!Number.isSafeInteger(unitCount) || unitCount < 1 || unitCount > OFFICE_INSPECT_MAX_UNITS) {
    throw new OfficeProcessingError(
      'invalid-range',
      `unitCount 必须是 1-${OFFICE_INSPECT_MAX_UNITS} 的整数`,
    )
  }
  if (units.length === 0) {
    if (startUnit !== 1) throw new OfficeProcessingError('invalid-range', 'Office 文件没有可读取的结构单元')
    return { units: [], nextUnit: null }
  }
  if (startUnit > units.length) {
    throw new OfficeProcessingError('invalid-range', `startUnit 超过结构单元总数 ${units.length}`)
  }

  const selected: OfficeInspectionUnit[] = []
  let remainingChars = OFFICE_INSPECT_MAX_TEXT_CHARS
  for (const unit of units.slice(startUnit - 1, startUnit - 1 + unitCount)) {
    if (remainingChars <= 0) break
    const text = boundedText(unit.text, remainingChars)
    selected.push({ ...unit, text })
    remainingChars -= text.length
    if (text.length < unit.text.length) break
  }
  const consumedThrough = selected.at(-1)?.index ?? startUnit - 1
  return {
    units: selected,
    nextUnit: consumedThrough < units.length ? consumedThrough + 1 : null,
  }
}
