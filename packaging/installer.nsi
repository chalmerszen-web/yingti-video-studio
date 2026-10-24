; -*- coding: utf-8 -*-
Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
!include "WinVer.nsh"
!include "FileFunc.nsh"
!ifndef APP_VERSION
  !error "APP_VERSION must be supplied by the build script."
!endif
Name "映替视频工作台 ${APP_VERSION}"
OutFile "${OUTPUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\YingTiStudio"
RequestExecutionLevel user
!ifdef QUICK_TEST
  SetCompress off
!else
!ifdef FAST_COMPRESSION
  SetCompressor zlib
!else
  SetCompressor /SOLID lzma
  SetCompressorDictSize 64
!endif
!endif
SetDatablockOptimize on
ShowInstDetails show
ShowUninstDetails show
BrandingText "映替 · 本地视频工作台"
Icon "${PAYLOAD}\YingTiStudio.ico"
UninstallIcon "${PAYLOAD}\YingTiStudio.ico"
VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey /LANG=2052 "ProductName" "映替视频工作台"
VIAddVersionKey /LANG=2052 "FileDescription" "映替 Windows x64 本地测试安装包"
VIAddVersionKey /LANG=2052 "FileVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=2052 "ProductVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=2052 "LegalCopyright" "映替视频工作台"
Var TestMode
Var PreviousDir
Var DirectoryState
Var VerifiedDir
Var VerifiedState
Var InspectOptions

!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "安装映替视频工作台"
!define MUI_WELCOMEPAGE_TEXT "安装后从桌面图标打开独立应用窗口，最小化可收起到系统托盘。$\r$\n$\r$\n检测到旧版本时，将自动保存进度、退出旧版并覆盖更新，无需先卸载。项目、KEY 和成片都会保留。$\r$\n$\r$\n已包含运行组件；视频分析和生成需要联网，并由你自行导入 VocalignTech KEY。"
!insertmacro MUI_PAGE_WELCOME
!define MUI_DIRECTORYPAGE_TEXT_TOP "可选择空文件夹，或覆盖已识别的映替安装目录。若‘安装’按钮不可点击，表示该目录含有无法识别的文件，请选择空文件夹；无需删除项目数据。"
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipUpgradeDirectory
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\YingTiStudio.exe"
!define MUI_FINISHPAGE_RUN_TEXT "启动映替视频工作台"
!define MUI_FINISHPAGE_SHOWREADME "$INSTDIR\安装说明.txt"
!define MUI_FINISHPAGE_SHOWREADME_TEXT "查看安装说明"
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH
!insertmacro MUI_LANGUAGE "SimpChinese"

Function .onInit
  SetShellVarContext current
  SetRegView 64
  StrCpy $TestMode 0
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/TESTMODE" $1
  ${IfNot} ${Errors}
    StrCpy $TestMode 1
  ${EndIf}
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "此安装包需要 64 位 Windows 10 或 Windows 11。" /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_OK|MB_ICONSTOP "此安装包需要 Windows 10 或 Windows 11。" /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
  StrCpy $PreviousDir ""
  StrCpy $InspectOptions ""
  ${If} $TestMode == 1
    StrCpy $InspectOptions "-IgnoreRegistration"
  ${EndIf}
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=inspect-install.ps1 "${PAYLOAD}\scripts\inspect-install.ps1"
  File /oname=install-identity.ps1 "${PAYLOAD}\scripts\install-identity.ps1"
  File /oname=prepare-update.ps1 "${PAYLOAD}\scripts\prepare-update.ps1"
  File /oname=stop-backend.ps1 "${PAYLOAD}\scripts\stop-backend.ps1"
  File /oname=update-manifest.json "${PAYLOAD}\build-manifest.json"
  StrCpy $VerifiedDir "$INSTDIR"
  ${If} $TestMode == 0
    ReadRegStr $PreviousDir HKCU "Software\YingTiStudio" "InstallDir"
    ${If} $PreviousDir != ""
      StrCpy $INSTDIR $PreviousDir
      Call InspectInstallDirectory
      ${If} $DirectoryState == "Invalid"
        StrCpy $INSTDIR $VerifiedDir
        StrCpy $PreviousDir ""
      ${EndIf}
    ${EndIf}
  ${EndIf}
  Call InspectInstallDirectory
  StrCpy $VerifiedDir "$INSTDIR"
  StrCpy $VerifiedState "$DirectoryState"
  StrCpy $PreviousDir ""
  ${If} $TestMode == 0
    ${If} $DirectoryState == "Installed"
    ${OrIf} $DirectoryState == "Repair"
      StrCpy $PreviousDir "$INSTDIR"
    ${EndIf}
  ${EndIf}
FunctionEnd

Function InspectInstallDirectory
  Push $0
  Push $1
  StrCpy $DirectoryState "Invalid"
  Delete "$PLUGINSDIR\directory-state.ini"
  nsExec::ExecToStack /TIMEOUT=30000 '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\inspect-install.ps1" -InstallDir "$INSTDIR" -ManifestPath "$PLUGINSDIR\update-manifest.json" -ResultPath "$PLUGINSDIR\directory-state.ini" $InspectOptions'
  Pop $0
  Pop $1
  ${If} $0 == 0
    ReadINIStr $DirectoryState "$PLUGINSDIR\directory-state.ini" "install" "state"
    ${If} $DirectoryState == ""
      StrCpy $DirectoryState "Invalid"
    ${EndIf}
  ${EndIf}
  Pop $1
  Pop $0
FunctionEnd

Function SkipUpgradeDirectory
  ${If} $PreviousDir != ""
    Abort
  ${EndIf}
FunctionEnd

Function .onVerifyInstDir
  Push $0
  Push $1
  ${If} $INSTDIR == $VerifiedDir
  ${AndIf} $VerifiedState == "Repair"
    Goto directoryOK
  ${EndIf}
  ; Existing empty folders are valid, but ordinary files are not directories.
  IfFileExists "$INSTDIR\." directoryExists 0
  IfFileExists "$INSTDIR" directoryBad directoryOK
  directoryExists:
  IfFileExists "$INSTDIR\installed-product.id" markerExists 0
  FindFirst $0 $1 "$INSTDIR\*.*"
  directoryNext:
    StrCmp $1 "" directoryEmpty
    StrCmp $1 "." directoryContinue
    StrCmp $1 ".." directoryContinue
    FindClose $0
    Goto directoryBad
  directoryContinue:
    FindNext $0 $1
    Goto directoryNext
  directoryEmpty:
    FindClose $0
    Goto directoryOK
  markerExists:
  FileOpen $0 "$INSTDIR\installed-product.id" r
  FileRead $0 $1
  FileClose $0
  StrCmp $1 "YingTiStudio.LocalTest.x64" directoryOK directoryBad
  directoryBad:
    Pop $1
    Pop $0
    Abort
  directoryOK:
    Pop $1
    Pop $0
FunctionEnd

!macro InstallBinary Relative Parent Filename
  StrCpy $0 ""
  ReadINIStr $0 "$PLUGINSDIR\copy-plan.ini" "keep" "${Relative}"
  ${If} $0 != 1
    SetOutPath "$INSTDIR\${Parent}"
    File "/oname=${Filename}" "${PAYLOAD}\${Relative}"
  ${EndIf}
!macroend

Section "映替视频工作台" MainSection
  ; Revalidate at the write boundary, including silent installation and repair.
  Call InspectInstallDirectory
  ${If} $DirectoryState == "Invalid"
    MessageBox MB_OK|MB_ICONSTOP "无法确认此目录属于映替，已停止安装。请选择空文件夹，或原映替安装目录。项目数据无需删除。" /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
  ${If} $DirectoryState == "Repair"
    DetailPrint "已识别旧版本残留，正在修复程序文件并保留项目数据…"
  ${Else}
    DetailPrint "正在检查安装环境；如有旧版本，将保存进度并自动退出…"
  ${EndIf}
  nsExec::ExecToStack /TIMEOUT=420000 '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\prepare-update.ps1" -InstallDir "$INSTDIR" -Version "${APP_VERSION}" -ManifestPath "$PLUGINSDIR\update-manifest.json" -CopyPlan "$PLUGINSDIR\copy-plan.ini" $InspectOptions'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "未能安全覆盖：可能有编辑尚未保存，或需要更新的文件被其他软件占用。旧版程序和项目数据保持不变。请处理提示后重试，详情见数据目录 update-error.log。" /SD IDOK
    SetErrorLevel 10
    Abort
  ${EndIf}
  SetOutPath "$INSTDIR"
  SetOverwrite on
  File /r /x YingTiStudio.exe /x YingTiDesktop.exe /x node.exe /x ffmpeg.exe /x ffprobe.exe "${PAYLOAD}\*.*"
  !insertmacro InstallBinary "YingTiStudio.exe" "." "YingTiStudio.exe"
  !insertmacro InstallBinary "desktop\YingTiDesktop.exe" "desktop" "YingTiDesktop.exe"
  !insertmacro InstallBinary "runtime\node.exe" "runtime" "node.exe"
  !insertmacro InstallBinary "runtime\ffmpeg.exe" "runtime" "ffmpeg.exe"
  !insertmacro InstallBinary "runtime\ffprobe.exe" "runtime" "ffprobe.exe"
  SetOutPath "$INSTDIR"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  ${If} $TestMode == 1
    FileOpen $0 "$INSTDIR\test-install.marker" w
    FileWrite $0 "test-only"
    FileClose $0
  ${Else}
    CreateDirectory "$SMPROGRAMS\映替视频工作台"
    CreateShortcut "$SMPROGRAMS\映替视频工作台\映替视频工作台.lnk" "$INSTDIR\YingTiStudio.exe"
    CreateShortcut "$SMPROGRAMS\映替视频工作台\安装说明.lnk" "$INSTDIR\安装说明.txt"
    CreateShortcut "$SMPROGRAMS\映替视频工作台\卸载映替.lnk" "$INSTDIR\Uninstall.exe"
    CreateShortcut "$DESKTOP\映替视频工作台.lnk" "$INSTDIR\YingTiStudio.exe"
    WriteRegStr HKCU "Software\YingTiStudio" "InstallDir" "$INSTDIR"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\YingTiStudio" "DisplayName" "映替视频工作台"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\YingTiStudio" "DisplayVersion" "${APP_VERSION}"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\YingTiStudio" "InstallLocation" "$INSTDIR"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\YingTiStudio" "DisplayIcon" "$INSTDIR\YingTiStudio.exe"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\YingTiStudio" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\YingTiStudio" "QuietUninstallString" '$\"$INSTDIR\Uninstall.exe$\" /S'
    WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\YingTiStudio" "NoModify" 1
    WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\YingTiStudio" "NoRepair" 1
    WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\YingTiStudio" "EstimatedSize" ${INSTALLED_KB}
  ${EndIf}
SectionEnd

Function un.onInit
  SetShellVarContext current
  SetRegView 64
  IfFileExists "$INSTDIR\installed-product.id" 0 invalidUninstall
  FileOpen $0 "$INSTDIR\installed-product.id" r
  FileRead $0 $1
  FileClose $0
  StrCmp $1 "YingTiStudio.LocalTest.x64" 0 invalidUninstall
  nsExec::ExecToStack /TIMEOUT=360000 '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\scripts\prepare-update.ps1" -InstallDir "$INSTDIR" -Operation Uninstall'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "应用尚未完成保存，暂未卸载。请处理工作台中的提示后重试。项目、视频和已保存 KEY 会继续保留。" /SD IDOK
    SetErrorLevel 10
    Abort
  ${EndIf}
  Return
  invalidUninstall:
    MessageBox MB_OK|MB_ICONSTOP "安装标记不匹配，已停止卸载以保护文件。" /SD IDOK
    SetErrorLevel 1
    Abort
FunctionEnd

Section "Uninstall"
  ReadRegStr $0 HKCU "Software\YingTiStudio" "InstallDir"
  ${If} $0 == $INSTDIR
    Delete "$DESKTOP\映替视频工作台.lnk"
    Delete "$SMPROGRAMS\映替视频工作台\映替视频工作台.lnk"
    Delete "$SMPROGRAMS\映替视频工作台\安装说明.lnk"
    Delete "$SMPROGRAMS\映替视频工作台\卸载映替.lnk"
    RMDir "$SMPROGRAMS\映替视频工作台"
    DeleteRegKey HKCU "Software\YingTiStudio"
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\YingTiStudio"
  ${EndIf}
  ; Generated exact file allowlist: never recursively delete an installation or data folder.
  !include "${REMOVE_MANIFEST}"
  Delete "$INSTDIR\test-install.marker"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
