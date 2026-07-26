import { useState } from 'react'
import type {
  McpSettingsItem,
  SaveMcpSecretHeaderRequest,
} from '../../shared/settings.ts'

interface McpSecretHeaderEditorProps {
  server: McpSettingsItem['servers'][number]
  disabled: boolean
  onSave: (request: SaveMcpSecretHeaderRequest) => Promise<boolean>
}

export function McpSecretHeaderEditor(props: McpSecretHeaderEditorProps) {
  const suggestedHeaderName = props.server.suggestedSecretHeaderName
  const [open, setOpen] = useState(false)
  const [headerName, setHeaderName] = useState(
    suggestedHeaderName ?? '',
  )
  const [secret, setSecret] = useState('')
  if (props.server.scope !== 'global' || props.server.transport !== 'http') return null

  const save = async () => {
    const saved = await props.onSave({
      scope: props.server.scope,
      serverName: props.server.name,
      headerName,
      secret,
    })
    if (saved) setSecret('')
  }

  const clear = async (name: string) => {
    await props.onSave({
      scope: props.server.scope,
      serverName: props.server.name,
      headerName: name,
      clearSecret: true,
    })
  }

  return (
    <div className="mt-2 border-t border-neutral-100 pt-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          className="text-[11px] text-neutral-600 underline decoration-neutral-300 underline-offset-2 disabled:opacity-40"
          onClick={() => setOpen((value) => !value)}
          disabled={props.disabled}
        >
          {open
            ? `收起${suggestedHeaderName ? ' API Key' : '认证'}设置`
            : suggestedHeaderName ? 'API Key（可选）' : '认证设置'}
        </button>
        {props.server.secretHeaderNames.map((name) => (
          <span key={name} className="rounded bg-green-50 px-1.5 py-0.5 text-[10px] text-green-700">
            {name} 已安全保存
          </span>
        ))}
      </div>
      {open && (
        <div className="mt-2 rounded border border-neutral-200 bg-neutral-50/60 p-2">
          <div className={`grid gap-2 ${suggestedHeaderName ? '' : 'md:grid-cols-2'}`}>
            {!suggestedHeaderName && (
              <label className="block text-[10px] text-neutral-600">
                认证 Header 名称
                <input
                  className="mt-1 w-full rounded border border-neutral-300 bg-white px-2 py-1 text-xs"
                  value={headerName}
                  onChange={(event) => setHeaderName(event.target.value)}
                  placeholder="Authorization"
                  disabled={props.disabled}
                />
              </label>
            )}
            <label className="block text-[10px] text-neutral-600">
              {suggestedHeaderName
                ? 'API Key（官方推荐，留空也可使用）'
                : '完整 Header 值（例如 Bearer <token>）'}
              <input
                className="mt-1 w-full rounded border border-neutral-300 bg-white px-2 py-1 text-xs"
                type="password"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                autoComplete="new-password"
                disabled={props.disabled}
              />
            </label>
          </div>
          <p className="mt-1.5 text-[10px] text-neutral-500">
            {suggestedHeaderName && <>按服务预设通过 {suggestedHeaderName} 发送。 </>}
            密钥通过系统安全存储加密，不写入 mcp.json，也不会返回 Renderer；只有服务器 URL 未变化时才会随新会话发送。
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              className="rounded bg-neutral-900 px-2 py-1 text-[11px] text-white disabled:opacity-40"
              onClick={() => void save()}
              disabled={props.disabled || !headerName.trim() || !secret.trim()}
            >
              {suggestedHeaderName ? '保存 API Key' : '保存认证值'}
            </button>
            {props.server.secretHeaderNames.map((name) => (
              <button
                key={name}
                className="text-[10px] text-red-600 disabled:opacity-40"
                onClick={() => void clear(name)}
                disabled={props.disabled}
              >
                清除 {name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
