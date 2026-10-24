// 生圖並排挑（2026-10-24，拍攝單的首幀）：用生成頁目前的設定一次畫好幾張，同尺寸排成一張總表、每格大號編號，點一張就放進 input 當首幀。
// 只收這次送出的 job 的圖（別的生圖不會混進來）。圖照樣進圖庫。
import { el, api, toast, openModal, closeModal } from "./util.js";
import * as gen from "./gen.js";

const F = (id) => document.getElementById(id);
let generation = 0;
let run = null; // { jobs: Set, recs: [], resolve, w, h }

/** 畫 count 張（2～8）讓使用者挑；回 {name, width, height, gallery_id}，關掉回 null */
export async function pick({ count = 4 } = {}) {
  count = Math.max(2, Math.min(8, Math.round(Number(count)) || 4));
  if (run) finish(null);
  const ticket = ++generation;
  const params = { ...gen.collectParams(), mode: "txt2img", seed: -1 };
  let r;
  try { r = await api("/api/generate", { json: { params, count } }); } catch (e) { toast(e.message, "err"); return null; }
  if (ticket !== generation) return null;
  return new Promise((resolve) => {
    run = { jobs: new Set((r.jobs || []).map((j) => j.job)), recs: [], resolve, total: count, w: params.width || 1, h: params.height || 1 };
    const m = F("fpModal");
    m.oncancel = () => finish(null);
    m.onclick = (e) => { if (e.target === m || e.target.closest?.("[data-close]")) finish(null); };
    paint();
    openModal("#fpModal");
  });
}

/** main.js 收到新圖時呼叫；不是這次的 job 一律不理 */
export function onImage(job, rec) {
  if (!run || !rec || !run.jobs.has(job)) return;
  run.recs.push(rec);
  paint();
}

async function choose(rec) {
  const owner = run;
  try {
    const r = await api("/api/to_input", { json: { id: rec.id } });
    if (run === owner && owner) finish({ ...r, gallery_id: rec.id });
  } catch (e) { toast(e.message, "err"); }
}

function finish(v) {
  ++generation;
  const r = run;
  run = null;
  if (F("fpModal")) { F("fpModal").onclick = null; F("fpModal").oncancel = null; }
  closeModal("#fpModal");
  r?.resolve(v);
}

function paint() {
  if (!run) return;
  const ratio = `${run.w} / ${run.h}`;
  F("fpGrid").replaceChildren(...run.recs.map((rec, k) => el("button", { class: "fp-cell", type: "button", style: `aspect-ratio:${ratio}`, title: "用這張當首幀", onclick: () => choose(rec) },
    el("b", { class: "fp-n" }, String(k + 1)), el("img", { src: `/thumb/${rec.id}`, alt: "" }))));
  F("fpStatus").textContent = run.recs.length < run.total ? `畫好 ${run.recs.length} / ${run.total} 張，畫完前也可以先挑` : `${run.total} 張都畫好了，點一張當首幀`;
}
