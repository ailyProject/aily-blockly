!macro customInit
  ; 多种方式尝试关闭可能运行的实例
  nsExec::Exec 'taskkill /F /IM aily-blockly.exe /T'
  nsExec::Exec 'taskkill /F /IM ${PRODUCT_NAME}.exe /T'
  nsExec::Exec 'taskkill /F /IM "Aily Blockly.exe" /T'
  
  ; 等待确保进程完全终止
  Sleep 2000
  
  ; 强制释放可能被锁定的文件
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
  
  ; 最后再等待一下确保文件系统操作完成
  Sleep 1000
!macroend

!macro customInstall
  
  ; 使用7za.exe解压node-v18.20.8-win-x64到node目录
  nsExec::ExecToStack '"$INSTDIR\resources\app\child\7za.exe" x "$INSTDIR\resources\app\child\node-v18.20.8-win-x64.7z" -o"$INSTDIR\resources\app\child\node" -y'
  
  ; 等待解压完成
  Sleep 2000

  ; 删除解压后的压缩包，节省磁盘空间
  Delete "$INSTDIR\resources\app\child\node-v18.20.8-win-x64.7z"

!macroend

!macro customUnInstall
  ; 创建临时空目录用于 Robocopy 镜像删除
  CreateDirectory "$TEMP\empty_dir_for_cleanup"
  
  ; 使用 Robocopy 将空目录镜像到安装目录(实现删除效果)
  nsExec::ExecToStack 'cmd.exe /c robocopy "$TEMP\empty_dir_for_cleanup" "$INSTDIR" /MIR /NFL /NDL /NJH /NJS /NC /NS /MT:16'
  
  ; 删除临时空目录
  RMDir "$TEMP\empty_dir_for_cleanup"
  
  Sleep 2000
  
  ; 再次尝试直接删除安装目录(此时应该为空或几乎为空)
  nsExec::ExecToStack 'cmd.exe /c rd /s /q "$INSTDIR"'
  Sleep 1000
  RMDir /r "$INSTDIR"
  Sleep 1000
  RMDir "$INSTDIR"
!macroend