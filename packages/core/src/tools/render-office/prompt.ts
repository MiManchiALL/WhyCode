import {
  OFFICE_RENDER_MAX_PAGES,
  OFFICE_RENDER_OVERVIEW_MAX_PAGES,
} from '../../office/types.ts'

export const RENDER_OFFICE_TOOL_NAME = 'RenderOffice'

export const RENDER_OFFICE_PROMPT = `${RENDER_OFFICE_TOOL_NAME} 在后台把 DOCX、PPTX 或 XLSX 转为 PDF 页面并直接交给当前视觉模型，不打开 Office 窗口、不切换焦点，也不使用桌面截图。本工具必须独占一个模型步骤，不能与 InspectOffice 或任何其它工具同时调用。view=pages 每次最多 ${OFFICE_RENDER_MAX_PAGES} 页，用于逐页检查文字、裁切和对象细节；view=overview 每次最多 ${OFFICE_RENDER_OVERVIEW_MAX_PAGES} 页并合成一张总览图，用于模板选页和整套页序、构图轮廓、视觉密度与节奏检查。模板任务规划前先看原件 overview，再用 pages 检查候选源页；最终文件先看 overview，再用 pages 连续查看全部页面。必须修复裁切、重叠、错误换行、缺字、失真图表、空白页、单调重复轮廓和不一致版式后重新渲染。结构、公式和内容仍由 InspectOffice 复核；渲染成功不能替代结构检查。`
