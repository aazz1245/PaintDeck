// 局部重繪的遮罩編輯器：在原圖上塗出要重畫的區域，完成後上傳成黑底白色遮罩 PNG
import { $, $$, toast, uploadFile, openModal, closeModal } from "./util.js";

let base, draw, ctx, stage, cursor, img = null, onDone = null;
let tool = "brush", drawing = false, last = null, undo = [], scale = 1;
const keep = new Map(); // 同一張圖再次編輯時保留先前的筆觸

export function open(init, done) {
  onDone = done;
  stage = $("#maskStage"); base = $("#maskBase"); draw = $("#maskDraw"); cursor = $("#maskCursor");
  ctx = draw.getContext("2d");
  openModal("#maskModal");
  img = new Image();
  img.onload = () => {
    for (const c of [base, draw]) { c.width = img.naturalWidth; c.height = img.naturalHeight; }
    base.getContext("2d").drawImage(img, 0, 0);
    ctx.clearRect(0, 0, draw.width, draw.height);
    if (keep.has(init.name)) ctx.putImageData(keep.get(init.name), 0, 0);
    undo = [];
    fit();
  };
  img.src = `/input/${encodeURIComponent(init.name)}`;
  img.dataset.name = init.name;
}

function fit() {
  const r = stage.getBoundingClientRect();
  scale = Math.min((r.width - 20) / img.naturalWidth, (r.height - 20) / img.naturalHeight, 1.5);
  for (const c of [base, draw]) { c.style.width = img.naturalWidth * scale + "px"; c.style.height = img.naturalHeight * scale + "px"; }
  sizeCursor();
}

const size = () => +$("#maskSize").value;
function sizeCursor() { cursor.style.width = cursor.style.height = size() + "px"; }

function pos(e) {
  const r = draw.getBoundingClientRect();
  return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
}

function stroke(a, b) {
  ctx.globalCompositeOperation = tool === "erase" ? "destination-out" : "source-over";
  ctx.strokeStyle = ctx.fillStyle = "#ff3b3b";
  ctx.lineWidth = size() / scale;
  ctx.lineCap = ctx.lineJoin = "round";
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  ctx.beginPath(); ctx.arc(b.x, b.y, ctx.lineWidth / 2, 0, Math.PI * 2); ctx.fill();
}

function snapshot() {
  undo.push(ctx.getImageData(0, 0, draw.width, draw.height));
  if (undo.length > 12) undo.shift();
}

function init() {
  const st = $("#maskStage");
  st.addEventListener("pointerdown", (e) => {
    if (!img) return;
    st.setPointerCapture(e.pointerId);
    snapshot();
    drawing = true; last = pos(e); stroke(last, last);
  });
  st.addEventListener("pointermove", (e) => {
    const r = st.getBoundingClientRect();
    cursor.style.left = e.clientX - r.left + "px"; cursor.style.top = e.clientY - r.top + "px";
    if (!drawing) return;
    const p = pos(e); stroke(last, p); last = p;
  });
  const end = () => { drawing = false; };
  st.addEventListener("pointerup", end);
  st.addEventListener("pointercancel", end);
  st.addEventListener("wheel", (e) => {
    e.preventDefault();
    const s = $("#maskSize");
    s.value = Math.max(4, Math.min(300, +s.value * (e.deltaY < 0 ? 1.15 : 0.87)));
    sizeCursor();
  }, { passive: false });
  $("#maskSize").oninput = sizeCursor;
  $("#maskTool").onclick = (e) => {
    const b = e.target.closest("button"); if (!b) return;
    tool = b.dataset.t;
    $$("#maskTool button").forEach((x) => x.classList.toggle("on", x === b));
  };
  $("#maskUndo").onclick = () => { if (undo.length) ctx.putImageData(undo.pop(), 0, 0); };
  $("#maskClear").onclick = () => { snapshot(); ctx.clearRect(0, 0, draw.width, draw.height); };
  $("#maskInvert").onclick = () => {
    snapshot();
    const t = document.createElement("canvas"); t.width = draw.width; t.height = draw.height;
    const c = t.getContext("2d");
    c.fillStyle = "#ff3b3b"; c.fillRect(0, 0, t.width, t.height);
    c.globalCompositeOperation = "destination-out"; c.drawImage(draw, 0, 0);
    ctx.globalCompositeOperation = "copy"; ctx.drawImage(t, 0, 0); ctx.globalCompositeOperation = "source-over";
  };
  document.addEventListener("keydown", (e) => {
    if ($("#maskModal").hidden) return;
    if (e.key === "z" && e.ctrlKey) { e.preventDefault(); $("#maskUndo").click(); }
    if (e.key === "[") { $("#maskSize").value = Math.max(4, +$("#maskSize").value - 10); sizeCursor(); }
    if (e.key === "]") { $("#maskSize").value = Math.min(300, +$("#maskSize").value + 10); sizeCursor(); }
  });
  window.addEventListener("resize", () => { if (!$("#maskModal").hidden && img) fit(); });
  $("#maskDone").onclick = finish;
}

async function finish() {
  const data = ctx.getImageData(0, 0, draw.width, draw.height);
  let any = false;
  for (let i = 3; i < data.data.length; i += 4) if (data.data[i] > 0) { any = true; break; }  // 每個像素都看：小筆刷點一下也算
  if (!any) return toast("還沒有塗任何區域", "err");
  keep.set(img.dataset.name, data);
  const out = document.createElement("canvas"); out.width = draw.width; out.height = draw.height;
  const c = out.getContext("2d");
  c.fillStyle = "#fff"; c.fillRect(0, 0, out.width, out.height);
  c.globalCompositeOperation = "destination-in"; c.drawImage(draw, 0, 0);
  c.globalCompositeOperation = "destination-over"; c.fillStyle = "#000"; c.fillRect(0, 0, out.width, out.height);
  const blob = await new Promise((r) => out.toBlob(r, "image/png"));
  try {
    const m = await uploadFile(new File([blob], "mask.png", { type: "image/png" }), "mask");
    closeModal("#maskModal");
    onDone && onDone(m);
  } catch (e) {
    toast("遮罩上傳失敗：" + e.message, "err");
  }
}

init();
