const axios = require('axios');
const { LRUCache } = require('lru-cache');

// TMDB 配置
const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMG = 'https://image.tmdb.org/t/p';
const TMDB_TOKEN = process.env.TMDB_TOKEN;

// 缓存：10分钟，最多 1000 条
const cache = new LRUCache({
  max: 1000,
  ttl: 10 * 60 * 1000,
});

// 限流：IP 记录（也使用LRU缓存避免内存泄漏）
const rateLimit = new LRUCache({
  max: 10000, // 最多记录10000个IP
  ttl: 2 * RATE_WINDOW, // 保留时间略长于窗口期
});
const RATE_MAX = 60; // 每分钟 60 次
const RATE_WINDOW = 60 * 1000;

module.exports = async (req, res) => {
  // CORS 跨域
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // 获取客户端 IP（处理X-Forwarded-For可能包含多个IP的情况）
  let ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';
  if (typeof ip === 'string') {
    ip = ip.split(',')[0].trim(); // 取第一个IP地址
  }

  // 验证TMDB_TOKEN是否存在
  if (!TMDB_TOKEN) {
    console.error('TMDB_TOKEN is not set in environment variables');
    return res.status(500).json({ code: 500, msg: '服务器配置错误' });
  }

  // 限流：防恶意刷
  const now = Date.now();
  const limit = rateLimit.get(ip) || { count: 0, reset: now + RATE_WINDOW };
  if (now > limit.reset) {
    limit.count = 1;
    limit.reset = now + RATE_WINDOW;
  } else {
    limit.count++;
  }
  rateLimit.set(ip, limit);
  if (limit.count > RATE_MAX) {
    return res.status(429).json({ code: 429, msg: '请求过于频繁' });
  }

  try {
    const url = req.url;

    // 代理 TMDB 图片
    if (url.startsWith('/t/p/')) {
      const imgUrl = TMDB_IMG + url;
      const img = await axios.get(imgUrl, { responseType: 'arraybuffer' });
      const contentType = img.headers['content-type'];
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'max-age=31536000');
      return res.end(img.data);
    }

    // 缓存 KEY
    const key = url;
    if (cache.has(key)) {
      return res.json(cache.get(key));
    }

    // 请求 TMDB
    const response = await axios.get(TMDB_BASE + url, {
      headers: {
        'Authorization': `Bearer ${TMDB_TOKEN}`,
        'Accept': 'application/json',
      },
    });

    // 缓存成功结果
    if (response.status === 200) {
      cache.set(key, response.data);
    }

    return res.json(response.data);

  } catch (e) {
    const status = e.response?.status || 500;
    const data = e.response?.data || { msg: '服务器错误' };
    res.status(status).json(data);
  }
};