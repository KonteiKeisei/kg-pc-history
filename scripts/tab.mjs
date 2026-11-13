import {
  ABILITIES, CATEGORIES, ORIGINS, TAB_ID, TEMPLATES, abilityAbbr, abilityLabel, esc, formatDate, isCharacter,
  levelFromSource, renderTemplate, setting, signed, userName, validClassOrder
} from "./util.mjs";
import { anyModeAllowed, inferGeneration, keptSets, methodLabel, rerollState } from "./methods.mjs";
import { getPending, getStore, loadView, reportResults, submit } from "./store.mjs";
import { rebuildEntries } from "./tracking.mjs";
import { GenerationApp } from "./apps/generation-app.mjs";
import { EntryEditor } from "./apps/entry-editor.mjs";
import { GenerationEditor } from "./apps/generation-editor.mjs";
import { ClassOrderEditor, classesInOrder } from "./apps/class-order.mjs";
import { EFFECT_GROUPS, abilityEffectParts, currentEffects, effectCategory } from "./effects.mjs";

const { DialogV2 } = foundry.applications.api;

/* Per-actor view state, kept for the session so re-renders do not reset it. */
const states = new Map();
function stateFor(actor) {
  let s = states.get(actor.uuid);
  if ( !s ) {
    states.set(actor.uuid, s = {
      cats: new Set(), classes: new Set(), level: "", text: "", desc: false, scroll: 0,
      expanded: new Set(), ability: null
    });
  }
  return s;
}

export function canSeeHistory(actor) {
  return game.user.isGM || !!setting("playersSeeHistory");
}

/* -------------------------------------------- */
/*  Entry views                                 */
/* -------------------------------------------- */

function levelKey(level) {
  return (level === null) || (level === undefined) || (level === "") ? "none" : String(level);
}

function cardLabel(key) {
  if ( key === "none" ) return "Unsorted";
  return key === "0" ? "Origin" : `Level ${key}`;
}

function sourceName(src) {
  if ( !src || (src.type === "user") ) return "";
  return src.classLevel ? `${src.name} ${src.classLevel}` : (src.name ?? "");
}

function sourceText(e) {
  if ( e.origin === "manual" ) return `${e.source?.via ?? "Edited on the sheet"}${e.source?.name ? ` by ${e.source.name}` : ""}`;
  return [sourceName(e.source), e.source?.via].filter(Boolean).join(" · ");
}

const PREFIXES = [
  [/^Saving throw proficiency: (.+)$/, m => `${m[1]} save`],
  [/^Lost saving throw proficiency: (.+)$/, m => `${m[1]} save`],
  [/^Expertise: (.+)$/, m => `${m[1]} (expertise)`],
  [/^Half proficiency: (.+)$/, m => `${m[1]} (half)`],
  [/^Weapon mastery: (.+)$/, m => `Mastery: ${m[1]}`],
  [/^Damage resistance: (.+)$/, m => `Resist ${m[1]}`],
  [/^Damage immunity: (.+)$/, m => `Immune: ${m[1]}`],
  [/^Damage vulnerability: (.+)$/, m => `Vulnerable: ${m[1]}`],
  [/^Condition immunity: (.+)$/, m => `Immune: ${m[1]}`],
  [/^Hit points (\+\d+)$/, m => `${m[1]} HP`],
  [/^Removed [^:]+: (.+)$/, m => m[1]],
  [/^Lost [^:]+: (.+)$/, m => m[1]],
  [/^[^:]{1,40}: (.+)$/, m => m[1]]
];

/** The short text on a chip. The row it sits in already says what kind of change it is. */
function chipText(e) {
  const label = String(e.label ?? "");
  if ( e.category === "ability" ) {
    const m = label.match(/^(\S+)\s+([+-]\d+)$/);
    const key = e.key?.startsWith("ability:") ? e.key.slice(8) : null;
    if ( m && key ) return `${abilityAbbr(key)} ${m[2]}`;
    return label;
  }
  if ( ["scale", "generation", "note"].includes(e.category) ) return label;
  for ( const [re, fn] of PREFIXES ) {
    const m = label.match(re);
    if ( m ) return fn(m);
  }
  return label;
}

function isRemoved(e) {
  if ( e.removed !== undefined ) return !!e.removed;
  return /^(Removed |Lost |Proficiency reduced)/.test(e.label ?? "") || / level removed$/.test(e.label ?? "");
}

function entryView(e, classColors) {
  const cat = CATEGORIES[e.category] ?? CATEGORIES.other;
  const who = userName(e.user);
  const src = sourceText(e);
  const anchorId = e.anchor?.classId ?? "";
  return {
    id: e.id,
    category: e.category in CATEGORIES ? e.category : "other",
    icon: cat.icon,
    catLabel: cat.label,
    label: e.label,
    chip: chipText(e),
    chipSub: e.category === "ability" ? (e.detail ?? "") : "",
    detail: e.detail,
    source: src,
    origin: e.origin,
    originLabel: ORIGINS[e.origin] ?? "",
    manual: e.origin === "manual",
    gm: e.origin === "gm",
    removed: isRemoved(e),
    date: formatDate(e.ts),
    who,
    note: e.note,
    edited: !!e.editedBy,
    levelApprox: !!e.levelApprox,
    levelKey: levelKey(e.level),
    classId: anchorId,
    classColor: anchorId ? (classColors.get(anchorId) ?? 0) : null,
    search: [e.label, e.detail, src, e.note, cat.label, who, e.anchor?.className].filter(Boolean).join(" ").toLowerCase()
  };
}

/* -------------------------------------------- */
/*  Ability strip                               */
/* -------------------------------------------- */

function abilityView(actor, gen, entries, effects) {
  const final = gen?.status === "final";
  return ABILITIES.map(a => {
    const sourceValue = Number(actor._source?.system?.abilities?.[a]?.value ?? 10);
    const shown = Number(actor.system?.abilities?.[a]?.value ?? sourceValue);
    const base = final ? Number(gen.base?.[a]) : null;
    const parts = [];
    const idx = gen?.assignIndex?.[a];
    const set = Number.isInteger(idx) ? gen.sets?.[idx] : null;
    if ( Number.isFinite(base) ) {
      parts.push({
        text: `${base} base`, sub: methodLabel(gen), cls: "base",
        dice: set?.dice?.map(d => ({ r: d.r, off: !d.a })) ?? null
      });
    }
    else parts.push({ text: "No base score recorded", cls: "muted" });
    let sum = Number.isFinite(base) ? base : null;
    for ( const e of entries ) {
      if ( (e.key !== `ability:${a}`) || !Number(e.delta) ) continue;
      const who = e.origin === "manual" ? `hand edit${e.source?.name ? ` (${e.source.name})` : ""}` : (sourceName(e.source) || "advancement");
      parts.push({
        text: `${signed(e.delta)} ${who}`, sub: cardLabel(levelKey(e.level)),
        cls: e.origin === "manual" ? "manual" : ""
      });
      if ( sum !== null ) sum += Number(e.delta);
    }
    if ( (sum !== null) && (sum !== sourceValue) ) {
      parts.push({ text: `${signed(sourceValue - sum)} not recorded`, sub: "changed before tracking, or with tracking off", cls: "warn" });
    }
    if ( shown !== sourceValue ) {
      const named = abilityEffectParts(effects, a);
      if ( named.length ) parts.push(...named);
      else parts.push({ text: `${signed(shown - sourceValue)} active effects or items`, sub: "not permanent", cls: "muted" });
    }
    const baseShown = Number.isFinite(base) ? base : null;
    return {
      key: a, abbr: abilityAbbr(a), label: abilityLabel(a), value: shown,
      base: baseShown, hasBase: baseShown !== null, diff: baseShown !== null ? shown - baseShown : 0,
      diffText: baseShown !== null && shown !== baseShown ? signed(shown - baseShown) : "",
      parts
    };
  });
}

function generationView(gen) {
  if ( !gen ) return null;
  const rolled = gen.mode === "roll";
  const state = gen.status === "rolling" ? rerollState(gen, game.user.isGM) : null;
  return {
    final: gen.status === "final",
    rolling: gen.status === "rolling",
    method: methodLabel(gen),
    by: userName(gen.finalizedBy ?? gen.rolledBy),
    date: formatDate(gen.finalizedAt ?? gen.rolledAt),
    verified: gen.verified !== false,
    inferred: !!gen.inferred,
    edited: !!gen.editedBy,
    editedBy: userName(gen.editedBy),
    points: gen.mode === "pointBuy" ? `${gen.pointsSpent ?? "?"} of ${gen.budget ?? "?"} points` : "",
    sets: rolled && gen.sets ? gen.sets.map((s, i) => ({
      total: s.total, dropped: i === gen.dropped, dice: (s.dice ?? []).map(d => ({ r: d.r, off: !d.a }))
    })) : null,
    kept: rolled ? keptSets(gen).length : 0,
    discarded: (gen.discarded ?? []).map((d, n) => ({
      n: n + 1, free: !!d.free,
      totals: d.sets.map((s, i) => (i === d.dropped ? `(${s.total})` : s.total)).join(", ")
    })),
    rerolls: state,
    note: gen.note ?? "",
    hasDetails: !!(rolled && gen.sets) || !!gen.discarded?.length || !!gen.note
  };
}

/* -------------------------------------------- */
/*  Context                                     */
/* -------------------------------------------- */

const ROW_ORDER = ["class", "ability", "proficiency", "language", "feat", "feature", "spell", "defense", "hp", "scale",
  "other", "generation", "note"];

function buildContext(actor, view) {
  const isGM = game.user.isGM;
  const state = stateFor(actor);
  const gen = view.generation;
  let effects = [];
  try {
    effects = currentEffects(actor);
  } catch(err) {
    console.warn("kg-pc-history | Could not read current effects", err);
  }
  // Feature effects attach to the feature's history entry; everything else is a current modifier.
  const featureFx = new Map();
  for ( const fx of effects ) {
    if ( (fx.group !== "feature") || !fx.itemId ) continue;
    if ( !featureFx.has(fx.itemId) ) featureFx.set(fx.itemId, []);
    featureFx.get(fx.itemId).push(fx);
  }
  const liveEffects = effects.filter(fx => fx.group !== "feature");
  const sorted = view.entries.slice().sort((a, b) =>
    ((a.level ?? 999) - (b.level ?? 999)) || ((a.ts ?? 0) - (b.ts ?? 0)) || ((a.seq ?? 0) - (b.seq ?? 0)));

  // Classes, in the order they were taken where known, each with a stable color.
  const classes = classesInOrder(actor, view.classOrder);
  for ( const e of sorted ) {
    const a = e.anchor;
    if ( a?.classId && !classes.some(c => c.id === a.classId) ) classes.push({ id: a.classId, name: a.className, levels: 0, gone: true });
  }
  const classColors = new Map(classes.map((c, i) => [c.id, i % 8]));
  const multiclass = actor.items.filter(i => i.type === "class").length > 1;
  const orderSet = validClassOrder(actor, view.classOrder);

  const catCounts = {};
  const cards = new Map();
  const views = [];
  for ( const e of sorted ) {
    const v = entryView(e, classColors);
    // A feature's own passive effects belong to the feature: show them on its chip, not as a current modifier.
    if ( e.key?.startsWith("item:") && !v.removed ) {
      const fx = featureFx.get(e.key.slice(5));
      if ( fx?.length ) {
        v.effects = fx.map(f => ({ name: f.name, summary: f.summary }));
        v.effectText = fx.map(f => f.summary || f.name).join("; ");
      }
    }
    views.push(v);
    catCounts[v.category] = (catCounts[v.category] ?? 0) + 1;
    let card = cards.get(v.levelKey);
    if ( !card ) {
      cards.set(v.levelKey, card = {
        key: v.levelKey, label: cardLabel(v.levelKey), entries: [], tags: new Map(), sources: new Set(),
        manual: 0, approx: false
      });
    }
    card.entries.push(v);
    if ( e.anchor?.classId ) {
      const tagKey = `${e.anchor.classId}:${e.anchor.classLevel}`;
      if ( !card.tags.has(tagKey) && (e.category !== "generation") ) {
        card.tags.set(tagKey, {
          id: e.anchor.classId, color: classColors.get(e.anchor.classId) ?? 0,
          text: `${e.anchor.className ?? classes.find(c => c.id === e.anchor.classId)?.name ?? "Class"} ${e.anchor.classLevel ?? ""}`.trim(),
          classLevel: Number(e.anchor.classLevel) || 0
        });
      }
    }
    const sn = sourceName(e.source);
    if ( sn && !e.anchor && (e.origin !== "manual") ) card.sources.add(sn.replace(/\s+\d+$/, ""));
    if ( v.manual ) card.manual++;
    if ( v.levelApprox ) card.approx = true;
  }

  let cardList = [...cards.values()].map(c => {
    const byCat = new Map();
    for ( const v of c.entries ) {
      if ( !byCat.has(v.category) ) byCat.set(v.category, []);
      byCat.get(v.category).push(v);
    }
    const rows = ROW_ORDER.filter(id => byCat.has(id)).map(id => ({
      id, label: CATEGORIES[id].label, icon: CATEGORIES[id].icon, chips: byCat.get(id)
    }));
    const tags = [...c.tags.values()].sort((a, b) => a.classLevel - b.classLevel);
    return {
      key: c.key, label: c.label, tags, rows,
      sources: [...c.sources].slice(0, 4).join(" · "),
      classIds: tags.map(t => t.id).join(" "),
      manual: c.manual, approx: c.approx, count: c.entries.length,
      entries: c.entries, expanded: state.expanded.has(c.key),
      pinned: (c.key === "0") || (c.key === "none")
    };
  });
  const unsorted = cardList.filter(c => c.key === "none");
  cardList = cardList.filter(c => c.key !== "none");
  if ( state.desc ) cardList.reverse();
  cardList.push(...unsorted);

  const levelKeys = [...cards.keys()].sort((a, b) => (a === "none" ? 999 : Number(a)) - (b === "none" ? 999 : Number(b)));
  return {
    isGM,
    // With generation off (the default), nobody sees a Generate button; the GM still has the pencil to edit the record.
    canGenerate: actor.isOwner && (gen?.status !== "final") && anyModeAllowed(),
    generation: generationView(gen),
    abilities: abilityView(actor, gen, sorted, effects),
    modifiers: {
      count: liveEffects.length,
      expanded: state.expanded.has("modifiers"),
      rows: Object.entries(EFFECT_GROUPS).map(([id, g]) => ({
        id, label: g.label, icon: g.icon, hint: g.hint, chips: liveEffects.filter(e => e.group === id)
      })).filter(r => r.chips.length),
      all: liveEffects
    },
    openAbility: state.ability,
    pendingCount: view.pendingCount ?? 0,
    hasEntries: sorted.length > 0,
    total: sorted.length,
    desc: state.desc,
    text: state.text,
    multiclass,
    orderSet,
    categories: ROW_ORDER.filter(id => catCounts[id]).map(id => ({
      id, label: CATEGORIES[id].label, icon: CATEGORIES[id].icon, count: catCounts[id], active: state.cats.has(id)
    })),
    classes: classes.filter(c => !c.gone || sorted.some(e => e.anchor?.classId === c.id)).map(c => ({
      id: c.id, name: c.name, levels: c.levels, color: classColors.get(c.id), active: state.classes.has(c.id)
    })),
    showClassFilter: classes.length > 1,
    levels: levelKeys.map(k => ({ id: k, label: cardLabel(k), selected: state.level === k })),
    allCats: !state.cats.size,
    allClasses: !state.classes.size,
    cards: cardList,
    views
  };
}

function effectDetailHTML(fx, isGM) {
  const meta = [
    `<span>${esc(fx.groupLabel)}</span>`,
    fx.source && `<span>${esc(fx.source)}</span>`,
    fx.duration && `<span>${esc(fx.duration)}</span>`
  ].filter(Boolean).join("");
  const changes = fx.changes.length
    ? `<ul class="kg-pch-fxchanges">${fx.changes.map(c => `<li>${esc(c.text)}</li>`).join("")}</ul>`
    : "";
  const statuses = fx.statuses.length ? `<div class="kg-pch-chipdetail-meta"><span>Conditions: ${esc(fx.statuses.join(", "))}</span></div>` : "";
  const actions = isGM ? `<span class="kg-pch-chipdetail-actions">
      <span role="button" tabindex="0" class="kg-pch-btn small" data-kg-action="record-effect" data-effect-id="${esc(fx.id)}"
        data-tooltip="Add an entry for this effect to the history. Nothing changes on the character."><i class="fa-solid fa-thumbtack"></i> Record in history</span>
    </span>` : "";
  return `<div class="kg-pch-chipdetail" data-for="${esc(fx.id)}">
    <div class="kg-pch-chipdetail-main">
      <strong>${esc(fx.name)}</strong>
      <div class="kg-pch-chipdetail-meta">${meta}</div>
      ${changes}${statuses}
    </div>${actions}</div>`;
}

/* -------------------------------------------- */
/*  Rendering                                   */
/* -------------------------------------------- */

function scrollParent(el) {
  let node = el.parentElement;
  while ( node && (node !== document.body) ) {
    const oy = getComputedStyle(node).overflowY;
    if ( ((oy === "auto") || (oy === "scroll")) && (node.scrollHeight > node.clientHeight) ) return node;
    node = node.parentElement;
  }
  return null;
}

/*
 * Render memo. A character sheet re-renders on every update to the actor (HP in combat, a used spell slot), and the
 * History tab is part of it. Nothing the tab shows depends on most of those updates, so each render is keyed by what
 * the tab does depend on; when the key matches the last render, the finished HTML is reused and no data is loaded,
 * no context is built and no template runs.
 */
const memo = new Map();

function renderKey(actor) {
  const s = stateFor(actor);
  const store = getStore(actor);
  const parts = [
    store.file ?? "", store.rev ?? 0, getPending(actor).length, game.user.isGM ? 1 : 0, anyModeAllowed() ? 1 : 0,
    [...s.cats].join(","), [...s.classes].join(","), s.level, s.text, s.desc ? 1 : 0, [...s.expanded].join(","), s.ability ?? "",
    actor.system?.details?.originalClass ?? ""
  ];
  const src = actor._source?.system?.abilities ?? {};
  for ( const a of ABILITIES ) parts.push(actor.system?.abilities?.[a]?.value, src[a]?.value);
  for ( const i of actor.items ) if ( i.type === "class" ) parts.push(i.id, i.name, i.system?.levels);
  try {
    for ( const e of actor.allApplicableEffects?.() ?? actor.effects ) {
      parts.push(e.id, e.active ? 1 : 0, e.name, e.duration?.remaining ?? "");
    }
  } catch(err) { parts.push(Math.random()); }
  return parts.join("|");
}

function paint(root, actor, html, view, context) {
  root.innerHTML = html;
  bind(root, actor, view, context);
  applyFilters(root, actor);
}

/** Render the History tab contents into `root`. Safe to call repeatedly; a later call wins. */
export async function renderHistory(root, actor) {
  const token = String((Number(root.dataset.kgRender) || 0) + 1);
  root.dataset.kgRender = token;
  root.classList.add("kg-pch-root");
  const key = renderKey(actor);
  const hit = memo.get(actor.uuid);
  if ( hit?.key === key ) {
    paint(root, actor, hit.html, hit.view, hit.context);
    restoreScroll(root, actor);
    return;
  }
  let view;
  try {
    view = await loadView(actor);
  } catch(err) {
    console.error(err);
    root.innerHTML = "<p class=\"kg-pch-empty\">The history could not be loaded.</p>";
    return;
  }
  if ( root.dataset.kgRender !== token ) return;
  const context = buildContext(actor, view);
  const html = await renderTemplate(`${TEMPLATES}/history.hbs`, context);
  if ( (root.dataset.kgRender !== token) || !root.isConnected ) return;
  memo.set(actor.uuid, { key, html, view, context });
  paint(root, actor, html, view, context);
  restoreScroll(root, actor);
}

function restoreScroll(root, actor) {
  const sp = scrollParent(root);
  const state = stateFor(actor);
  if ( sp ) {
    sp._kgActor = actor;
    if ( state.scroll ) sp.scrollTop = state.scroll;
    if ( !sp._kgScrollBound ) {
      sp._kgScrollBound = true;
      sp.addEventListener("scroll", () => {
        if ( sp._kgActor ) stateFor(sp._kgActor).scroll = sp.scrollTop;
      }, { passive: true });
    }
  }
}

/*
 * One visibility observer per open sheet. A sheet re-render replaces the tab's element, so the previous observer is
 * disconnected rather than left watching a detached element.
 */
const observers = new Map();

/** Render now if the root is visible, otherwise as soon as it becomes visible (the tab is opened). */
export function renderWhenVisible(root, actor, sheetId) {
  const slot = sheetId ?? actor.uuid;
  observers.get(slot)?.disconnect();
  observers.delete(slot);
  if ( root.offsetParent !== null ) return renderHistory(root, actor);
  const obs = new IntersectionObserver(entries => {
    if ( !entries.some(e => e.isIntersecting) ) return;
    obs.disconnect();
    if ( observers.get(slot) === obs ) observers.delete(slot);
    renderHistory(root, actor);
  });
  obs.observe(root);
  observers.set(slot, obs);
}

/** Forget a closed sheet's observer. */
export function releaseSheet(sheetId) {
  observers.get(sheetId)?.disconnect();
  observers.delete(sheetId);
}

function applyFilters(root, actor) {
  const s = stateFor(actor);
  const text = s.text.trim().toLowerCase();
  const entryOk = el => (!s.cats.size || s.cats.has(el.dataset.category))
    && (!text || el.dataset.search.includes(text));
  let shown = 0;
  for ( const card of root.querySelectorAll(".kg-pch-lcard:not(.kg-pch-mcard)") ) {
    const classOk = !s.classes.size || (card.dataset.pinned === "1")
      || card.dataset.classes.split(" ").some(id => s.classes.has(id));
    const levelOk = !s.level || (card.dataset.level === s.level);
    let any = false;
    for ( const chip of card.querySelectorAll(".kg-pch-xchip, .kg-pch-fullrow") ) {
      const ok = classOk && levelOk && entryOk(chip);
      chip.hidden = !ok;
      if ( ok && chip.classList.contains("kg-pch-xchip") ) {
        any = true;
        shown++;
      }
    }
    for ( const row of card.querySelectorAll(".kg-pch-trow") ) {
      row.hidden = !row.querySelector(".kg-pch-xchip:not([hidden])");
    }
    card.hidden = !any;
  }
  const none = root.querySelector(".kg-pch-nomatch");
  if ( none ) none.hidden = shown > 0;
  const count = root.querySelector(".kg-pch-count");
  if ( count ) count.textContent = String(shown);
}

/** Listeners are delegated and bound once per root; each render swaps the data they act on. */
function bind(root, actor, view, context) {
  root._kgCtx = {
    actor, view,
    byId: new Map(context.views.map(v => [v.id, v])),
    effectsById: new Map(context.modifiers.all.map(e => [e.id, e]))
  };
  if ( root._kgBound ) return;
  root._kgBound = true;
  root.addEventListener("change", ev => {
    ev.stopPropagation();
    if ( ev.target.matches?.(".kg-pch-level-select") ) {
      stateFor(root._kgCtx.actor).level = ev.target.value;
      applyFilters(root, root._kgCtx.actor);
    }
  });
  root.addEventListener("submit", ev => ev.stopPropagation());
  root.addEventListener("keydown", ev => {
    if ( (ev.key === "Enter") && ev.target.matches?.(".kg-pch-search") ) ev.preventDefault();
    // Controls are spans (sheet stylesheets restyle every <button>), so give them button keys.
    if ( ((ev.key === "Enter") || (ev.key === " ")) && ev.target.matches?.("[role=button][data-kg-action]") ) {
      ev.preventDefault();
      ev.stopPropagation();
      ev.target.click();
    }
  });
  root.addEventListener("input", ev => {
    ev.stopPropagation();
    if ( !ev.target.matches?.(".kg-pch-search") ) return;
    stateFor(root._kgCtx.actor).text = ev.target.value;
    closeDetails(root);
    applyFilters(root, root._kgCtx.actor);
  });
  root.addEventListener("click", ev => {
    const el = ev.target.closest("[data-kg-action]");
    if ( !el || !root.contains(el) ) return;
    ev.preventDefault();
    ev.stopPropagation();
    onAction(el, root, root._kgCtx.actor, root._kgCtx.view);
  });
}

function closeDetails(root) {
  root.querySelectorAll(".kg-pch-chipdetail").forEach(d => d.remove());
  root.querySelectorAll(".kg-pch-xchip.open").forEach(c => c.classList.remove("open"));
}

function detailHTML(v, isGM) {
  const meta = [
    v.source && `<span>${esc(v.source)}</span>`,
    v.originLabel && `<span class="origin origin-${esc(v.origin)}">${esc(v.originLabel)}</span>`,
    v.levelApprox && "<span class=\"kg-pch-pill warn\" data-tooltip=\"Placed at its class level. Set the class order to fix it.\">Approximate level</span>",
    v.edited && "<span class=\"kg-pch-pill\">Edited</span>",
    v.date && `<span${v.who ? ` data-tooltip="${esc(v.who)}"` : ""}>${esc(v.date)}</span>`
  ].filter(Boolean).join("");
  const actions = isGM ? `<span class="kg-pch-chipdetail-actions">
      <span role="button" tabindex="0" class="kg-pch-icon" data-kg-action="edit" data-entry-id="${esc(v.id)}" data-tooltip="Edit" aria-label="Edit entry"><i class="fa-solid fa-pen"></i></span>
      <span role="button" tabindex="0" class="kg-pch-icon" data-kg-action="delete" data-entry-id="${esc(v.id)}" data-tooltip="Delete" aria-label="Delete entry"><i class="fa-solid fa-trash"></i></span>
    </span>` : "";
  return `<div class="kg-pch-chipdetail" data-for="${esc(v.id)}">
    <div class="kg-pch-chipdetail-main">
      <strong>${esc(v.label)}</strong>${v.detail ? ` <span class="kg-pch-chipdetail-detail">${esc(v.detail)}</span>` : ""}
      <div class="kg-pch-chipdetail-meta">${meta}</div>
      ${v.effects?.length ? `<ul class="kg-pch-fxchanges">${v.effects.map(f =>
        `<li><i class="fa-solid fa-bolt"></i> ${esc(f.name)}${f.summary ? `: ${esc(f.summary)}` : ""}</li>`).join("")}</ul>` : ""}
      ${v.note ? `<p class="kg-pch-note">${esc(v.note)}</p>` : ""}
    </div>${actions}</div>`;
}

function toggleFilter(el, root, actor) {
  const s = stateFor(actor);
  const set = el.dataset.kind === "cat" ? s.cats : s.classes;
  const value = el.dataset.value;
  if ( value === "*" ) set.clear();
  else if ( set.has(value) ) set.delete(value);
  else set.add(value);
  const box = el.closest(".kg-pch-chips");
  for ( const chip of box.querySelectorAll("[data-kg-action=filter]") ) {
    const v = chip.dataset.value;
    chip.classList.toggle("active", v === "*" ? !set.size : set.has(v));
  }
  closeDetails(root);
  applyFilters(root, actor);
}

async function onAction(el, root, actor, view) {
  const action = el.dataset.kgAction;
  const id = el.dataset.entryId ?? el.closest("[data-entry-id]")?.dataset.entryId;
  const state = stateFor(actor);
  switch ( action ) {
    case "filter":
      return toggleFilter(el, root, actor);
    case "effect": {
      const open = el.classList.contains("open");
      closeDetails(root);
      if ( open ) return;
      const fx = root._kgCtx.effectsById.get(el.dataset.effectId);
      if ( !fx ) return;
      el.classList.add("open");
      el.closest(".kg-pch-trow").insertAdjacentHTML("afterend", effectDetailHTML(fx, game.user.isGM));
      return;
    }
    case "record-effect": {
      const fx = root._kgCtx.effectsById.get(el.dataset.effectId);
      if ( !fx ) return;
      return EntryEditor.open(actor, null, {
        label: `Effect: ${fx.name}`,
        detail: fx.summary,
        category: effectCategory(fx),
        level: actor.system?.details?.level ?? 0,
        source: { name: fx.source, via: `${fx.groupLabel} effect` },
        note: ""
      });
    }
    case "chip": {
      const open = el.classList.contains("open");
      closeDetails(root);
      if ( open ) return;
      const v = root._kgCtx.byId.get(id);
      if ( !v ) return;
      el.classList.add("open");
      el.closest(".kg-pch-trow").insertAdjacentHTML("afterend", detailHTML(v, game.user.isGM));
      return;
    }
    case "toggle-card": {
      const card = el.closest(".kg-pch-lcard");
      const key = card.dataset.level;
      const on = !card.classList.contains("expanded");
      card.classList.toggle("expanded", on);
      if ( on ) state.expanded.add(key);
      else state.expanded.delete(key);
      closeDetails(root);
      return;
    }
    case "ability": {
      const key = el.dataset.ability;
      state.ability = state.ability === key ? null : key;
      root.querySelectorAll(".kg-pch-score").forEach(c => c.classList.toggle("open", c.dataset.ability === state.ability));
      root.querySelectorAll(".kg-pch-breakdown").forEach(b => b.hidden = b.dataset.ability !== state.ability);
      return;
    }
    case "sort":
      state.desc = !state.desc;
      return renderHistory(root, actor);
    case "generate":
      return GenerationApp.open(actor);
    case "add":
      return EntryEditor.open(actor, null);
    case "class-order":
      return ClassOrderEditor.open(actor, view.classOrder);
    case "edit": {
      const entry = view.entries.find(e => e.id === id);
      if ( entry ) EntryEditor.open(actor, entry);
      return;
    }
    case "delete": {
      const entry = view.entries.find(e => e.id === id);
      if ( !entry ) return;
      const ok = await DialogV2.confirm({
        window: { title: "Delete History Entry" },
        content: `<p>Delete <strong>${esc(entry.label)}</strong> from ${esc(actor.name)}'s history?</p>`,
        rejectClose: false
      });
      if ( ok ) reportResults(await submit(actor, [{ type: "deleteEntry", entryId: id }]));
      return;
    }
    case "edit-generation":
      return GenerationEditor.open(actor, view.generation);
    case "reset-generation":
      if ( await confirmTyped({
        title: "Reset Ability Generation",
        phrase: "RESET",
        icon: "fa-solid fa-rotate-left",
        label: "Reset",
        content: `<p>Clear ${esc(actor.name)}'s ability generation record so the player can generate scores again?</p>`
          + "<p>Ability scores on the sheet are not changed. The old record is gone, but the reset is noted in the history.</p>"
      }) ) reportResults(await submit(actor, [{ type: "resetGeneration" }]));
      return;
    case "rebuild":
      return rebuild(actor, view);
  }
}

/**
 * A confirmation that only goes through when the user types `phrase` (case-insensitive). The confirm button stays
 * disabled until the text matches, and the result is checked again on submit.
 */
async function confirmTyped({ title, content, phrase, label, icon }) {
  const matches = value => String(value ?? "").trim().toUpperCase() === phrase.toUpperCase();
  const result = await DialogV2.wait({
    window: { title, icon },
    classes: ["kg-pch", "kg-pch-typed-confirm"],
    content: `${content}<p>Type <strong>${esc(phrase)}</strong> to confirm.</p>`
      + `<input type="text" name="kgConfirm" autocomplete="off" spellcheck="false" placeholder="${esc(phrase)}">`,
    buttons: [
      { action: "cancel", label: "Cancel", icon: "fa-solid fa-xmark", default: true },
      {
        action: "confirm", label, icon, class: "kg-pch-danger",
        callback: (event, button) => matches(button.form?.elements?.kgConfirm?.value)
      }
    ],
    render: (event, dialog) => {
      const el = dialog?.element ?? event?.target?.element;
      const input = el?.querySelector?.("input[name=kgConfirm]");
      const btn = el?.querySelector?.("button[data-action=confirm]");
      if ( !input || !btn ) return;
      btn.disabled = true;
      input.addEventListener("input", () => btn.disabled = !matches(input.value));
      input.addEventListener("keydown", ev => {
        if ( (ev.key === "Enter") && !matches(input.value) ) ev.preventDefault();
      });
      input.focus();
    },
    rejectClose: false
  });
  return result === true;
}

async function rebuild(actor, view) {
  const order = validClassOrder(actor, view.classOrder) ? view.classOrder : null;
  const fresh = rebuildEntries(actor, { order });
  const have = new Set(view.entries.map(e => `${e.key}|${e.level ?? ""}`));
  const entries = fresh.filter(e => !e.key || !have.has(`${e.key}|${e.level ?? ""}`));
  const inferred = view.generation ? null : inferGeneration(actor);
  if ( !entries.length && !inferred ) {
    ui.notifications.info("PC History: nothing to add. Every advancement on this character is already in its history.");
    return;
  }
  const multi = actor.items.filter(i => i.type === "class").length > 1;
  const inferHTML = inferred ? `<label class="kg-pch-check kg-pch-infer"><input type="checkbox" name="kgInfer" checked><span>`
    + `Also record base scores of <strong>${ABILITIES.map(a => `${abilityAbbr(a)} ${inferred.base[a]}`).join(", ")}</strong> `
    + `(${esc(inferredMethodText(inferred))}), marked Inferred.</span></label>`
    + "<p class=\"hint\">That is the sheet's scores minus the increases its advancements recorded. A score typed onto "
    + "the sheet by hand would be counted as base, so check it with the pencil on the Ability Scores card.</p>" : "";
  const choice = await DialogV2.wait({
    window: { title: "Rebuild From Advancements" },
    classes: ["kg-pch"],
    content: (entries.length
      ? `<p>Add <strong>${entries.length}</strong> entries rebuilt from the choices stored on ${esc(actor.name)}'s classes, `
        + "species, background and feats? Existing entries are kept, and anything already recorded is skipped.</p>"
        + (multi && !order ? "<p>This character has more than one class and no class order yet. Entries are placed at their "
          + "class level and marked approximate until you set the class order (the layers button on the History tab).</p>" : "")
        + "<p>Changes made without advancement (typed on the sheet) cannot be rebuilt; add those by hand.</p>"
      : `<p>Every advancement on ${esc(actor.name)} is already in its history, but no ability generation is recorded.</p>`)
      + inferHTML,
    buttons: [
      { action: "cancel", label: "Cancel", icon: "fa-solid fa-xmark" },
      {
        action: "rebuild", label: entries.length ? "Rebuild" : "Record Scores", icon: "fa-solid fa-wand-magic-sparkles", default: true,
        callback: (event, button) => ({ infer: !!button.form?.elements?.kgInfer?.checked })
      }
    ],
    rejectClose: false
  });
  if ( !choice || (choice === "cancel") ) return;
  const ops = [];
  if ( entries.length ) ops.push({ type: "append", entries });
  if ( inferred && choice.infer ) ops.push({ type: "setGeneration", generation: inferred });
  if ( ops.length ) reportResults(await submit(actor, ops));
}

function inferredMethodText(gen) {
  if ( gen.mode === "standardArray" ) return "they match the standard array";
  if ( gen.mode === "pointBuy" ) return `they spend exactly ${gen.budget} points, so likely point buy`;
  return "not the standard array or point buy, so rolled or set by hand";
}

/* -------------------------------------------- */
/*  Default dnd5e sheet                         */
/* -------------------------------------------- */

/**
 * Add the History tab to dnd5e's character sheet as a real tab (TABS + PARTS), so the sheet's own tab handling keeps
 * it selected across re-renders. The part is a placeholder that renderHistory fills.
 */
export function patchCoreSheet() {
  const cls = globalThis.dnd5e?.applications?.actor?.CharacterActorSheet;
  if ( !cls?.TABS || !cls?.PARTS ) {
    console.warn("kg-pc-history | dnd5e CharacterActorSheet not found; the History tab is only available on Tidy 5e.");
    return false;
  }
  if ( cls.TABS.some(t => t.tab === TAB_ID) ) return true;
  const tab = { tab: TAB_ID, label: "History", icon: "fa-solid fa-scroll", condition: actor => canSeeHistory(actor) };
  const at = cls.TABS.findIndex(t => t.tab === "specialTraits");
  if ( at >= 0 ) cls.TABS.splice(at, 0, tab);
  else cls.TABS.push(tab);
  cls.PARTS[TAB_ID] = {
    container: { classes: ["tab-body"], id: "tabs" },
    template: `${TEMPLATES}/history-part.hbs`,
    scrollable: [""]
  };
  return true;
}

const prompted = new Set();

/** Should a new character be asked for ability scores? */
export async function shouldPrompt(actor) {
  if ( !isCharacter(actor) || !actor.isOwner || actor.isToken || !anyModeAllowed() ) return false;
  if ( levelFromSource(actor._source) > 1 ) return false;
  // A character with a history file or queued changes already has history: no need to download it to know that.
  const store = getStore(actor);
  if ( store.file || getPending(actor).length ) return false;
  const view = await loadView(actor);
  return !view.generation && !view.entries.length;
}

async function maybePromptOnOpen(actor) {
  if ( game.user.isGM || (setting("promptMode") !== "open") || prompted.has(actor.uuid) ) return;
  prompted.add(actor.uuid);
  if ( await shouldPrompt(actor) ) GenerationApp.open(actor);
}

export async function promptOnCreate(actor, userId) {
  if ( (userId !== game.user.id) || (setting("promptMode") === "never") ) return;
  prompted.add(actor.uuid);
  if ( await shouldPrompt(actor) ) setTimeout(() => GenerationApp.open(actor), 300);
}

function onRenderSheet(app, element) {
  const el = element instanceof HTMLElement ? element : element?.[0];
  if ( !el || el.classList.contains("tidy5e-sheet") ) return;
  const actor = app.actor ?? app.document;
  if ( !isCharacter(actor) ) return;
  maybePromptOnOpen(actor);
  const root = el.querySelector(`[data-application-part="${TAB_ID}"] .kg-pch-root`)
    ?? el.querySelector(`.tab[data-tab="${TAB_ID}"] .kg-pch-root`);
  if ( root ) renderWhenVisible(root, actor, app.id);
}

/* -------------------------------------------- */
/*  Tidy 5e                                     */
/* -------------------------------------------- */

export function registerTidy() {
  Hooks.once("tidy5e-sheet.ready", api => {
    try {
      api.registerCharacterTab(new api.models.HtmlTab({
        title: "History",
        tabId: TAB_ID,
        iconClass: "fa-solid fa-scroll",
        html: "<div class=\"kg-pch-root kg-pch-tidy\"></div>",
        enabled: context => canSeeHistory(context?.actor ?? context?.document),
        onRender: params => {
          const actor = params.app?.actor ?? params.app?.document ?? params.data?.actor;
          if ( !isCharacter(actor) ) return;
          const root = params.tabContentsElement?.querySelector?.(".kg-pch-root")
            ?? params.element?.querySelector?.(".kg-pch-root.kg-pch-tidy");
          if ( root ) renderWhenVisible(root, actor, params.app?.id);
        }
      }), { layout: "all" });
    } catch(err) {
      console.error("kg-pc-history | Could not register the Tidy 5e tab", err);
    }
  });
  // Tidy sheets still get the open-sheet prompt.
  Hooks.on("renderActorSheetV2", (app, element) => {
    const el = element instanceof HTMLElement ? element : element?.[0];
    if ( !el?.classList.contains("tidy5e-sheet") ) return;
    const actor = app.actor ?? app.document;
    if ( isCharacter(actor) ) maybePromptOnOpen(actor);
  });
}

export function registerSheetHooks() {
  Hooks.on("renderCharacterActorSheet", onRenderSheet);
  Hooks.on("closeActorSheetV2", app => releaseSheet(app.id));
}
