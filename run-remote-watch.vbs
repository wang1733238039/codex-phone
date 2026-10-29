Option Explicit
Dim files, shell, root, powershell, command, result
Set files = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
root = files.GetParentFolderName(WScript.ScriptFullName)
powershell = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
command = """" & powershell & """ -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & root & "\start-remote-watch.ps1"" -Run"
shell.CurrentDirectory = root
' Remain alive and recover the watcher too, including a clean/unexpected worker exit.
Do
    result = shell.Run(command, 0, True)
    WScript.Sleep 20000
Loop
