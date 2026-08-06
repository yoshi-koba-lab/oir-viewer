'use strict';
/**
 * Electron shell for OIR Viewer.
 *
 * The Python backend already serves the built frontend and picks its own free
 * port, so the shell's whole job is: start that process, learn which port it
 * chose, point a window at it, and make sure it dies when the app does.
 *
 * Port discovery is by parsing the backend's startup line rather than guessing,
 * because the port is chosen at runtime (8765 is often taken on this machine).
 */
const { app, BrowserWindow, shell, dialog, ipcMain, Menu } = require('electron');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

const isDev = !app.isPackaged;
/** Give the JVM + Bio-Formats a generous window on a cold start. */
const BACKEND_TIMEOUT_MS = 120_000;

let backend = null;
let mainWindow = null;
let backendLog = '';

/** Where the packaged Python backend lives, or how to run it from source. */
function backendCommand() {
  if (isDev) {
    const script = path.join(__dirname, '..', 'backend', 'main.py');
    return { cmd: process.env.OIR_PYTHON || 'python3', args: [script, '--no-webview'], cwd: path.dirname(script) };
  }
  const exe = process.platform === 'win32' ? 'oir-viewer-backend.exe' : 'oir-viewer-backend';
  const dir = path.join(process.resourcesPath, 'backend');
  return { cmd: path.join(dir, exe), args: [], cwd: dir };
}

function startBackend() {
  return new Promise((resolve, reject) => {
    const { cmd, args, cwd } = backendCommand();
    if (!isDev && !fs.existsSync(cmd)) {
      reject(new Error(`Backend executable not found:\n${cmd}`));
      return;
    }

    backend = spawn(cmd, args, {
      cwd,
      // A packaged build must never fall back to a system Java or a download.
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Backend did not report a port within ${BACKEND_TIMEOUT_MS / 1000}s.\n\n${backendLog.slice(-2000)}`));
    }, BACKEND_TIMEOUT_MS);

    const scan = (chunk) => {
      const text = chunk.toString();
      backendLog += text;
      process.stdout.write(`[backend] ${text}`);
      const m = text.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    };
    backend.stdout.on('data', scan);
    backend.stderr.on('data', scan); // uvicorn logs to stderr

    backend.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    backend.on('exit', (code) => {
      backend = null;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Backend exited with code ${code}.\n\n${backendLog.slice(-2000)}`));
    });
  });
}

function stopBackend() {
  if (!backend) return;
  const proc = backend;
  backend = null;
  try {
    if (process.platform === 'win32') {
      // SIGTERM does not reliably reach a Windows child; ask the OS to end the tree.
      spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      proc.kill('SIGTERM');
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* already gone */ } }, 3000);
    }
  } catch { /* nothing useful to do while quitting */ }
}

/**
 * Wait until the server actually answers on `port`.
 *
 * The backend prints its port before uvicorn binds the socket, so loading the
 * URL the moment that line appears races the listener and lands on
 * ERR_CONNECTION_REFUSED. Probe instead of trusting log order.
 */
function waitForServer(port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(
        { host: '127.0.0.1', port, path: '/api/images', timeout: 2000 },
        (res) => {
          res.resume();
          if (res.statusCode && res.statusCode < 500) resolve();
          else retry();
        },
      );
      req.on('error', retry);
      req.on('timeout', () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() > deadline) reject(new Error(`Server on port ${port} never became ready.`));
      else setTimeout(attempt, 250);
    };
    attempt();
  });
}

/**
 * Extensions the viewer can open. No leading dot: that is the shape Electron's
 * dialog filters take on every platform.
 *
 * The last filter matters as much as the first. Olympus splits a dataset over
 * ~1 GB into `<name>.oir` plus companions literally named `<name>_00001`,
 * `_00002` — no extension at all. A user who needs to see one of those (to
 * confirm it is there, or to pick a file in a folder full of them) cannot with
 * an extension filter applied, so "すべてのファイル" has to be reachable.
 */
const IMAGE_EXTENSIONS = ['oir', 'oib', 'oif', 'tif', 'tiff', 'nd2', 'lif', 'czi'];

/**
 * The picker is the main process's job: the packaged backend has no way to show
 * one (see preload.js), and Electron's is the real native dialog.
 *
 * Passing the window makes it a sheet on macOS and, on Windows, keeps it from
 * opening behind the app — a modeless dialog there can end up behind its own
 * parent or on another monitor.
 */
function registerDialogHandlers() {
  ipcMain.handle('dialog:chooseFiles', async () => {
    const parent = BrowserWindow.getFocusedWindow() || mainWindow;
    if (!parent || parent.isDestroyed()) return { paths: [], cancelled: true };
    const r = await dialog.showOpenDialog(parent, {
      title: '画像ファイルを選択',
      // openFile and openDirectory together do not work on Windows, so this
      // stays files-only; the folder picker below is a separate call.
      properties: ['openFile', 'multiSelections', 'dontAddToRecent'],
      filters: [
        { name: '画像ファイル', extensions: IMAGE_EXTENSIONS },
        { name: 'すべてのファイル', extensions: ['*'] },
      ],
    });
    return { paths: r.canceled ? [] : r.filePaths, cancelled: r.canceled };
  });

  ipcMain.handle('dialog:chooseFolder', async () => {
    const parent = BrowserWindow.getFocusedWindow() || mainWindow;
    if (!parent || parent.isDestroyed()) return { path: null, cancelled: true };
    const r = await dialog.showOpenDialog(parent, {
      title: '保存先フォルダを選択',
      properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'],
    });
    return {
      path: r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0],
      cancelled: r.canceled,
    };
  });
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1000,
    minHeight: 700,
    backgroundColor: '#0a0a0a',
    title: 'OIR Viewer',
    show: false,
    webPreferences: {
      // The UI is our own bundle served over loopback; it needs no Node access
      // beyond the two file pickers preload.js exposes.
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(`http://127.0.0.1:${port}/`);

  // Keep external links in the user's browser, not in the app frame.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// One instance only: a second backend would fight over the app data directory.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    // Registered before the window exists: the renderer can call as soon as it
    // loads, and an unhandled invoke would reject rather than wait.
    registerDialogHandlers();

    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      { role: 'windowMenu' },
    ]));

    try {
      const port = await startBackend();
      await waitForServer(port);
      createWindow(port);
    } catch (err) {
      dialog.showErrorBox('OIR Viewer が起動できませんでした', String(err && err.message ? err.message : err));
      app.quit();
    }
  });

  app.on('window-all-closed', () => {
    stopBackend();
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    // macOS: re-open a window if the backend is still alive.
    if (!mainWindow && backend) {
      const m = backendLog.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) createWindow(Number(m[1]));
    }
  });

  app.on('before-quit', stopBackend);
  process.on('exit', stopBackend);
}
