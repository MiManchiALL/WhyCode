const POLITE_PREFIX = String.raw`(?:(?:好(?:的)?|可以|行|那就|那么|现在)[，,\s]*)?(?:(?:请|麻烦(?:你)?|我想让你)[，,\s]*)?`

const CONSULTATIVE = /^(?:请问[，,\s]*)?(?:是否|要不要|应不应该|该不该|你觉得)|^(?:should we|do you think)\b/i
const CONSULTATIVE_SUFFIX = /(?:吗|好不好|怎么样|合适吗|可以吗)[？?。！!\s]*$|[？?]\s*$/
const NEGATED_STATEMENT = /^(?:我(?:不|不会|没有|没说)|别(?:误会|理解为)|不要(?:修改|调整|取消|放弃|停止))\b/

const EXPLICIT_PLAN_COMMANDS = [
  new RegExp(`^${POLITE_PREFIX}(?:继续|接着|恢复|续上)(?:[吧。！!\\s]*$|(?:刚才|之前|原来|当前|上次|上一轮)(?:的)?(?:任务|计划|工作))`),
  new RegExp(`^${POLITE_PREFIX}(?:取消|放弃|终止|结束|停止)(?:掉)?(?:刚才|之前|当前|这个|原来)?(?:的)?(?:任务|计划|工作)`),
  new RegExp(`^${POLITE_PREFIX}(?:别|不要)(?:再)?继续(?:刚才|之前|当前|原来)?(?:的)?(?:任务|计划|工作)`),
  new RegExp(`^${POLITE_PREFIX}(?:调整|修改|重做|重新规划|替换)(?:一下)?(?:刚才|之前|当前|这个|原来)?(?:的)?(?:任务|计划|方案|目标)`),
  new RegExp(`^${POLITE_PREFIX}(?:把|将)(?:刚才|之前|当前|这个|原来)?(?:的)?(?:任务|计划|方案|目标).*?(?:改成|改为|换成|调整|替换)`),
  new RegExp(`^${POLITE_PREFIX}(?:换个|切换|改做)(?:新的?)?(?:任务|目标)`),
  /^(?:please\s+)?(?:continue|resume|carry on|pick up)(?:[.!\s]*$|\s+(?:with\s+)?(?:the\s+)?(?:(?:previous|current|old)\s+)?(?:task|plan|work)\b)/i,
  /^(?:please\s+)?(?:cancel|abandon|stop|modify|adjust|change|replace)(?:\s+the)?\s+(?:(?:current|previous|old)\s+)?(?:task|plan|work)\b/i,
]

const INTERRUPTED_RESUME_COMMANDS = [
  new RegExp(`^${POLITE_PREFIX}(?:开始(?:做|执行)?|动手|继续做|接着做)(?:吧)?[。！!\\s]*$`),
  new RegExp(`^${POLITE_PREFIX}(?:按这个做|就这样做)(?:吧)?[。！!\\s]*$`),
  /^(?:please\s+)?(?:start|go ahead|continue|resume)(?:\s+now)?[.!\s]*$/i,
]

/** 明确指向旧任务/计划的控制命令；可用于决定是否立即启用未完成保护。 */
export function requestsTaskPlanControl(text: string): boolean {
  const normalized = normalize(text)
  if (
    !normalized
    || CONSULTATIVE.test(normalized)
    || CONSULTATIVE_SUFFIX.test(normalized)
    || NEGATED_STATEMENT.test(normalized)
  ) return false
  return EXPLICIT_PLAN_COMMANDS.some((pattern) => pattern.test(normalized))
}

/** 紧跟用户停止后的“开始做吧”等短命令，可安全解释为恢复刚被中止的任务。 */
export function requestsInterruptedTaskResume(text: string): boolean {
  const normalized = normalize(text)
  if (
    !normalized
    || CONSULTATIVE.test(normalized)
    || CONSULTATIVE_SUFFIX.test(normalized)
    || NEGATED_STATEMENT.test(normalized)
  ) return false
  return requestsTaskPlanControl(normalized)
    || INTERRUPTED_RESUME_COMMANDS.some((pattern) => pattern.test(normalized))
}

function normalize(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim()
}
