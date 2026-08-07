import { useState } from 'react'
import type { AddMcpServerRequest } from '../../shared/settings.ts'
import { PaperFrame } from './paper-frame.tsx'
import { SelectMenu } from './select-menu.tsx'

interface McpAddServerProps {
  hasProject: boolean
  disabled: boolean
  onAdd: (request: AddMcpServerRequest) => Promise<boolean>
}

export function McpAddServer(props: McpAddServerProps) {
  const [open, setOpen] = useState(false)
  const [scope, setScope] = useState<'global' | 'project'>('global')
  const [transport, setTransport] = useState<'http' | 'stdio'>('http')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [cwd, setCwd] = useState('')

  const submit = async () => {
    const server = transport === 'http'
      ? { transport, url }
      : {
          transport,
          command,
          args: args.split(/\r?\n/u).filter((argument) => argument.trim()),
          ...(cwd.trim() ? { cwd } : {}),
        }
    const saved = await props.onAdd({ scope, name, server })
    if (!saved) return
    setName('')
    setUrl('')
    setCommand('')
    setArgs('')
    setCwd('')
    setOpen(false)
  }

  if (!open) {
    return (
      <button
        className="mb-3 rounded border border-neutral-300 px-2 py-1 text-[11px] text-neutral-700 disabled:opacity-40"
        onClick={() => setOpen(true)}
        disabled={props.disabled}
      >
        + 添加 MCP 服务
      </button>
    )
  }

  const editor = (
    <div className="wc-paper-card wc-paper-white wc-paper-shape-d wc-paper-angle-soft-left wc-paper-pad min-w-0">
      <div className="grid gap-3 md:grid-cols-2">
        <label className="block min-w-0 text-[11px] text-neutral-600">
          名称
          <input
            className="mt-1 min-w-0 w-full rounded border border-neutral-300 bg-white px-2 py-1 text-xs"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如 github"
            disabled={props.disabled}
          />
        </label>
        <div className="min-w-0 text-[11px] text-neutral-600">
          <span className="mb-1 block">作用域</span>
          <SelectMenu
            value={scope}
            options={[
              { value: 'global', label: '全局' },
              ...(props.hasProject ? [{ value: 'project', label: '当前项目' }] : []),
            ]}
            onValueChange={(value) => setScope(value as 'global' | 'project')}
            ariaLabel="MCP 服务作用域"
            disabled={props.disabled}
            className="w-full"
          />
        </div>
      </div>

      <div className="mt-3 flex gap-1.5">
        {(['http', 'stdio'] as const).map((value) => (
          <button
            key={value}
            className={`rounded px-2 py-1 text-[11px] ${
              transport === value
                ? 'bg-neutral-900 text-white'
                : 'border border-neutral-300 bg-white text-neutral-600'
            }`}
            onClick={() => setTransport(value)}
            disabled={props.disabled}
          >
            {value === 'http' ? 'Streamable HTTP' : 'stdio'}
          </button>
        ))}
      </div>

      {transport === 'http' ? (
        <label className="mt-3 block min-w-0 text-[11px] text-neutral-600">
          URL
          <input
            className="mt-1 min-w-0 w-full rounded border border-neutral-300 bg-white px-2 py-1 text-xs"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://example.com/mcp"
            disabled={props.disabled}
          />
        </label>
      ) : (
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <label className="block min-w-0 text-[11px] text-neutral-600">
            启动命令
            <input
              className="mt-1 min-w-0 w-full rounded border border-neutral-300 bg-white px-2 py-1 text-xs"
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              placeholder="node"
              disabled={props.disabled}
            />
          </label>
          <label className="block min-w-0 text-[11px] text-neutral-600">
            工作目录（可选）
            <input
              className="mt-1 min-w-0 w-full rounded border border-neutral-300 bg-white px-2 py-1 text-xs"
              value={cwd}
              onChange={(event) => setCwd(event.target.value)}
              disabled={props.disabled}
            />
          </label>
          <label className="block min-w-0 text-[11px] text-neutral-600 md:col-span-2">
            参数（每行一个，空格不会被当作分隔符）
            <textarea
              className="mt-1 min-h-20 min-w-0 w-full rounded border border-neutral-300 bg-white px-2 py-1 text-xs"
              value={args}
              onChange={(event) => setArgs(event.target.value)}
              placeholder={'-y\n@example/mcp-server'}
              disabled={props.disabled}
            />
          </label>
        </div>
      )}

      <p className="mt-2 text-[10px] text-neutral-500">
        环境变量、额外 Header 和超时等低频选项继续使用高级配置文件，避免普通设置表单承载全部协议细节。
      </p>
      <div className="mt-3 flex gap-2">
        <button
          className="rounded bg-neutral-900 px-3 py-1 text-xs text-white disabled:opacity-40"
          onClick={() => void submit()}
          disabled={props.disabled || !name.trim() || (
            transport === 'http' ? !url.trim() : !command.trim()
          )}
        >
          添加并启用
        </button>
        <button
          className="rounded px-2 py-1 text-xs text-neutral-600 disabled:opacity-40"
          onClick={() => setOpen(false)}
          disabled={props.disabled}
        >
          取消
        </button>
      </div>
    </div>
  )
  return <PaperFrame className="wc-paper-frame-soft">{editor}</PaperFrame>
}
