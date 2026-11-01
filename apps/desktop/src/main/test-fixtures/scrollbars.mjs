import assert from 'node:assert/strict'
import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { writeFile } from 'node:fs/promises'

const directory = process.env.WHYCODE_SCROLLBAR_TEST_DIR
app.setPath('userData', path.join(directory, 'profile'))
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 760, height: 560, webPreferences: { backgroundThrottling: false } })
  const run = code => win.webContents.executeJavaScript(code)
  const until = async (condition, label) => {
    const deadline = Date.now() + 7000
    while (!await run(condition)) {
      assert.ok(Date.now() < deadline, label)
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  const color = (id, pseudo = '') => run(`getComputedStyle(document.getElementById(${JSON.stringify(id)}),${JSON.stringify(pseudo)}).getPropertyValue('--wc-scrollbar-thumb').trim()`)
  const paint = () => run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  const pixel = async (x, y) => {
    await paint()
    const image = await win.webContents.capturePage({ x, y, width: 1, height: 1 })
    return [...image.toBitmap().subarray(0, 3)]
  }
  try {
    await win.loadFile(path.join(directory, 'index.html'))
    await until('document.querySelector("#inline")', 'fixture mounted')
    assert.equal(await color('inline'), 'rgba(0, 0, 0, 0)')
    assert.equal(await color('panel'), 'rgba(56, 59, 53, 0.07)')
    assert.equal(await run('document.querySelector("#inline").style.getPropertyValue("--wc-scrollbar-height")'), '8px')
    await run('document.querySelector("#inline").scrollTop=40;document.querySelector("#panel").scrollLeft=40')
    await until('document.querySelectorAll("[data-wc-scrollbar=scrolling]").length===2', 'both axes show activity')
    assert.equal(await color('inline'), 'rgba(56, 59, 53, 0.2)')
    assert.equal(await color('panel'), 'rgba(56, 59, 53, 0.2)')
    const point = await run(`(()=>{const el=document.querySelector('#inline'),r=el.getBoundingClientRect();return {x:Math.floor(r.right-4),y:Math.floor(r.top+25)}})()`)
    assert.ok((await pixel(point.x,point.y)).every(channel=>channel>200 && channel<230), 'active native thumb is dark gray')
    assert.ok((await pixel(340,186)).every(channel=>channel>200 && channel<230), 'bottom fade does not lighten horizontal thumb')
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point })
    await until('document.querySelector("#panel").dataset.wcScrollbar==="idle" && document.querySelector("#panel").getAnimations().length===0', 'three second inactivity')
    assert.equal(await run('document.querySelector("#inline").dataset.wcScrollbar'), 'scrolling', 'hover holds activity until leaving the scrollbar')
    const hovered = await pixel(point.x,point.y)
    assert.ok(hovered.every(channel=>channel<70), 'hovered thumb stays black after idle timeout')
    win.webContents.sendInputEvent({ type:'mouseMove', x:700, y:400 })
    await until('document.querySelector("#inline").dataset.wcScrollbar==="idle"', 'hover exit settles an expired timer')
    assert.ok(await run('document.querySelector("#inline").getAnimations().length>0'), 'hover exit also fades')
    await until('document.querySelector("#inline").getAnimations().length===0', 'hover exit fade completes')
    win.webContents.sendInputEvent({ type:'mouseMove', ...point })
    win.webContents.sendInputEvent({ type:'mouseDown', button:'left', clickCount:1, ...point })
    win.webContents.sendInputEvent({ type:'mouseMove', x:point.x, y:point.y+60, movementY:60 })
    win.webContents.sendInputEvent({ type:'mouseUp', button:'left', clickCount:1, x:point.x, y:point.y+60 })
    await until('document.querySelector("#inline").scrollTop>40', 'native thumb dragging remains usable')
    win.webContents.sendInputEvent({ type:'mouseMove', x:700, y:400 })
    await until('document.querySelector("#inline").dataset.wcScrollbar==="idle"', 'second idle timeout')
    assert.ok(await run('document.querySelector("#inline").getAnimations().length>0'), 'idle change fades rather than disappearing immediately')
    await until('document.querySelector("#inline").getAnimations().length===0', 'second fade completes')
    assert.equal(await color('inline'), 'rgba(0, 0, 0, 0)')
    assert.equal(await color('panel'), 'rgba(56, 59, 53, 0.07)')
    await run('document.querySelector("#inline").firstElementChild.style.width="100px"')
    await until('document.querySelector("#inline").style.getPropertyValue("--wc-scrollbar-height")==="0px"', 'no gap in fade without horizontal overflow')
    await run(`(() => {
      let deliver;
      window.whycode={controlTerminal:()=>Promise.resolve(),onTerminalEvent:callback=>{deliver=callback;return ()=>{deliver=undefined}}};
      const host=document.createElement('div');host.id='terminal';host.style.cssText='width:500px;height:160px;margin:30px';document.body.append(host);
      window.detachTerminal=fixture.attachTerminal({id:'scrollbar-test',title:'终端',cwd:'/'},host);
      deliver({terminalId:'scrollbar-test',type:'data',data:'line\\r\\n'.repeat(70)});
    })()`)
    await until('document.querySelector("#terminal [data-wc-scrollbar=scrolling]")', 'xterm activity uses same state')
    await until('document.querySelector("#terminal [data-wc-scrollbar=idle]")?.getAnimations().length===0', 'xterm idle state')
    assert.equal(await run('getComputedStyle(document.querySelector("#terminal .slider")).backgroundColor'), 'rgba(56, 59, 53, 0.07)')
    assert.equal(await run('getComputedStyle(document.querySelector("#terminal .scrollbar.vertical")).opacity'), '1')
    await run('window.detachTerminal();fixture.disposeTerminalView("scrollbar-test");document.querySelector("#terminal").remove()')
    const edges = await run(`(async()=>{
      const source='flowchart TD\\nA[发送请求] -->|成功| B[进入下一步]\\nA -->|超出上下文预算| C[重新压缩]\\nC --> D[重发请求]';
      const svg=await fixture.renderMermaid(source,new AbortController().signal);
      const diagram=new DOMParser().parseFromString(svg,'image/svg+xml');
      const preview=document.importNode(diagram.documentElement,true);document.querySelector('#root').append(preview);
      const labels=[...preview.querySelectorAll('.edgeLabel rect.background')].map(rect=>({opacity:getComputedStyle(rect).opacity,stroke:getComputedStyle(rect).stroke,
        text:getComputedStyle(rect.parentElement.querySelector('text')).fill}));
      preview.remove();
      if(labels.length!==2 || labels.some(label=>label.opacity!=='1' || label.stroke!=='rgb(215, 220, 210)' || label.text!=='rgb(98, 103, 95)'))throw new Error('连线标签应有不透明底色、灰色边框和中灰文字');
      const image=document.createElement('img');image.style.cssText='display:block;margin:30px auto;width:360px';
      const url=URL.createObjectURL(new Blob([svg],{type:'image/svg+xml'}));image.src=url;document.querySelector('#root').append(image);await image.decode();URL.revokeObjectURL(url);
      return [...diagram.querySelectorAll('.flowchart-link')].map(edge=>edge.getAttribute('d'));
    })()`)
    assert.equal(edges.length, 3)
    for(const edge of edges) {
      assert.doesNotMatch(edge, /[CQ]/i, '流程图连线不含曲线')
      const points=[...edge.matchAll(/[ML]([\d.-]+),([\d.-]+)/g)].map(match=>match.slice(1).map(Number))
      for(let i=1;i<points.length;i++) {
        assert.notDeepEqual(points[i],points[i-1], '零长度线段不能改变箭头朝向')
        assert.ok(points[i][0]===points[i-1][0] || points[i][1]===points[i-1][1], '折线线段水平或垂直')
      }
    }
    if(process.env.WHYCODE_UI_CAPTURE) {
      await paint()
      await new Promise(resolve=>setTimeout(resolve,100))
      await writeFile(process.env.WHYCODE_UI_CAPTURE,(await win.webContents.capturePage()).toPNG())
    }
    await run('document.querySelector("#panel").scrollTop=10')
    await until('document.querySelector("#panel").dataset.wcScrollbar==="scrolling"', 'active before teardown')
    await run('window.fixture.scrollbars.dispose()')
    assert.equal(await run('document.querySelector("#panel").hasAttribute("data-wc-scrollbar")'), false)
    console.log('scrollbars passed')
  } finally { win.destroy() }
  app.quit()
}).catch(error => { console.error(error); app.exit(1) })
