import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { pathReferenceText, readWorkspacePathDrag, splitPathReferences, workspacePathReference, WORKSPACE_PATH_MIME } from './path-reference.ts'

describe('会话路径引用', () => {
  it('本机和 SSH 均保留完整路径，目录有明确结尾，不读取文件内容', () => {
    const local = workspacePathReference('C:\\Users\\me\\Project', 'src/main.ts', 'main.ts', 'file')
    assert.equal(local.path, 'C:/Users/me/Project/src/main.ts')
    assert.equal(pathReferenceText(local), '[main.ts](<C:/Users/me/Project/src/main.ts>)')
    const network = workspacePathReference('\\\\server\\share', 'src/main.ts', 'main.ts', 'file')
    assert.equal(network.path, '//server/share/src/main.ts')
    assert.deepEqual(splitPathReferences(pathReferenceText(network))[0]?.reference, network)
    const remote = workspacePathReference('/home/Lin', 'fpga', 'fpga', 'directory')
    assert.equal(pathReferenceText(remote), '[fpga](</home/Lin/fpga/>)')
    assert.deepEqual(splitPathReferences(pathReferenceText(remote))[0]?.reference, { ...remote, path: `${remote.path}/` })
  })

  it('中文、空格、括号、百分号、井号和 Markdown 转义在草稿与发送中保持原义', () => {
    for (const name of ['需求 [最终版] (2).md', '预算#50% &amp; <记录>.txt', '反\\斜杠_!*.md', '多\n行.txt']) {
      const reference = workspacePathReference('/project', name, name, 'file')
      const source = pathReferenceText(reference)
      const text = `检查 ${source}\n然后继续`
      const parts = splitPathReferences(text)
      assert.deepEqual(parts.map(part => part.text).join(''), text)
      assert.deepEqual(parts[1]?.reference, reference)
    }
  })

  it('代码、图片、普通网页链接和 HTML 不变成路径引用', () => {
    const link = pathReferenceText({ name: 'a.ts', path: '/repo/a.ts', kind: 'file' })
    for (const text of [`\`${link}\``, `\`\`\`md\n${link}\n\`\`\``, `!${link}`, '[网址](<https://example.com/a.ts>)', `<pre>\n${link}\n</pre>`]) {
      assert.deepEqual(splitPathReferences(text), [{ text }])
    }
    const text = `原文 **不变** ${link} [其它](https://example.com)`
    assert.equal(splitPathReferences(text).filter(part => part.reference).length, 1)
    assert.equal(splitPathReferences(text).map(part => part.text).join(''), text)
  })

  it('拖放只能写入路径所属会话，不能把本机或其它服务器的路径误交给当前会话', () => {
    const reference = { name: 'a.ts', path: '/repo/a.ts', kind: 'file' }
    const data = { getData: (format: string) => format === WORKSPACE_PATH_MIME ? JSON.stringify({ runtimeId: 'ssh-a', ...reference }) : '' }
    assert.deepEqual(readWorkspacePathDrag(data, 'ssh-a'), reference)
    assert.equal(readWorkspacePathDrag(data, 'ssh-b'), null)
    assert.equal(readWorkspacePathDrag({ getData: () => '{}' }, 'ssh-a'), null)
    assert.equal(readWorkspacePathDrag({ getData: () => 'not json' }, 'ssh-a'), null)
    assert.equal(readWorkspacePathDrag({ getData: () => JSON.stringify({ ...reference, runtimeId: 'ssh-a', path: 'https://example.com' }) }, 'ssh-a'), null)
  })
})
