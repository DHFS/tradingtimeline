# TradingTimeTable

全球主要市场交易时段看板（北京时间）。纯静态页面，无构建步骤。

## 文件

- `index.html` — 页面结构
- `style.css` — 深色主题
- `app.js` — 时段 / 倒计时 / 排序 / 行情 / 时间轴
- `data.js` — 2026 官方节假日与市场元数据

## 本地预览

```bash
python3 -m http.server 8080 --bind 127.0.0.1
```

打开 http://127.0.0.1:8080/

## GitHub Pages

从 `main` 分支根目录发布：https://dhfs.github.io/tradingtimeline/

## 免责声明

本页面不构成任何投资建议。
