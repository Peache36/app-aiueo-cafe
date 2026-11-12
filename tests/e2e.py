import json,time,urllib.request
from playwright.sync_api import sync_playwright
B='http://localhost:8099'
def otp(): return json.load(urllib.request.urlopen(B+'/__otp'))
errs=[]
with sync_playwright() as p:
    br=p.chromium.launch(executable_path='/usr/bin/google-chrome',args=['--no-sandbox'])
    ctx=br.new_context(viewport={'width':390,'height':844},device_scale_factor=2,has_touch=True,is_mobile=True)
    pg=ctx.new_page(); pg.on('pageerror',lambda e:errs.append(str(e))); pg.on('console',lambda m: m.type=='error' and errs.append(m.text))
    pg.goto(B); pg.wait_for_selector('#splash',state='detached',timeout=8000)
    pg.screenshot(path='/tmp/s1_login.png')
    print('LOGIN TEXT:',pg.inner_text('#app')[:200].replace('\n',' | '))
    def login(phone):
        pg.fill('#ph',phone); pg.click('#goOtp'); time.sleep(1)
        if pg.locator('#nm').count(): pg.fill('#nm','Budi Uji'); pg.click('#goOtp'); time.sleep(1.2)
        c=otp()['code']; pg.fill('.otp',c); time.sleep(.3)
        btn=pg.locator('button.btn:has-text("Masuk"), button.btn:has-text("Verifikasi")')
        if btn.count(): btn.first.click()
        time.sleep(2)
    login('081234567801')
    pg.screenshot(path='/tmp/s2_home.png')
    print('HOME:',pg.inner_text('#app')[:300].replace('\n',' | '))
    nav=pg.locator('.nav').bounding_box(); print('NAV box',nav)
    pg.click('.nav button >> nth=1'); time.sleep(.8); pg.screenshot(path='/tmp/s3_tab2.png')
    pg.click('.nav button >> nth=2'); time.sleep(.8); pg.screenshot(path='/tmp/s4_tab3.png')
    pg.click('.nav button >> nth=0'); time.sleep(.5)
    # QR
    pg.click('.nav button >> nth=0'); time.sleep(.3)
    pg.click('text=Tampilkan QR Saya'); time.sleep(1.5); pg.screenshot(path='/tmp/s5_qr.png')
    print('QR img:',pg.locator('.qrbox img').count(), 'code:',pg.locator('#qrmcode').inner_text())
    pg.keyboard.press('Escape')
    br.close()
print('ERRORS:',errs)
