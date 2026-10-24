// MOSS-Image 版面框：在畫面上拉框，每框寫類型＋描述；生圖時後端（graphs.rs 的 Layout）組成 MOSS 的排版 JSON。
// 生成頁（gen.js）和導演台每段的第一格（director.js）共用。座標存 0～1、左上角原點：box = [x0, y0, x1, y1]
import { el, toast } from "./util.js";

export const LAYOUT_TYPES = [["character", "角色"], ["object", "物件"], ["text", "文字"]];
const NAME = Object.fromEntries(LAYOUT_TYPES);
const MAX = 16;    // 跟 graphs.rs 的 LAYOUT_MAX 一樣
const MIN = 0.02;  // 比這個小的框不要（後端也會丟掉 1% 以下的）
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const no = (i) => String(i + 1).padStart(2, "0");
const area = (b) => (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]);
const hasWords = (b) => !!(b.desc.trim() || (b.type === "text" && b.text.trim()));

/** 只留看得懂的框（舊資料、手改的設定檔都可能缺欄位） */
function clean(list) {
  return (Array.isArray(list) ? list : []).slice(0, MAX).flatMap((b) => {
    const v = Array.isArray(b?.box) && b.box.length === 4 ? b.box.map((x) => clamp(+x || 0, 0, 1)) : null;
    if (!v) return [];
    const [x0, x1, y0, y1] = [Math.min(v[0], v[2]), Math.max(v[0], v[2]), Math.min(v[1], v[3]), Math.max(v[1], v[3])];
    return [{ type: NAME[b.type] ? b.type : "object", desc: String(b.desc ?? ""), text: String(b.text ?? ""), box: [x0, y0, x1, y1].map(r4) }];
  });
}

/** 一個框在畫面的哪裡：給導演台的 AI 看（中文，跟後端 director.rs 的 layout_rule 一樣分九宮格） */
export function whereText(box) {
  const [x0, y0, x1, y1] = box, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const h = cx < 1 / 3 ? "左" : cx > 2 / 3 ? "右" : "中", v = cy < 1 / 3 ? "上" : cy > 2 / 3 ? "下" : "中";
  return `畫面${v}${h}，約佔寬 ${Math.round((x1 - x0) * 100)}%、高 ${Math.round((y1 - y0) * 100)}%`;
}

/**
 * 版面框編輯器。左欄只放小預覽和框的清單（點了打開畫框視窗）；真正拉框、寫描述在跳出來的大視窗裡（畫布照螢幕放到最大）。opts：
 *   onChange(list)  框有變動（拖完、改類型、打字停一下）
 *   maxH            左欄小預覽最高幾 px（寬度跟著比例算）
 *   disabled()      回傳 true 時不能改（導演台執行中）
 * 回傳 { el, get, usable, set, setAspect, count, open }
 */
export function layoutEditor({ onChange = () => {}, maxH = 340, disabled = () => false } = {}) {
  let boxes = [], sel = -1, lastType = "character", drag = null;
  // ---- 大視窗：畫布（左）＋框的清單（右）
  const canvas = el("div", { class: "lay-canvas", tabindex: "0", role: "application", "aria-label": "版面畫布：拖曳畫框，選取後按 Delete 刪除" });
  const size = el("span", { class: "lay-size" });
  const list = el("div", { class: "lay-list" });
  const clear = () => {
    if (disabled() || !boxes.length || !confirm(`刪掉全部 ${boxes.length} 個框？`)) return;
    boxes = []; sel = -1; render(); changed();
  };
  // 下一個新框的類型（畫好也可以在右邊改）
  const typeSel = el("select", { class: "sm", "aria-label": "新畫的框是什麼", title: "新畫的框是什麼（畫好也可以在右邊改）" },
    ...LAYOUT_TYPES.map(([v, n]) => el("option", { value: v }, n)));
  typeSel.onchange = () => { lastType = typeSel.value; };
  const win = el("div", { class: "modal lay-modal", hidden: true, role: "dialog", "aria-modal": "true", "aria-label": "版面框" },
    el("div", { class: "lay-win" },
      el("div", { class: "row wrap lay-head" },
        el("b", {}, "版面框"),
        el("span", { class: "muted sm" }, "新畫的框是"), typeSel,
        el("span", { class: "muted sm grow" }, "拖曳＝畫新框・拖標籤＝移動・拖右下角＝改大小・點一下選取，Delete 刪除、方向鍵微調（Shift 一次多移一點）"),
        el("button", { type: "button", class: "akey sm", title: "刪掉所有的框", onclick: clear }, "全部清除"),
        el("button", { type: "button", class: "akey go", onclick: () => close() }, "完成")),
      el("div", { class: "lay-body" },
        el("div", { class: "lay-stage" }, canvas, size),
        el("div", { class: "lay-side" }, list))));
  // ---- 左欄：小預覽（點了打開大視窗）＋框的清單
  const prev = el("div", { class: "lay-canvas lay-prev", role: "button", tabindex: "0", title: "打開畫框視窗", "aria-label": "版面預覽：按一下打開畫框視窗" });
  prev.style.setProperty("--lay-max-h", maxH + "px");
  const prevSize = el("span", { class: "lay-size" });
  const sum = el("div", { class: "lay-sum" });
  const openBtn = el("button", { type: "button", class: "akey sm go", onclick: () => open() }, "打開畫框視窗");
  const root = el("div", { class: "lay" },
    el("div", { class: "lay-stage" }, prev, prevSize),
    el("div", { class: "row between wrap lay-bar" },
      el("span", { class: "muted sm" }, "點畫面或按右邊的鈕，跳出大視窗來拉框、寫描述"),
      el("span", { class: "row" }, openBtn, el("button", { type: "button", class: "akey sm", title: "刪掉所有的框", onclick: clear }, "全部清除"))),
    sum);
  prev.addEventListener("click", (e) => open(+(e.target.closest(".lay-box")?.dataset.i ?? -1)));
  prev.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });

  /** 打開畫框視窗（i：先選起第幾個框） */
  function open(i = -1) {
    if (!win.isConnected) document.body.append(win);
    if (i >= 0 && boxes[i]) sel = i;
    typeSel.value = lastType;
    win.hidden = false;
    render();
    canvas.focus({ preventScroll: true });
  }
  function close() {
    win.hidden = true;
    sel = -1;
    renderBoxes();
    openBtn.focus({ preventScroll: true });
  }

  const changed = () => onChange(get());
  let soon;
  const changedSoon = () => { clearTimeout(soon); soon = setTimeout(changed, 400); };

  // ---------------------------------------------------------------- 畫
  const words = (b) => (b.type === "text" && b.text.trim() ? `「${b.text.trim()}」${b.desc.trim() ? " " + b.desc.trim() : ""}` : b.desc.trim());
  function drawInto(target, live) {
    target.querySelectorAll(".lay-box").forEach((e) => e.remove());
    // 大框常常整個包住小框：小的疊在上面才點得到
    const order = boxes.map((_, i) => i).sort((a, b) => area(boxes[b]) - area(boxes[a]));
    order.forEach((i, z) => {
      const b = boxes[i], [x0, y0, x1, y1] = b.box;
      target.append(el("div", { class: `lay-box t-${b.type}${live && i === sel ? " sel" : ""}${hasWords(b) ? "" : " empty"}`, "data-i": i,
        style: `left:${x0 * 100}%;top:${y0 * 100}%;width:${(x1 - x0) * 100}%;height:${(y1 - y0) * 100}%;z-index:${z + 1}` },
        el("span", { class: "lay-tag", ...(live ? { "data-act": "move", title: "拖這裡移動" } : {}) }, `${no(i)} ${NAME[b.type]}`),
        el("span", { class: "lay-words" }, words(b) || "（還沒寫描述）"),
        live && el("span", { class: "lay-h", "data-act": "size", title: "拖這裡改大小" })));
    });
    target.classList.toggle("blank", !boxes.length);
  }
  function renderBoxes() {
    if (!win.hidden) drawInto(canvas, true);
    drawInto(prev, false);
    renderSum();
  }
  // 左欄的清單：一行一個框，點了打開大視窗、選起那個框
  function renderSum() {
    sum.replaceChildren(...boxes.map((b, i) => el("button", { type: "button", class: `lay-sum-row t-${b.type}${hasWords(b) ? "" : " empty"}`, onclick: () => open(i) },
      el("span", { class: "lay-no" }, no(i)), el("span", { class: "muted sm" }, NAME[b.type]), el("span", { class: "sm" }, words(b) || "（還沒寫描述）"))));
  }

  function markRows() {
    list.querySelectorAll(".lay-row").forEach((r) => r.classList.toggle("sel", +r.dataset.i === sel));
  }

  function renderRows() {
    list.innerHTML = "";
    const off = disabled();
    root.classList.toggle("off", off);
    win.classList.toggle("off", off);
    boxes.forEach((b, i) => {
      const type = el("select", { class: "sm", "aria-label": `第 ${i + 1} 個框的類型`, disabled: off }, ...LAYOUT_TYPES.map(([v, n]) => el("option", { value: v }, n)));
      type.value = b.type;
      type.onchange = () => { b.type = lastType = typeSel.value = type.value; renderRows(); renderBoxes(); changed(); };
      const desc = el("input", { type: "text", class: "lay-d", maxlength: 600, disabled: off, "aria-label": `第 ${i + 1} 個框的描述`,
        placeholder: b.type === "text" ? "字的樣子：字型、顏色、大小（可以不寫）" : b.type === "character" ? "誰、長相、穿著、動作（中英文都可以）" : "什麼東西、長什麼樣子" });
      desc.value = b.desc;
      desc.oninput = () => { b.desc = desc.value; renderBoxes(); changedSoon(); };
      let text = null;
      if (b.type === "text") {
        text = el("input", { type: "text", class: "lay-t", maxlength: 200, disabled: off, placeholder: "要畫的字（照抄）", "aria-label": `第 ${i + 1} 個框要畫的字` });
        text.value = b.text;
        text.oninput = () => { b.text = text.value; renderBoxes(); changedSoon(); };
      }
      list.append(el("div", { class: `lay-row t-${b.type}${text ? " has-t" : ""}${i === sel ? " sel" : ""}`, "data-i": i,
        onfocusin: () => { if (sel !== i) { sel = i; renderBoxes(); markRows(); } } },
        el("span", { class: "lay-no" }, no(i)), type, desc, text,
        el("button", { type: "button", class: "icon", title: "刪掉這個框", "aria-label": `刪掉第 ${i + 1} 個框`, disabled: off, onclick: () => remove(i) }, "✕")));
    });
    list.append(el("div", { class: "muted sm" }, boxes.length
      ? "沒寫描述的框不會送出。描述寫外觀就好，整張圖的氣氛、光線、畫風寫在生成頁的提示詞。"
      : "還沒有框：在左邊的畫面上拖曳，畫出角色、物件或文字要放的位置（上面可以先選新框是什麼）。"));
  }

  function render() { renderBoxes(); renderRows(); }

  function remove(i) {
    if (disabled() || !boxes[i]) return;
    boxes.splice(i, 1);
    sel = -1;
    render();
    changed();
  }

  // ---------------------------------------------------------------- 滑鼠：畫新框、移動、改大小
  const pt = (e) => {
    const r = canvas.getBoundingClientRect();
    return [clamp((e.clientX - r.left) / r.width, 0, 1), clamp((e.clientY - r.top) / r.height, 0, 1)];
  };
  canvas.addEventListener("pointerdown", (e) => {
    if (disabled() || e.button !== 0) return;
    const act = e.target.dataset?.act, be = e.target.closest(".lay-box");
    const i = be ? +be.dataset.i : -1;
    const [x, y] = pt(e);
    e.preventDefault();
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture(e.pointerId);
    drag = { mode: act && i >= 0 ? act : "draw", i: act ? i : -1, hit: i, x, y, cx: e.clientX, cy: e.clientY, moved: false, b0: i >= 0 ? [...boxes[i].box] : null };
    if (act && i >= 0 && sel !== i) { sel = i; renderBoxes(); markRows(); }
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.cx, e.clientY - drag.cy) < 4) return;
    drag.moved = true;
    const [x, y] = pt(e);
    if (drag.mode === "draw") {
      if (drag.i < 0) {
        if (boxes.length >= MAX) { toast(`最多 ${MAX} 個框`, "err"); drag = null; return; }
        boxes.push({ type: lastType, desc: "", text: "", box: [x, y, x, y] });
        drag.i = sel = boxes.length - 1;
        renderRows();
      }
      boxes[drag.i].box = [Math.min(drag.x, x), Math.min(drag.y, y), Math.max(drag.x, x), Math.max(drag.y, y)];
    } else if (drag.mode === "move") {
      const [a, b, c, d] = drag.b0, w = c - a, h = d - b;
      const nx = clamp(a + x - drag.x, 0, 1 - w), ny = clamp(b + y - drag.y, 0, 1 - h);
      boxes[drag.i].box = [nx, ny, nx + w, ny + h];
    } else {
      const [a, b] = drag.b0;
      boxes[drag.i].box = [a, b, clamp(Math.max(x, a + MIN), 0, 1), clamp(Math.max(y, b + MIN), 0, 1)];
    }
    renderBoxes();
  });
  const up = () => {
    const d = drag;
    drag = null;
    if (!d) return;
    if (!d.moved) {  // 點一下：選點到的框（小的優先），點空白就取消選取
      if (d.mode === "draw" && sel !== d.hit) { sel = d.hit; renderBoxes(); markRows(); }
      return;
    }
    if (d.i < 0 || !boxes[d.i]) return;
    const b = boxes[d.i];
    if (d.mode === "draw" && (b.box[2] - b.box[0] < MIN || b.box[3] - b.box[1] < MIN)) {
      boxes.splice(d.i, 1);
      sel = -1;
      render();
      return;
    }
    b.box = b.box.map(r4);
    renderBoxes();
    changed();
    if (d.mode === "draw") {  // 畫好直接打描述
      const row = list.querySelector(`.lay-row[data-i="${d.i}"]`);
      row?.scrollIntoView({ block: "nearest" });
      (row?.querySelector(".lay-t") || row?.querySelector(".lay-d"))?.focus({ preventScroll: true });  // 文字框先填要畫的字
    }
  };
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);

  // 鍵盤：Delete 刪、方向鍵移動（Shift 一次 5%）、Esc 取消選取。不讓全站快捷鍵（圖庫的 Delete 等）收到
  canvas.addEventListener("keydown", (e) => {
    if (disabled() || sel < 0 || !boxes[sel]) return;
    const step = e.shiftKey ? 0.05 : 0.01;
    const mv = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (e.key === "Delete" || e.key === "Backspace") remove(sel);
    else if (e.key === "Escape") { sel = -1; renderBoxes(); markRows(); }
    else if (mv) {
      const [a, b, c, d] = boxes[sel].box, w = c - a, h = d - b;
      const nx = r4(clamp(a + mv[0], 0, 1 - w)), ny = r4(clamp(b + mv[1], 0, 1 - h));
      boxes[sel].box = [nx, ny, r4(nx + w), r4(ny + h)];
      renderBoxes();
      changedSoon();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  });

  // ---------------------------------------------------------------- 對外
  function get() { return boxes.map((b) => ({ type: b.type, desc: b.desc, text: b.text, box: [...b.box] })); }
  /** 送去生圖的：有寫描述（或文字）的框 */
  function usable() {
    return boxes.filter(hasWords).map((b) => ({ type: b.type, desc: b.desc.trim(), ...(b.type === "text" ? { text: b.text } : {}), box: [...b.box] }));
  }
  function set(list) { boxes = clean(list); sel = -1; render(); }
  function setAspect(w, h) {
    if (!(w > 0 && h > 0)) return;
    for (const c of [canvas, prev]) c.style.setProperty("--ar", String(w / h));
    size.textContent = prevSize.textContent = `${Math.round(w)}×${Math.round(h)}`;
  }
  render();
  return { el: root, get, usable, set, setAspect, count: () => boxes.length, render, open };
}
