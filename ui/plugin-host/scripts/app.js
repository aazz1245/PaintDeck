// 繪匣原生外掛 UI 宿主橋接：模擬 ComfyUI scripts/app.js
export const app = {
  extensions: [],
  graph: {
    _nodes: [],
    nodes: [],
    setDirtyCanvas() {},
  },
  canvas: {
    setDirty() {},
  },
  registerExtension(ext) {
    if (ext) this.extensions.push(ext);
  },
};

window.__pdComfyApp = app;
