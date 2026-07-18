const _patcherPort = process.env.PORT || 5067
process.env.APP_URL = `http://localhost:${_patcherPort}`
console.log(`[Patcher] Setting APP_URL to ${process.env.APP_URL}`)

const _log = msg => console.log(`[Patcher] ${msg}`)
const _logError = (msg, err) => console.error(`[Patcher] ${msg}`, err || '')

const _sendText = (res, text, statusCode = 200) => {
  const data = Buffer.from(text)
  res.writeHead(statusCode, { 'Content-Type': 'text/plain', 'Content-Length': data.length })
  res.end(data)
}

;(async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const os = await import('node:os')
  const http = await import('node:http')
  const https = await import('node:https')
  const net = await import('node:net')
  const tempPath = path.join(os.tmpdir(), 'httptoolkit-patch')
  _log(`Selected temp path: ${tempPath}`)

  const _fetch = url => new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http
    mod.get(url, { headers: { 'User-Agent': 'HTTP-Toolkit-Patcher' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return _fetch(new URL(res.headers.location, url).toString()).then(resolve).catch(reject)
      }
      const chunks = []
      res.on('data', d => chunks.push(d))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        resolve({ statusCode: res.statusCode, headers: res.headers, body: buf })
      })
      res.on('error', reject)
    }).on('error', reject)
  })

  let _onlineCache = null
  let _onlineCacheTime = 0
  const _hasInternet = async () => {
    const now = Date.now()
    if (_onlineCache && now - _onlineCacheTime < 10000) return _onlineCache
    try {
      const r = await _fetch('https://www.google.com/generate_204')
      _onlineCache = r.statusCode < 400
    } catch (e) {
      _onlineCache = false
    }
    _onlineCacheTime = now
    return _onlineCache
  }

  const _recursiveMkdir = (dir) => {
    if (!fs.existsSync(dir)) {
      _recursiveMkdir(path.dirname(dir))
      fs.mkdirSync(dir)
    }
  }

  const _sendFile = (res, filePath, statusCode = 200) => {
    if (!fs.existsSync(filePath)) return _sendText(res, 'Not found', 404)
    const data = fs.readFileSync(filePath)
    const ext = String(filePath).split('.').pop()?.toLowerCase()
    const types = { html: 'text/html', js: 'application/javascript', css: 'text/css', json: 'application/json', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', eot: 'application/vnd.ms-fontobject' }
    const contentType = types[ext] || 'application/octet-stream'
    res.writeHead(statusCode, {
      'Content-Type': contentType,
      'Content-Length': data.length
    })
    res.end(data)
  }

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url, process.env.APP_URL)
    const pathname = reqUrl.pathname
    _log(`Request to: ${pathname}`)

    if (pathname === '/ui-update-worker.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript', 'Content-Length': 0, 'Service-Worker-Allowed': '/' })
      return res.end()
    }

    let filePath = path.join(tempPath, pathname === '/' ? 'index.html' : pathname)
    if (['/view', '/intercept', '/settings', '/mock'].includes(pathname)) filePath += '.html'

    if (!fs.existsSync(tempPath)) {
      _log(`Temp path not found, creating: ${tempPath}`)
      fs.mkdirSync(tempPath)
    }

    const hasOld = fs.existsSync(filePath)
    if (hasOld) {
      // Serve cached files immediately. Check for updates in background only if file is stale.
      const stat = fs.statSync(filePath)
      const ageMs = Date.now() - stat.mtimeMs
      if (ageMs < 24 * 60 * 60 * 1000) {
        _log('Serving from temp path')
        return _sendFile(res, filePath)
      }
    }

    const online = await _hasInternet()
    if (!online && hasOld) {
      _log('No internet connection, serving stale file from temp path')
      return _sendFile(res, filePath)
    }
    if (!online) {
      _log('No internet connection, file not cached')
      return _sendText(res, 'Not found', 404)
    }

    try {
      _log('File not found or stale, downloading')
      const remote = await _fetch(`https://app.httptoolkit.tech${pathname}`)
      if (remote.statusCode !== 200 && remote.statusCode !== 204) {
        if (hasOld) {
          _log('Remote returned error, serving stale file')
          return _sendFile(res, filePath)
        }
        return _sendText(res, 'Not found', remote.statusCode || 404)
      }

      _recursiveMkdir(path.dirname(filePath))
      let fileData = remote.body

      if (pathname === '/main.js') {
        _log('Patching main.js')
        let textData = fileData.toString('utf-8')
        const accStoreName = textData.match(/class ([0-9A-Za-z_]+){constructor\(e\){this\.goToSettings=e/)?.[1]
        const modName = textData.match(/([0-9A-Za-z_]+).(getLatestUserData|getLastUserData)/)?.[1]
        if (!accStoreName) _logError('[ERR] Account store name not found in main.js')
        else if (!modName) _logError('[ERR] Module name not found in main.js')
        else {
          let patched = textData
            .replace(`class ${accStoreName}{`, `["getLatestUserData","getLastUserData"].forEach(p=>Object.defineProperty(${modName},p,{value:()=>user}));class ${accStoreName}{`)
          if (patched === textData) _logError('[ERR] Patch failed')
          else {
            patched = `const user={
  userId: 'httptoolkit-patched-user',
  email: ${JSON.stringify(email)},
  banned: false,
  featureFlags: [],
  subscription: {
    status: 'active',
    plan: 'pro-annual',
    sku: 'pro-annual',
    tierCode: 'pro',
    interval: 'annual',
    quantity: 1,
    expiry: new Date('9999-12-31T00:00:00.000Z'),
    canManageSubscription: true,
    canUpdateTeamSize: false
  },
  isStatusUnexpired() { return true },
  isPaidUser() { return true },
  isPastDueUser() { return false },
  userHasSubscription() { return true }
};` + patched
            fileData = Buffer.from(patched)
            _log('main.js patched')
          }
        }
      }

      fs.writeFileSync(filePath, fileData)
      _log(`File downloaded and saved: ${filePath}`)
      _sendFile(res, filePath)
    } catch (e) {
      _logError(`Error while fetching file: ${filePath}`, e)
      if (hasOld) {
        _log('Fetch failed, serving stale file')
        return _sendFile(res, filePath)
      }
      _sendText(res, 'Internal server error', 500)
    }
  })

  // Safety net: prevent Electron uncaughtException dialog for EADDRINUSE on this port
  process.on('uncaughtException', err => {
    if (err && err.code === 'EADDRINUSE' && String(err.message).includes(String(_patcherPort))) {
      _log(`Ignoring EADDRINUSE on port ${_patcherPort}`)
      return
    }
    throw err
  })

  const _isPortInUse = port => new Promise(resolve => {
    const tester = net.createServer()
    tester.once('error', err => {
      tester.removeAllListeners()
      resolve(err.code === 'EADDRINUSE')
    })
    tester.once('listening', () => {
      tester.removeAllListeners()
      tester.close(() => resolve(false))
    })
    tester.listen({ port, host: '127.0.0.1' })
  })

  const portInUse = await _isPortInUse(_patcherPort)
  if (portInUse) {
    _log(`Patcher server already running on port ${_patcherPort}, skipping`)
    return
  }

  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      _log(`Port ${_patcherPort} already in use, another patcher instance is likely running`)
      return
    }
    _logError('Patcher server error', err)
  })
  server.listen(_patcherPort, () => _log(`Server listening on port ${_patcherPort}`))
})().catch(err => _logError('Fatal patcher error', err))