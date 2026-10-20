"use strict";

// ---- bootstrap --------------------------------------------------------------
const TOKEN = location.pathname.replace(/\/+$/, "").split("/").pop();
const API = `/api/d/${TOKEN}`;

const stage = document.getElementById("stage");
const svg = document.getElementById("links");
const nodesLayer = document.getElementById("nodes");
const titleEl = document.getElementById("title");
const expiryEl = document.getElementById("expiry");
const saveEl = document.getElementById("save-state");
const overlay = document.getElementById("overlay");

let data = null;           // { title, root, view, expiresAt, ... }
let selectedId = null;
let view = { x: 120, y: 0, scale: 1 }; // pan/zoom; y is set to center after first layout

// layout constants (tuned to match the reference design)
const H_GAP = 64;          // horizontal gap between a node and its children
const V_GAP = 16;          // vertical gap between sibling subtrees
const TOGGLE_R = 6;        // collapse-toggle radius
const SVG_NS = "http://www.w3.org/2000/svg";

// ---- data loading -----------------------------------------------------------
async function boot() {
  let res;
  try {
    res = await fetch(API, { cache: "no-store" });
  } catch (_) {
    return showOverlay("サーバに接続できません", "mindmap-mcp サーバが起動しているか確認してください。");
  }
  if (res.status === 404) {
    return showOverlay("リンクが無効です", "この樹形図は存在しないか、3日間の有効期限が切れました。");
  }
  if (!res.ok) return showOverlay("読み込みエラー", "データを取得できませんでした。");

  data = await res.json();
  ensureIds(data.root);
  // a view of {0,0,1} is the server's default -> treat as "never positioned" and fit
  const pristine = !data.view ||
    (data.view.x === 0 && data.view.y === 0 && (data.view.scale === 1 || data.view.scale == null));
  if (data.view && typeof data.view === "object") view = { ...view, ...data.view };
  titleEl.textContent = data.title || "";
  renderExpiry();
  layoutAndRender(false);
  if (pristine) fitToScreen();
  setInterval(renderExpiry, 60 * 1000);
}

function showOverlay(title, msg) {
  document.getElementById("overlay-title").textContent = title;
  document.getElementById("overlay-msg").textContent = msg;
  overlay.classList.remove("hidden");
}

function renderExpiry() {
  if (!data || !data.expiresAt) return;
  const ms = data.expiresAt - Date.now();
  if (ms <= 0) { expiryEl.textContent = "期限切れ"; return; }
  const h = Math.floor(ms / 3600000);
  const d = Math.floor(h / 24);
  expiryEl.textContent = d >= 1 ? `あと約${d}日で期限切れ` : `あと約${h}時間で期限切れ`;
}

// ---- tree helpers -----------------------------------------------------------
let _idc = 0;
function makeId() { return "n" + (Date.now().toString(36)) + (_idc++).toString(36); }

function ensureIds(node) {
  if (!node.id) node.id = makeId();
  if (!Array.isArray(node.children)) node.children = [];
  node.children.forEach(ensureIds);
}

function findNode(id, node = data.root, parent = null) {
  if (node.id === id) return { node, parent };
  for (const c of node.children) {
    const r = findNode(id, c, node);
    if (r) return r;
  }
  return null;
}

// ---- layout -----------------------------------------------------------------
// Walk the (visible) tree, measuring each node div and assigning x/y.
// Left-to-right: x grows with depth, y is packed by subtree extent.
const nodeEls = new Map(); // id -> element

function measure(node, depth) {
  let el = nodeEls.get(node.id);
  if (!el) {
    el = document.createElement("div");
    el.className = "node";
    el.dataset.id = node.id;
    el.spellcheck = false;
    el.setAttribute("autocomplete", "off");
    el.setAttribute("autocorrect", "off");
    el.setAttribute("autocapitalize", "off");
    el.setAttribute("data-gramm", "false"); // keep Grammarly etc. out of nodes
    nodesLayer.appendChild(el);
    nodeEls.set(node.id, el);
    wireNode(el, node);
  }
  el.__node = node;
  if (document.activeElement !== el) el.textContent = node.text || "​";
  el.classList.toggle("root", depth === 0);
  const rect = el.getBoundingClientRect();
  node._w = rect.width / view.scale;
  node._h = rect.height / view.scale;
}

let _cursorY = 0;
function layout(node, depth, x) {
  measure(node, depth);
  node._x = x;
  const childX = x + node._w + H_GAP;
  const kids = node.collapsed ? [] : node.children;

  if (kids.length === 0) {
    node._y = _cursorY + node._h / 2;
    _cursorY += node._h + V_GAP;
  } else {
    const startY = _cursorY;
    for (const c of kids) layout(c, depth + 1, childX);
    const first = kids[0], last = kids[kids.length - 1];
    node._y = (first._y + last._y) / 2;
    // make sure the parent's own box fits vertically in degenerate cases
    const mid = node._y;
    if (mid - node._h / 2 < startY) { /* fine */ }
  }
}

function collectVisible(node, out) {
  out.push(node);
  if (!node.collapsed) node.children.forEach((c) => collectVisible(c, out));
  return out;
}

const ANIM_MS = 260;
let animRAF = null;

function buildParentMap() {
  const map = new Map();
  (function walk(n, p) { map.set(n.id, p); n.children.forEach((c) => walk(c, n)); })(data.root, null);
  return map;
}

// Compute the target layout, then move nodes + connectors there — snapping
// instantly (animate=false) or gliding via requestAnimationFrame (animate=true)
// so that the SVG links and the HTML nodes stay perfectly in sync every frame.
function layoutAndRender(animate = false) {
  const visible = collectVisible(data.root, []);
  const live = new Set(visible.map((n) => n.id));
  const parentMap = buildParentMap();

  _cursorY = 0;
  layout(data.root, 0, 0); // measures visible els, sets target _x/_y

  // nodes that just became hidden/removed -> retract into first visible ancestor
  const exiting = [];
  for (const [id, el] of nodeEls) {
    if (live.has(id)) continue;
    const node = el.__node;
    let anc = parentMap.get(id);
    while (anc && !live.has(anc.id)) anc = parentMap.get(anc.id);
    const tx = anc ? anc._x : (node._rx != null ? node._rx : node._x || 0);
    const ty = anc ? anc._y : (node._ry != null ? node._ry : node._y || 0);
    exiting.push({ el, node, sx: node._rx != null ? node._rx : tx, sy: node._ry != null ? node._ry : ty, tx, ty });
  }

  // seed start positions: new nodes grow out of their parent
  for (const node of visible) {
    if (node._rx == null) {
      const p = parentMap.get(node.id);
      node._rx = p ? (p._rx != null ? p._rx : p._x) : node._x;
      node._ry = p ? (p._ry != null ? p._ry : p._y) : node._y;
      node._ro = 0;
    } else if (node._ro == null) {
      node._ro = 1;
    }
    node._sx = node._rx; node._sy = node._ry; node._so = node._ro;
  }

  if (animRAF) { cancelAnimationFrame(animRAF); animRAF = null; }

  if (!animate) {
    for (const node of visible) { node._rx = node._x; node._ry = node._y; node._ro = 1; }
    for (const ex of exiting) { ex.el.remove(); nodeEls.delete(ex.node.id); }
    paint(visible);
    return;
  }

  const t0 = performance.now();
  (function step(now) {
    let t = (now - t0) / ANIM_MS;
    if (t > 1) t = 1;
    const e = 1 - Math.pow(1 - t, 3); // easeOutCubic
    for (const node of visible) {
      node._rx = node._sx + (node._x - node._sx) * e;
      node._ry = node._sy + (node._y - node._sy) * e;
      node._ro = node._so + (1 - node._so) * e;
    }
    for (const ex of exiting) {
      const x = ex.sx + (ex.tx - ex.sx) * e;
      const y = ex.sy + (ex.ty - ex.sy) * e;
      ex.el.style.left = x + "px";
      ex.el.style.top = (y - ex.node._h / 2) + "px";
      ex.el.style.opacity = String(1 - e);
    }
    paint(visible);
    if (t < 1) { animRAF = requestAnimationFrame(step); }
    else {
      for (const ex of exiting) { ex.el.remove(); nodeEls.delete(ex.node.id); }
      animRAF = null;
    }
  })(t0);
}

function applyTransform() {
  const t = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  nodesLayer.style.transform = t;
  svg.style.transform = t;
}

// position live nodes at their current rendered coords + redraw connectors
function paint(visible) {
  for (const node of visible) {
    const el = nodeEls.get(node.id);
    el.style.left = node._rx + "px";
    el.style.top = (node._ry - node._h / 2) + "px";
    el.style.opacity = node._ro == null ? "1" : String(node._ro);
    el.classList.toggle("selected", node.id === selectedId);
  }
  drawLinks();
  renderAddButton();
}

// lightweight repaint without re-layout (e.g. on selection change)
function positionNodes() {
  paint(collectVisible(data.root, []));
}

// zoom/pan so the whole tree fits in the viewport
function fitToScreen() {
  const nodes = collectVisible(data.root, []);
  if (!nodes.length) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n._x);
    maxX = Math.max(maxX, n._x + n._w + 30); // room for toggle / + button
    minY = Math.min(minY, n._y - n._h / 2);
    maxY = Math.max(maxY, n._y + n._h / 2);
  }
  const m = 70;
  const vw = window.innerWidth, vh = window.innerHeight;
  const cw = Math.max(1, maxX - minX), ch = Math.max(1, maxY - minY);
  let scale = Math.min((vw - 2 * m) / cw, (vh - 2 * m) / ch);
  scale = Math.min(1.3, Math.max(0.2, scale));
  view.scale = scale;
  view.x = (vw - cw * scale) / 2 - minX * scale;
  view.y = (vh - ch * scale) / 2 - minY * scale;
  applyTransform();
  scheduleSave();
}

// ---- connectors -------------------------------------------------------------
function drawLinks() {
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  drawLinksFor(data.root);
}

function drawLinksFor(node) {
  const hasKids = node.children.length > 0;
  if (hasKids) {
    const cx = node._rx + node._w + TOGGLE_R + 3;
    const cy = node._ry;
    if (!node.collapsed) {
      for (const child of node.children) {
        const sx = cx + TOGGLE_R;
        const sy = cy;
        const ex = child._rx;
        const ey = child._ry;
        const mx = sx + (ex - sx) * 0.5;
        const d = `M ${sx} ${sy} C ${mx} ${sy}, ${mx} ${ey}, ${ex} ${ey}`;
        appendPath(d);
        drawLinksFor(child);
      }
    }
    appendToggle(cx, cy, node);
  }
}

function appendPath(d) {
  const p = document.createElementNS(SVG_NS, "path");
  p.setAttribute("d", d);
  svg.appendChild(p);
}

function appendToggle(cx, cy, node) {
  const c = document.createElementNS(SVG_NS, "circle");
  c.setAttribute("class", "toggle");
  c.setAttribute("cx", cx);
  c.setAttribute("cy", cy);
  c.setAttribute("r", TOGGLE_R);
  c.addEventListener("mousedown", (e) => { e.stopPropagation(); });
  c.addEventListener("click", (e) => {
    e.stopPropagation();
    node.collapsed = !node.collapsed;
    layoutAndRender(true);
    scheduleSave();
  });
  svg.appendChild(c);
  if (node.collapsed) {
    // show a small "+" to indicate hidden children
    const plus = document.createElementNS(SVG_NS, "text");
    plus.setAttribute("class", "toggle-plus");
    plus.setAttribute("x", cx);
    plus.setAttribute("y", cy + 3.5);
    plus.setAttribute("text-anchor", "middle");
    plus.setAttribute("font-size", "11");
    plus.textContent = "+";
    plus.style.pointerEvents = "none";
    svg.appendChild(plus);
  }
}

// ---- add button -------------------------------------------------------------
let addBtn = null;
function renderAddButton() {
  if (!addBtn) {
    addBtn = document.createElement("div");
    addBtn.className = "add-btn";
    addBtn.textContent = "+";
    addBtn.title = "子ノードを追加";
    addBtn.addEventListener("mousedown", (e) => e.stopPropagation());
    addBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (selectedId) addChild(selectedId);
    });
    nodesLayer.appendChild(addBtn);
  }
  if (!selectedId) { addBtn.style.display = "none"; return; }
  const r = findNode(selectedId);
  if (!r) { addBtn.style.display = "none"; return; }
  const node = r.node;
  addBtn.style.display = "block";
  addBtn.style.left = (node._rx + node._w + 2) + "px";
  addBtn.style.top = (node._ry - node._h / 2 - 2) + "px";
}

// ---- node interaction -------------------------------------------------------
function wireNode(el, node) {
  el.addEventListener("mousedown", (e) => {
    if (el.classList.contains("editing")) return;
    e.stopPropagation();
  });
  el.addEventListener("click", (e) => {
    if (el.classList.contains("editing")) return;
    e.stopPropagation();
    select(node.id);
  });
  el.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    startEdit(node);
  });
  el.addEventListener("blur", () => commitEdit(node, el));
  el.addEventListener("keydown", (e) => {
    if (!el.classList.contains("editing")) return;
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); el.blur(); }
    if (e.key === "Escape") { e.preventDefault(); el.textContent = node.text || ""; el.blur(); }
    e.stopPropagation(); // don't trigger global shortcuts while typing
  });
}

function select(id) {
  selectedId = id;
  positionNodes();
}

function startEdit(node) {
  const el = nodeEls.get(node.id);
  selectedId = node.id;
  el.classList.add("editing");
  el.contentEditable = "true";
  if (el.textContent === "​") el.textContent = "";
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function commitEdit(node, el) {
  if (!el.classList.contains("editing")) return;
  el.classList.remove("editing");
  el.contentEditable = "false";
  const text = el.textContent.replace(/​/g, "").trim();
  node.text = text;
  layoutAndRender(true);
  scheduleSave();
}

function addChild(parentId) {
  const r = findNode(parentId);
  if (!r) return;
  r.node.collapsed = false;
  const child = { id: makeId(), text: "", collapsed: false, children: [] };
  r.node.children.push(child);
  selectedId = child.id;
  layoutAndRender(true);
  scheduleSave();
  requestAnimationFrame(() => startEdit(child));
}

function addSibling(id) {
  const r = findNode(id);
  if (!r || !r.parent) { addChild(id); return; } // root -> add child instead
  const sib = { id: makeId(), text: "", collapsed: false, children: [] };
  const idx = r.parent.children.indexOf(r.node);
  r.parent.children.splice(idx + 1, 0, sib);
  selectedId = sib.id;
  layoutAndRender(true);
  scheduleSave();
  requestAnimationFrame(() => startEdit(sib));
}

function deleteNode(id) {
  const r = findNode(id);
  if (!r || !r.parent) return; // can't delete root
  const idx = r.parent.children.indexOf(r.node);
  r.parent.children.splice(idx, 1);
  selectedId = r.parent.id;
  layoutAndRender(true);
  scheduleSave();
}

// ---- global shortcuts -------------------------------------------------------
document.addEventListener("keydown", (e) => {
  const editing = document.activeElement && document.activeElement.classList &&
                  document.activeElement.classList.contains("editing");
  if (editing || document.activeElement === titleEl) return;
  if (e.key === "f" || e.key === "F") { e.preventDefault(); fitToScreen(); return; }
  if (!selectedId) return;
  if (e.key === "Tab") { e.preventDefault(); addChild(selectedId); }
  else if (e.key === "Enter") { e.preventDefault(); addSibling(selectedId); }
  else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteNode(selectedId); }
  else if (e.key === "F2") { e.preventDefault(); const r = findNode(selectedId); if (r) startEdit(r.node); }
});

// fit button
document.getElementById("fit").addEventListener("click", (e) => { e.stopPropagation(); fitToScreen(); });

// title editing
titleEl.addEventListener("dblclick", () => { titleEl.contentEditable = "true"; titleEl.focus(); });
titleEl.addEventListener("blur", () => {
  titleEl.contentEditable = "false";
  data.title = titleEl.textContent.trim();
  scheduleSave();
});
titleEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); titleEl.blur(); }
  e.stopPropagation();
});

// ---- pan & zoom -------------------------------------------------------------
let panning = false, panStart = null;
stage.addEventListener("mousedown", (e) => {
  if (e.target.closest(".node") || e.target.closest(".toggle") || e.target.closest(".add-btn")) return;
  panning = true;
  stage.classList.add("panning");
  panStart = { x: e.clientX - view.x, y: e.clientY - view.y };
  selectedId = null;
  positionNodes();
});
window.addEventListener("mousemove", (e) => {
  if (!panning) return;
  view.x = e.clientX - panStart.x;
  view.y = e.clientY - panStart.y;
  applyTransform();
});
window.addEventListener("mouseup", () => {
  if (panning) { panning = false; stage.classList.remove("panning"); scheduleSave(); }
});

stage.addEventListener("wheel", (e) => {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
  const newScale = Math.min(2.5, Math.max(0.25, view.scale * factor));
  // zoom toward cursor
  const mx = e.clientX, my = e.clientY;
  view.x = mx - (mx - view.x) * (newScale / view.scale);
  view.y = my - (my - view.y) * (newScale / view.scale);
  view.scale = newScale;
  applyTransform();
  scheduleSave();
}, { passive: false });

// ---- auto-save --------------------------------------------------------------
let saveTimer = null;
function scheduleSave() {
  saveEl.textContent = "";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 600);
}

async function save() {
  if (!data) return;
  data.view = { x: view.x, y: view.y, scale: view.scale };
  saveEl.textContent = "保存中…";
  try {
    const res = await fetch(API, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: data.title, root: stripLayout(data.root), view: data.view }),
    });
    if (res.status === 404) return showOverlay("リンクが無効です", "有効期限が切れたため保存できません。");
    saveEl.textContent = res.ok ? "保存済み" : "保存失敗";
  } catch (_) {
    saveEl.textContent = "保存失敗（オフライン）";
  }
}

// remove transient layout fields before persisting
function stripLayout(node) {
  return {
    id: node.id,
    text: node.text,
    collapsed: !!node.collapsed,
    children: node.children.map(stripLayout),
  };
}

window.addEventListener("resize", () => { applyTransform(); });

boot();
