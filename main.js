import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { ensureTextures, getTexturePaths } from './main/textures.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = process.argv.includes('--dev');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    backgroundColor: '#1a1a1e',
    frame: true,
    autoHideMenuBar: true,
    title: 'D-DAS',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: !isDev,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  await ensureTextures(app);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

const IMAGE_FILTERS = [
  { name: 'Image Files', extensions: ['png', 'jpg', 'jpeg'] },
  { name: 'All Files', extensions: ['*'] },
];

const CSV_FILTERS = [
  { name: 'CSV Telemetry', extensions: ['csv'] },
  { name: 'Text Files', extensions: ['txt'] },
  { name: 'All Files', extensions: ['*'] },
];

const TLE_FILTERS = [
  { name: 'TLE Files', extensions: ['tle', 'txt'] },
  { name: 'All Files', extensions: ['*'] },
];

ipcMain.handle('dialog:openImage', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select an Image for D-DAS',
    properties: ['openFile'],
    filters: IMAGE_FILTERS,
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const filePath = result.filePaths[0];
  const fileData = await fs.promises.readFile(filePath);
  return {
    base64: fileData.toString('base64'),
    name: path.basename(filePath),
    path: filePath,
    size: fileData.length,
  };
});

ipcMain.handle('dialog:openCsv', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select a CSV Telemetry Log',
    properties: ['openFile'],
    filters: CSV_FILTERS,
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const filePath = result.filePaths[0];
  const content = await fs.promises.readFile(filePath, 'utf-8');
  return {
    content: content,
    name: path.basename(filePath),
    path: filePath,
    size: Buffer.byteLength(content, 'utf-8'),
  };
});

ipcMain.handle('dialog:openTle', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select a TLE File',
    properties: ['openFile', 'multiSelections'],
    filters: TLE_FILTERS,
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const files = await Promise.all(result.filePaths.map(async (filePath) => {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    return {
      content: content,
      name: path.basename(filePath),
      path: filePath,
      size: Buffer.byteLength(content, 'utf-8'),
    };
  }));
  return files;
});

ipcMain.handle('fs:saveLog', async (event, content) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Analysis Log',
    defaultPath: 'd-das-analysis-log.txt',
    filters: [
      { name: 'Text Files', extensions: ['txt'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });

  if (result.canceled || !result.filePath) {
    return { success: false, reason: 'canceled' };
  }

  try {
    await fs.promises.writeFile(result.filePath, content, 'utf-8');
    return { success: true, path: result.filePath };
  } catch (error) {
    return { success: false, reason: error.message };
  }
});

ipcMain.handle('app:getInfo', async () => {
  return {
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  };
});

ipcMain.handle('app:getTexturePaths', async () => {
  return getTexturePaths(app);
});
