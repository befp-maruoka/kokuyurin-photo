// 設置時に書き換えるのは API_URL だけです（Apps Script の「ウェブアプリURL」）。
window.APP_CONFIG = {
  API_URL: "https://script.google.com/macros/s/AKfycbw9qIu9TReleSRX-3lY2kpMMguZXTqT9OQPB0KF1TuZqT3HxuTgdV9FLVPT0FIhiT6N/exec",
  MAX_FILES: 50,                 // 1回に選べる枚数
  MAX_BYTES: 20 * 1024 * 1024,   // 1枚あたりの上限（20MB）
  RETRY_INTERVAL_MS: 30000       // 画面を開いている間の自動再送間隔
};
