import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'
import { scanCommandPaths } from './index.ts'

describe('RunCommand 路径扫描', () => {
  it('识别 PowerShell 环境变量展开后的项目外路径', () => {
    const name = 'WHYCODE_TEST_HOME'
    const previous = process.env[name]
    process.env[name] = 'C:\\Users\\WhyCode Test'
    try {
      const paths = scanCommandPaths(
        'Set-Content -Path "$env:WHYCODE_TEST_HOME\\Desktop\\hello.txt" -Value hello',
      )

      assert.deepEqual(paths, [resolve('C:\\Users\\WhyCode Test\\Desktop\\hello.txt')])
    } finally {
      if (previous === undefined) delete process.env[name]
      else process.env[name] = previous
    }
  })
})
