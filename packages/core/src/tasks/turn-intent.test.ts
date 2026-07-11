import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  dormantTurnToolAccess,
  requestsIndependentComplexTask,
  requestsInterruptedTaskResume,
  requestsTaskPlanControl,
} from './turn-intent.ts'

describe('任务计划回合意图', () => {
  it('只接受明确的继续、调整、取消或替换命令', () => {
    const accepted = [
      '继续',
      '请继续刚才的任务',
      '恢复之前的计划',
      '取消当前计划',
      '把刚才的任务改成 tkinter 继续做',
      '换个任务，放弃当前计划',
      '继续刚才的任务，看看为什么测试失败',
      '取消当前计划并告诉我为什么',
      '不要再继续刚才的任务',
      '那你继续做吧',
      '按这个改吧',
      'please resume the previous task',
      'cancel the current plan',
    ]

    for (const text of accepted) {
      assert.equal(requestsTaskPlanControl(text), true, text)
    }
  })

  it('普通问题和咨询式讨论不接合旧计划', () => {
    const rejected = [
      'TTL是什么意思',
      '我刚刚说了什么',
      '不用外部依赖是不是会好一点，你觉得呢',
      '为什么刚才的任务停止了',
      '是否继续做比较好？',
      '继续刚才的任务怎么样？',
      '取消当前计划吗？',
      '继续回答 TTL 的含义',
      '继续这个回答',
      '接着处理 TTL',
      '我不会取消当前任务',
      '不要修改当前计划',
      'what does TTL mean?',
      'should we resume the previous task?',
      'continue the previous explanation',
    ]

    for (const text of rejected) {
      assert.equal(requestsTaskPlanControl(text), false, text)
    }
  })

  it('中断边界额外接受简短的立即开工命令，但继续拒绝咨询', () => {
    for (const text of ['可以，开始做吧', '按这个做吧', '就这样做', 'go ahead']) {
      assert.equal(requestsInterruptedTaskResume(text), true, text)
    }
    for (const text of ['你觉得现在开始怎么样？', '是否开始做比较好？', 'go ahead?']) {
      assert.equal(requestsInterruptedTaskResume(text), false, text)
    }
  })

  it('休眠计划按最新消息收缩本地工具，而不是按编程领域一刀切', () => {
    for (const text of [
      'TTL是什么意思',
      '这个游戏目前玩的人多吗',
      '今天吃什么好一点',
      '帮我写首诗',
    ]) {
      assert.equal(dormantTurnToolAccess(text), 'none', text)
    }
    for (const text of [
      '你一个人看看这个项目是干什么的',
      '当前文件写了什么',
      '分析一下这段代码为什么报错',
    ]) {
      assert.equal(dormantTurnToolAccess(text), 'read-only', text)
    }
    for (const text of [
      '新建一个 hello.txt',
      '修复这个登录 bug',
      '运行测试并告诉我结果',
      '给我做一个新的小游戏',
    ]) {
      assert.equal(dormantTurnToolAccess(text), 'all', text)
    }
  })

  it('只把明确的独立复杂目标识别为计划替换候选', () => {
    for (const text of [
      '你现在给我完整开发一个 CSGO 枪战游戏',
      '要不现在做我的世界这个游戏吧',
      '重新做一个新的桌面应用',
      'build a complete chat application',
    ]) assert.equal(requestsIndependentComplexTask(text), true, text)

    for (const text of [
      '这个游戏目前玩的人多吗',
      '看看这个项目是干什么的',
      '新建一个 hello.txt',
      '给当前按钮改个颜色',
      '这个项目需要重新开发吗',
      '不要重新开发这个游戏',
    ]) assert.equal(requestsIndependentComplexTask(text), false, text)
  })
})
