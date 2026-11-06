// Сборка и установка приложения Agent Hub.
//   node build-app.js            — собрать в release/ и установить (ярлыки на рабочем столе и в «Пуске»)
//   node build-app.js --no-install — только собрать
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

(async () => {
  const { packager } = require('@electron/packager');
  const root = __dirname;
  if (!fs.existsSync(path.join(root, 'electron', 'icon.ico'))) {
    console.log('Рисую иконку…');
    execFileSync(process.execPath, [require.resolve('electron/cli.js'), path.join(root, 'electron', 'make-icon.js')], { stdio: 'inherit' });
  }
  console.log('Упаковываю приложение…');
  const [out] = await packager({
    dir: root,
    name: 'AgentHub',
    executableName: 'AgentHub',
    platform: 'win32',
    arch: 'x64',
    out: path.join(root, 'release'),
    overwrite: true,
    asar: true,
    icon: path.join(root, 'electron', 'icon.ico'),
    appCopyright: 'Agent Hub',
    win32metadata: { ProductName: 'Agent Hub', FileDescription: 'Agent Hub', CompanyName: 'Agent Hub', InternalName: 'AgentHub', OriginalFilename: 'AgentHub.exe' },
    ignore: [/^\/release($|\/)/, /^\/dist($|\/)/, /^\/data($|\/)/, /^\/workspaces($|\/)/, /^\/build\.js$/, /^\/build-app\.js$/, /^\/README\.md$/],
  });
  console.log('Собрано:', out);
  if (process.argv.includes('--no-install')) return;

  const dest = path.join(process.env.LOCALAPPDATA, 'Programs', 'AgentHub');
  console.log('Устанавливаю в', dest);
  try { execFileSync('taskkill', ['/IM', 'AgentHub.exe', '/F'], { stdio: 'ignore' }); } catch {}
  await new Promise((r) => setTimeout(r, 1000));
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(out, dest, { recursive: true });

  const exe = path.join(dest, 'AgentHub.exe');
  const ps = `
$s = New-Object -ComObject WScript.Shell
foreach ($dir in @([Environment]::GetFolderPath('Desktop'), (Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs'))) {
  $l = $s.CreateShortcut((Join-Path $dir 'Agent Hub.lnk'))
  $l.TargetPath = '${exe.replace(/'/g, "''")}'
  $l.WorkingDirectory = '${dest.replace(/'/g, "''")}'
  $l.IconLocation = '${exe.replace(/'/g, "''")},0'
  $l.Description = 'Agent Hub — команда ИИ-агентов'
  $l.Save()
}`;
  const psFile = path.join(require('os').tmpdir(), 'agenthub-shortcuts.ps1');
  fs.writeFileSync(psFile, '﻿' + ps, 'utf8');
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile], { stdio: 'inherit' });
  console.log('Готово: ярлык «Agent Hub» на рабочем столе и в меню «Пуск».');
})().catch((e) => { console.error(e); process.exit(1); });
