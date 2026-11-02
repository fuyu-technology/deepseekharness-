// 需求箱 · 独立控制页（单独网址）
// 打开：http://127.0.0.1:3200/?token=<state/box-token 里的值>
// 数据与 qq-bridge 共用：D:\大肥鱼\qq-bridge\state\message-box.json
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const STATE = path.join(ROOT, 'state')
const FILE = process.env.BOX_FILE || 'D:\\大肥鱼\\qq-bridge\\state\\message-box.json'
const TOKEN_FILE = path.join(STATE, 'box-token')
const PORT = Number(process.env.BOX_PORT) || 3200

fs.mkdirSync(STATE, { recursive: true })

function loadToken() {
  try {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim()
    if (t) return t
  } catch {}
  const t = crypto.randomBytes(16).toString('hex')
  fs.writeFileSync(TOKEN_FILE, t + '\n', 'utf8')
  return t
}
const TOKEN = loadToken()

function readDoc() {
  try {
    const raw = fs.readFileSync(FILE, 'utf8').replace(/^\uFEFF/, '')
    const d = JSON.parse(raw)
    if (d && Array.isArray(d.items)) return d
  } catch {}
  return { version: 1, items: [] }
}
function writeDoc(doc) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true })
  const tmp = `${FILE}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, FILE)
}

const RECEIPT_LABEL = { open: '待处理', received: '已收', working: '处理中', done: '已处理', wontfix: '不处理' }
const KIND_LABEL = { sos: '现场求助', l1: 'L1 问题反馈', l2: 'L2 需求', l3: 'L3 牢骚' }

function send(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(obj))
}
function readBody(req) {
  return new Promise((resolve) => {
    let buf = ''
    req.on('data', (c) => { buf += c; if (buf.length > 2e6) req.destroy() })
    req.on('end', () => { try { resolve(JSON.parse(buf || '{}')) } catch { resolve({}) } })
    req.on('error', () => resolve({}))
  })
}
function authorized(req, url) {
  const h = req.headers['x-box-token']
  const q = url.searchParams.get('token')
  return (h && h === TOKEN) || (q && q === TOKEN)
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const p = url.pathname

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(HTML)
    return
  }
  if (!p.startsWith('/api/')) { send(res, 404, { ok: false, error: 'not found' }); return }
  if (!authorized(req, url)) { send(res, 401, { ok: false, error: '令牌无效或缺失' }); return }

  if (req.method === 'GET' && p === '/api/box') {
    const doc = readDoc()
    const kind = url.searchParams.get('kind')
    const receipt = url.searchParams.get('receipt')
    let items = doc.items.slice()
    if (kind) items = items.filter((i) => i.kind === kind)
    if (receipt) items = items.filter((i) => i.receipt === receipt)
    items.sort((a, b) => b.createdAt - a.createdAt)
    const counts = { open: 0, sos: 0, l1: 0, l2: 0, l3: 0 }
    for (const i of doc.items) {
      if (i.receipt === 'open') counts.open++
      if (counts[i.kind] !== undefined) counts[i.kind]++
    }
    send(res, 200, { ok: true, items: items.slice(0, 500), counts, total: doc.items.length })
    return
  }

  if (req.method === 'POST' && p === '/api/box/receipt') {
    const body = await readBody(req)
    if (!RECEIPT_LABEL[body.receipt] || body.receipt === 'open') { send(res, 400, { ok: false, error: '回执值无效' }); return }
    const doc = readDoc()
    const item = doc.items.find((i) => i.id === body.id)
    if (!item) { send(res, 404, { ok: false, error: '没找到这条留言' }); return }
    item.receipt = body.receipt
    item.receiptNote = String(body.note ?? '').slice(0, 500)
    item.receiptAt = Date.now()
    writeDoc(doc)
    send(res, 200, { ok: true, item })
    return
  }

  if (req.method === 'POST' && p === '/api/box/reply') {
    const body = await readBody(req)
    const text = String(body.reply ?? '').slice(0, 2000)
    if (!text.trim()) { send(res, 400, { ok: false, error: '回复内容不能为空' }); return }
    const doc = readDoc()
    const item = doc.items.find((i) => i.id === body.id)
    if (!item) { send(res, 404, { ok: false, error: '没找到这条留言' }); return }
    item.reply = text
    item.replyAt = Date.now()
    writeDoc(doc)
    send(res, 200, { ok: true, item })
    return
  }

  if (req.method === 'POST' && p === '/api/box/remove') {
    const body = await readBody(req)
    const doc = readDoc()
    const idx = doc.items.findIndex((i) => i.id === body.id)
    if (idx < 0) { send(res, 404, { ok: false, error: '没找到这条留言' }); return }
    doc.items.splice(idx, 1)
    writeDoc(doc)
    send(res, 200, { ok: true })
    return
  }

  if (req.method === 'POST' && p === '/api/box') {
    const body = await readBody(req)
    if (!KIND_LABEL[body.kind]) { send(res, 400, { ok: false, error: 'kind 无效' }); return }
    const item = {
      id: crypto.randomBytes(6).toString('hex'),
      kind: body.kind,
      title: String(body.title || '').slice(0, 120),
      detail: String(body.detail || '').slice(0, 2000),
      key: null,
      source: 'admin',
      createdAt: Date.now(),
      receipt: 'open',
      receiptNote: '',
      receiptAt: 0,
      notified: null
    }
    if (!item.title) { send(res, 400, { ok: false, error: 'title 不能为空' }); return }
    const doc = readDoc()
    doc.items.push(item)
    writeDoc(doc)
    send(res, 200, { ok: true, item })
    return
  }

  send(res, 404, { ok: false, error: 'not found' })
})

const HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>需求箱 · 大肥鱼</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#0f1216;--card:#161b22;--line:#242c36;--text:#e6edf3;--muted:#8b98a5;--accent:#4aa8ff;--danger:#e2555b}
*{box-sizing:border-box}
body{margin:0;font:14px/1.6 "Segoe UI","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--text)}
header{padding:18px 24px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:14px;flex-wrap:wrap}
h1{font-size:18px;margin:0}
.muted{color:var(--muted);font-size:12px}
main{padding:18px 24px;max-width:1100px}
.bar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;align-items:center}
button{background:var(--card);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:6px 12px;cursor:pointer;font:inherit}
button:hover{border-color:var(--accent)}
button.active{background:var(--accent);border-color:var(--accent);color:#fff}
.item{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:10px}
.item.sos{border-left:4px solid var(--danger)}
.item.done,.item.wontfix{opacity:.62}
.head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.tag{font-size:12px;padding:1px 8px;border-radius:999px;border:1px solid var(--line);color:var(--muted)}
.tag.sos{color:#fff;background:var(--danger);border-color:var(--danger)}
.title{font-weight:600}
.detail{white-space:pre-wrap;margin:8px 0;color:#cfd8e3}
.meta{font-size:12px;color:var(--muted)}
.note{margin-top:8px;font-size:12px;color:#9fd3a5}
.acts{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;align-items:center}
.acts input{flex:1;min-width:200px;background:#0d1117;border:1px solid var(--line);color:var(--text);border-radius:8px;padding:6px 10px;font:inherit}
.empty{color:var(--muted);padding:40px 0;text-align:center}
.top-link{display:inline-flex;align-items:center;gap:4px;padding:5px 11px;border:1px solid var(--line);border-radius:999px;font-size:12px;font-weight:600;color:var(--text);text-decoration:none;background:var(--card)}
.top-link:hover{border-color:var(--accent);color:var(--accent)}
</style>
</head>
<body>
<header>
  <h1>需求箱</h1>
  <span class="muted" id="counts">读取中…</span>
  <span style="margin-left:auto"><a class="top-link" href="https://space.bilibili.com/2033307654" target="_blank" rel="noopener noreferrer">蝠羽科技 &#8599;</a></span>
  <span class="muted" id="live">—</span>
</header>
<main>
  <div class="bar" id="bar">
    <button data-f="" class="active">全部</button>
    <button data-f="open">未处理</button>
    <button data-f="sos">🚨 现场求助</button>
    <button data-f="l1">L1 问题反馈</button>
    <button data-f="l2">L2 需求</button>
    <button data-f="l3">L3 牢骚</button>
  </div>
  <div id="list"></div>
</main>
<script>
var params = new URLSearchParams(location.search);
var TOKEN = params.get('token') || localStorage.getItem('box-token') || '';
if (TOKEN) localStorage.setItem('box-token', TOKEN);
var filter = '';
var KIND = { sos: '🚨 现场求助', l1: 'L1 问题反馈', l2: 'L2 需求', l3: 'L3 牢骚' };
var REC = { open: '待处理', received: '已收', working: '处理中', done: '已处理', wontfix: '不处理' };
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function fmt(ms){if(!ms)return'';var d=new Date(ms);var p=function(n){return String(n).padStart(2,'0')};return (d.getMonth()+1)+'/'+d.getDate()+' '+p(d.getHours())+':'+p(d.getMinutes())}
async function api(path, method, body){
  var r = await fetch(path, { method: method||'GET', headers: { 'x-box-token': TOKEN, 'content-type': 'application/json' }, body: body?JSON.stringify(body):undefined });
  var j = await r.json().catch(function(){return {}});
  if(!r.ok) throw new Error(j.error || ('HTTP '+r.status));
  return j;
}
function paintFilter(){
  document.querySelectorAll('#bar button').forEach(function(b){ b.classList.toggle('active', b.dataset.f === filter); });
}
// 输入草稿：轮询重绘会清空输入框，这里按「条目id+字段」记住没保存的内容
var drafts = {};
function captureDrafts(){
  document.querySelectorAll('#list [data-id]').forEach(function(el){
    var id = el.dataset.id;
    el.querySelectorAll('input').forEach(function(inp){
      var field = inp.className;
      if (inp.value && inp.value !== inp.defaultValue) drafts[id + '::' + field] = inp.value;
      else if (inp.value === '') delete drafts[id + '::' + field];
    });
  });
}
// 正在打字就别重绘：把光标、选区、输入内容一起保住
function isTypingInList(){
  var a = document.activeElement;
  var list = document.getElementById('list');
  return !!(a && list && list.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA'));
}
async function refresh(){
  if(!TOKEN){
    document.getElementById('list').innerHTML = '<div class="empty">请在地址后加 <code>?token=你的令牌</code><br>令牌在 D:\\大肥鱼\\需求箱\\state\\box-token</div>';
    return;
  }
  if (isTypingInList()) return;   // 打字期间跳过本轮，避免输入被清空
  captureDrafts();
  try{
    var q = filter==='open' ? '?receipt=open' : (filter ? '?kind='+filter : '');
    var r = await api('/api/box'+q);
    var c = r.counts||{};
    document.getElementById('counts').textContent = '未处理 '+(c.open||0)+' · 求助 '+(c.sos||0)+' · L1 '+(c.l1||0)+' · L2 '+(c.l2||0)+' · L3 '+(c.l3||0)+' · 共 '+(r.total||0)+' 条';
    document.getElementById('live').textContent = '已同步 '+new Date().toLocaleTimeString();
    var list = document.getElementById('list');
    if(!r.items.length){ list.innerHTML = '<div class="empty">箱子里还没有留言。鱼需要时会自己写进来。</div>'; return; }
    list.innerHTML = r.items.map(function(it){
      var cls = it.kind==='sos' ? 'item sos' : 'item';
      if(it.receipt==='done'||it.receipt==='wontfix') cls += ' '+it.receipt;
      var ntf = it.notified ? ' · 通知 '+esc(it.notified) : '';
      var replyVal = drafts[it.id + '::reply-in'] != null ? drafts[it.id + '::reply-in'] : (it.reply||'');
      var noteVal = drafts[it.id + '::note-in'] != null ? drafts[it.id + '::note-in'] : (it.receiptNote||'');
      var btns = ['received','working','done','wontfix'].map(function(x){
        return '<button data-r="'+x+'"'+(it.receipt===x?' class="active"':'')+'>'+REC[x]+'</button>';
      }).join('');
      // 两栏：左「鱼的诉求」= 原始标题与详情；右「我的回复」= 管理员写下的处理结果
      var replyBlock = it.replyAt
        ? '<div class="reply-text">'+esc(it.reply)+'</div><div class="muted2">回复于 '+fmt(it.replyAt)+'</div>'
        : '<div class="reply-empty">还没有回复</div>';
      var noteHtml = it.receiptNote ? '<div class="note">回执备注：'+esc(it.receiptNote)+'</div>' : '';
      return '<div class="'+cls+'" data-id="'+it.id+'">'+
        '<div class="head"><span class="tag '+(it.kind==='sos'?'sos':'')+'">'+(KIND[it.kind]||it.kind)+'</span><span class="title">'+esc(it.title)+'</span>'+
        '<span class="meta" style="margin-left:auto">'+fmt(it.createdAt)+' · '+esc(it.key||'无会话')+' · 来自 '+esc(it.source)+ntf+'</span></div>'+
        '<div class="cols">'+
          '<div class="col">'+
            '<div class="col-h">🐟 鱼的诉求</div>'+
            (it.detail ? '<div class="detail">'+esc(it.detail)+'</div>' : '<div class="reply-empty">（没有补充说明）</div>')+
          '</div>'+
          '<div class="col">'+
            '<div class="col-h">✍ 我的回复</div>'+
            replyBlock+
            '<div class="reply-edit"><input class="reply-in" placeholder="写一句处理后的回复…" value="'+esc(replyVal)+'"><button class="reply-save">保存回复</button></div>'+
          '</div>'+
        '</div>'+
        noteHtml+
        '<div class="acts"><input class="note-in" placeholder="回执备注（可选）" value="'+esc(noteVal)+'">'+btns+'<button data-del="1" title="删除">✕</button></div>'+
      '</div>';
    }).join('');
    list.querySelectorAll('[data-id]').forEach(function(el){
      var id = el.dataset.id;
      el.querySelectorAll('[data-r]').forEach(function(b){
        b.onclick = async function(){
          var r = b.dataset.r;
          // 两种「关门」动作都要确认：处理完成、不处理
          if(r==='done' && !confirm('标记为「处理完成」？\\n\\n这条留言会被归档为已处理，鱼会看到这个回执。')) return;
          if(r==='wontfix' && !confirm('标记为「不处理」？\\n\\n这条留言会被归档为不处理，鱼会看到这个回执。')) return;
          try{
            await api('/api/box/receipt','POST',{id:id,receipt:r,note:el.querySelector('.note-in').value});
            delete drafts[id + '::note-in'];
            // 立刻只高亮刚点的这个，不等下一次轮询
            el.querySelectorAll('[data-r]').forEach(function(x){ x.classList.toggle('active', x === b); });
            refresh();
          }
          catch(e){ alert('保存失败：'+e.message); }
        };
      });
      var saveBtn = el.querySelector('.reply-save');
      if (saveBtn) saveBtn.onclick = async function(){
        var text = el.querySelector('.reply-in').value;
        if (!text.trim()) { alert('回复内容不能为空'); return; }
        try{
          await api('/api/box/reply','POST',{ id: id, reply: text });
          delete drafts[id + '::reply-in'];
          refresh();
        } catch(e){ alert('保存回复失败：' + e.message); }
      };
      el.querySelector('[data-del]').onclick = async function(){
        if(!confirm('删除这条留言？')) return;
        try{ await api('/api/box/remove','POST',{id:id}); refresh(); }catch(e){ alert('删除失败：'+e.message); }
      };
    });
  }catch(e){
    document.getElementById('list').innerHTML = '<div class="empty">读取失败：'+esc(e.message)+'</div>';
  }
}
document.querySelectorAll('#bar button').forEach(function(b){
  b.onclick = function(){ filter = b.dataset.f; paintFilter(); refresh(); };
});
paintFilter();
refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`

server.listen(PORT, '127.0.0.1', () => {
  console.log(`需求箱独立页面: http://127.0.0.1:${PORT}/?token=${TOKEN}`)
  console.log(`数据文件: ${FILE}`)
})
