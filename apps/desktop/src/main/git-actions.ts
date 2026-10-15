import type { GitMutation } from '../shared/git.ts'
import { GitRepository } from './git-repository.ts'
import { gitPushProxyArgs, type SystemProxyResolver } from './git-proxy.ts'

export async function mutateGitRepository(
  repo: GitRepository,
  mutation: GitMutation,
  resolveProxy?: SystemProxyResolver,
): Promise<string> {
  const info = await repo.info()
  if (info.head !== mutation.expectedHead || info.branch !== mutation.expectedBranch) {
    throw new Error('当前分支或提交已变化，请刷新后再操作')
  }
  const action = mutation.action
  if (info.conflicts) throw new Error('仓库存在未解决的冲突，请先在文件中处理冲突')
  switch (action.kind) {
    case 'create': {
      const name = action.name.trim()
      if (name.startsWith('-') || name.includes('@{')) throw new Error('分支名称无效')
      await repo.text(['check-ref-format', '--branch', name], '校验分支名称')
      await repo.text(['switch', '-c', name], '创建并切换分支', { readOnly: false })
      return `已切换到 ${name}`
    }
    case 'switch': {
      const branch = info.refs.find(ref => ref.ref === action.ref)
      if (!branch) throw new Error('分支已不存在，请刷新后重试')
      let local = branch.remote ? null : branch.name
      if (branch.remote) {
        const tracking = (await repo.text(['for-each-ref', '--format=%(refname:short)%00%(upstream)', 'refs/heads'], '读取跟踪分支'))
          .trimEnd().split('\n').map(line => line.split('\0')).filter(([, upstream]) => upstream === branch.ref)
        if (tracking.length > 1) throw new Error('有多个本地分支跟踪此远端分支，请直接选择本地分支')
        local = tracking[0]?.[0] ?? null
      }
      await repo.text(local ? ['switch', '--', local] : ['switch', '--track', '--', branch.ref], '切换分支', { readOnly: false })
      return `已切换到 ${local ?? branch.name}`
    }
    case 'commit': {
      if (!info.branch) throw new Error('请先创建分支，再保存提交')
      if (action.scope === 'all') await repo.text(['add', '-A', '--', '.'], '暂存全部改动', { readOnly: false })
      await repo.text(['commit', '-m', action.message], '提交', { readOnly: false, timeoutMs: 180_000 })
      return '已提交改动'
    }
    case 'push': {
      if (!info.branch || !info.head) throw new Error('请先创建分支并提交改动')
      if (!info.remotes.includes(action.remote)) throw new Error('所选远端已不存在，请刷新后重试')
      const upstream = (await repo.text(['for-each-ref', '--format=%(upstream:remotename)%00%(upstream:remoteref)',
        `refs/heads/${info.branch}`], '读取推送目标')).trim().split('\0')
      const target = upstream[0] === action.remote && upstream[1] ? upstream[1] : `refs/heads/${info.branch}`
      const proxyArgs = resolveProxy ? await gitPushProxyArgs(repo, action.remote, resolveProxy) : []
      await repo.text([...proxyArgs, 'push', '--porcelain', '--set-upstream', '--', action.remote, `refs/heads/${info.branch}:${target}`],
        '推送', { readOnly: false, timeoutMs: 180_000 })
      return `已推送 ${info.branch}`
    }
  }
}
