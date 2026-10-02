export interface EmbeddedOfficeSkillFile {
  relativePath: string
  content: string
}

export function officeSkillDocument(...lines: string[]): string {
  return `${lines.join('\n')}\n`
}

export const OFFICE_EXECUTION_GUIDE: readonly string[] = [
  "## 执行环境",
  "",
  "WhyCode 在加载本 Skill 时自动准备所需环境，并在正文末尾追加本次运行环境声明。下面的 NODE/RUN/OFFICE/CHECK 分别代表声明中的 `node`、`run`、`office`、`check`，替换为实际绝对路径并按当前 shell 引用；PowerShell 执行带引号的可执行路径要加 `&`。",
  "",
  "- 生成或修改：`NODE RUN /绝对路径/task.mjs`。脚本是普通 Node ESM，可以读写文件；支持 import `docx`、`pptxgenjs`、`exceljs`、`jszip`、`fast-xml-parser`。库解析由 RUN 负责，不必在项目中安装依赖。",
  "- 检查：`NODE CHECK /绝对路径/output.docx --contains \"必需文字\" --offset 0 --limit 20`。DOCX 按段落、PPTX 按幻灯片、XLSX 按工作表分页；返回 nextOffset 时继续读取。`--count N` 核对上述单位数量。结构报告有界，全文提取或复杂对象分析可用脚本读取 OOXML。",
  "- 页面预览：`NODE OFFICE render --input /绝对路径/output.docx --output-dir /绝对路径/preview --pages 1,2 --dpi 144`。输出目录必须尚不存在；结果 JSON 给出图片路径，用通用 ViewImage 实际查看。",
  "- PDF：`NODE OFFICE convert --input /绝对路径/output.docx --output /绝对路径/output.pdf`。",
  "",
  "SSH 会话的这些路径和命令都属于服务器；直接在服务器读取素材、生成与检查，不把工作交给本机。依赖准备失败时如实说明原因。缺少适用字体时指定服务器已有字体目录 `--font-directory /path/to/fonts`，或在获得授权后准备所需字体；不要把缺字或替代字体造成的漂移当作检查通过。",
  "",
  "渲染、转换和重算由 LibreOffice 引擎执行，版式和公式兼容性可能与 Microsoft Office 不同。执行默认限时 120 秒，可按实际规模用 `--timeout-ms` 调整至最多 600 秒；失败会以非零退出码和 JSON 原因返回。无需启动桌面 Office。",
]
