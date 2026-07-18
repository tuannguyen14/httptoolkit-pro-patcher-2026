// @ts-check
import { execSync } from 'child_process'
import asar from '@electron/asar'
import path from 'path'
import yargs from 'yargs'
import chalk from 'chalk'
import fs from 'fs'
import os from 'os'
import { fileURLToPath } from 'url'
import { flipFuses, FuseV1Options, FuseVersion } from '@electron/fuses'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const argv = await yargs(process.argv.slice(2))
  .usage('Usage: node . <command> [options]')
  .command('patch', 'Patch HTTP Toolkit using the specified script')
  .command('restore', 'Restore HTTP Toolkit files to their original state')
  .command('start', 'Start HTTP Toolkit')
  .demandCommand(1, 'You need at least one command before moving on')
  .alias('h', 'help')
  .parse()

const isLinux = process.platform === 'linux'
const isWin = process.platform === 'win32'
const isSudo = isLinux && (process.getuid || (() => process.env.SUDO_UID ? 0 : null))() === 0

// Auto-elevate with sudo on Linux when needed for patch/restore
if (isLinux && !isSudo && (argv._[0] === 'patch' || argv._[0] === 'restore')) {
  console.log(chalk.blueBright`[+] Root access required, re-running with sudo...`)
  try {
    execSync(`sudo node ${process.argv.slice(1).map(a => `"${a}"`).join(' ')}`, {
      stdio: 'inherit',
      cwd: __dirname
    })
    process.exit(0)
  } catch (e) {
    process.exit(1)
  }
}

const appPath = (() => {
  const candidates = process.platform === 'win32'
    ? [
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'HTTP Toolkit'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'httptoolkit'),
      ]
    : [
        path.join('/opt', 'HTTP Toolkit'),
        path.join('/opt', 'httptoolkit'),
        path.join('/usr', 'lib', 'httptoolkit'),
        path.join('/usr', 'lib', 'HTTP Toolkit'),
      ]
  return candidates.find(p => fs.existsSync(path.join(p, 'resources', 'app.asar'))) || candidates[0]
})()

const serverPath = (() => {
  const candidates = process.platform === 'win32'
    ? [
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'HTTP Toolkit', 'resources', 'httptoolkit-server'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'httptoolkit', 'resources', 'httptoolkit-server'),
        path.join(process.env.LOCALAPPDATA || '', 'httptoolkit-server', 'client'),
      ]
    : [
        path.join('/opt', 'httptoolkit-server', 'client'),
        path.join('/opt', 'HTTP Toolkit Server', 'client'),
      ]
  const svPath = candidates.find(p => fs.existsSync(path.join(p, 'bundle', 'index.js')))
  if (svPath) return svPath
  const versionedPath = candidates.find(p => fs.existsSync(p))
  if (versionedPath) {
    const versions = fs.readdirSync(versionedPath)
    return path.join(versionedPath, versions[0])
  }
  return path.join(appPath, 'resources', 'httptoolkit-server')
})()

if (!fs.existsSync(path.join(appPath, 'resources', 'app.asar'))) {
  console.error(chalk.redBright`[-] HTTP Toolkit not found`)
  process.exit(1)
}

if (!fs.existsSync(path.join(serverPath, 'bundle', 'index.js'))) {
  console.error(chalk.redBright`[-] HTTP Toolkit Server not found`)
  process.exit(1)
}

console.log(chalk.blueBright`[+] HTTP Toolkit found at {bold ${appPath}}`)
console.log(chalk.blueBright`[+] HTTP Toolkit Server found at {bold ${serverPath}}`)

const patchServer = () => {
  const filePath = path.join(serverPath, 'bundle', 'index.js')
  const data = fs.readFileSync(filePath, 'utf-8')

  const isPatched = data.includes('ALLOWED_ORIGINS=false')
    || data.includes('corsOptions:{strict:!1,origin:!0')
    || data.includes('T()({strict:!1,allowSafe:!0,origin:!0')
    || data.includes('T()({strict:!1,allowSafe:!0,origin:"http://localhost:5067"')
    || data.includes('var ei=!1')
    || data.includes('__HTK_PATCHED_ISPAID__')
  if (!isPatched) {
    console.log(chalk.yellowBright`[!] Server patch skipped (patterns not found, server version may not need patching)`)
    return
  }
  if (isPatched && data.includes('__HTK_PATCHED_ISPAID__')) {
    console.log(chalk.greenBright`[+] Server already patched`)
    return
  }

  console.log(chalk.blueBright`[+] Patching server...`)
  let patchedData = data

  // Old pattern for legacy server versions
  patchedData = patchedData.replace(/ALLOWED_ORIGINS=\w\.IS_PROD_BUILD/g, 'ALLOWED_ORIGINS=false')

  // New pattern: disable strict CORS origin check so UI loaded from localhost:5067 can connect
  patchedData = patchedData.replace(/corsOptions:\{strict:!0,origin:[A-Za-z_$][A-Za-z0-9_$]*/, 'corsOptions:{strict:!1,origin:!0')

  // API server custom CORS middleware: strict with origin:"" rejects all origins. Allow any origin.
  patchedData = patchedData.replace('T()({strict:!0,allowSafe:!1,origin:""', 'T()({strict:!1,allowSafe:!0,origin:!0')

  // Force dev-mode origin allowlist (localhost, 127.0.0.x, local.httptoolkit.tech, app.httptoolkit.tech)
  patchedData = patchedData.replace('var ei=!!process.env.HTTPTOOLKIT_SERVER_BINPATH', 'var ei=!1')

  // Force isPaidUser() to always return true so MCP/CTL operations are not blocked by Pro tier check
  patchedData = patchedData.replace(
    /isPaidUser"?,?value:function\(\)\{var e,A,t;return null!=\(e=null==\(t=this\.primaryChannel\)\|\|null==\(A=t\.user\)\?void 0:A\.isPaidUser\(\)\)&&e\}/,
    'isPaidUser",value:function(){return!0}/*__HTK_PATCHED_ISPAID__*/'
  )

  if (data !== patchedData) {
    fs.writeFileSync(`${filePath}.bak`, data, 'utf-8')
    fs.writeFileSync(filePath, patchedData, 'utf-8')
    console.log(chalk.greenBright`[+] Server patched`)
  } else {
    console.log(chalk.greenBright`[+] Server already patched`)
  }
}

const patchApp = async () => {
  try {
    console.log(chalk.blueBright`[+] Cleaning up old processes...`)
    if (isWin) {
      execSync('powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 5067 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"', { stdio: 'ignore' })
      execSync('taskkill /F /IM "HTTP Toolkit.exe" 2>nul', { stdio: 'ignore' })
      // Kill old httptoolkit-server node.exe processes that hold the named pipe
      execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"name=\'node.exe\'\\" | Where-Object CommandLine -match \'httptoolkit-server\' | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"', { stdio: 'ignore' })
    } else {
      execSync('kill $(lsof -t -i:5067) 2>/dev/null || true', { stdio: 'ignore' })
      execSync('pkill -f "/opt/HTTP Toolkit/httptoolkit" 2>/dev/null || true', { stdio: 'ignore' })
      execSync('pkill -f "httptoolkit-server" 2>/dev/null || true', { stdio: 'ignore' })
    }
    await new Promise(r => setTimeout(r, 1000))
  } catch (e) { /* ignore */ }

  const email = 'tuannguyen7067@gmail.com'

  const filePath = path.join(appPath, 'resources', 'app.asar')
  const tempPath = path.join(appPath, 'resources', 'app')

  const patch = fs.readFileSync(path.join(__dirname, 'patch.js'), 'utf-8')
  const patchSignature = patch
  const needsPatch = () => {
    const asarData = fs.readFileSync(filePath)
    return !asarData.includes('Injected by HTTP Toolkit Patcher') || !asarData.includes(patchSignature)
  }
  const needsServerPatch = () => {
    const sp = path.join(serverPath, 'bundle', 'index.js')
    const data = fs.readFileSync(sp, 'utf-8')
    const isPatched = data.includes('ALLOWED_ORIGINS=false')
      || data.includes('corsOptions:{strict:!1,origin:!0')
      || data.includes('T()({strict:!1,allowSafe:!0,origin:!0')
      || data.includes('T()({strict:!1,allowSafe:!0,origin:"http://localhost:5067"')
      || data.includes('var ei=!1')
      || data.includes('__HTK_PATCHED_ISPAID__')
    return !isPatched
  }

  if (!needsPatch() && !needsServerPatch()) {
    console.log(chalk.greenBright`[+] App already patched`)
    return
  }

  console.log(chalk.blueBright`[+] Patching app...`)

  try {
    if (fs.existsSync(tempPath)) {
      fs.rmSync(tempPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    }
    asar.extractAll(filePath, tempPath)
  } catch (e) {
    if (e && typeof e === 'object' && (('errno' in e && (e.errno === -13 || e.errno === -40436)) || ('code' in e && (e.code === 'EACCES' || e.code === 'EPERM')))) {
      console.error(chalk.redBright`[-] Permission denied, try running as Administrator`)
      process.exit(1)
    }
    throw e
  }

  const indexPath = path.join(tempPath, 'build', 'index.js')
  let data = fs.readFileSync(indexPath, 'utf-8')

  // Strip any previously injected patch content (including nested re-patches)
  while (data.includes('// ------- Injected by HTTP Toolkit Patcher -------')) {
    const start = data.indexOf('// ------- Injected by HTTP Toolkit Patcher -------')
    const endMarker = '// ------- End patched content -------\n'
    const end = data.indexOf(endMarker, start)
    if (end === -1) {
      console.error(chalk.redBright`[-] Could not find end of existing patch`)
      process.exit(1)
    }
    data = data.slice(0, start) + data.slice(end + endMarker.length)
  }

  const patchedData = data
    .replace('const APP_URL =', `// ------- Injected by HTTP Toolkit Patcher -------\n;((email) => {\n${patch}\n})(\`${email.replaceAll('`', '\\`')}\`);\n// ------- End patched content -------\nconst APP_URL =`)

  if (data === patchedData || !patchedData) {
    console.error(chalk.redBright`[-] Patch failed`)
    process.exit(1)
  }

  fs.writeFileSync(indexPath, patchedData, 'utf-8')
  fs.copyFileSync(filePath, `${filePath}.bak`)
  console.log(chalk.blueBright`[+] Building app...`)
  await asar.createPackage(tempPath, filePath)

  // On Windows, Electron verifies asar integrity hash. Disable the fuse after repackaging.
  if (isWin) {
    const exePath = path.join(appPath, 'HTTP Toolkit.exe')
    if (fs.existsSync(exePath)) {
      console.log(chalk.blueBright`[+] Disabling asar integrity check...`)
      try {
        if (!fs.existsSync(`${exePath}.bak`)) fs.copyFileSync(exePath, `${exePath}.bak`)
        await flipFuses(exePath, {
          version: FuseVersion.V1,
          [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
        })
        console.log(chalk.greenBright`[+] Asar integrity check disabled`)
      } catch (e) {
        console.error(chalk.redBright`[-] Failed to disable asar integrity check`, e)
        process.exit(1)
      }
    }
  }

  console.log(chalk.greenBright`[+] App patched`)
}

switch (argv._[0]) {
  case 'patch':
    await patchApp()
    patchServer()
    break
  case 'restore':
    try {
      console.log(chalk.blueBright`[+] Restoring server...`)
      if (!fs.existsSync(path.join(serverPath, 'bundle', 'index.js.bak')))
        console.error(chalk.redBright`[-] Server not patched or restore file not found`)
      else {
        fs.copyFileSync(path.join(serverPath, 'bundle', 'index.js.bak'), path.join(serverPath, 'bundle', 'index.js'))
        console.log(chalk.greenBright`[+] Server restored`)
      }
      console.log(chalk.blueBright`[+] Restoring app...`)
      if (!fs.existsSync(path.join(appPath, 'resources', 'app.asar.bak')))
        console.error(chalk.redBright`[-] App not patched or restore file not found`)
      else {
        fs.copyFileSync(path.join(appPath, 'resources', 'app.asar.bak'), path.join(appPath, 'resources', 'app.asar'))
        console.log(chalk.greenBright`[+] App restored`)
      }
      if (isWin) {
        const exePath = path.join(appPath, 'HTTP Toolkit.exe')
        const exeBakPath = `${exePath}.bak`
        if (fs.existsSync(exeBakPath)) {
          console.log(chalk.blueBright`[+] Restoring executable...`)
          fs.copyFileSync(exeBakPath, exePath)
          console.log(chalk.greenBright`[+] Executable restored`)
        }
      }
      fs.rmSync(path.join(os.tmpdir(), 'httptoolkit-patch'), { recursive: true, force: true })
    } catch (e) {
      if (e && typeof e === 'object' && (('errno' in e && (e.errno === -13 || e.errno === -40436)) || ('code' in e && (e.code === 'EACCES' || e.code === 'EPERM')))) {
        console.error(chalk.redBright`[-] Permission denied, try running as Administrator`)
        process.exit(1)
      }
      console.error(chalk.redBright`[-] An error occurred`, e)
      process.exit(1)
    }
    break
  case 'start':
    console.log(chalk.blueBright`[+] Auto-patching before start...`)
    await patchApp()
    patchServer()
    console.log(chalk.blueBright`[+] Starting HTTP Toolkit...`)
    try {
      execSync(process.platform === 'win32' ? `start "" "${path.join(appPath, 'HTTP Toolkit.exe')}"` : 'httptoolkit', { stdio: 'inherit' })
    } catch (e) {
      console.error(chalk.redBright`[-] An error occurred`, e)
      if (isSudo) console.error(chalk.redBright`[-] Try running without sudo`)
      process.exit(1)
    }
    break
  default:
    console.error(chalk.redBright`[-] Unknown command`)
    process.exit(1)
}

console.log(chalk.greenBright`[+] Done`)
