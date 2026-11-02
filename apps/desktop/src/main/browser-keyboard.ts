import type { WebContents } from 'electron'

interface Key { key: string; code: string; windowsVirtualKeyCode: number; text?: string }
interface Modifier extends Key { mask: number }
const modifiers: Record<string, Modifier> = {
  Alt: { key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18, mask: 1 },
  Control: { key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, mask: 2 },
  Meta: { key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91, mask: 4 },
  Shift: { key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, mask: 8 },
}
const namedKeys: Record<string, number> = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35,
  PageUp: 33, PageDown: 34, Insert: 45, Space: 32 }
// 固定 US 键位决定 code/VK/Shift，独立于宿主输入法；不把 Unicode 文本冒充物理按键。
const punctuation: [string, string, string, number][] = [
  ['`', '~', 'Backquote', 192], ['-', '_', 'Minus', 189], ['=', '+', 'Equal', 187],
  ['[', '{', 'BracketLeft', 219], [']', '}', 'BracketRight', 221], ['\\', '|', 'Backslash', 220],
  [';', ':', 'Semicolon', 186], ["'", '"', 'Quote', 222], [',', '<', 'Comma', 188],
  ['.', '>', 'Period', 190], ['/', '?', 'Slash', 191],
]

export function browserKeyStroke(input: string): { key: Key; modifiers: Modifier[] } {
  const held = new Map<string, Modifier>()
  let name = input
  for (let match; (match = /^(Alt|Control|Meta|Shift)\+/.exec(name));) {
    held.set(match[1]!, modifiers[match[1]!]!)
    name = name.slice(match[0].length)
  }
  const shift = () => held.set('Shift', modifiers.Shift!)
  let key: Key | undefined
  if (Object.hasOwn(namedKeys, name)) {
    key = { key: name === 'Space' ? ' ' : name, code: name, windowsVirtualKeyCode: namedKeys[name]!,
      text: name === 'Enter' ? '\r' : name === 'Space' ? ' ' : undefined }
  } else if (/^F([1-9]|1\d|2[0-4])$/.test(name)) {
    key = { key: name, code: name, windowsVirtualKeyCode: 111 + Number(name.slice(1)) }
  } else if (/^[a-z]$/i.test(name)) {
    if (name === name.toUpperCase() && held.size === 0) shift()
    const letter = held.has('Shift') ? name.toUpperCase() : name.toLowerCase()
    key = { key: letter, code: `Key${name.toUpperCase()}`, windowsVirtualKeyCode: name.toUpperCase().charCodeAt(0), text: letter }
  } else if (name === ' ') {
    key = { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' }
  } else {
    const digit = '0123456789'.indexOf(name), symbol = ')!@#$%^&*('.indexOf(name)
    if (name.length === 1 && (digit >= 0 || symbol >= 0)) {
      if (symbol >= 0) shift()
      const number = digit >= 0 ? digit : symbol
      const text = held.has('Shift') ? ')!@#$%^&*('[number]! : String(number)
      key = { key: text, code: `Digit${number}`, windowsVirtualKeyCode: 48 + number, text }
    } else {
      const definition = punctuation.find(([plain, shifted]) => name === plain || name === shifted)
      if (definition) {
        const [plain, shifted, code, windowsVirtualKeyCode] = definition
        if (name === shifted) shift()
        const text = held.has('Shift') ? shifted : plain
        key = { key: text, code, windowsVirtualKeyCode, text }
      }
    }
  }
  if (!key) throw new Error('不支持此按键；可使用 US 键盘字符、命名按键及 Control/Alt/Shift/Meta 组合。Unicode 文本请在可编辑控件使用 browser.type({text})。')
  if ([...held.keys()].some(name => name !== 'Shift')) delete key.text
  return { key, modifiers: [...held.values()] }
}

export async function dispatchBrowserKey(guest: WebContents, stroke: ReturnType<typeof browserKeyStroke>, signal: AbortSignal): Promise<void> {
  let mask = 0
  const sequence: (Key & { mask?: number })[] = [...stroke.modifiers, stroke.key]
  const pressed: (Key & { mask?: number })[] = []
  try {
    for (const key of sequence) {
      signal.throwIfAborted()
      if (key.mask) mask |= key.mask
      pressed.push(key)
      await guest.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: key.key, code: key.code,
        windowsVirtualKeyCode: key.windowsVirtualKeyCode, text: key.text, modifiers: mask })
    }
  } finally {
    // 已发出的按键必须配对释放，取消不能把修饰键留在网页里。
    for (const key of pressed.reverse()) {
      if (key.mask) mask &= ~key.mask
      if (guest.isDestroyed() || !guest.debugger.isAttached()) break
      await guest.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: key.key, code: key.code,
        windowsVirtualKeyCode: key.windowsVirtualKeyCode, modifiers: mask })
    }
  }
}
