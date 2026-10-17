export function powerShellCommandArgs(command: string): string[] {
  // scriptblock 调用会重置 $?；在正文结束时保存状态，供外层完成输出后退出。
  const script = [
    command,
    '$script:__whycodeCommandSucceeded = $?',
    '$script:__whycodeCommandExitCode = $LASTEXITCODE',
  ].join('\n')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  // -EncodedCommand 会把 stderr 序列化为 CLIXML。只传固定引导程序和 Base64 数据，
  // 先设置 UTF-8 再解析用户脚本，让语法错误也使用相同编码，且不经过原生命令行引号重解释。
  const bootstrap = [
    '[Console]::OutputEncoding = $OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    `try { $__whycodeScript = [scriptblock]::Create([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}'))) }`,
    'catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }',
    // return 可在状态赋值前正常结束正文；throw 和显式 exit 仍由 PowerShell 处理。
    '$__whycodeCommandSucceeded = $true',
    // 必须等 Out-Default 完成对象格式化；正文内 exit 会丢弃尚未写出的表格。
    '& $__whycodeScript | Out-Default',
    'if ($__whycodeCommandSucceeded) { exit 0 }',
    'if (($null -ne $__whycodeCommandExitCode) -and ($__whycodeCommandExitCode -ne 0)) { exit $__whycodeCommandExitCode }',
    'exit 1',
  ].join('\n')
  return ['-NoLogo', '-NoProfile', '-OutputFormat', 'Text', '-Command', bootstrap]
}
