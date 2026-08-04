import { editDocxTemplate } from './template-docx.ts'
import { createPptxFromTemplate } from './template-pptx.ts'

export const OFFICE_TEMPLATE_CAPABILITY = Object.freeze({
  docx: editDocxTemplate,
  pptx: createPptxFromTemplate,
})
