import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { assertPublicWebTarget, parseWebPageUrl } from './url-safety.ts'

describe('网页目标地址安全校验', () => {
  it('只接受无凭据的 HTTP/HTTPS URL，并移除 fragment', () => {
    assert.equal(
      parseWebPageUrl('https://example.com/docs#part').toString(),
      'https://example.com/docs',
    )
    assert.throws(() => parseWebPageUrl('file:///C:/secret'), /只支持/)
    assert.throws(() => parseWebPageUrl('https://user:pass@example.com'), /只支持/)
    assert.throws(() => parseWebPageUrl(`https://example.com/${'a'.repeat(2_048)}`), /无效/)
  })

  it('拒绝本机、私网、保留地址及其 IPv6 映射形式', async () => {
    const resolver = async () => ({ endpoints: [{ address: '93.184.216.34' }] })
    for (const value of [
      'http://127.0.0.1',
      'http://10.0.0.1',
      'http://169.254.169.254/latest/meta-data',
      'http://168.63.129.16',
      'http://[::1]',
      'http://[::ffff:127.0.0.1]',
      'http://localhost',
      'http://service.internal',
      'http://service.onion',
      'http://single-label',
    ]) {
      await assert.rejects(
        assertPublicWebTarget(parseWebPageUrl(value), resolver),
        /不能访问本机、内网或保留地址/,
        value,
      )
    }
  })

  it('要求域名的所有解析结果都是公开单播地址', async () => {
    await assert.doesNotReject(assertPublicWebTarget(
      parseWebPageUrl('https://example.com'),
      async () => ({ endpoints: [
        { address: '93.184.216.34' },
        { address: '2606:2800:220:1:248:1893:25c8:1946' },
      ] }),
    ))
    await assert.rejects(assertPublicWebTarget(
      parseWebPageUrl('https://mixed.example.com'),
      async () => ({ endpoints: [
        { address: '93.184.216.34' },
        { address: '192.168.1.20' },
      ] }),
    ), /不能访问本机、内网或保留地址/)
  })

  it('DNS 失败使用脱敏错误，不回传底层解析细节', async () => {
    await assert.rejects(assertPublicWebTarget(
      parseWebPageUrl('https://example.com'),
      async () => { throw new Error('resolver internal details') },
    ), (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      assert.equal(message, '无法解析目标网站地址')
      assert.doesNotMatch(message, /internal details/)
      return true
    })
  })
})
