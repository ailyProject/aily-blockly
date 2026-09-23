const APPLICATION_NAME_ROLES = new Set(['about', 'hide', 'quit']);

function roleName(item) {
  return String(item?.role || '').toLowerCase();
}

/** Refresh the native menu after startup/build product identity is resolved. */
function refreshApplicationMenu({ app, Menu, platform = process.platform }) {
  if (platform !== 'darwin') return false;

  const currentMenu = Menu.getApplicationMenu();
  if (!currentMenu) return false;

  const applicationMenuIndex = currentMenu.items.findIndex(item =>
    roleName(item) === 'appmenu'
    || item.submenu?.items.some(child => roleName(child) === 'about'),
  );
  if (applicationMenuIndex < 0) return false;

  // Electron constructs its default menu before the application finishes loading
  // product configuration. Changing app.name does not rebuild its cached labels.
  // Reuse all unrelated MenuItems so their callbacks, shortcuts and state survive.
  const template = currentMenu.items.map((item, index) => {
    if (index !== applicationMenuIndex) return item;
    return {
      role: 'appMenu',
      label: app.getName(),
      submenu: item.submenu.items.map(child => {
        if (!APPLICATION_NAME_ROLES.has(roleName(child))) return child;
        // Omitting label makes Electron resolve the localized role label using
        // the current app name, including About/Hide/Quit on macOS.
        return {
          role: child.role,
          ...(child.id ? { id: child.id } : {}),
          ...(child.accelerator ? { accelerator: child.accelerator } : {}),
          enabled: child.enabled,
          visible: child.visible,
        };
      }),
    };
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  return true;
}

module.exports = { refreshApplicationMenu };
