import type { GitRepository } from './git-repository.ts'
import { requireGitSuccess } from './git-process.ts'

export type SystemProxyResolver = (url: string) => Promise<string>

export async function gitPushProxyArgs(
  repo: GitRepository,
  remote: string,
  resolveProxy: SystemProxyResolver,
): Promise<string[]> {
  if (repo.io.identity !== 'local') return []
  if (await hasGitConfig(repo, ['--get', `remote.${remote}.proxy`])) return []
  // get-url 展开 pushurl、insteadOf 和 pushInsteadOf，不能用 fetch URL 代替推送地址。
  const urls = await repo.text(['remote', 'get-url', '--push', '--all', '--', remote], '读取推送地址')
  const args: string[] = []
  for (const address of new Set(urls.trim().split('\n'))) {
    if (!/^https?:\/\//iu.test(address)) continue
    if (await hasGitConfig(repo, ['--get-urlmatch', 'http.proxy', address])) continue
    const url = new URL(address)
    if (hasEnvironmentProxy(url.protocol)) continue
    url.username = ''; url.password = ''
    const proxy = gitProxyUrl(await resolveProxy(url.href))
    args.push('-c', `http.${url.href}.proxy=${proxy}`)
  }
  return args
}

async function hasGitConfig(repo: GitRepository, args: string[]): Promise<boolean> {
  const result = await repo.run(['config', ...args])
  if (result.code === 1 && !result.timedOut) return false
  requireGitSuccess(result, '读取 Git 代理配置')
  return true
}

function hasEnvironmentProxy(protocol: string): boolean {
  const names = protocol === 'https:' ? ['https_proxy', 'HTTPS_PROXY'] : ['http_proxy']
  return [...names, 'all_proxy', 'ALL_PROXY'].some(name => Boolean(process.env[name]))
}

function gitProxyUrl(resolution: string): string {
  // Git 不支持 PAC 候选列表；只使用首选路径，不能在推送结果未知时自动重试。
  const first = resolution.split(';')[0]!.trim()
  if (first === 'DIRECT') return ''
  const match = /^(PROXY|HTTPS|SOCKS|SOCKS4|SOCKS5)\s+(\S+)$/u.exec(first)
  if (!match) throw new Error('无法使用系统代理：Git 仅支持 HTTP、HTTPS 和 SOCKS 代理')
  const schemes: Record<string, string> = {
    PROXY: 'http', HTTPS: 'https', SOCKS: 'socks4', SOCKS4: 'socks4', SOCKS5: 'socks5h',
  }
  return `${schemes[match[1]!]!}://${match[2]!}`
}
