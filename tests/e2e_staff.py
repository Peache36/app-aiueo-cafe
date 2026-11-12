import json,time,urllib.request
from playwright.sync_api import sync_playwright
B='http://localhost:8099'
otp=lambda: json.load(urllib.request.urlopen(B+'/__otp'))
errs=[]
with sync_playwright() as p:
    br=p.chromium.launch(executable_path='/usr/bin/google-chrome',args=['--no-sandbox'])
    ctx=br.new_context(viewport={'width':390,'height':844},device_scale_factor=2,has_touch=True,is_mobile=True)
    pg=ctx.new_page(); pg.on('pageerror',lambda e:errs.append(str(e)))
    pg.goto(B); pg.wait_for_selector('#splash',state='detached',timeout=8000)
    pg.fill('#ph','081200000001'); pg.click('#goOtp'); time.sleep(1)
    if pg.locator('#nm').count(): pg.fill('#nm','Owner'); pg.click('#goOtp'); time.sleep(1.2)
    pg.fill('#otp',otp()['code']); time.sleep(2.5)
    print('ADMIN:',pg.inner_text('.brand').replace('\n',' '), '|', [b.inner_text().strip() for b in pg.locator('.nav button').all()])
    n=pg.locator('.nav button').count()
    for i in range(n):
        pg.click(f'.nav button >> nth={i}'); time.sleep(.9); pg.screenshot(path=f'/tmp/a{i}.png')
    # kasir: cari member lalu tambah stamp
    pg.click('.nav button >> nth=0'); time.sleep(.5)
    print(pg.inner_text('#view')[:300].replace('\n',' | '))
    br.close()
print('ERRORS',errs)
