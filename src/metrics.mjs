// 流量采集：只读自己创作者后台的数据，每天一次。按作品 ID 匹配（标题在平台上可能改过）。
import { evaluate, withTab, sleep } from './driver.mjs';
import { SITE } from './site.mjs';
import { collectDouyinWorkMetrics } from './account-douyin.mjs';

const J = JSON.stringify;
// "1.2万" "6,017" "5.3K" → 数字
export function num(s) {
  if (s == null) return null; s = String(s).replace(/,/g, '').trim();
  const m = s.match(/^([\d.]+)\s*(万|亿|K|M|w)?/i); if (!m) return null;
  const k = { '万': 1e4, 'w': 1e4, '亿': 1e8, 'k': 1e3, 'm': 1e6 }[(m[2] || '').toLowerCase()] || 1;
  return Math.round(parseFloat(m[1]) * k);
}
const idOf = (url, re) => ((url || '').match(re) || [])[1] || '';

export const collectors = {
  async bilibili({ url, p }) {
    const bvid = idOf(url, /video\/(BV\w+)/);
    const st = await withTab('https://member.bilibili.com/platform/upload-manager/article', (t) => evaluate(t, `fetch('/x/web/archives?status=is_pubing%2Cpubed%2Cnot_pubed&pn=1&ps=50&coop=1',{credentials:'include'}).then(r=>r.json()).then(x=>{const a=(x.data&&x.data.arc_audits||[]).find(a=>a.Archive.bvid===${J(bvid)}||a.Archive.title===${J(p.title)});return a?a.stat:null})`));
    return st && { views: st.view, likes: st.like, comments: st.reply, favorites: st.favorite, shares: st.share, extra: { 投币: st.coin, 弹幕: st.danmaku } };
  },
  async xhs({ url, p }) {
    const id = idOf(url, /explore\/(\w+)/);
    const n = await withTab('https://creator.xiaohongshu.com/new/note-manager', (t) => evaluate(t, `(()=>{const c=[...document.querySelectorAll('.note-card')].find(c=>{let i='';try{i=JSON.parse(c.getAttribute('data-impression')).noteTarget.value.noteId}catch(e){};return (${J(id)}&&i===${J(id)})||((c.querySelector('.note-card__title')||{}).innerText||'').trim()===${J(p.title)}});return c?[...c.querySelectorAll('.note-card__stat')].map(e=>e.innerText.trim()):null})()`), { wait: 12000 });
    // 图标没有文字标签，按页面顺序：浏览、评论、点赞、收藏、分享
    return n && n.length >= 5 && { views: num(n[0]), comments: num(n[1]), likes: num(n[2]), favorites: num(n[3]), shares: num(n[4]) };
  },
  async douyin({ url, p }) {
    return collectDouyinWorkMetrics({ id: idOf(url, /video\/(\d+)/), title: p?.title });
  },
  async channels({ p }) {
    // publish.json 里视频号写的是 desc（不是 body），取不到 body 时按 desc / 短标题退回，否则会抛 TypeError 一直读不到数
    const src = String((p && (p.body || p.desc || p.shortTitle || p.title)) || '');
    const first = src.split('\n')[0].trim().slice(0, 30);
    if (!first) return null;   // 三个字段都空时别用空串去匹配，否则 startsWith('') 会撞上第一条作品（别人家的数）
    const n = await withTab('https://channels.weixin.qq.com/platform/post/list', (t) => evaluate(t, `(()=>{const R=document.querySelector('wujie-app')&&document.querySelector('wujie-app').shadowRoot;if(!R)return null;const c=[...R.querySelectorAll('.post-feed-item')].find(c=>c.innerText.trim().startsWith(${J(first)}));if(!c)return null;const o={};for(const d of c.querySelectorAll('.data-item')){const k=/eyes/.test(d.innerHTML)?'views':/outlined-like/.test(d.innerHTML)?'likes':/comment/.test(d.innerHTML)?'comments':/icon-share/.test(d.innerHTML)?'shares':/thumb/.test(d.innerHTML)?'recommend':'';if(k)o[k]=d.innerText.trim()}return o})()`), { wait: 14000 });
    return n && { views: num(n.views), likes: num(n.likes), comments: num(n.comments), shares: num(n.shares), extra: { 推荐: num(n.recommend) } };
  },
  async youtube({ url, p }) {
    const id = idOf(url, /youtu\.be\/([\w-]+)/);
    const c = await withTab('https://studio.youtube.com/', async (t) => {
      await evaluate(t, `(location.href = location.href.replace(/(\\/channel\\/[^/]+).*/, '$1/videos/upload'), 1)`); await sleep(10000);
      return evaluate(t, `(()=>{const r=[...document.querySelectorAll('ytcp-video-row')].find(r=>{const a=r.querySelector('a[href*="/video/"]');return (${J(id)}&&a&&a.href.includes(${J(id)}))||((r.querySelector('#video-title')||{}).innerText||'').trim()===${J(p.title)}});if(!r)return null;const g=(k)=>((r.querySelector('.tablecell-'+k)||{}).innerText||'').trim();return {views:g('views'),comments:g('comments'),likes:g('likes')}})()`);
    }, { wait: 9000 });
    return c && { views: num(c.views), comments: num(c.comments), likes: num(c.likes) };
  },
  // X：视频帖 + 它引用的长文帖子一起算（长文链接记在任务备注里「长文 https://x.com/…/status/…」）
  async x({ url, detail }) {
    const one = async (u) => {
      if (!/status\/\d+/.test(u || '')) return null;
      const label = await withTab(u, (t) => evaluate(t, `(()=>{const a=document.querySelector('article');const g=a&&a.querySelector('[role=group][aria-label]');return g?g.getAttribute('aria-label'):null})()`), { wait: 10000 });
      if (!label) return null;
      const g = (k) => num((label.match(new RegExp('([\\d,.]+[KM]?)\\s+' + k, 'i')) || [])[1]) ?? 0;
      return { views: g('views?'), likes: g('likes?'), comments: g('repl(?:y|ies)'), favorites: g('bookmarks?'), shares: g('reposts?') };
    };
    const v = await one(url);
    const art = ((detail || '').match(/长文\s*(https:\/\/x\.com\/[^\s（）()]+?\/status\/\d+)/) || [])[1];
    if (!art || art === url) return v;
    await sleep(2000);
    const a = await one(art);
    if (!v && !a) return null;
    const sum = (k) => (v?.[k] ?? 0) + (a?.[k] ?? 0);
    return { views: sum('views'), likes: sum('likes'), comments: sum('comments'), favorites: sum('favorites'), shares: sum('shares'),
      extra: { 视频帖播放: v?.views ?? null, 长文播放: a?.views ?? null } };
  },
  async instagram({ url }) {   // 在自己登录的页面里读这条 Reels 的作品信息（播放、赞、评论、转发）
    const sc = idOf(url, /\/reel\/([\w-]+)/); if (!sc) return null;
    const m = await withTab(url, (t) => evaluate(t, `(async()=>{const A='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';let pk=0n;for(const c of ${J(sc)})pk=pk*64n+BigInt(A.indexOf(c));
      const r=await fetch('/api/v1/media/'+pk+'/info/',{credentials:'include',headers:{'X-IG-App-ID':'936619743392459'}});if(!r.ok)return null;const it=((await r.json()).items||[])[0];
      return it?{views:it.play_count??it.ig_play_count,likes:it.like_count,comments:it.comment_count,shares:it.reshare_count}:null})()`), { wait: 6000 });
    return m && { views: m.views ?? null, likes: m.likes ?? null, comments: m.comments ?? null, shares: m.shares ?? null };
  },
  async threads({ url }) {   // 串文页底部的赞、回复、转发、分享（数字为 0 时不显示）；网页上看不到播放数，留空
    if (!/\/post\//.test(url || '')) return null;
    const m = await withTab(url, (t) => evaluate(t, `(()=>{const L={likes:['赞','取消赞','Like','Unlike'],comments:['回复','Reply'],reposts:['转发','Repost'],shares:['分享','Share']};const o={};let hit=0;
      for(const [k,ls] of Object.entries(L)){const s=[...document.querySelectorAll('svg')].find(s=>ls.includes(s.getAttribute('aria-label')||(s.querySelector('title')||{}).textContent||''));const b=s&&s.closest('[role=button],button');if(!b){o[k]=null;continue}hit++;o[k]=b.innerText.trim()||'0'}
      return hit?o:null})()`), { wait: 8000 });
    if (!m) return null;
    return { views: null, likes: num(m.likes), comments: num(m.comments), shares: num(m.reposts), extra: { 分享: num(m.shares) } };
  },
  async zsz({ url, p }) {
    const id = idOf(url, /courseId=(\w+)/);
    if (!SITE || SITE.salesOnly) return null;
    const c = await withTab(SITE.admin, (t) => evaluate(t, `fetch(${J(SITE.coursesApi)},{credentials:'include'}).then(r=>r.json()).then(x=>{const c=(x.courses||[]).find(c=>c._id===${J(id)}||c.title===${J(p.title)});return c?{views:c.viewCount||0}:null})`));
    return c && { views: c.views };
  },
};
