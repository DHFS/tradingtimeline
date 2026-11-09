/**
 * TradingTimeTable — market calendars & metadata (DATA_YEAR=2026)
 * Holidays hardcoded from official exchange notices.
 * Verified: 2026-11-09
 */
const DATA_YEAR = 2026;

const HOLIDAY_SOURCES = {
  cn: {
    name: '上海证券交易所（SSE）',
    url: 'https://www.sse.com.cn/disclosure/dealinstruc/closed/list/',
    note: '上证公告〔2025〕45号「关于上海证券交易所2026年部分节假日休市安排的通知」(2025-12-22)；深交所同步安排',
    verified: '2026-11-09',
  },
  hk: {
    name: '香港交易所（HKEX）',
    url: 'https://www.hkex.com.hk/-/media/HKEX-Market/Services/Circulars-and-Notices/Participant-and-Members-Circulars/SEHK/2025/ce_SEHK_CT_075_2025.pdf',
    note: 'Hong Kong Securities Market Holiday Schedule for Year 2026 (CE/SEHK/CT/075/2025)；半日市：农历新年前夕、圣诞前夕、新年前夕',
    verified: '2026-11-09',
  },
  jp: {
    name: '日本取引所グループ（JPX/TSE）',
    url: 'https://www.jpx.co.jp/english/corporate/about-jpx/calendar/index.html',
    note: 'JPX Market Holidays 2026（含 1/2–1/3、12/31 交易所休市及振替休日）',
    verified: '2026-11-09',
  },
  kr: {
    name: '한국거래소（KRX）',
    url: 'https://open.krx.co.kr/contents/MKD/01/0110/01100305/MKD01100305.jsp',
    note: 'KRX 2026 휴장일（含替代休日、地方选举日、年末休市）；交叉核验 tradinghours / markethours 汇总',
    verified: '2026-11-09',
  },
  us: {
    name: 'NYSE Group',
    url: 'https://www.nyse.com/trade/hours-calendars',
    note: 'NYSE Group 2026 Holiday and Early Closings Calendar；提前收市 13:00 ET：11/27、12/24',
    verified: '2026-11-09',
  },
};

/** YYYY-MM-DD holiday closures (official announced dates, incl. holiday-period weekends where listed). */
const HOLIDAYS = {
  cn: [
    // 元旦
    '2026-01-01', '2026-01-02', '2026-01-03',
    // 春节
    '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
    '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
    // 清明
    '2026-04-04', '2026-04-05', '2026-04-06',
    // 劳动节
    '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
    // 端午
    '2026-06-19', '2026-06-20', '2026-06-21',
    // 中秋
    '2026-09-25', '2026-09-26', '2026-09-27',
    // 国庆
    '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
    '2026-10-05', '2026-10-06', '2026-10-07',
  ],
  hk: [
    '2026-01-01',
    '2026-02-17', '2026-02-18', '2026-02-19',
    '2026-04-03', '2026-04-06', '2026-04-07',
    '2026-05-01',
    '2026-05-25',
    '2026-06-19',
    '2026-07-01',
    '2026-10-01',
    '2026-10-19',
    '2026-12-25',
  ],
  jp: [
    '2026-01-01', '2026-01-02', '2026-01-03',
    '2026-01-12',
    '2026-02-11',
    '2026-02-23',
    '2026-03-20',
    '2026-04-29',
    '2026-05-03', '2026-05-04', '2026-05-05', '2026-05-06',
    '2026-07-20',
    '2026-08-11',
    '2026-09-21', '2026-09-22', '2026-09-23',
    '2026-10-12',
    '2026-11-03',
    '2026-11-23',
    '2026-12-31',
  ],
  kr: [
    '2026-01-01',
    '2026-02-16', '2026-02-17', '2026-02-18',
    '2026-03-02',
    '2026-05-01',
    '2026-05-05',
    '2026-05-25',
    '2026-06-03',
    '2026-07-17',
    '2026-08-17',
    '2026-09-24', '2026-09-25',
    '2026-10-05',
    '2026-10-09',
    '2026-12-25',
    '2026-12-31',
  ],
  us: [
    '2026-01-01',
    '2026-01-19',
    '2026-02-16',
    '2026-04-03',
    '2026-05-25',
    '2026-06-19',
    '2026-07-03',
    '2026-09-07',
    '2026-11-26',
    '2026-12-25',
  ],
};

/** HKEX half-day: morning session only 09:30–12:00 BJT */
const HALF_DAYS = {
  hk: ['2026-02-16', '2026-12-24', '2026-12-31'],
};

/** NYSE early close 13:00 ET */
const EARLY_CLOSE = {
  us: ['2026-11-27', '2026-12-24'],
};

/**
 * Markets metadata.
 * Sessions are Beijing time (Asia/Shanghai) minutes from midnight,
 * except US which is computed dynamically for DST / early close.
 */
const MARKETS = [
  {
    id: 'crypto',
    name: '加密货币',
    short: '24/7',
    exchange: 'Binance',
    alwaysOpen: true,
    pinFirst: true,
    holidayKey: null,
    quotes: [
      { id: 'btc', label: 'BTC', source: 'binance', symbol: 'BTCUSDT' },
      { id: 'eth', label: 'ETH', source: 'binance', symbol: 'ETHUSDT' },
    ],
    timeline: [{ type: 'open', start: 0, end: 24 * 60 }],
  },
  {
    id: 'cn',
    name: 'A股',
    short: '沪深',
    exchange: 'SSE / SZSE',
    holidayKey: 'cn',
    quotes: [
      { id: 'sh', label: '上证指数', source: 'eastmoney', secid: '1.000001' },
      { id: 'sz', label: '深证成指', source: 'eastmoney', secid: '0.399001' },
      { id: 'cyb', label: '创业板指', source: 'eastmoney', secid: '0.399006' },
    ],
    // 09:30–11:30, lunch 11:30–13:00, 13:00–15:00
    sessions: {
      morning: [9 * 60 + 30, 11 * 60 + 30],
      lunch: [11 * 60 + 30, 13 * 60],
      afternoon: [13 * 60, 15 * 60],
    },
  },
  {
    id: 'hk',
    name: '港股',
    short: 'HKEX',
    exchange: 'HKEX',
    holidayKey: 'hk',
    halfDayKey: 'hk',
    quotes: [
      { id: 'hsi', label: '恒生指数', source: 'eastmoney', secid: '100.HSI' },
    ],
    // 09:30–12:00, lunch 12:00–13:00, 13:00–16:00; half-day morning only
    sessions: {
      morning: [9 * 60 + 30, 12 * 60],
      lunch: [12 * 60, 13 * 60],
      afternoon: [13 * 60, 16 * 60],
    },
  },
  {
    id: 'jp',
    name: '日经',
    short: 'JPX',
    exchange: 'TSE',
    holidayKey: 'jp',
    quotes: [
      { id: 'n225', label: '日经225', source: 'eastmoney', secid: '100.N225' },
    ],
    // JST 09:00–11:30 / 12:30–15:30 → BJT 08:00–10:30 / 11:30–14:30
    sessions: {
      morning: [8 * 60, 10 * 60 + 30],
      lunch: [10 * 60 + 30, 11 * 60 + 30],
      afternoon: [11 * 60 + 30, 14 * 60 + 30],
    },
  },
  {
    id: 'kr',
    name: '韩股',
    short: 'KRX',
    exchange: 'KRX',
    holidayKey: 'kr',
    quotes: [
      { id: 'kospi', label: 'KOSPI', source: 'eastmoney', secid: '100.KS11' },
    ],
    // KST 09:00–15:30 continuous → BJT 08:00–14:30
    sessions: {
      continuous: [8 * 60, 14 * 60 + 30],
    },
  },
  {
    id: 'us',
    name: '美股',
    short: 'NYSE/Nasdaq',
    exchange: 'NYSE / Nasdaq',
    holidayKey: 'us',
    earlyCloseKey: 'us',
    quotes: [
      { id: 'spx', label: '标普500', source: 'eastmoney', secid: '100.SPX' },
      { id: 'ixic', label: '纳斯达克', source: 'eastmoney', secid: '100.NDX' },
      { id: 'djia', label: '道琼斯', source: 'eastmoney', secid: '100.DJIA' },
    ],
    // DST / standard windows resolved in app.js
    usMarket: true,
  },
];
