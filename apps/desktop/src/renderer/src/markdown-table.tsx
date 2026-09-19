import { useEffect, useRef, useState, type ComponentProps } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Copy, Download } from 'lucide-react'
import { extractTableDataFromElement, tableDataToCSV, tableDataToMarkdown, tableDataToTSV } from 'streamdown'

const formats = {
  md: { label: 'Markdown', mime: 'text/markdown', serialize: tableDataToMarkdown },
  csv: { label: 'CSV', mime: 'text/csv', serialize: tableDataToCSV },
  tsv: { label: 'TSV', mime: 'text/tab-separated-values', serialize: tableDataToTSV },
}
type Format = keyof typeof formats

export function MarkdownTable({ node: _node, className = '', children, ...props }: ComponentProps<'table'> & { node?: unknown }) {
  const table = useRef<HTMLTableElement>(null)
  const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null)
  useEffect(() => {
    if (!feedback) return
    const timer = setTimeout(() => setFeedback(null), feedback.error ? 4000 : 1600)
    return () => clearTimeout(timer)
  }, [feedback])
  const act = async (action: 'copy' | 'download', format: Format) => {
    if (!table.current) return
    const selected = formats[format]
    const text = selected.serialize(extractTableDataFromElement(table.current))
    try {
      if (action === 'copy') await navigator.clipboard.writeText(text)
      else {
        const url = URL.createObjectURL(new Blob([format === 'md' ? text : `\uFEFF${text}`], { type: `${selected.mime};charset=utf-8` }))
        try {
          const link = document.createElement('a')
          link.href = url
          link.download = `table.${format}`
          link.click()
        } finally { URL.revokeObjectURL(url) }
      }
      setFeedback({ text: action === 'copy' ? `已复制 ${selected.label}` : '已开始下载', error: false })
    } catch (error) {
      setFeedback({ text: `${action === 'copy' ? '复制' : '下载'}失败：${error instanceof Error ? error.message : String(error)}`, error: true })
    }
  }
  return <div className="wc-markdown-table">
    <div className="flex min-h-9 items-center justify-end gap-1 px-2 py-1">
      {feedback && <span role={feedback.error ? 'alert' : 'status'} className={`mr-auto min-w-0 truncate text-xs ${feedback.error ? 'text-[var(--wc-danger)]' : 'text-[var(--wc-muted)]'}`} title={feedback.text}>{feedback.text}</span>}
      <TableActionMenu action="copy" onSelect={format => void act('copy', format)} />
      <TableActionMenu action="download" onSelect={format => void act('download', format)} />
    </div>
    <div className="wc-scrollbar overflow-x-auto">
      <table {...props} ref={table} data-streamdown="table" className={`w-full border-collapse ${className}`}>{children}</table>
    </div>
  </div>
}

function TableActionMenu({ action, onSelect }: { action: 'copy' | 'download'; onSelect: (format: Format) => void }) {
  const label = action === 'copy' ? '复制表格' : '下载表格'
  const Icon = action === 'copy' ? Copy : Download
  return <DropdownMenu.Root>
    <DropdownMenu.Trigger asChild><button type="button" className="wc-icon-button size-7" title={label} aria-label={label}><Icon size={15} /></button></DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content align="end" sideOffset={5} collisionPadding={8} className="wc-menu-content">
        {(Object.keys(formats) as Format[]).map(format => <DropdownMenu.Item key={format} className="wc-menu-item" onSelect={() => onSelect(format)}>{formats[format].label}</DropdownMenu.Item>)}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>
}
