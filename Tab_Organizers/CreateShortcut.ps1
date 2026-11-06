## CreateShortcut.ps1
## Run once to create a desktop shortcut for the Tab Organizer launcher

$launcherPath = Join-Path $PSScriptRoot "Launch Tab Organizer.bat"
$iconPath = Join-Path $PSScriptRoot "karlx.ico"
$shortcutPath = "$env:USERPROFILE\Desktop\Tab Organizer.lnk"

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = "cmd.exe"
$shortcut.Arguments = "/c `"$launcherPath`""
$shortcut.WorkingDirectory = $PSScriptRoot
$shortcut.WindowStyle = 7   # 7 = minimized (no flashing cmd window)
$shortcut.IconLocation = "$iconPath,0"
$shortcut.Description = "Launch Brave + Tab Organizer backend"
$shortcut.Save()

Write-Host "Shortcut created at: $shortcutPath" -ForegroundColor Green
Write-Host "Double-click 'Tab Organizer' on your desktop to launch everything." -ForegroundColor Cyan
