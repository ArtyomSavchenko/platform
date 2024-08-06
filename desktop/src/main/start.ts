//
// Copyright © 2024 Hardcore Engineering Inc.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
// See the License for the specific language governing permissions and
// limitations under the License.
//

import { BrowserWindow, CookiesSetDetails, Notification, app, ipcMain, nativeImage, shell, dialog, systemPreferences, desktopCapturer } from 'electron'
import contextMenu from 'electron-context-menu'
import WinBadge from 'electron-windows-badge'
import Store from 'electron-store'
import * as path from 'path'
import { config as dotenvConfig } from 'dotenv'
import log from 'electron-log'
import { ProgressInfo, UpdateInfo } from 'electron-updater'

import autoUpdater from './updater'
import { NotificationParams, Config } from '../ui/types'
import { addMenus } from './menu'
import { getOptions } from './args'
import { addPermissionHandlers } from './permissions'

let mainWindow: BrowserWindow | undefined
let winBadge: any

const isMac = process.platform === 'darwin'
const isWindows = process.platform === 'win32'
const isDev = process.env.NODE_ENV === 'development'

const sessionPartition = !isDev ? 'persist:huly' : 'persist:huly_dev'
const iconKey = path.join(app.getAppPath(), 'dist', 'ui', 'public', 'AppIcon.png')

const defaultWidth = 1440
const defaultHeight = 960

const envPath = path.join(app.getAppPath(), isDev ? '.env-dev' : '.env')
console.log('do loading env from', envPath)
dotenvConfig({
  path: envPath
})
const options = getOptions()

// Note: using electron-store here as local storage is not available in the main process
// before the window is created
const settings = new Store()
const oldFront = readServerUrl()

if (options.server !== undefined) {
  ;(settings as any).set('server', options.server)
}

const FRONT_URL = readServerUrl()
const serverChanged = oldFront !== FRONT_URL

function readServerUrl (): string {
  if (isDev) {
    return process.env.FRONT_URL ?? 'http://localhost:8087'
  }

  return ((settings as any).get('server', process.env.FRONT_URL) as string) ?? 'https://huly.app'
}

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup') === true) {
  app.quit()
}

console.log('Running Huly', process.env.MODEL_VERSION, process.env.VERSION, isMac, isDev, process.env.NODE_ENV)

function hookOpenWindow (window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    console.log('opening window', url)

    /*
      We need to detect if url is "our" or external. We should
      open external urls in system browser

      When we open local URLs it would be as file:///workbench/my-spc/tracker/TSK-2
      As we load only our index.html there is no security problem to pass such URLs
      to open arg as well
    */
    if (url.indexOf(FRONT_URL) !== 0 && url.indexOf('file://') !== 0) {
      void shell.openExternal(url)
    } else {
      void (async (): Promise<void> => {
        const bounds = mainWindow?.getBounds()
        const childWindow = new BrowserWindow({
          width: bounds?.width ?? defaultWidth,
          height: bounds?.height ?? defaultHeight,
          x: (bounds?.x ?? 0) + 25,
          y: (bounds?.y ?? 0) + 25,
          titleBarStyle: isMac ? 'hidden' : 'default',
          trafficLightPosition: { x: 10, y: 10 },
          icon: nativeImage.createFromPath(iconKey),
          webPreferences: {
            devTools: true,
            sandbox: false,
            partition: sessionPartition,
            preload: path.join(app.getAppPath(), 'dist', 'main', 'preload.js'),
            additionalArguments: [
              `--open=${encodeURI(
                new URL(url).pathname
                  .split('/')
                  .filter((it) => it.length > 0)
                  .join('/')
              )}`
            ]
          }
        })
        // await childWindow.webContents.openDevTools()
        await childWindow.loadFile(path.join('dist', 'ui', 'index.html'))
        hookOpenWindow(childWindow)
      })()
    }
    return { action: 'deny' }
  })
}

const createWindow = async (): Promise<void> => {
  mainWindow = new BrowserWindow({
    width: defaultWidth,
    height: defaultHeight,
    titleBarStyle: isMac ? 'hidden' : 'default',
    trafficLightPosition: { x: 10, y: 10 },
    icon: nativeImage.createFromPath(iconKey),
    webPreferences: {
      devTools: true,
      sandbox: false,
      backgroundThrottling: false,
      partition: sessionPartition,
      preload: path.join(app.getAppPath(), 'dist', 'main', 'preload.js')
    }
  })
  app.dock?.setIcon(nativeImage.createFromPath(iconKey))
  // await mainWindow.webContents.openDevTools()
  if (isDev) {
    mainWindow.webContents.openDevTools()
  }
  await mainWindow.loadFile(path.join('dist', 'ui', 'index.html'))
  addPermissionHandlers(mainWindow.webContents.session)

  // In this example, only windows with the `about:blank` url will be created.
  // All other urls will be blocked.
  hookOpenWindow(mainWindow)

  if (isMac) {
    mainWindow.on('close', (event) => {
      // Prevent the default behavior (which would quit the app)
      event.preventDefault()
      // Hide the window
      mainWindow?.hide()
    })
  } else if (isWindows) {
    winBadge = new WinBadge(mainWindow, {
      font: '14px arial'
    })
  }
}

addMenus((cmd: string, ...args: any[]) => {
  mainWindow?.webContents.send(cmd, args)
})

contextMenu({
  showSaveImageAs: false,
  showInspectElement: false,
  showSelectAll: false
})

ipcMain.on('set-badge', (event, badge: number) => {
  app.dock?.setBadge(badge > 0 ? `${badge}` : '')
  app.badgeCount = badge

  if (isWindows && winBadge !== undefined) {
    winBadge.update(badge)
  }
})

ipcMain.on('dock-bounce', (event) => {
  app.dock?.bounce('informational')
})

ipcMain.on('send-notification', (event, notificationParams: NotificationParams) => {
  if (Notification.isSupported()) {
    const notification = new Notification(notificationParams)

    notification.on('click', () => {
      mainWindow?.show()
      mainWindow?.webContents.send('handle-notification-navigation')
    })

    notification.show()
  }
})

ipcMain.on('set-title', (event, title) => {
  const webContents = event.sender
  const win = BrowserWindow.fromWebContents(webContents)
  win?.setTitle(title)
})

ipcMain.on('set-combined-config', (event, config: Config) => {
  log.info('Config set: ', config)

  const updatesUrl = process.env.DESKTOP_UPDATES_URL ?? config.DESKTOP_UPDATES_URL ?? 'https://dist.huly.io'
  const updatesChannel = process.env.DESKTOP_UPDATES_CHANNEL ?? config.DESKTOP_UPDATES_CHANNEL ?? 'huly'

  autoUpdater.setFeedURL({
    provider: 'generic',
    url: updatesUrl,
    channel: updatesChannel
  })
  void autoUpdater.checkForUpdatesAndNotify()
})

ipcMain.handle('get-main-config', (event, path) => {
  const cfg = {
    CONFIG_URL: process.env.CONFIG_URL ?? '',
    FRONT_URL,
    INITIAL_URL: process.env.INITIAL_URL ?? '',
    MODEL_VERSION: process.env.MODEL_VERSION ?? '',
    VERSION: process.env.VERSION ?? '',
  }
  return cfg
})
ipcMain.handle('get-host', (event, path) => {
  return new URL(FRONT_URL).host
})

ipcMain.on('set-front-cookie', function (event, host: string, name: string, value: string) {
  const webContents = event.sender
  const win = BrowserWindow.fromWebContents(webContents)
  const cv: CookiesSetDetails = {
    url: host,
    name,
    value,
    path: '/',
    secure: true,
    sameSite: 'no_restriction',
    httpOnly: true,
    domain: process.env.FRONT_DOMAIN
  }
  void win?.webContents?.session.cookies.set(cv)
})

const DEEP_LINKS_PROTOCOL = 'huly'
/*
  Copy-paste from official tutorial for deep links
  https://www.electronjs.org/docs/latest/tutorial/launch-app-from-url-in-another-app
*/
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(DEEP_LINKS_PROTOCOL, process.execPath, [path.resolve(process.argv[1])])
  }
} else {
  app.setAsDefaultProtocolClient(DEEP_LINKS_PROTOCOL)
}

const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
}

let deepLink = ''
let haveDeepLinkHandler = false
function tryToOpenDeepLink (link?: string): void {
  if (mainWindow == null || !haveDeepLinkHandler) {
    if (link != null) {
      deepLink = link
    }
    return
  }

  const url = link ?? deepLink
  const httpsUrl = url.replace(`${DEEP_LINKS_PROTOCOL}://`, 'https://')
  mainWindow.webContents.send('handle-deep-link', httpsUrl)
}

// Add windows / linux handler for second instance
// This is because Windows try to open second instance from the deep link
app.on('second-instance', (event, commandLine, workingDirectory) => {
  if (mainWindow != null) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }

  const url = commandLine.pop()
  console.log('Opening url', url)

  if (url != null) {
    tryToOpenDeepLink(url)
  }
})

ipcMain.on('on-deep-link-handler', () => {
  haveDeepLinkHandler = true
  tryToOpenDeepLink()
})

ipcMain.handle('get-screen-access', () => systemPreferences.getMediaAccessStatus('screen') === 'granted')
ipcMain.handle('get-screen-sources', () => {
  return desktopCapturer.getSources({ types: ['window', 'screen'], fetchWindowIcons: true, thumbnailSize: { width: 225, height: 135 } }).then(async sources => {
    return sources.map(source => {
      return {
        ...source,
        appIconURL: source.appIcon?.toDataURL(),
        thumbnailURL: source.thumbnail.toDataURL()
      }
    })
  })
})

// MacOS implementation
// Handle the protocol. In this case, we choose to show an Error Box.
app.on('open-url', (event, url) => {
  if (url == null) {
    return
  }
  tryToOpenDeepLink(url)
})

async function onReady (): Promise<void> {
  await createWindow()

  const customProtocolArg = process.argv.find((arg) => arg.startsWith(`${DEEP_LINKS_PROTOCOL}://`)) ?? ''
  tryToOpenDeepLink(customProtocolArg)

  if (serverChanged) {
    mainWindow?.webContents.send('logout')
  }
}

app.on('ready', () => {
  void onReady()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

if (isMac) {
  app.on('activate', () => {
    if (mainWindow != null && (mainWindow.isMinimized() || !mainWindow.isVisible())) {
      mainWindow.show()
    }
  })

  app.on('before-quit', () => {
    // Note: in case the app is exited by auto-updater all windows will be destroyed at this point
    if (mainWindow === undefined || mainWindow.isDestroyed()) return

    mainWindow?.removeAllListeners('close')
    mainWindow?.close()
  })
}

autoUpdater.on('update-available', (info: UpdateInfo) => {
  void dialog
    .showMessageBox({
      type: 'info',
      buttons: ['Update & Restart', 'Quit'],
      defaultId: 0,
      message: `A new version ${info.version} is available and it is required to continue. It will be downloaded and installed automatically.`
    })
    .then(({ response }) => {
      log.info(`Update dialog exit code: ${response}`) // eslint-disable-line no-console

      if (response !== 0) {
        app.quit()
      }
    })
})

autoUpdater.on('download-progress', (progressObj: ProgressInfo) => {
  if (mainWindow === undefined) return

  mainWindow.setProgressBar(progressObj.percent / 100)
  mainWindow.webContents.send('handle-update-download-progress', progressObj.percent)
})

autoUpdater.on('update-downloaded', (info) => {
  // We have listeners that prevents the app from being exited on mac
  app.removeAllListeners('window-all-closed')
  mainWindow?.removeAllListeners('close')

  autoUpdater.quitAndInstall()
})