"""Browser e2e for the YouTube -> mp3 flow, against an offline fake server.

Run:  python3 test/e2e-convert.py        (needs `pip install playwright` + a Chromium)
Covers: server detection, per-track and bulk convert, auto-convert in Analyze pending,
failure fallback, deck playback, reload rehydration, server-down revert, stale-cancel
regression, settings clamping, silent-file rejection, corrupt saved state.
"""
import os, subprocess, sys, time, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
PORT = int(os.environ.get('E2E_PORT', '8767'))
BASE = f'http://127.0.0.1:{PORT}/'
A, B, SIL, FAIL = 'aaaaaaaaaaa', 'bbbbbbbbbbb', 'ssssssssssi', 'failfailfai'
failures = []

def check(cond, msg):
    print(('ok   ' if cond else 'FAIL ') + msg)
    if not cond: failures.append(msg)

def start_server():
    p = subprocess.Popen(['node', str(ROOT / 'test/server/fake-server.mjs')], env={**os.environ, 'PORT': str(PORT)},
                         stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    for _ in range(50):
        try:
            urllib.request.urlopen(BASE + 'api/health', timeout=1); return p
        except Exception: time.sleep(0.2)
    p.kill(); sys.exit('fake server did not start')

def wav_silence(seconds=8, sr=22050):
    n = sr * seconds * 2
    import struct
    return b'RIFF' + struct.pack('<I', 36 + n) + b'WAVEfmt ' + struct.pack('<IHHIIHH', 16, 1, 1, sr, sr * 2, 2, 16) + b'data' + struct.pack('<I', n) + bytes(n)

server = start_server()
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
        ctx = browser.new_context(); ctx.route('**/youtube.com/**', lambda r: r.abort()); ctx.route('**/noembed.com/**', lambda r: r.abort())
        pg = ctx.new_page(); errors = []
        pg.on('pageerror', lambda e: errors.append(str(e)))
        ev = pg.evaluate
        def load(): pg.goto(BASE); pg.wait_for_function('API.up === true || API.up === false'); pg.wait_for_timeout(500)
        def track(i): return ev(f"(()=>{{const t=S.tracks['{i}'];return t&&{{kind:t.kind,conv:!!t.converted,status:t.status,bpm:t.bpm,err:t.error||'',peaks:!!t.peaks,title:t.title}}}})()")
        def wait_status(i, want, timeout=40):
            end = time.time() + timeout
            while time.time() < end:
                t = track(i)
                if t and t['status'] in want: return t
                pg.wait_for_timeout(250)
            return track(i)

        load()
        check(ev('API.up'), 'server detected')
        check(pg.is_visible('#convRow') and pg.is_visible('#btnConvertAll'), 'convert controls appear when the server is up')

        # 1. single-track convert via the row button
        ev(f"addTrack('{A}','test',{{title:'',author:''}}); save(); render();")
        ev("document.querySelector('#tabLib')?.removeAttribute('hidden'); render();")
        check(pg.is_visible(f'.trow[data-id="{A}"] [data-act="conv"]'), 'YouTube row shows a convert button')
        pg.click(f'.trow[data-id="{A}"] [data-act="conv"]')
        t = wait_status(A, ['done', 'error'])
        check(t['kind'] == 'file' and t['conv'], 'converted track becomes a file-backed track')
        check(t['status'] == 'done' and t['bpm'] and abs(t['bpm'] - 128) < 2, f"exact BPM from the mp3 (got {t['bpm']})")
        check(t['peaks'], 'waveform peaks computed')
        check('Alpha' in t['title'], 'title filled from the server')
        check('YT→MP3' in ev(f"kindBadge(S.tracks['{A}'])"), 'YT→MP3 badge')
        check(not pg.is_visible(f'.trow[data-id="{A}"] [data-act="conv"]'), 'no convert button once converted')

        # 2. Analyze pending converts first, falls back for failures
        ev(f"addTrack('{B}','t'); addTrack('{FAIL}','t'); S.settings.convert=true; save(); render();")
        ev("runAnalysis()")
        t = wait_status(B, ['done', 'error'], 60)
        check(t['conv'] and t['status'] == 'done' and abs(t['bpm'] - 100) < 2, f"Analyze pending auto-converts ({t})")
        f = track(FAIL)
        check(f['kind'] == 'yt' and not f['conv'], 'failed conversion leaves a normal YouTube track')
        pg.wait_for_function('!AN.running', timeout=30000)
        check('convert failed' in ev("document.querySelector('#anLog')?.textContent || ''"), 'failure is logged')

        # 3. convert-all skips file tracks and reports
        ev(f"delete S.tracks['{FAIL}']; S.order=S.order.filter(x=>x!=='{FAIL}'); save();")

        # 4. deck can load and play the converted mp3
        ev(f"D.decks[0].load('{A}')")
        pg.wait_for_function("D.decks[0].audio.readyState >= 1", timeout=15000)
        dur = ev("D.decks[0].audio.duration")
        check(18 < dur < 22, f'deck loads converted mp3 over HTTP (duration {dur:.1f}s)')
        ev("D.decks[0].audio.currentTime = 5")  # seek requires Range support
        check(abs(ev("D.decks[0].audio.currentTime") - 5) < 0.5, 'seeking works (range requests)')

        # 5. reload: converted tracks re-attach
        load()
        check(ev(f"LOCAL.has('{A}') && LOCAL.has('{B}')"), 'converted tracks re-attach after reload')
        check(track(A)['status'] == 'done' and track(A)['kind'] == 'file', 'analysis survives reload')

        # 6. stale cancel flag must not abort a manual convert
        ev("S.tracks['zzzzzzzzzzz']={id:'zzzzzzzzzzz',kind:'yt',title:'',author:'',status:'pending',sources:[]}; S.order.push('zzzzzzzzzzz'); AN.cancel=true; render();")
        ev("convertTrack(S.tracks['zzzzzzzzzzz'], {analyze:false})")
        pg.wait_for_function("(document.querySelector('#anLog')?.textContent || '').includes('convert failed')", timeout=15000)
        log = ev("document.querySelector('#anLog')?.textContent || ''")
        check('unknown fake video' in log and 'cancelled' not in log, 'stale cancel flag does not abort a manual convert (it reached the server)')
        ev("delete S.tracks['zzzzzzzzzzz']; S.order=S.order.filter(x=>x!=='zzzzzzzzzzz'); AN.cancel=false;")

        # 7. bulk convert
        ev(f"addTrack('{SIL}','t',{{title:'Silence'}}); save(); render();")
        ev("setPrep(true)")
        pg.click('#btnConvertAll')
        t = wait_status(SIL, ['done', 'error', 'pending'], 40)
        pg.wait_for_function('!AN.running', timeout=40000); pg.wait_for_timeout(1500)
        t = track(SIL)
        check(t['conv'], 'Convert all handles remaining YouTube tracks')
        check(t['status'] == 'error' and 'silent' in t['err'], f"silent audio is rejected, not given a made-up BPM ({t['status']}: {t['err']})")

        # 8. settings clamp: clearing the BPM-min field must not poison the setting
        pg.fill('#optBpmMin', '')
        check(ev('S.settings.bpmMin') == 80, 'cleared BPM-min field keeps a sane value')
        pg.fill('#optBpmMin', '90')
        check(ev('S.settings.bpmMin') == 90, 'valid BPM-min value is accepted')
        pg.fill('#optBpmMin', '80')

        # 9. local file drop of silence is rejected too
        pg.set_input_files('#fileInput', files=[{'name': 'silent.wav', 'mimeType': 'audio/wav', 'buffer': wav_silence()}])
        pg.wait_for_timeout(500)
        t = wait_status(ev("S.order.find(i=>S.tracks[i].kind==='file'&&i.startsWith('f:'))"), ['error', 'done'], 20)
        check(t['status'] == 'error' and 'silent' in t['err'], 'silent local file is rejected')

        # 10. library delete keeps the resume position pointing at the right track
        ev(f"S.set=['{A}','{B}','{SIL}']; S.pos=1; D.started=false; save(); render();")
        ev("document.querySelector('#tabLib')?.removeAttribute('hidden'); render();")
        pg.click(f'#libView .trow[data-id="{B}"] [data-act="del"]')
        check(ev("S.set[Math.max(S.pos,0)]") == SIL, 'deleting a set track before start keeps resume on the right track')

        # 11. corrupt saved state must not brick the page
        ev("clearTimeout(saveT); saveT = null")  # don't let a pending save overwrite the fixture on pagehide
        ev("localStorage.setItem('tubedj.v1', JSON.stringify({tracks:null, order:'x', set:[1,2], settings:null}))")
        errors.clear(); load()
        check(not errors and ev('Object.keys(S.tracks).length') == 0, f'corrupt saved state is normalised (errors: {errors})')
        ev("clearTimeout(saveT); saveT = null")
        ev("localStorage.setItem('tubedj.v1', JSON.stringify({tracks:{x:{id:'x',title:'old'}}, order:['x','ghost'], set:['ghost'], settings:{}}))")
        errors.clear(); load()
        check(not errors and ev("S.order.join()") == 'x' and ev("S.set.length") == 0 and ev("S.tracks.x.sources.length") == 0, 'old-format tracks get defaults, dangling ids dropped')

        # 12. server down: converted tracks fall back to YouTube, keeping analysis
        load(); ev(f"addTrack('{A}','t'); convertTrack(S.tracks['{A}'],{{analyze:true}})"); wait_status(A, ['done'], 40)
        pg.route('**/api/**', lambda r: r.abort())  # the app is served by the same process, so simulate the API vanishing
        pg.reload(); pg.wait_for_function('API.up === false', timeout=15000); pg.wait_for_timeout(500)
        t = track(A)
        check(t['kind'] == 'yt' and not t['conv'] and t['bpm'], f"server down: track reverts to YouTube and keeps its BPM ({t})")
        check(not pg.is_visible('#convRow'), 'convert controls hidden when the server is down')
        check(not errors, f'no page errors during the run: {errors}')
        browser.close()
finally:
    server.kill()

print(f"\n{'FAILED: ' + str(len(failures)) if failures else 'all e2e checks passed'}")
sys.exit(1 if failures else 0)
