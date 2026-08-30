// Headless-Chrome screenshot at an exact pixel size, waiting for webfonts.
// Drives Chrome over CDP directly so this needs no Puppeteer/Playwright
// dependency — the browser is already on the machine.
//
// Usage: node tools/og-shot.mjs <url> <out.png> <w> <h>
// Normally invoked by `make cover`; see tools/og-card.html.
const [url, out, w, h] = process.argv.slice(2);
const { execFile } = await import('node:child_process');
const fs = await import('node:fs/promises');

const CHROME = process.env.CHROME
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const port = 9333 + Math.floor(Math.random() * 500);
const proc = execFile(CHROME, [
  '--headless=new', `--remote-debugging-port=${port}`, '--no-first-run',
  '--user-data-dir=/tmp/cdp-og-' + port, '--hide-scrollbars', 'about:blank',
]);

let page;
for (let i = 0; i < 60 && !page; i++) {
  try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page'); } catch {}
  if (!page) await new Promise((r) => setTimeout(r, 200));
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const x = JSON.parse(m.data); if (x.id && pending.has(x.id)) { pending.get(x.id)(x.result); pending.delete(x.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = (e) => send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: e }).then((r) => r.result && r.result.value);

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: +w, height: +h, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });
await new Promise((r) => setTimeout(r, 1200));
// Fonts and the logo have to be in before the pixels are read, or the capture
// races the swap and lands on the fallback face.
await ev(`document.fonts.ready.then(()=>'ok')`);
await ev(`Promise.all([...document.images].map(i=>i.complete?1:new Promise(r=>{i.onload=i.onerror=r}))).then(()=>'ok')`);
console.log('fonts loaded  :', await ev(`[...document.fonts].filter(f=>f.status==='loaded').map(f=>f.family+' '+f.weight).join(', ')`));
console.log('h1 lines      :', await ev(`(()=>{const e=document.querySelector('h1');const cs=getComputedStyle(e);return Math.round(e.getBoundingClientRect().height/parseFloat(cs.lineHeight))+' line(s), '+Math.round(e.getBoundingClientRect().width)+'px wide'})()`));
console.log('overflow      :', await ev(`document.documentElement.scrollWidth+'x'+document.documentElement.scrollHeight`));

const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: +w, height: +h, scale: 1 }, captureBeyondViewport: true });
await fs.writeFile(out, Buffer.from(data, 'base64'));
console.log('wrote', out);
ws.close(); proc.kill(); process.exit(0);
