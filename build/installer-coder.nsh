!macro customHeader
  ; 安装完成页面：添加“启动应用程序”复选框
  !define MUI_FINISHPAGE_RUN_TEXT "启动 ${PRODUCT_NAME}"
!macroend

!macro customInit
  ; 独立 Coder 安装包只关闭自身，不影响同时安装的 Aily Blockly。
  nsExec::Exec 'taskkill /F /IM aily-coder.exe /T'
  nsExec::Exec 'taskkill /F /IM ${PRODUCT_NAME}.exe /T'
  nsExec::Exec 'taskkill /F /IM "Aily Coder.exe" /T'

  Sleep 2000

  ${if} ${FileExists} "$INSTDIR"
    ClearErrors
    RMDir /r "$INSTDIR\app"
    RMDir /r "$INSTDIR\locales"
    RMDir /r "$INSTDIR\resources"
    Delete "$INSTDIR\*.dll"
    Delete "$INSTDIR\*.exe"
    Delete "$INSTDIR\*.pak"
    Delete "$INSTDIR\*.bin"
    Delete "$INSTDIR\*.dat"
  ${endif}

  Sleep 1000
!macroend

!macro customInstall
  nsExec::ExecToStack '"$INSTDIR\resources\child\7za.exe" x "$INSTDIR\resources\child\node-v22.19.0-win-x64.7z" -o"$INSTDIR\resources\child\node" -y'
  Sleep 2000
  Delete "$INSTDIR\resources\child\node-v22.19.0-win-x64.7z"

  FindFirst $0 $1 "$INSTDIR\resources\child\probe-rs-*.7z"
  ${If} $1 != ""
    nsExec::ExecToStack '"$INSTDIR\resources\child\7za.exe" x "$INSTDIR\resources\child\$1" -o"$INSTDIR\resources\child\probe-rs" -y'
    Sleep 2000
    Delete "$INSTDIR\resources\child\$1"
  ${EndIf}
  FindClose $0

  CreateShortcut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\${PRODUCT_FILENAME}.exe" "" "$INSTDIR\resources\icon.ico" 0
  System::Call 'shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend

!macro customUnInstall
  Delete "$DESKTOP\${PRODUCT_NAME}.lnk"

  CreateDirectory "$TEMP\empty_dir_for_cleanup"
  nsExec::ExecToStack 'cmd.exe /c robocopy "$TEMP\empty_dir_for_cleanup" "$INSTDIR" /MIR /NFL /NDL /NJH /NJS /NC /NS /MT:16'
  RMDir "$TEMP\empty_dir_for_cleanup"

  Sleep 2000
  nsExec::ExecToStack 'cmd.exe /c rd /s /q "$INSTDIR"'
  Sleep 1000
  RMDir /r "$INSTDIR"
  Sleep 1000
  RMDir "$INSTDIR"
!macroend
