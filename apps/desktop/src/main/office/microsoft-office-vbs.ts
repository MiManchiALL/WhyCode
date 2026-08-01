export const MICROSOFT_OFFICE_PDF_VBS = String.raw`
Option Explicit
Dim source, output, format, pidFile, processName
Dim application, document, failure, beforePids, ownsApplication

source = WScript.Arguments(0)
output = WScript.Arguments(1)
format = LCase(WScript.Arguments(2))
pidFile = WScript.Arguments(3)
failure = ""
ownsApplication = False
Set application = Nothing
Set document = Nothing

Select Case format
  Case "docx": processName = "WINWORD.EXE"
  Case "pptx": processName = "POWERPNT.EXE"
  Case "xlsx": processName = "EXCEL.EXE"
  Case Else
    WScript.StdErr.WriteLine "Unsupported Office format"
    WScript.Quit 2
End Select

Set beforePids = ProcessIds(processName)
On Error Resume Next

Select Case format
  Case "docx"
    Set application = CreateObject("Word.Application")
    CaptureFailure "create Word"
    If failure = "" Then ownsApplication = SaveNewProcessId(processName, beforePids, pidFile)
    If failure = "" And Not ownsApplication Then failure = "dedicated Word process was not created"
    If failure = "" Then application.Visible = False
    CaptureFailure "hide Word"
    If failure = "" Then application.DisplayAlerts = 0
    CaptureFailure "disable Word alerts"
    If failure = "" Then application.AutomationSecurity = 3
    CaptureFailure "disable Word macros"
    If failure = "" Then application.Options.ConfirmConversions = False
    CaptureFailure "disable Word conversion prompts"
    If failure = "" Then application.Options.UpdateLinksAtOpen = False
    CaptureFailure "disable Word link updates"
    If failure = "" Then Set document = application.Documents.Open(source, False, True, False)
    CaptureFailure "open DOCX"
    If failure = "" Then document.ExportAsFixedFormat output, 17
    CaptureFailure "export DOCX"

  Case "pptx"
    Set application = CreateObject("PowerPoint.Application")
    CaptureFailure "create PowerPoint"
    If failure = "" Then ownsApplication = SaveNewProcessId(processName, beforePids, pidFile)
    If failure = "" And Not ownsApplication Then failure = "dedicated PowerPoint process was not created"
    If failure = "" Then application.DisplayAlerts = 1
    CaptureFailure "disable PowerPoint alerts"
    If failure = "" Then application.AutomationSecurity = 3
    CaptureFailure "disable PowerPoint macros"
    If failure = "" Then Set document = application.Presentations.Open(source, True, False, False)
    CaptureFailure "open PPTX"
    If failure = "" Then document.SaveAs output, 32
    CaptureFailure "export PPTX"

  Case "xlsx"
    Set application = CreateObject("Excel.Application")
    CaptureFailure "create Excel"
    If failure = "" Then ownsApplication = SaveNewProcessId(processName, beforePids, pidFile)
    If failure = "" And Not ownsApplication Then failure = "dedicated Excel process was not created"
    If failure = "" Then application.Visible = False
    CaptureFailure "hide Excel"
    If failure = "" Then application.DisplayAlerts = False
    CaptureFailure "disable Excel alerts"
    If failure = "" Then application.AskToUpdateLinks = False
    CaptureFailure "disable Excel link prompts"
    If failure = "" Then application.EnableEvents = False
    CaptureFailure "disable Excel events"
    If failure = "" Then application.AutomationSecurity = 3
    CaptureFailure "disable Excel macros"
    If failure = "" Then Set document = application.Workbooks.Open(source, 0, True)
    CaptureFailure "open XLSX"
    If failure = "" Then document.ExportAsFixedFormat 0, output
    CaptureFailure "export XLSX"
End Select

If Not document Is Nothing Then
  Err.Clear
  If format = "pptx" Then
    document.Close
  Else
    document.Close False
  End If
End If
If Not application Is Nothing And ownsApplication Then
  Err.Clear
  application.Quit
End If
Set document = Nothing
Set application = Nothing

If failure <> "" Then
  WScript.StdErr.WriteLine failure
  WScript.Quit 1
End If
WScript.Quit 0

Sub CaptureFailure(stepName)
  If failure = "" And Err.Number <> 0 Then
    failure = stepName & " failed (0x" & Hex(Err.Number) & ")"
  End If
  Err.Clear
End Sub

Function ProcessIds(name)
  Dim ids, service, processes, item
  Set ids = CreateObject("Scripting.Dictionary")
  On Error Resume Next
  Set service = GetObject("winmgmts:\\.\root\cimv2")
  Set processes = service.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE Name='" & name & "'")
  For Each item In processes
    ids(CStr(item.ProcessId)) = True
  Next
  Err.Clear
  Set ProcessIds = ids
End Function

Function SaveNewProcessId(name, oldIds, targetPath)
  Dim currentIds, key, fileSystem, stream, attempt
  SaveNewProcessId = False
  For attempt = 1 To 40
    Set currentIds = AutomationProcessIds(name)
    For Each key In currentIds.Keys
      If Not oldIds.Exists(key) Then
        Set fileSystem = CreateObject("Scripting.FileSystemObject")
        Set stream = fileSystem.CreateTextFile(targetPath, True, False)
        stream.Write key
        stream.Close
        SaveNewProcessId = True
        Exit Function
      End If
    Next
    WScript.Sleep 50
  Next
End Function

Function AutomationProcessIds(name)
  Dim ids, service, processes, item, commandLine
  Set ids = CreateObject("Scripting.Dictionary")
  On Error Resume Next
  Set service = GetObject("winmgmts:\\.\root\cimv2")
  Set processes = service.ExecQuery("SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='" & name & "'")
  For Each item In processes
    commandLine = ""
    If Not IsNull(item.CommandLine) Then commandLine = LCase(CStr(item.CommandLine))
    If InStr(commandLine, "automation") > 0 Or InStr(commandLine, "embedding") > 0 Then
      ids(CStr(item.ProcessId)) = True
    End If
  Next
  Err.Clear
  Set AutomationProcessIds = ids
End Function
`
