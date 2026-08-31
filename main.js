const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { PNG } = require('pngjs');

const isDev = process.argv.includes('--dev');

let mainWindow = null;

const TEXTURE_W = 2048;
const TEXTURE_H = 1024;

function noise(x, y, seed) {
  const s = Math.sin((x * 12.9898 + y * 78.233 + seed) * 0.0174533) * 43758.5453;
  return s - Math.floor(s);
}

function lerp(a, b, t) { return a + (b - a) * t; }
function smooth(t) { return t * t * (3 - 2 * t); }

function valueNoise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const v00 = noise(xi, yi, seed);
  const v10 = noise(xi + 1, yi, seed);
  const v01 = noise(xi, yi + 1, seed);
  const v11 = noise(xi + 1, yi + 1, seed);
  const u = smooth(xf), v = smooth(yf);
  return lerp(lerp(v00, v10, u), lerp(v01, v11, u), v);
}

function fbm(x, y, seed, octaves) {
  let n = 0, amp = 1, freq = 1, max = 0;
  for (let o = 0; o < octaves; o++) {
    n += amp * valueNoise(x * freq, y * freq, seed + o * 31);
    max += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return n / max;
}

function elevation(lon, lat) {
  const u = (lon + 1) * 0.5;
  const v = (lat + 1) * 0.5;
  let h = 0;
  h += 0.55 * fbm(u * 3.0, v * 1.6, 11, 4);
  h += 0.30 * fbm(u * 6.0 + 17, v * 3.2 + 23, 29, 4);
  h += 0.15 * fbm(u * 12.0 + 41, v * 6.4 + 53, 71, 3);
  return h;
}

function classify(h, absLat) {
  if (absLat > 0.92) return [240, 246, 252];
  if (h < 0.46) {
    const t = (0.46 - h) / 0.46;
    return [
      Math.round(10 + t * 15),
      Math.round(55 + t * 30),
      Math.round(130 + t * 70)
    ];
  }
  if (h < 0.50) {
    return [70, 150, 200];
  }
  if (h < 0.58) {
    const t = (h - 0.50) / 0.08;
    return [
      Math.round(lerp(70, 175, t)),
      Math.round(lerp(150, 175, t)),
      Math.round(lerp(200, 130, t))
    ];
  }
  if (h < 0.72) {
    const t = (h - 0.58) / 0.14;
    const baseLat = absLat;
    const dryness = baseLat < 0.4 ? 0.4 : 1.0;
    return [
      Math.round(lerp(60, 110, t) * dryness + 50 * (1 - dryness)),
      Math.round(lerp(95, 130, t) * dryness + 75 * (1 - dryness)),
      Math.round(lerp(50, 60, t) * dryness + 35 * (1 - dryness))
    ];
  }
  const t = Math.min(1, (h - 0.72) / 0.18);
  return [
    Math.round(lerp(120, 180, t)),
    Math.round(lerp(115, 165, t)),
    Math.round(lerp(105, 155, t))
  ];
}

function buildEarthPNG() {
  const png = new PNG({ width: TEXTURE_W, height: TEXTURE_H });
  for (let y = 0; y < TEXTURE_H; y++) {
    const lat = (y / TEXTURE_H) * 2 - 1;
    const absLat = Math.abs(lat);
    for (let x = 0; x < TEXTURE_W; x++) {
      const lon = (x / TEXTURE_W) * 2 - 1;
      const h = elevation(lon, lat);
      const [r, g, b] = classify(h, absLat);
      const i = (y * TEXTURE_W + x) << 2;
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

function buildCloudPNG() {
  const png = new PNG({ width: TEXTURE_W, height: TEXTURE_H });
  for (let y = 0; y < TEXTURE_H; y++) {
    for (let x = 0; x < TEXTURE_W; x++) {
      const n = fbm(x * 0.008, y * 0.008, 211, 4);
      const n2 = fbm(x * 0.016 + 311, y * 0.016 + 87, 47, 3);
      const m = n * 0.65 + n2 * 0.35;
      const i = (y * TEXTURE_W + x) << 2;
      if (m > 0.55) {
        const a = Math.min(220, Math.round((m - 0.55) * 700));
        png.data[i] = 255;
        png.data[i + 1] = 255;
        png.data[i + 2] = 255;
        png.data[i + 3] = a;
      } else {
        png.data[i] = 0;
        png.data[i + 1] = 0;
        png.data[i + 2] = 0;
        png.data[i + 3] = 0;
      }
    }
  }
  return PNG.sync.write(png);
}

function ensureTextures() {
  const cacheDir = path.join(app.getPath('userData'), 'textures');
  const earthPath = path.join(cacheDir, 'earth.png');
  const cloudPath = path.join(cacheDir, 'cloud.png');
  if (fs.existsSync(earthPath) && fs.existsSync(cloudPath)) {
    return { earthPath, cloudPath, built: false };
  }
  fs.mkdirSync(cacheDir, { recursive: true });
  const t0 = Date.now();
  fs.writeFileSync(earthPath, buildEarthPNG());
  fs.writeFileSync(cloudPath, buildCloudPNG());
  console.log(`[d-das] Baked Earth textures in ${Date.now() - t0} ms -> ${cacheDir}`);
  return { earthPath, cloudPath, built: true };
}

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
      webSecurity: !isDev
    }
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

app.whenReady().then(() => {
  ensureTextures();
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
  { name: 'All Files', extensions: ['*'] }
];

const CSV_FILTERS = [
  { name: 'CSV Telemetry', extensions: ['csv'] },
  { name: 'Text Files', extensions: ['txt'] },
  { name: 'All Files', extensions: ['*'] }
];

const TLE_FILTERS = [
  { name: 'TLE Files', extensions: ['tle', 'txt'] },
  { name: 'All Files', extensions: ['*'] }
];

ipcMain.handle('dialog:openImage', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select an Image for D-DAS',
    properties: ['openFile'],
    filters: IMAGE_FILTERS
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
    size: fileData.length
  };
});

ipcMain.handle('dialog:openCsv', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select a CSV Telemetry Log',
    properties: ['openFile'],
    filters: CSV_FILTERS
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
    size: Buffer.byteLength(content, 'utf-8')
  };
});

ipcMain.handle('dialog:openTle', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select a TLE File',
    properties: ['openFile', 'multiSelections'],
    filters: TLE_FILTERS
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
      size: Buffer.byteLength(content, 'utf-8')
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
      { name: 'All Files', extensions: ['*'] }
    ]
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
    node: process.versions.node
  };
});

ipcMain.handle('app:getTexturePaths', async () => {
  const cacheDir = path.join(app.getPath('userData'), 'textures');
  return {
    earth: path.join(cacheDir, 'earth.png'),
    cloud: path.join(cacheDir, 'cloud.png')
  };
});