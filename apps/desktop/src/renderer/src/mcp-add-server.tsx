import { useState } from 'react'
import { Plus } from 'lucide-react'
import type { AddMcpServerRequest } from '../../shared/settings.ts'
import { SelectMenu } from './select-menu.tsx'
import {
  SettingsActionRow,
  SettingsButton,
  SettingsPanel,
  SettingsRow,
} from './settings-layout.tsx'

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
      <div className="flex justify-end">
        <SettingsButton onClick={() => setOpen(true)} disabled={props.disabled}>
          <Plus size={14} />
          添加 MCP 服务
        </SettingsButton>
      </div>
    )
  }

  return (
    <SettingsPanel padded={false}>
      <div className="px-4 py-3">
        <p className="text-sm font-medium text-[var(--wc-ink)]">添加 MCP 服务</p>
        <p className="mt-0.5 wc-type-caption text-[var(--wc-muted)]">
          配置常用连接参数；低频协议选项继续保留在高级配置文件中。
        </p>
      </div>
      <SettingsRow label="名称" description="在配置和工具目录中使用的稳定名称。">
        <input
          className="wc-settings-input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="例如 github"
          disabled={props.disabled}
        />
      </SettingsRow>
      <SettingsRow label="作用域" description="项目配置只对当前项目生效。">
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
      </SettingsRow>
      <SettingsRow label="连接类型">
        <div className="flex flex-wrap gap-1.5 sm:justify-end">
          {(['http', 'stdio'] as const).map((value) => (
            <SettingsButton
              key={value}
              variant={transport === value ? 'primary' : 'secondary'}
              aria-pressed={transport === value}
              onClick={() => setTransport(value)}
              disabled={props.disabled}
            >
              {value === 'http' ? 'Streamable HTTP' : 'stdio'}
            </SettingsButton>
          ))}
        </div>
      </SettingsRow>

      {transport === 'http' ? (
        <SettingsRow label="服务 URL">
          <input
            className="wc-settings-input"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://example.com/mcp"
            disabled={props.disabled}
          />
        </SettingsRow>
      ) : (
        <>
          <SettingsRow label="启动命令">
            <input
              className="wc-settings-input"
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              placeholder="node"
              disabled={props.disabled}
            />
          </SettingsRow>
          <SettingsRow label="工作目录" description="可选；留空时使用默认工作目录。">
            <input
              className="wc-settings-input"
              value={cwd}
              onChange={(event) => setCwd(event.target.value)}
              disabled={props.disabled}
            />
          </SettingsRow>
          <SettingsRow label="参数" description="每行一个；参数内的空格会原样保留。">
            <textarea
              className="wc-settings-input min-h-20 resize-y"
              value={args}
              onChange={(event) => setArgs(event.target.value)}
              placeholder={'-y\n@example/mcp-server'}
              disabled={props.disabled}
            />
          </SettingsRow>
        </>
      )}

      <SettingsActionRow>
        <SettingsButton
          onClick={() => setOpen(false)}
          disabled={props.disabled}
        >
          取消
        </SettingsButton>
        <SettingsButton
          variant="primary"
          onClick={() => void submit()}
          disabled={props.disabled || !name.trim() || (
            transport === 'http' ? !url.trim() : !command.trim()
          )}
        >
          添加并启用
        </SettingsButton>
      </SettingsActionRow>
    </SettingsPanel>
  )
}
