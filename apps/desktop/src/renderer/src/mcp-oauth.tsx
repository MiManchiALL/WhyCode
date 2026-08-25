import type {
  McpOAuthRequest,
  McpSettingsItem,
} from '../../shared/settings.ts'
import { SettingsButton } from './settings-layout.tsx'

interface McpOAuthEditorProps {
  server: McpSettingsItem['servers'][number]
  disabled: boolean
  onAuthorize: (request: McpOAuthRequest) => Promise<boolean>
  onDisconnect: (request: McpOAuthRequest) => Promise<boolean>
}

export function McpOAuthEditor(props: McpOAuthEditorProps) {
  const oauth = props.server.oauth
  if (!oauth) return null
  const request = {
    scope: props.server.scope,
    serverName: props.server.name,
  } as const
  return (
    <div className="mt-3 flex min-w-0 flex-wrap items-center justify-end gap-2 border-t border-[var(--wc-line)] pt-3 [overflow-wrap:anywhere]">
      {oauth.status === 'connected' ? (
        <>
          <span className="rounded bg-green-50 px-1.5 py-0.5 wc-type-tiny text-green-700">
            OAuth 已登录
          </span>
          <SettingsButton
            variant="danger"
            onClick={() => void props.onDisconnect(request)}
            disabled={props.disabled}
          >
            退出登录
          </SettingsButton>
        </>
      ) : (
        <SettingsButton
          onClick={() => void props.onAuthorize(request)}
          disabled={props.disabled || oauth.status !== 'available'}
        >
          OAuth 登录
        </SettingsButton>
      )}
      {oauth.message && (
        <p className="min-w-0 basis-full break-words wc-type-tiny text-amber-700">{oauth.message}</p>
      )}
      <p className="min-w-0 basis-full break-words wc-type-tiny text-neutral-500">
        使用标准 MCP OAuth 发现、PKCE 和安全令牌存储；当前会话不会热替换连接，新建会话后按需生效。
      </p>
    </div>
  )
}
