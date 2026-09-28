' Runs scripts/relay.mjs with no console window (for Windows Task Scheduler).
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
CreateObject("WScript.Shell").Run """C:\Program Files\nodejs\node.exe"" """ & root & "\scripts\relay.mjs""", 0, True
