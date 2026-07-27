import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { redactUrlCredentials } from './url-credentials.ts'

describe('MCP URL 凭据脱敏', () => {
  it('隐藏 URL userinfo 和常见临时授权参数，保留普通参数', () => {
    const input = [
      'https://alice:private-password@example.test/file',
      'https://raw.example.test/private?ref=main&token=temporary-token',
      'https://bucket.example.test/object?X-Amz-Algorithm=AWS4-HMAC-SHA256'
        + '&X-Amz-Credential=temporary-credential'
        + '&X-Amz-Signature=temporary-signature',
      'https://example.test/docs?language=zh&version=1',
    ].join('\n')

    const result = redactUrlCredentials(input)

    assert.doesNotMatch(
      result,
      /alice|private-password|temporary-token|temporary-credential|temporary-signature/u,
    )
    assert.match(result, /https:\/\/REDACTED:REDACTED@example\.test\/file/u)
    assert.match(result, /token=REDACTED/u)
    assert.match(result, /X-Amz-Credential=REDACTED/u)
    assert.match(result, /X-Amz-Signature=REDACTED/u)
    assert.match(result, /https:\/\/example\.test\/docs\?language=zh&version=1/u)
  })

  it('隐藏 OAuth fragment 凭据，不改写不含凭据的 URL 文本', () => {
    const ordinary = '文档：https://example.test/a_(b)?page=2。'
    assert.equal(redactUrlCredentials(ordinary), ordinary)
    assert.equal(
      redactUrlCredentials(
        'https://auth.example.test/callback#/done?code=private-code&state=private-state',
      ),
      'https://auth.example.test/callback#/done?code=REDACTED&state=REDACTED',
    )
    assert.equal(
      redactUrlCredentials(
        '下载：[文件](https://example.test/a_(b)?to%6ben=private-token)。',
      ),
      '下载：[文件](https://example.test/a_(b)?token=REDACTED)。',
    )
  })
})
