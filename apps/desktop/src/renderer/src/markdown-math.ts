import { mathFromMarkdown } from 'mdast-util-math'
import { math } from 'micromark-extension-math'
import { markdownLineEnding } from 'micromark-util-character'
import type { Construct, State, Tokenizer } from 'micromark-util-types'
import type { Processor } from 'unified'

/** 在语法入口决定定界符，不在 KaTeX 输出或 Markdown 文本上修补金额。 */
export function remarkMathSyntax(this: Processor): void {
  const syntax = math({ singleDollarTextMath: true })
  const dollar = syntax.text![36] as Construct
  syntax.text = { 36: boundedDollarMath(dollar), 92: texInlineMath }
  const data = this.data()
  ;(data.micromarkExtensions ??= []).push(syntax)
  ;(data.fromMarkdownExtensions ??= []).push(mathFromMarkdown())
}

function boundedDollarMath(dollar: Construct): Construct {
  return {
    ...dollar,
    tokenize(effects, ok, nok) {
      const start = this.now()
      return dollar.tokenize.call(this, effects, code => {
        const value = this.sliceSerialize({ start, end: this.now() })
        // Pandoc 单美元边界：内部两端不留空白，结束符后不紧接数字。
        // 多美元公式沿用上游规则；金额和普通 Markdown 由同一次解析继续处理。
        if (!value.startsWith('$$') && (
          /\s/u.test(value[1] ?? '') || /\s/u.test(value.at(-2) ?? '')
          || (code !== null && code >= 48 && code <= 57)
        )) return nok(code)
        return ok(code)
      }, nok)
    },
  }
}

const tokenizeTexInline: Tokenizer = function (effects, ok, nok) {
  const close: Tokenizer = (closing, closed, unmatched) => code => {
    closing.enter('mathTextSequence')
    closing.consume(code)
    return next => {
      if (next !== 41) return unmatched(next)
      closing.consume(next)
      closing.exit('mathTextSequence')
      return closed
    }
  }
  return start

  function start(code: number | null): State | undefined {
    effects.enter('mathText')
    effects.enter('mathTextSequence')
    effects.consume(code)
    return open
  }

  function open(code: number | null): State | undefined {
    if (code !== 40) return nok(code)
    effects.consume(code)
    effects.exit('mathTextSequence')
    return between
  }

  function between(code: number | null): State | undefined {
    if (code === null) return nok(code)
    if (code === 92) return effects.attempt({ partial: true, tokenize: close }, done, dataStart)(code)
    if (markdownLineEnding(code)) {
      effects.enter('lineEnding')
      effects.consume(code)
      effects.exit('lineEnding')
      return between
    }
    return dataStart(code)
  }

  function dataStart(code: number | null): State | undefined {
    effects.enter('mathTextData')
    effects.consume(code)
    return code === 92 ? escaped : data
  }

  function escaped(code: number | null): State | undefined {
    if (code === 92) { effects.consume(code); return data }
    return data(code)
  }

  function data(code: number | null): State | undefined {
    if (code === null || code === 92 || markdownLineEnding(code)) {
      effects.exit('mathTextData')
      return between(code)
    }
    effects.consume(code)
    return data
  }

  function done(code: number | null): State | undefined {
    effects.exit('mathText')
    return ok(code)
  }
}

// 显式 TeX 定界符不经过单美元转换，公式两侧空白与紧随数字均不产生金额歧义。
const texInlineMath: Construct = { name: 'texInlineMath', tokenize: tokenizeTexInline }
