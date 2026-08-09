const { contextBridge, ipcRenderer } = require('electron');

/**
 * The only bridge between the UI and Node. Everything else the UI needs comes
 * from the backend over HTTP.
 *
 * File pickers live here because the backend cannot open one. It is frozen by
 * PyInstaller, where `sys.executable` is the app itself, so its old
 * `subprocess.run([sys.executable, "-c", tkinter_code])` launched a second copy
 * of the backend instead of a dialog and then blocked for its full 300 s
 * timeout — the Windows "Opening…" hang. Electron already owns a real native
 * dialog on every platform; this exposes that one.
 *
 * The picker calls take no path from the page: the renderer receives whatever
 * the user chose, nothing more.
 */
contextBridge.exposeInMainWorld('electronAPI', {
  chooseFiles: () => ipcRenderer.invoke('dialog:chooseFiles'),
  chooseFolder: () => ipcRenderer.invoke('dialog:chooseFolder'),
});
