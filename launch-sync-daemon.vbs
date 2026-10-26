' Antigravity Sync Daemon Silent Background Launcher
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

userProfile = WshShell.ExpandEnvironmentStrings("%USERPROFILE%")
daemonScript = userProfile & "\.gemini\bin\antigravity-sync-daemon.js"
nodeExe = "C:\Program Files\nodejs\node.exe"

If Not fso.FileExists(nodeExe) Then
    nodeExe = "node.exe"
End If

cmd = """" & nodeExe & """ """ & daemonScript & """"
WshShell.Run cmd, 0, False
