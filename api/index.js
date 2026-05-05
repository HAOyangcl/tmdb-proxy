const axios = require('axios');
const { LRUCache } = require('lru-cache');

// TMDB 配置
const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMG = 'https://image.tmdb.org/t/p';
const TMDB_TOKEN = process.env.TMDB_TOKEN;

// 缓存：10分钟，最多 1000 条
const cache = new LRUCache({
  max: 1000,
  ttl: 10 * 60 * 1000, // 10分钟
});

// 限流：IP 记录（使用LRU缓存避免内存泄漏）
const RATE_MAX = 60; // 每分钟 60 次
const RATE_WINDOW = 60 * 1000; // 60秒

const rateLimit = new LRUCache({
  max: 10000, // 最多记录10000个IP
  ttl: RATE_WINDOW * 2, // 保留时间是窗口期的2倍
});

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
    console.error('❌ TMDB_TOKEN is not set in environment variables');
    return res.status(500).json({ 
      code: 500, 
      msg: '服务器配置错误：缺少TMDB_TOKEN环境变量' 
    });
  }

  // 限流：防恶意刷
  const now = Date.now();
  const limit = rateLimit.get(ip) || { count: 0, reset: now + RATE_WINDOW };
  
  if (now > limit.reset) {
    // 重置计数
    limit.count = 1;
    limit.reset = now + RATE_WINDOW;
  } else {
    limit.count++;
  }
  
  rateLimit.set(ip, limit);
  
  if (limit.count > RATE_MAX) {
    console.warn(`⚠️ Rate limit exceeded for IP: ${ip}`);
    return res.status(429).json({ 
      code: 429, 
      msg: '请求过于频繁，请稍后再试' 
    });
  }

  try {
    const url = req.url;

    // 代理 TMDB 图片
    if (url.startsWith('/t/p/')) {
      const imageUrl = TMDB_IMG + url;
      console.log(`📷 Proxying image: ${imageUrl}`);
      
      const img = await axios.get(imageUrl, { 
        responseType: 'arraybuffer',
        timeout: 10000 // 10秒超时
      });
      
      const contentType = img.headers['content-type'];
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return res.end(img.data);
    }

    // 缓存 KEY
    const key = url;
    if (cache.has(key)) {
      console.log(`✅ Cache hit: ${key}`);
      return res.json(cache.get(key));
    }

    console.log(`🔄 Fetching from TMDB: ${TMDB_BASE + url}`);
    
    // 请求 TMDB
    const response = await axios.get(TMDB_BASE + url, {
      headers: {
        'Authorization': `Bearer ${TMDB_TOKEN}`,
        'Accept': 'application/json',
      },
      timeout: 10000 // 10秒超时
    });

    // 缓存成功结果
    if (response.status === 200) {
      cache.set(key, response.data);
      console.log(`💾 Cached: ${key}`);
    }

    return res.json(response.data);

  } catch (e) {
    console.error('❌ Error:', e.message);
    if (e.response) {
      console.error('Response status:', e.response.status);
      console.error('Response data:', e.response.data);
    }
    
    const status = e.response?.status || 500;
    const data = e.response?.data || { 
      code: status,
      msg: e.message || '服务器错误' 
    };
    res.status(status).json(data);
  }
};