export function powerShellCommandArgs(command: string): string[] {
  // 在脚本内部收口退出码；调用 scriptblock 本身会重置 $?，不能移到调用后判断。
  const script = [
    command,
    '$__whycodeCommandSucceeded = $?',
    '$__whycodeCommandExitCode = $LASTEXITCODE',
    'if ($__whycodeCommandSucceeded) { exit 0 }',
    'if (($null -ne $__whycodeCommandExitCode) -and ($__whycodeCommandExitCode -ne 0)) { exit $__whycodeCommandExitCode }',
    'exit 1',
  ].join('\n')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  // -EncodedCommand 会把 stderr 序列化为 CLIXML。只传固定引导程序和 Base64 数据，
  // 先设置 UTF-8 再解析用户脚本，让语法错误也使用相同编码，且不经过原生命令行引号重解释。
  const bootstrap = [
    '[Console]::OutputEncoding = $OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    `try { $__whycodeScript = [scriptblock]::Create([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}'))) }`,
    'catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }',
    '& $__whycodeScript',
  ].join('\n')
  return ['-NoLogo', '-NoProfile', '-OutputFormat', 'Text', '-Command', bootstrap]
}
