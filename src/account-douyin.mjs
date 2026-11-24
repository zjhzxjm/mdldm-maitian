import { withTab, evaluate, click, sleep } from './driver.mjs';

const MANAGE = 'https://creator.douyin.com/creator-micro/content/manage';
const NEXT = '[aria-label="下一页"],[title="下一页"],[aria-label="Next Page"],[title="Next Page"],[class*="page-next"]';
const SCROLLER = '[class*="manage-v2-list-"] [class*="list-scroll-"]';

// Inlined into browser expressions so both collectors read the same card data.
function readWorks() {
  const modern = [...document.querySelectorAll('article[class*="creator-work-card-"][class*="video-card-"]')];
  const cards = modern.length ? modern : [...document.querySelectorAll('[class*=video-card-info]')];
  const works = cards.map(card => {
    const key = Object.keys(card).find(k => k.startsWith('__reactFiber'));
    for (let fiber = card[key], i = 0; fiber && i < 25; fiber = fiber.return, i++) {
      const work = Object.values(fiber.memoizedProps || {}).find(v =>
        v && typeof v === 'object' && v.desc !== undefined &&
        (typeof v.aweme_id === 'string' || Number.isSafeInteger(v.aweme_id)) &&
        /^\d+$/.test(String(v.aweme_id)));
      if (work) return work;
    }
    return null;
  });
  return { works, modern: modern.length > 0 };
}

function workMetrics(stat) {
  if (!stat || typeof stat !== 'object') return null;
  const fields = { views: 'play_count', likes: 'digg_count', comments: 'comment_count', favorites: 'collect_count', shares: 'share_count' };
  const metrics = {};
  for (const [name, key] of Object.entries(fields)) {
    const value = stat[key];
    if (value == null) { metrics[name] = null; continue; }
    if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) return null;
    const count = Number(value);
    if (!Number.isSafeInteger(count) || count < 0) return null;
    metrics[name] = count;
  }
  return Object.values(metrics).some(value => value != null) ? metrics : null;
}

function readAccountPage(read, metricsOf, nextSelector, scrollerSelector) {
  const { works, modern } = read(), text = document.body.innerText || '';
  if (!works.length) {
    if (/扫码登录|登录后查看|请先登录/.test(text)) return { error: '请先登录抖音' };
    if (/暂无作品|暂无视频|还没有作品/.test(text)) return { videos: [], signature: 'empty', finished: true };
    return null;
  }

  const videos = [], ids = new Set();
  for (const video of works) {
    if (!video) return { error: '抖音作品数据格式已变化' };
    const id = String(video.aweme_id), published = Number(video.publish_time || video.create_time);
    ids.add(id);
    if (video.status?.in_reviewing || published * 1000 > Date.now()) continue;
    const metrics = metricsOf(video.statistics);
    if (!metrics) return { error: '抖音作品统计数据格式已变化或未读到' };
    videos.push({
      id, title: String(video.item_title || video.desc || id), url: 'https://www.douyin.com/video/' + id,
      publishedAt: Number.isFinite(published) && published > 0 ? new Date(published * 1000).toISOString() : null,
      ...metrics, extra: {},
    });
  }
  const signature = [...ids].join(',');
  if (modern) {
    const list = document.querySelector(scrollerSelector);
    if (!list) return { error: '抖音新版作品列表的滚动区域未识别' };
    const footer = list.querySelector('[class*="load-more-"]');
    return { videos, signature, scroll: true, finished: footer?.innerText.trim() === '没有更多作品' };
  }

  const next = document.querySelector(nextSelector);
  const disabled = !!next && (next.disabled || next.getAttribute('aria-disabled') === 'true' ||
    /disabled/.test(String(next.className) + ' ' + String(next.parentElement?.className || '')));
  const total = (text.match(/共\s*(\d+)\s*(?:条|个)/) || [])[1];
  if (!next && !(total != null && Number(total) <= ids.size)) {
    const controls = [...document.querySelectorAll('[class*="pagination"],[class*="page-item"]')]
      .map(e => String(e.className)).join(',').slice(0, 120);
    return { error: '抖音分页控件未识别（作品卡片 ' + works.length + ' 张；控件 ' + (controls || '无') + '）' };
  }
  return { videos, signature, finished: disabled || !next };
}

const readPage = `(${readAccountPage})(${readWorks}, ${workMetrics}, ${JSON.stringify(NEXT)}, ${JSON.stringify(SCROLLER)})`;

export async function collectDouyinVideos() {
  return withTab(MANAGE, async tab => {
    const videos = new Map(), seen = new Set();
    let previous = '';
    for (let page = 0; page < 500; page++) {
      let data;
      for (let attempt = 0; attempt < 30; attempt++) {
        data = await evaluate(tab, readPage);
        if (data?.error) throw new Error(data.error);
        if (data && (data.signature !== previous || (data.scroll && data.finished))) break;
        await sleep(1000);
      }
      const advanced = data && data.signature !== previous;
      if (!data || (!advanced && !(data.scroll && data.finished))) {
        throw new Error(previous ? '抖音翻页后作品列表未变化' : '抖音作品列表未就绪');
      }
      if (advanced && seen.has(data.signature)) {
        throw new Error('抖音分页重复，未保存不完整采集');
      }
      seen.add(data.signature);
      for (const video of data.videos) videos.set(video.id, video);
      if (data.finished) return [...videos.values()];
      previous = data.signature;
      if (data.scroll) {
        await evaluate(tab, `(() => {
          const list = document.querySelector(${JSON.stringify(SCROLLER)});
          if (list) list.scrollTop = list.scrollHeight;
        })()`);
      } else {
        await click(tab, `document.querySelector(${JSON.stringify(NEXT)})`);
      }
      await sleep(1000);
    }
    throw new Error('抖音作品超过 500 页，未保存不完整采集');
  }, { wait: 6000 });
}

function readWorkMetrics(read, metricsOf, id, title) {
  const { works } = read();
  const video = works.find(work => work && (id ? String(work.aweme_id) === id : work.item_title === title));
  return metricsOf(video?.statistics);
}

export async function collectDouyinWorkMetrics({ id, title }) {
  if (!id && !title) return null;
  const expression = `(${readWorkMetrics})(${readWorks}, ${workMetrics}, ${JSON.stringify(id)}, ${JSON.stringify(title)})`;
  return withTab(MANAGE, async tab => {
    for (let attempt = 0; attempt < 16; attempt++) {
      const result = await evaluate(tab, expression);
      if (result) return result;
      if (attempt < 15) await sleep(2000);
    }
    return null;
  }, { wait: 6000 });
}
