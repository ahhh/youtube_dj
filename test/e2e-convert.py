import sys, time
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    pg = b.new_page()
    errs=[]; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto('http://127.0.0.1:8766/'); pg.wait_for_timeout(1500)
    print('api up:', pg.evaluate('API.up'), 'convRow visible:', pg.is_visible('#convRow'))
    pg.evaluate("""S.settings.convert=true; addTrack('dQw4w9WgXcQ','test',{title:'Rick',author:'x'}); save(); render();""")
    pg.evaluate("runAnalysis()")
    for i in range(60):
        pg.wait_for_timeout(1000)
        st = pg.evaluate("(()=>{const t=S.tracks['dQw4w9WgXcQ'];return [t.kind,t.converted,t.status,t.bpm,t.keyName,t.camelot,!!t.peaks,t.beatOffset]})()")
        if st[2]=='done' or st[2]=='error': break
    print('state:', st)
    print('badge:', pg.evaluate("kindBadge(S.tracks['dQw4w9WgXcQ'])"))
    # reload: must rehydrate the cached mp3
    pg.reload(); pg.wait_for_timeout(2000)
    print('after reload LOCAL has:', pg.evaluate("LOCAL.has('dQw4w9WgXcQ')"), pg.evaluate("S.tracks['dQw4w9WgXcQ'].kind"))
    # deck can load it
    print('playable:', pg.evaluate("playable(S.tracks['dQw4w9WgXcQ'])"))
    print('page errors:', errs)
    b.close()
