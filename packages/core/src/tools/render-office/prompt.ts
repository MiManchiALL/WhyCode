import { OFFICE_RENDER_MAX_PAGES } from '../../office/types.ts'

export const RENDER_OFFICE_TOOL_NAME = 'RenderOffice'

export const RENDER_OFFICE_PROMPT = `${RENDER_OFFICE_TOOL_NAME} 在后台把 DOCX、PPTX 或 XLSX 转为 PDF 页面并直接交给当前视觉模型，不打开 Office 窗口、不切换焦点，也不使用桌面截图。每次最多 ${OFFICE_RENDER_MAX_PAGES} 页；用 startPage/pageCount 继续直到末页。必须实际查看全部最终渲染页，修复裁切、重叠、错误换行、缺字、失真图表、空白页和不一致版式后重新渲染。结构、公式和内容仍由 InspectOffice 复核；渲染成功不能替代结构检查。`
