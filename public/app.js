/* cmirror 前端:Listary 风单框 —— 引擎跳转 / URL 识别临时代理 / "/" 命令补全 */
(() => {
  'use strict'

  // ---------- 存储 ----------
  const LS_TOKEN = 'cmirror_token'
  const LS_ENGINE = 'cmirror_engine'
  const LS_MODE = 'cmirror_mode'
  const getMode = () => {
    const m = localStorage.getItem(LS_MODE)
    return m === 'stream' || m === 'rewrite' ? m : 'auto'
  }
  const setMode = (m) => localStorage.setItem(LS_MODE, m)
  const getToken = () => localStorage.getItem(LS_TOKEN) || ''
  const setToken = (t) => {
    if (t) localStorage.setItem(LS_TOKEN, t)
    else localStorage.removeItem(LS_TOKEN)
    // Cookie 让镜像页面跳转自动携带鉴权(浏览器导航不发 Authorization 头)
    document.cookie = t
      ? `cmirror_token=${encodeURIComponent(t)}; path=/; SameSite=Lax`
      : 'cmirror_token=; path=/; Max-Age=0'
  }

  // ---------- 搜索引擎 ----------
  const ENGINES = [
    { id: 'bing', name: 'Bing', url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}` },
    { id: 'google', name: 'Google', url: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}` },
    { id: 'baidu', name: '百度', url: (q) => `https://www.baidu.com/s?wd=${encodeURIComponent(q)}` },
    { id: 'ddg', name: 'DuckDuckGo', url: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}` },
    { id: 'github', name: 'GitHub', url: (q) => `https://github.com/search?q=${encodeURIComponent(q)}` },
  ]
  const getEngine = () => ENGINES.find((e) => e.id === localStorage.getItem(LS_ENGINE)) || ENGINES[0]
  const setEngine = (id) => localStorage.setItem(LS_ENGINE, id)

  const isUrl = (s) => !/\s/.test(s) && /^(https?:\/\/)?([\w-]+\.)+[a-z]{2,}([/?#]\S*)?$/i.test(s)
  const normalizeUrl = (s) => (/^https?:\/\//i.test(s) ? s : 'https://' + s)
  const mirrorHref = (u) => '/m/' + (getMode() === 'auto' ? '' : getMode() + '/') + normalizeUrl(u)
  // 启动器习惯:搜索/镜像结果一律新标签页打开,主框留在原地
  const openNew = (url) => window.open(url, '_blank', 'noopener')
  const isGithubUrl = (u) => /^(https?:\/\/)?([\w.-]+\.)?github\.(com|usercontent\.com|io)\b/i.test(u) || /^(https?:\/\/)?(gist|codeload)\.github\.com/i.test(u)

  // ---------- 命令 ----------
  const COMMANDS = [
    {
      cmd: '/mirror',
      args: '<url>',
      desc: '临时代理任意网址',
      run: (v) => { if (v) openNew(mirrorHref(v)) },
    },
    {
      cmd: '/mirror-github',
      args: '<github 链接>',
      desc: '镜像 GitHub 仓库/页面',
      run: (v) => {
        if (!v) return
        if (!isGithubUrl(v)) { alert('不是 GitHub 链接'); return }
        openNew(mirrorHref(v))
      },
    },
    { cmd: '/settings', desc: '打开设置(令牌 / 引擎 / 自定义代理)', run: () => (location.hash = '#settings') },
    {
      cmd: '/engine',
      args: '<' + ENGINES.map((e) => e.id).join('|') + '>',
      desc: '切换默认搜索引擎',
      run: (v) => {
        const e = ENGINES.find((x) => x.id === v.trim().toLowerCase())
        if (e) { setEngine(e.id); syncEngine() } else alert('未知引擎:' + v)
      },
    },
    { cmd: '/help', desc: '查看全部命令', run: () => {} },
  ]

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id)
  const input = $('q')
  const list = $('list')
  const engineBtn = $('engine')
  let sel = -1
  let matched = []

  const syncEngine = () => { engineBtn.textContent = getEngine().name }
  engineBtn.addEventListener('click', () => {
    const i = ENGINES.findIndex((e) => e.id === getEngine().id)
    setEngine(ENGINES[(i + 1) % ENGINES.length].id)
    syncEngine()
  })

  function renderList(items) {
    matched = items
    sel = items.length ? 0 : -1
    list.innerHTML = ''
    items.forEach((it, i) => {
      const li = document.createElement('li')
      li.innerHTML = `<span class="cmd"></span><span class="args"></span><span class="desc"></span>`
      li.children[0].textContent = it.cmd
      li.children[1].textContent = it.args || ''
      li.children[2].textContent = it.desc || ''
      li.className = i === sel ? 'sel' : ''
      li.addEventListener('mousedown', (e) => { e.preventDefault(); activate(i) })
      list.appendChild(li)
    })
    list.hidden = !items.length
  }

  // ---------- URL 镜像操作条(任意 URL 显示;GitHub 链接附加快捷操作) ----------
  const ghbar = $('ghbar')
  const GH_RE = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)(\/\S*)?$/i

  function renderUrlBar(v) {
    ghbar.innerHTML = ''
    const trimmed = v.trim()
    if (!isUrl(trimmed)) { ghbar.hidden = true; return }
    ghbar.hidden = false

    const mk = (label, fn, cls) => {
      const b = document.createElement('button')
      b.textContent = label
      if (cls) b.className = cls
      b.addEventListener('mousedown', (e) => e.preventDefault())
      b.addEventListener('click', fn)
      ghbar.appendChild(b)
      return b
    }

    // 模式三选:auto 按响应类型猜;rewrite 强制改写;stream 强制原样透传
    const seg = document.createElement('div')
    seg.className = 'seg'
    for (const m of ['auto', 'rewrite', 'stream']) {
      const b = document.createElement('button')
      b.textContent = m
      if (getMode() === m) b.className = 'on'
      b.title = m === 'auto' ? '按 Content-Type 自动选择' : m === 'rewrite' ? '强制 HTML/CSS 改写' : '强制原样透传(不注入不改写)'
      b.addEventListener('mousedown', (e) => e.preventDefault())
      b.addEventListener('click', () => {
        setMode(m)
        renderUrlBar(input.value)
        input.focus()
      })
      seg.appendChild(b)
    }
    ghbar.appendChild(seg)

    mk('镜像浏览', () => openNew(mirrorHref(trimmed)), 'primary')

    const g = GH_RE.exec(trimmed)
    if (g) {
      const owner = g[1]
      const repo = g[2].replace(/\.git$/i, '')
      const rest = g[3] || ''
      const base = `https://github.com/${owner}/${repo}`
      mk('复制 clone 命令', () => {
        const token = getToken()
        const proto = location.protocol === 'https:' ? 'https' : 'http'
        const auth = token ? `cmirror:${encodeURIComponent(token)}@` : ''
        copyText(`git clone ${proto}://${auth}${location.host}/m/${base}.git`, '已复制 ✓')
      })
      if (!rest || /^\/(tree|blob|releases|tags)/i.test(rest)) {
        mk('Releases', () => openNew(mirrorHref(base + '/releases')))
      }
      const blob = /^\/blob\/([^/]+)\/(.+)$/i.exec(rest)
      if (blob) {
        mk('Raw 镜像', () => openNew(mirrorHref(`https://raw.githubusercontent.com/${owner}/${repo}/${blob[1]}/${blob[2]}`)))
      }
    }
    if (!getToken()) {
      const note = document.createElement('span')
      note.className = 'note'
      note.textContent = '提示:在 /settings 配置令牌后可直接访问镜像'
      ghbar.appendChild(note)
    }
  }

  function copyText(text, okLabel) {
    const done = () => {
      const btn = [...ghbar.children].find((b) => b.tagName === 'BUTTON' && /clone/.test(b.textContent))
      if (btn) {
        const old = btn.textContent
        btn.textContent = okLabel
        setTimeout(() => (btn.textContent = old), 1400)
      }
    }
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, done)
    else {
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
      done()
    }
  }

  function refresh() {
    const v = input.value
    renderUrlBar(v)
    if (!v.startsWith('/')) { renderList([]); return }
    const head = v.split(' ')[0]
    const hasArg = v.includes(' ')
    if (hasArg) { renderList([]); return }
    renderList(COMMANDS.filter((c) => c.cmd.startsWith(head)))
  }

  /** Tab:仅补全命令文本(带参数命令留空格等待输入) */
  function complete(i) {
    const it = matched[i]
    if (!it) return
    input.value = it.cmd + (it.args ? ' ' : '')
    list.hidden = true
    input.focus()
  }

  /** Enter/点击:无参数命令直接执行;带参数命令先补全等待输入 */
  function activate(i) {
    const it = matched[i]
    if (!it) return
    if (it.args) { complete(i); return }
    list.hidden = true
    it.run('')
  }

  function submit() {
    const v = input.value.trim()
    if (!v) return
    if (v.startsWith('/')) {
      const sp = v.indexOf(' ')
      const name = sp === -1 ? v : v.slice(0, sp)
      const arg = sp === -1 ? '' : v.slice(sp + 1).trim()
      const cmd = COMMANDS.find((c) => c.cmd === name)
      if (cmd) {
        if (cmd.args && !arg) { input.value = cmd.cmd + ' '; return }
        cmd.run(arg)
        input.value = ''
        refresh()
        return
      }
      alert('未知命令:' + name + ' —— 输入 / 查看列表')
      return
    }
    if (isUrl(v)) { openNew(mirrorHref(v)); return }
    openNew(getEngine().url(v))
  }

  input.addEventListener('input', refresh)
  input.addEventListener('keydown', (e) => {
    const listOpen = !list.hidden && matched.length
    if (e.key === 'Tab' && listOpen) { e.preventDefault(); complete(sel); return }
    if (e.key === 'Enter' && listOpen && sel >= 0 && !input.value.includes(' ')) {
      e.preventDefault()
      activate(sel)
      return
    }
    if (listOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault()
      sel = (sel + (e.key === 'ArrowDown' ? 1 : matched.length - 1)) % matched.length
      mark()
      return
    }
    if (e.key === 'Escape') { list.hidden = true; return }
    if (e.key === 'Enter') { e.preventDefault(); submit() }
  })
  function mark() {
    [...list.children].forEach((li, i) => li.classList.toggle('sel', i === sel))
  }

  // ---------- 设置页 ----------
  const home = $('home')
  const settings = $('settings')
  const tokenInput = $('token')
  const engineSel = $('engineSel')
  const customList = $('customList')
  const customHint = $('customHint')

  for (const e of ENGINES) {
    const o = document.createElement('option')
    o.value = e.id
    o.textContent = e.name
    engineSel.appendChild(o)
  }

  async function api(path, opts = {}) {
    const t = getToken()
    const res = await fetch(path, {
      ...opts,
      headers: { 'content-type': 'application/json', ...(t ? { authorization: 'Bearer ' + t } : {}), ...(opts.headers || {}) },
    })
    return res
  }

  let rules = []
  async function loadRules() {
    try {
      const res = await api('/admin/mirror-rules')
      if (res.ok) {
        rules = await res.json()
        customHint.textContent = '共 ' + rules.length + ' 条(含内置默认)。修改需管理员令牌。'
      } else {
        customHint.textContent = '无法读取规则(HTTP ' + res.status + '),请检查令牌是否为管理员。'
      }
    } catch {
      customHint.textContent = '读取规则失败。'
    }
    renderRules()
  }
  function renderRules() {
    customList.innerHTML = ''
    for (const r of rules) {
      const li = document.createElement('li')
      const hostSpan = document.createElement('span')
      hostSpan.textContent = r.host
      const mode = document.createElement('span')
      mode.className = 'mode'
      mode.textContent = r.mode
      const del = document.createElement('button')
      del.textContent = '移除'
      del.addEventListener('click', async () => {
        rules = rules.filter((x) => x !== r)
        await saveRules()
      })
      li.append(hostSpan, mode, del)
      customList.appendChild(li)
    }
  }
  async function saveRules() {
    renderRules()
    const res = await api('/admin/mirror-rules', { method: 'PUT', body: JSON.stringify(rules) })
    if (!res.ok) customHint.textContent = '保存失败(HTTP ' + res.status + '),需要管理员令牌。'
    else customHint.textContent = '已保存 ' + rules.length + ' 条。'
  }
  $('customAdd').addEventListener('click', () => {
    const host = $('customHost').value.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
    if (!host) return
    if (rules.some((r) => r.host === host)) { customHint.textContent = host + ' 已存在'; return }
    rules = [...rules, { host, mode: $('customMode').value }]
    $('customHost').value = ''
    saveRules()
  })

  // /settings 既支持 hash 路由(#settings),也支持直接访问路径 /settings(SPA 回退到 index.html)
  const settingsActive = () => location.hash === '#settings' || location.pathname === '/settings'
  function showSettings(on) {
    settings.hidden = !on
    home.hidden = on
    if (on) {
      tokenInput.value = getToken()
      $('tokenState').textContent = getToken() ? '已保存 ✓(Cookie 已写入,镜像跳转自动携带)' : '保存在本浏览器(localStorage + Cookie),镜像页面跳转自动携带。'
      engineSel.value = getEngine().id
      loadRules()
    } else {
      input.focus()
    }
  }
  function saveToken() {
    const v = tokenInput.value.trim()
    setToken(v)
    $('tokenState').textContent = v ? '已保存 ✓(Cookie 已写入,镜像跳转自动携带)' : '已清除'
  }
  tokenInput.addEventListener('change', saveToken)
  tokenInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      saveToken()
    }
  })
  engineSel.addEventListener('change', () => { setEngine(engineSel.value); syncEngine() })
  window.addEventListener('hashchange', () => showSettings(settingsActive()))

  // ---------- 启动 ----------
  syncEngine()
  showSettings(settingsActive())
  if (!settingsActive()) input.focus()
})()
