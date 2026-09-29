import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { it } from 'node:test'
import { localWorkspaceIO, type WorkspaceReader } from './io.ts'
import { readBoundedWorkspaceFile } from './read.ts'

it('位置读取有界并发，处理短读且按原顺序返回字节', async () => {
  const source = Buffer.alloc(1024 * 1024)
  for (let i = 0; i < source.length; i++) source[i] = i % 251
  let active = 0
  let peak = 0
  let closed = false
  const reader: WorkspaceReader = {
    stat: async () => ({ size: source.length, mode: 0, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false }),
    read: async (buffer, offset, length, position) => {
      peak = Math.max(peak, ++active)
      await delay(1)
      const count = Math.min(length, 17_000, source.length - position)
      source.copy(buffer, offset, position, position + count)
      active--
      return { bytesRead: count }
    },
    close: async () => { assert.equal(active, 0); closed = true },
  }
  const io = { ...localWorkspaceIO, fs: { ...localWorkspaceIO.fs, open: async () => reader } }
  assert.deepEqual(await readBoundedWorkspaceFile('image', source.length, io), source)
  assert.equal(peak, 8)
  assert.equal(closed, true)

  reader.read = async () => { active++; await delay(1); active--; throw new Error('read failed') }
  await assert.rejects(readBoundedWorkspaceFile('image', source.length, io), /read failed/)
  assert.equal(active, 0)
})
