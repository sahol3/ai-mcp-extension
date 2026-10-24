import { execFileSync, spawn } from 'node:child_process';

/*
 * Gemini's upload widget and menus (observed from boq_assistant-bard-web-server_20260821.03_p0
 * onwards) only work while the tab is genuinely OS-visible — chrome.windows.update and CDP-level
 * overrides (Page.setWebLifecycleState, Emulation.setFocusEmulationEnabled) were all tried live
 * and none of them move document.visibilityState/hasFocus, because Windows deliberately blocks a
 * background process from stealing foreground focus. AttachThreadInput is the standard,
 * documented way around that (temporarily join input queues with whatever currently owns the
 * foreground, so SetForegroundWindow no longer counts as a steal), confirmed live:
 * document.visibilityState/hasFocus flip to true immediately after.
 *
 * This has to live server-side, not in the extension: a service worker has no Win32 API
 * access at all. It is Windows-only and briefly brings the browser to the front, which is a
 * real, visible side effect — acceptable for an unattended pipeline step.
 *
 * SPEED (2026-10-01): every call used to spawn powershell.exe and recompile the C# with
 * Add-Type — about 1.5-3 s before the window even moved, paid on every attach, every tools
 * menu, every trusted send. Now ONE helper process is started on first use and kept alive: it
 * compiles once, then reads commands on stdin ("hold <ms> <title>") and answers "held" the
 * moment it has put the window in front. A hold is a background loop inside that process;
 * a newer hold simply extends/replaces the current one.
 */
const TYPES = `
Add-Type @"
using System;
using System.Threading;
using System.Runtime.InteropServices;
public class AiMcpFocus {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();

  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);

  // A long-lived process loses the foreground right a freshly launched one inherits, and then
  // SetForegroundWindow silently fails (it may even return true). Injecting one key event makes
  // this process the one that "received the last input", which restores the right. F24 is a
  // real key that nothing binds, so the tap has no effect anywhere. Success is judged by who is
  // actually in front afterwards, not by the API's return value.
  public static bool Front(IntPtr target) {
    IntPtr fg = GetForegroundWindow();
    if (fg == target) return true;
    uint pid;
    uint fgThread = GetWindowThreadProcessId(fg, out pid);
    uint me = GetCurrentThreadId();
    keybd_event(0x87, 0, 0, UIntPtr.Zero);
    keybd_event(0x87, 0, 2, UIntPtr.Zero);
    AttachThreadInput(me, fgThread, true);
    if (IsIconic(target)) ShowWindow(target, 9);
    SetForegroundWindow(target);
    BringWindowToTop(target);
    AttachThreadInput(me, fgThread, false);
    return GetForegroundWindow() == target;
  }

  // The hold runs on its own thread, so the command loop never blocks on it and a newer
  // hold just moves the deadline.
  static IntPtr holdTarget = IntPtr.Zero;
  static long holdUntil = 0;
  static Thread worker = null;
  public static void Hold(IntPtr target, int ms) {
    holdTarget = target;
    Interlocked.Exchange(ref holdUntil, DateTime.UtcNow.AddMilliseconds(ms).Ticks);
    if (worker == null) {
      worker = new Thread(() => {
        while (true) {
          if (holdTarget != IntPtr.Zero && DateTime.UtcNow.Ticks < Interlocked.Read(ref holdUntil)) Front(holdTarget);
          Thread.Sleep(150);
        }
      });
      worker.IsBackground = true;
      worker.Start();
    }
  }
  public static void Release() { Interlocked.Exchange(ref holdUntil, 0); }
}
"@
`;

const FIND_AND_FRONT = `
function Find-Browser([string]$titleMatch) {
  foreach ($name in @('opera','msedge','chrome')) {
    $p = Get-Process -Name $name -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -match $titleMatch } | Select-Object -First 1
    if ($p) { return $p }
  }
  foreach ($name in @('opera','msedge','chrome')) {
    $p = Get-Process -Name $name -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($p) { return $p }
  }
  return $null
}
function Front([IntPtr]$target) { return [AiMcpFocus]::Front($target) }
`;

// Blocking ReadLine: PowerShell 5.1's console reader has no usable async read (a
// ReadLineAsync version never saw the next command).
const SERVER_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
${TYPES}
${FIND_AND_FRONT}
[Console]::Out.WriteLine('ready'); [Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $parts = $line.Split(' ', 3)
  if ($parts[0] -eq 'hold') {
    $ms = [int]$parts[1]; $title = if ($parts.Length -gt 2) { $parts[2] } else { 'Gemini' }
    $proc = Find-Browser $title
    if ($proc) {
      $ok = [AiMcpFocus]::Front($proc.MainWindowHandle)
      [AiMcpFocus]::Hold($proc.MainWindowHandle, $ms)
      [Console]::Out.WriteLine('held ' + $ok.ToString().ToLower() + ' ' + $proc.ProcessName); [Console]::Out.Flush()
    } else {
      [Console]::Out.WriteLine('held false none'); [Console]::Out.Flush()
    }
  } elseif ($parts[0] -eq 'release') {
    [AiMcpFocus]::Release()
    [Console]::Out.WriteLine('released'); [Console]::Out.Flush()
  } else {
    [Console]::Out.WriteLine('pong'); [Console]::Out.Flush()
  }
}
`;

let helper = null;
let helperReady = null;
const waiters = [];

function startHelper() {
  if (helper && !helper.killed && helper.exitCode === null) return helperReady;
  helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', SERVER_SCRIPT], {
    stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
  });
  helper.unref();
  helper.stdin.unref?.();
  helper.stdout.unref?.();
  let buf = '';
  hold(true);
  helperReady = new Promise((resolve) => {
    const settle = (v) => { hold(false); resolve(v); };
    helper.stdout.on('data', (d) => {
      buf += String(d);
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line === 'ready') settle(true);
        else if (waiters.length) waiters.shift()(line);
      }
    });
    helper.on('exit', () => { settle(false); while (waiters.length) waiters.shift()('exited'); helper = null; });
    helper.on('error', () => { settle(false); helper = null; });
    setTimeout(() => settle(false), 30000).unref?.(); // a cold Add-Type compile can take several seconds
  });
  return helperReady;
}

// The pipes are unref'd so an idle helper never keeps the server alive; while a command is in
// flight they are ref'd, or a short-lived caller would exit before the answer arrived.
const hold = (on) => { try { on ? helper?.stdout?.ref?.() : helper?.stdout?.unref?.(); } catch {} };

function send(cmd, timeoutMs = 3000) {
  hold(true);
  return new Promise((resolve) => {
    const t = setTimeout(() => { const k = waiters.indexOf(done); if (k >= 0) waiters.splice(k, 1); hold(false); resolve(null); }, timeoutMs);
    const done = (line) => { clearTimeout(t); hold(false); resolve(line); };
    waiters.push(done);
    try { helper.stdin.write(cmd + '\n'); } catch { done(null); }
  });
}

/**
 * Keep the browser window OS-foregrounded for `durationMs`. Resolves true as soon as the window
 * has been put in front (usually a few ms once the helper is warm), false if that failed.
 */
export async function holdBrowserFocus(durationMs = 6000, { titleMatch = 'Gemini' } = {}) {
  if (process.platform !== 'win32') return false;
  const ok = await startHelper().catch(() => false);
  if (!ok) return false;
  const line = await send(`hold ${Math.round(durationMs)} ${String(titleMatch).replace(/[\r\n]/g, ' ')}`);
  return /^held true/.test(line || '');
}

/** Stop re-asserting focus now (the operator gets their window back immediately). */
export async function releaseBrowserFocus() {
  if (!helper) return;
  await send('release', 1000);
}

/** Start the helper ahead of time so the first real hold is already warm. */
export function warmFocusHelper() {
  if (process.platform === 'win32') startHelper().catch(() => {});
}

/** One-shot synchronous front, kept for diagnostics. */
export function forceBrowserFocus() {
  if (process.platform !== 'win32') return { ok: false, error: 'windows_only' };
  const script = `$ErrorActionPreference='Stop'\n${TYPES}\n${FIND_AND_FRONT}\n$p = Find-Browser 'Gemini'; if (-not $p) { '{"ok":false,"error":"no_browser_window_found"}' } else { $r = Front $p.MainWindowHandle; '{"ok":' + $r.ToString().ToLower() + ',"process":"' + $p.ProcessName + '"}' }`;
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 15000 });
    return JSON.parse(out.trim().split('\n').filter(Boolean).pop() ?? '{}');
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}
