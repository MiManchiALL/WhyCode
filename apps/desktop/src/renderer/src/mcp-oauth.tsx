import type {
  McpOAuthRequest,
  McpSettingsItem,
} from '../../shared/settings.ts'

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
    <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2 border-t border-neutral-100 pt-2 [overflow-wrap:anywhere]">
      {oauth.status === 'connected' ? (
        <>
          <span className="rounded bg-green-50 px-1.5 py-0.5 text-[10px] text-green-700">
            OAuth 已登录
          </span>
          <button
            className="text-[10px] text-red-600 disabled:opacity-40"
            onClick={() => void props.onDisconnect(request)}
            disabled={props.disabled}
          >
            退出登录
          </button>
        </>
      ) : (
        <button
          className="rounded border border-neutral-300 px-2 py-1 text-[11px] text-neutral-700 disabled:opacity-40"
          onClick={() => void props.onAuthorize(request)}
          disabled={props.disabled || oauth.status !== 'available'}
        >
          OAuth 登录
        </button>
      )}
      {oauth.message && (
        <p className="min-w-0 basis-full break-words text-[10px] text-amber-700">{oauth.message}</p>
      )}
      <p className="min-w-0 basis-full break-words text-[10px] text-neutral-500">
        使用标准 MCP OAuth 发现、PKCE 和安全令牌存储；当前会话不会热替换连接，新建会话后按需生效。
      </p>
    </div>
  )
}
