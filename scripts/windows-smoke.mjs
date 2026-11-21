// Smoke-test the installed Windows app on a GitHub-hosted Windows runner (.github/workflows/windows-smoke.yml).
// It lives here, in the public downloads repository, and not beside the app source: Actions minutes are
// free here, and the run reads nothing private (brain ADR 449). It uses only the node standard library.
// The Linux debug build on the box (scripts/app-drive.mjs, WebKitGTK) is the only build a machine drove
// before this; the shipped NSIS installer and its WebView2 shell were run by no machine. This drives the
// app the installer put on disk, over WebDriver (tauri-driver in front of msedgedriver), with no sign-in:
//
//   node scripts/windows-smoke.mjs --app <Manyhands.exe> --driver <tauri-driver.exe> --native <msedgedriver.exe> --out <dir>
//
// It passes when the main window opens and the first screen draws its heading, "Sign in to Manyhands"
// (src/shell/signinCopy.ts in the app source). It writes to --out:
//   window.png      the webview, from WebDriver
//   desktop.png     the whole screen, so the native frame and anything over it shows
//   app-log.txt     timings, the first screen's text, webview console errors, the app's process and window
//   driver-log.txt  tauri-driver's and msedgedriver's output, and the app's stderr under it (RUST_LOG)
//   msedgedriver-verbose.log  only when the tauri-driver session failed: a second try straight at
//                   msedgedriver, with its own verbose log, so the reason is in the file
//   timings.json    the same timings, for the run's summary
// The exit code is 1 when a check failed. Every wait has a limit: a msedgedriver that does not match the
// WebView2 runtime hangs at session start rather than failing.
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  if (i < 0 || !args[i + 1]) throw new Error(`${name} is needed`);
  return args[i + 1];
};
const app = opt("--app");
const driverBin = opt("--driver");
const native = opt("--native");
const out = opt("--out");
mkdirSync(out, { recursive: true });

const HEADING = "Sign in to Manyhands";
const log = [];
const note = (line) => {
  log.push(line);
  console.log(line);
};
const timings = {};
const started = Date.now();
const mark = (name) => (timings[name] = +((Date.now() - started) / 1000).toFixed(1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ps = (script) => spawnSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8" });
// MainWindowTitle is the native top-level window, so "Manyhands" there means a real window, not only
// a webview WebDriver reached.
const appProcess = () => {
  const r = ps(`Get-Process | Where-Object { $_.Path -eq '${app}' } | Format-List Id,ProcessName,MainWindowTitle,Responding,StartTime,WorkingSet64 | Out-String -Width 200`);
  note(`--- app process ---\n${(r.stdout || r.stderr || "(none)").trim()}\n---`);
};

const driverLog = createWriteStream(join(out, "driver-log.txt"));
const children = [];
const start = (bin, argv) => {
  const child = spawn(bin, argv, { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(driverLog, { end: false });
  child.stderr.pipe(driverLog, { end: false });
  children.push(child);
  return child;
};

async function wd(base, method, path, body, ms = 30_000) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(ms),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.value?.error) throw new Error(`${method} ${path}: ${json.value?.message ?? res.status}`);
  return json.value;
}

async function up(base, what) {
  for (let t = 0; ; t++) {
    try {
      await fetch(`${base}/status`, { signal: AbortSignal.timeout(1000) });
      return;
    } catch {
      if (t > 100) throw new Error(`${what} did not answer at ${base} in 10 s`);
      await sleep(100);
    }
  }
}

// One WebDriver session against the app: open it, wait for the first screen, take the shot. Returns
// true when the heading was drawn. `caps` is what the driver at `base` is sent.
async function drive(label, base, caps) {
  let session;
  const S = () => `/session/${session.sessionId}`;
  const evaluate = (js) => wd(base, "POST", `${S()}/execute/sync`, { script: `return (${js});`, args: [] });
  let ok = false;
  try {
    const t0 = Date.now();
    // The session start launches the app; it returns once msedgedriver has attached to its WebView2.
    session = await wd(base, "POST", "/session", { capabilities: { alwaysMatch: caps } }, 180_000);
    mark(`${label}_window_open_s`);
    note(`${label}: session after ${((Date.now() - t0) / 1000).toFixed(1)} s, ${session.capabilities?.browserName} ${session.capabilities?.browserVersion}`);

    // The same console hook as app-drive.mjs: msedgedriver keeps no browser log for a WebView2 target.
    await evaluate(`(() => {
      if (window.__smokeNoise) return null;
      const noise = (window.__smokeNoise = []);
      const str = (a) => (a instanceof Error ? a.stack || a.message : typeof a === "string" ? a : JSON.stringify(a));
      for (const level of ["error", "warn"]) {
        const orig = console[level];
        console[level] = (...a) => { noise.push(level + ": " + a.map(str).join(" ")); orig.apply(console, a); };
      }
      addEventListener("error", (e) => noise.push("exception: " + (e.error?.stack || e.message)));
      addEventListener("unhandledrejection", (e) => noise.push("rejection: " + str(e.reason)));
      return null;
    })()`).catch((e) => note(`console hook: ${e.message}`));

    // Every window of the app is a webview, and the session may start on any of them (run 3 started on
    // the hidden Jot window): look through them all for the main one, the one that draws the heading.
    let text = "";
    for (let t = 0; t < 60 && !text.includes(HEADING); t++) {
      for (const handle of (await wd(base, "GET", `${S()}/window/handles`).catch(() => [])) ?? []) {
        await wd(base, "POST", `${S()}/window`, { handle }).catch(() => {});
        text = (await evaluate("document.readyState === 'complete' ? document.body.innerText : ''").catch(() => "")) ?? "";
        if (text.includes(HEADING)) break;
      }
      if (!text.includes(HEADING)) await sleep(1000);
    }
    ok = text.includes(HEADING);
    if (ok) {
      mark(`${label}_first_screen_s`);
      note(`${label}: first screen: "${HEADING}" is drawn`);
    } else note(`FAIL ${label}: "${HEADING}" was not drawn within 60 s of the window opening`);
    await sleep(1500); // the sign-in card's entrance animation, so the shot is the settled screen
    writeFileSync(join(out, "window.png"), Buffer.from(await wd(base, "GET", `${S()}/screenshot`), "base64"));
    note(`title: ${await wd(base, "GET", `${S()}/title`).catch((e) => e.message)}`);
    note(`url: ${await wd(base, "GET", `${S()}/url`).catch((e) => e.message)}`);
    note(`window rect: ${JSON.stringify(await wd(base, "GET", `${S()}/window/rect`).catch((e) => e.message))}`);
    note(`--- first screen text ---\n${text.slice(0, 2000)}\n---`);
    for (const n of (await evaluate("window.__smokeNoise || []").catch(() => [])) ?? []) note(`console: ${n}`);
    appProcess();
  } catch (e) {
    note(`FAIL ${label}: ${e.message}`);
  }
  if (session) await wd(base, "DELETE", S()).catch(() => {});
  return ok;
}

let passed = false;
try {
  start(driverBin, ["--port", "4444", "--native-port", "4445", "--native-driver", native]);
  await up("http://127.0.0.1:4444", "tauri-driver");
  mark("driver_up_s");
  passed = await drive("tauri_driver", "http://127.0.0.1:4444", { "tauri:options": { application: app } });
  if (!passed) {
    // The same session straight at msedgedriver, with the capabilities and environment tauri-driver
    // 2.1.0 gives it (src/server.rs, src/webdriver.rs), and msedgedriver's own verbose log.
    process.env.TAURI_WEBVIEW_AUTOMATION = "true";
    start(native, ["--port=4446", "--verbose", `--log-path=${join(out, "msedgedriver-verbose.log")}`]);
    await up("http://127.0.0.1:4446", "msedgedriver");
    await drive("msedgedriver", "http://127.0.0.1:4446", {
      browserName: "webview2",
      "ms:edgeChromium": true,
      "ms:edgeOptions": { binary: app, args: [] },
    });
  }
} catch (e) {
  note(`FAIL: ${e.message}`);
}
const failed = !passed;

// Outside WebDriver: the whole screen. The app's process is read inside drive(), while it runs.
const shot = ps(`Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
[System.Drawing.Graphics]::FromImage($bmp).CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$bmp.Save('${join(out, "desktop.png")}')
"$($b.Width)x$($b.Height)"`);
note(`desktop shot: ${(shot.stdout || shot.stderr).trim()}`);

for (const c of children) c.kill();
mark("total_s");
timings.pass = passed;
note(`timings: ${JSON.stringify(timings)}`);
writeFileSync(join(out, "timings.json"), JSON.stringify(timings, null, 2));
writeFileSync(join(out, "app-log.txt"), log.join("\n") + "\n");
driverLog.end();
process.exit(failed ? 1 : 0);
