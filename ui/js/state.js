// 各模組共用的狀態（避免循環 import）：伺服器狀態、切換分頁的函式
export const app = { state: null, page: "gen", showPage: () => {}, refreshState: async () => {} };
