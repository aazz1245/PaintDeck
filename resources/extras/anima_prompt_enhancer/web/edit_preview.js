// Anima Prompt Edit (preview)：執行完把最新的改寫結果填進 edited 欄位，讓你直接看、直接改。
// use_edited 打開後就不再覆蓋（保留你改過的內容）。
import { app } from "../../scripts/app.js";

app.registerExtension({
  name: "anima.PromptEditPreview",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "AnimaPromptEdit") return;
    const orig = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      orig?.apply(this, arguments);
      const text = message?.text?.[0];
      if (typeof text !== "string") return;
      const use = this.widgets?.find((w) => w.name === "use_edited");
      const ed = this.widgets?.find((w) => w.name === "edited");
      if (ed && !use?.value) {
        ed.value = text;
        this.setDirtyCanvas?.(true, true);
      }
    };
  },
});
