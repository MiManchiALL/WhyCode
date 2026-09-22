export const BUILD_OFFICE_ARTIFACT_TOOL_NAME = 'BuildOfficeArtifact'

export const BUILD_OFFICE_ARTIFACT_PROMPT = `${BUILD_OFFICE_ARTIFACT_TOOL_NAME} 在限时限内存、无 Node 权限的 SES 隔离区执行 JavaScript 构建函数，验证后原子写入 DOCX、PPTX 或 XLSX。调用前读取对应 Office Skill 的 references/builder-api.md；PPTX 模板还需读取 references/template-following.md。

先用 WriteFile 保存一个任务 builder，求值结果必须是 async ({ docx, PptxGenJS, ExcelJS, JSZip, fastXml, OfficeTemplate, assets, report }) => artifact。不要 import、require、访问文件系统、启动进程或自行写输出。不要依赖 Date/Intl 获取环境时间，使用上下文中的明确日期。DOCX 返回 docx.Document 或 OOXML bytes，PPTX 返回 PptxGenJS 实例或 bytes，XLSX 返回 ExcelJS.Workbook 或 bytes。assets 含 name、extension、bytes、base64、dataUri 和 text；UTF-8/JSON 用 text，例如 JSON.parse(assets.data.text)，不要用 bytes.toString() 解码。

mode=create 用于新建；编辑原件或采用指定模板/参考设计用 mode=template，并提供模板 asset 和 templateAssetKey。文件仅作为内容素材时不推定它控制设计。PPTX 依据用户要求决定保留范围，优先复制源页、编辑现有对象；允许的重排不受原对象位置、尺寸或顺序限制。pptxTemplateRequirements 只声明任务确实要求的画幅、参考版式覆盖率或占位符约束，未要求的省略，不自行编造复用比例。PPTX 始终检查源文件和输出结构；程序检查不证明 Logo、配色、内容或整体设计合格，仍需读取并渲染对照。DOCX/XLSX 模板继续保留共享样式、媒体与格式锚点。

模板复制接口为 OfficeTemplate.docx({ template: assets.template.bytes, textEdits, rangeEdits }) 和 OfficeTemplate.pptx({ template: assets.template.bytes, slides })，直接返回 bytes，不接收裸 bytes 或返回带 slide/replaceShapeText 方法的对象。具体编辑字段以 builder-api.md 为准；超出辅助接口的局部编辑可使用 JSZip/fastXml 操作已检查的目标，保证 XML 和关系完整。XLSX 用 ExcelJS load 后局部修改；含公式时发布前实际重算并复查，没有可用引擎或仍有公式错误则失败。

报错后修正同一个 builder，不要用相同参数盲目重试；不要改用 RunCommand/WriteFile 手写、打包或覆盖最终 OOXML。成功后用 InspectOffice 核对内容、对象、样式和结构；视觉可用时用 RenderOffice overview 检查整套，再用 pages 复核所有最终页。`
