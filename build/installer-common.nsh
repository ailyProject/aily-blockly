; Shared Blockly/Coder hooks for electron-builder 25.1.8.
; Keep the stock installer responsible for stopping the app and replacing files.
!ifndef BUILD_UNINSTALLER
  Var ailyUpgradeInPlace
  Var ailyLegacyDesktopHandle
  Var ailyShortcutSchema

  ; A manually launched installer is also an upgrade when the selected target
  ; is the registered installation. Upstream disables preservation without
  ; --updated when changing the installation directory is allowed.
  !macroundef _isUpdated
  !macro _isUpdated _a _b _t _f
    ${StdUtils.TestParameter} $R9 "updated"
    ; LogicLib conditions cannot be nested inside a LogicLib test macro.
    StrCmp "$ailyUpgradeInPlace" "true" 0 +2
    StrCpy $R9 "true"
    StrCmp "$R9" "true" `${_t}` `${_f}`
  !macroend
!endif

!macro customHeader
  !define MUI_FINISHPAGE_RUN_TEXT "启动 ${PRODUCT_NAME}"

  !ifndef BUILD_UNINSTALLER

    ; Runs after directory selection, before the stock install section.
    ; Opening or cancelling the wizard never removes installed files.
    Section "-Preserve upgrade shortcuts"
      StrCpy $ailyUpgradeInPlace "false"
      StrCpy $ailyLegacyDesktopHandle 0
      ReadRegDWORD $ailyShortcutSchema SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" AilyShortcutSchema
      ReadRegStr $R0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
      ${If} $R0 == $INSTDIR
      ${AndIf} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
        StrCpy $ailyUpgradeInPlace "true"

        ; Legacy uninstallers ignore --keep-shortcuts in their custom hook and
        ; Delete the desktop link. Deny delete sharing until they have exited.
        ; The file/attributes stay intact; Windows releases the handle on exit,
        ; including failed, cancelled and terminated installations.
        ${If} ${FileExists} "$DESKTOP\${SHORTCUT_NAME}.lnk"
          ; A query-only handle (access=0) does NOT participate in Windows
          ; deletion sharing checks. Request GENERIC_READ and omit SHARE_DELETE.
          System::Call 'kernel32::CreateFileW(w "$DESKTOP\${SHORTCUT_NAME}.lnk", i 0x80000000, i 3, p 0, i 3, i 0, p 0) p .r0'
          StrCpy $ailyLegacyDesktopHandle $0
          IntCmp $ailyLegacyDesktopHandle -1 ailyShortcutLockFailed
          IntCmp $ailyLegacyDesktopHandle 0 ailyShortcutLockFailed
        ${EndIf}
      ${EndIf}
      Goto ailyShortcutLockReady
      ailyShortcutLockFailed:
        Abort "Unable to preserve the existing desktop shortcut. Close applications using the shortcut and retry."
      ailyShortcutLockReady:
      ClearErrors
    SectionEnd
  !endif
!macroend

!macro customInstall
  ${If} $ailyLegacyDesktopHandle != 0
    System::Call 'kernel32::CloseHandle(p $ailyLegacyDesktopHandle)'
    StrCpy $ailyLegacyDesktopHandle 0
  ${EndIf}

  ; Repair missing links without overwriting retained links.
  ${IfNot} ${FileExists} "$newStartMenuLink"
    !insertmacro createMenuDirectory
    CreateShortcut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
  ${EndIf}
  ${IfNot} ${FileExists} "$newDesktopLink"
    CreateShortcut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
  ${ElseIf} $ailyShortcutSchema != 1
    ; One-time migration of the legacy hand-created link. Subsequent upgrades
    ; do not save or replace existing links, even with identical properties.
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
  ${EndIf}
  ${IfNot} ${FileExists} "$newStartMenuLink"
  ${OrIfNot} ${FileExists} "$newDesktopLink"
    Abort "Unable to create application shortcuts. Check Start Menu and desktop folder permissions, then retry."
  ${EndIf}
  WriteRegDWORD SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" AilyShortcutSchema 1

  ; Retained legacy links use the external icon; continue distributing it.
  System::Call 'shell32::SHChangeNotify(i 0x8000000, i 0, p 0, p 0)'

  nsExec::ExecToStack '"$INSTDIR\resources\child\7za.exe" x "$INSTDIR\resources\child\node-v22.19.0-win-x64.7z" -o"$INSTDIR\resources\child\node" -y'
  Pop $0
  Pop $1
  ${If} $0 == 0
    Delete "$INSTDIR\resources\child\node-v22.19.0-win-x64.7z"
  ${EndIf}

  FindFirst $0 $1 "$INSTDIR\resources\child\probe-rs-*.7z"
  ${If} $1 != ""
    nsExec::ExecToStack '"$INSTDIR\resources\child\7za.exe" x "$INSTDIR\resources\child\$1" -o"$INSTDIR\resources\child\probe-rs" -y'
    Pop $2
    Pop $3
    ${If} $2 == 0
      Delete "$INSTDIR\resources\child\$1"
    ${EndIf}
  ${EndIf}
  FindClose $0
!macroend
