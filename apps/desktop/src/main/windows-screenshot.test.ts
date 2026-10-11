import assert from 'node:assert/strict'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'vite'
import type { withWindowsScreenshotWindow as captureWindow } from './windows-screenshot.ts'

const require = createRequire(import.meta.url)

test('Windows 外部窗口截图保留原状态，失败、取消和宿主断开也归还窗口', {
  skip: process.platform !== 'win32' || process.env.WHYCODE_TEST_DESKTOP_CAPTURE !== '1', timeout: 90_000,
}, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'whycode-screenshot-test-'))
  const children: ChildProcess[] = []
  t.after(async () => {
    for (const child of children.reverse()) await disconnect(child)
    assert.equal(path.dirname(directory), path.resolve(tmpdir()))
    assert.ok(path.basename(directory).startsWith('whycode-screenshot-test-'))
    await rm(directory, { force: true, recursive: true })
  })
  await writeFile(path.join(directory, 'package.json'), '{"type":"module"}')
  await build({
    configFile: false, logLevel: 'silent',
    build: {
      outDir: directory, emptyOutDir: false, minify: false,
      lib: {
        entry: {
          'windows-screenshot': path.join(import.meta.dirname, 'windows-screenshot.ts'),
          'windows-screenshot-worker': path.join(import.meta.dirname, 'windows-screenshot-worker.ts'),
        }, formats: ['es'], fileName: (_format, name) => `${name}.js`,
      },
      rollupOptions: {
        external: [/^node:/, 'koffi'],
        output: { paths: { koffi: pathToFileURL(require.resolve('koffi')).href } },
      },
    },
  })
  const { withWindowsScreenshotWindow } = await import(pathToFileURL(path.join(directory, 'windows-screenshot.js')).href) as {
    withWindowsScreenshotWindow: typeof captureWindow
  }
  const env: NodeJS.ProcessEnv = { ...process.env, WHYCODE_SCREENSHOT_TEST_DIR: directory }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  const target = spawn(require('electron'), [path.join(import.meta.dirname, 'test-fixtures/screenshot-window.cjs')], {
    env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  children.push(target)
  target.stderr?.resume()
  const [{ handle, title }] = await once(target, 'message') as [{ handle: string; title: string }]
  const hwnd = BigInt(handle)
  const { default: koffi } = await import('koffi')
  const user32 = koffi.load(path.join(process.env.SystemRoot!, 'System32/user32.dll'))
  const foreground = user32.func('void * GetForegroundWindow()')
  const previous = user32.func('void * GetWindow(void *, uint32_t)')
  const style = user32.func('intptr_t GetWindowLongPtrW(void *, int)')
  const layer = user32.func('int GetLayeredWindowAttributes(void *, _Out_ uint32_t *, _Out_ uint8_t *, _Out_ uint32_t *)')
  const setLayer = user32.func('int SetLayeredWindowAttributes(void *, uint32_t, uint8_t, uint32_t)')
  const minimized = user32.func('int IsIconic(void *)')
  const visible = user32.func('int IsWindowVisible(void *)')
  const previousVisible = () => {
    let window = previous(hwnd, 3)
    // 进程启动会创建不可见的系统辅助窗口；它们不属于用户看到的应用叠层。
    while (window && !visible(window)) window = previous(window, 3)
    return window
  }
  const read = () => {
    const color = [0], alpha = [0], flags = [0]
    layer(hwnd, color, alpha, flags)
    return {
      foreground: foreground(), previous: previousVisible(), style: Number(style(hwnd, -20)),
      color: color[0], alpha: alpha[0], flags: flags[0], minimized: !!minimized(hwnd), visible: !!visible(hwnd),
    }
  }
  const setState = async (state: string) => {
    const applied = once(target, 'message')
    target.send(state)
    await applied
  }
  for (const state of ['background', 'minimized', 'hidden', 'failure', 'cancel']) {
    await t.test(state, async () => {
      await setState(state === 'failure' || state === 'cancel' ? 'hidden' : state)
      const before = read()
      const controller = new AbortController()
      const result = withWindowsScreenshotWindow(title, undefined, controller.signal, async (source, signal) => {
        assert.equal(source.id, handle)
        assert.ok(source.size.width > 0 && source.size.height > 0)
        if (state === 'background') assert.deepEqual(read(), before)
        else {
          assert.equal(read().alpha, 0)
          assert.equal(read().visible, true)
          assert.equal(read().minimized, false)
          assert.equal(read().foreground, before.foreground)
        }
        if (state === 'failure') throw new Error('Fixture capture failed')
        if (state === 'cancel') { controller.abort(); signal.throwIfAborted() }
        return 'captured'
      })
      if (state === 'failure' || state === 'cancel') await assert.rejects(result)
      else assert.equal(await result, 'captured')
      assert.deepEqual(read(), before)
    })
  }
  await t.test('已有非零透明度在隐藏窗口捕获后恢复', async () => {
    await setState('hidden')
    assert.ok(setLayer(hwnd, 0, 173, 2))
    try {
      const before = read()
      await withWindowsScreenshotWindow(title, undefined, new AbortController().signal, async () => {
        assert.equal(read().alpha, 0)
      })
      assert.deepEqual(read(), before)
    } finally { setLayer(hwnd, 0, 0, 2) }
  })
  await t.test('IPC 断开后的 finally 不依赖仍然存活的宿主', async () => {
    await setState('minimized')
    const before = read()
    const worker = spawn(process.execPath, [path.join(directory, 'windows-screenshot-worker.js')], {
      windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    children.push(worker)
    worker.stderr?.resume()
    const ready = once(worker, 'message')
    worker.send({ type: 'prepare', windowTitle: title })
    const [message] = await ready
    assert.equal(message.type, 'prepared')
    assert.equal(read().minimized, false)
    await disconnect(worker)
    assert.deepEqual(read(), before)
  })
  await t.test('捕获停滞时到期释放窗口并取消迟到结果', async () => {
    await setState('hidden')
    const before = read()
    await assert.rejects(withWindowsScreenshotWindow(title, undefined, new AbortController().signal, async (_source, signal) => {
      await delay(30_000, undefined, { signal })
    }), /超时/)
    assert.deepEqual(read(), before)
  })
  await t.test('找不到窗口时明确失败且不改变窗口状态', async () => {
    const before = read()
    await assert.rejects(withWindowsScreenshotWindow('Missing Screenshot Fixture', undefined, new AbortController().signal, async () => {}), /找不到/)
    assert.deepEqual(read(), before)
  })

  const launcher = path.join(directory, 'Launcher.exe')
  await promisify(execFile)(path.join(process.env.SystemRoot!, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), [
    '/nologo', '/target:winexe', `/out:${launcher}`, '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll',
    path.join(import.meta.dirname, 'test-fixtures/screenshot-launcher.cs'),
  ], { windowsHide: true })
  await mkdir(path.join(directory, 'app'))
  await copyFile(launcher, path.join(directory, 'app/Fixture.exe'))
  const titleText = user32.func('int GetWindowTextW(void *, void *, int)')
  const enumerate = user32.func('__stdcall', 'EnumWindows', 'int', [koffi.pointer(koffi.proto('int __stdcall ColdFixtureVisitor(void *, intptr_t)')), 'intptr_t'])
  const close = user32.func('int PostMessageW(void *, uint32_t, uintptr_t, intptr_t)')
  const exists = user32.func('int IsWindow(void *)')
  const fixtureWindow = () => {
    let found: bigint | undefined
    enumerate((handle: bigint) => {
      const buffer = Buffer.alloc(1024)
      const length = titleText(handle, buffer, 512)
      if (buffer.toString('utf16le', 0, length * 2) === 'WhyCode Launcher Child') found = handle
      return 1
    }, 0)
    return found
  }
  for (const mode of ['success', 'capture-failure', 'title-mismatch', 'cancel'] as const) {
    await t.test(`启动器退出、子进程延迟显示窗口：${mode}`, async t => {
      const before = foreground()
      const observed = new Set<bigint | null>()
      const observer = setInterval(() => observed.add(foreground()), 5)
      const controller = new AbortController()
      const cancel = mode === 'cancel' ? setInterval(() => {
        if (fixtureWindow()) controller.abort()
      }, 20) : undefined
      let window: bigint | undefined
      try {
        const capture = withWindowsScreenshotWindow(
          mode === 'title-mismatch' || mode === 'cancel' ? 'Unmatched Fixture Title' : 'WhyCode Launcher Child',
          launcher, controller.signal, async source => {
            window = BigInt(source.id)
            assert.equal(source.launched, true)
            assert.equal(fixtureWindow(), window)
            const color = [0], alpha = [255], flags = [0]
            assert.ok(layer(window, color, alpha, flags))
            assert.equal(alpha[0], 0)
            assert.equal(foreground(), before)
            assert.ok(visible(window))
            assert.equal(minimized(window), 0)
            if (mode === 'capture-failure') throw new Error('Fixture frame failed')
            return 'child frame'
          },
        )
        if (mode === 'success') assert.equal(await capture, 'child frame')
        else await assert.rejects(capture, mode === 'capture-failure' ? /Fixture frame failed/ : mode === 'cancel' ? /取消/ : /未出现匹配/)
        window = fixtureWindow()
        assert.ok(window, '匹配失败也应恢复已启动的子进程窗口')
        assert.ok(minimized(window))
        assert.equal(Number(style(window, -20)) & (0x80000 | 0x08000000 | 0x20), 0)
        if ([...observed].some(handle => handle !== before)) {
          t.diagnostic('应用在窗口事件送达前发生过瞬时激活；WinEvent 为异步观察，不能把最终恢复等同于从未抢焦点。')
        }
        assert.equal(foreground(), before)
      } finally {
        clearInterval(observer)
        clearInterval(cancel)
        for (let attempt = 0; attempt < 30 && !window; attempt++) {
          window = fixtureWindow()
          if (!window) await delay(50)
        }
        if (window) {
          close(window, 0x10, 0, 0)
          for (let attempt = 0; attempt < 50 && exists(window); attempt++) await delay(50)
          assert.equal(exists(window), 0)
        }
      }
    })
  }
  await t.test('窗口建立前取消启动，不留下迟到弹窗或自有子进程', async () => {
    const marker = path.join(directory, 'app/started')
    await rm(marker, { force: true })
    const controller = new AbortController()
    const capture = assert.rejects(withWindowsScreenshotWindow('WhyCode Launcher Child', launcher, controller.signal,
      async () => assert.fail('取消的启动不应进入截图')), /取消/)
    try {
      let started = false
      for (let attempt = 0; attempt < 100 && !started; attempt++) {
        started = await readFile(marker, 'utf8').then(() => true, () => false)
        if (!started) await delay(20)
      }
      assert.ok(started, '确实启动子程序后再取消')
    } finally { controller.abort() }
    await capture
    await delay(600)
    assert.equal(fixtureWindow(), undefined)
  })
})

async function disconnect(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit', { signal: AbortSignal.timeout(5_000) })
  if (child.connected) child.disconnect()
  await exited
}
