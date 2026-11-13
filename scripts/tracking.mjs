import { MODULE_ID, advancementTitle, charLevelFor, isCharacter, setting, validClassOrder } from "./util.mjs";
import { describeAtom, diffSnapshots, snapshot } from "./snapshot.mjs";
import { makeEntry, reportResults, submit } from "./store.mjs";

/*
 * Advancement tracking.
 *
 * dnd5e's AdvancementManager works on a clone of the actor. Right before it saves, it fires
 * dnd5e.preAdvancementManagerComplete with the manager, whose `actor` is still untouched and whose `clone` holds the
 * finished result. Diffing the two gives every real change (scores, proficiencies, languages, items, class levels).
 * Each step's advancement says what it granted (its stored `value`), which names the source: the class, subclass,
 * background, species or feat, the advancement, and the level. Changes no step claims are still recorded.
 */

const TRACKED_SYSTEM = ["abilities", "skills", "tools", "traits"];
const TRACKED_ITEM_TYPES = new Set(["class", "subclass", "background", "race", "feat"]);
const FIXED_LEVEL_TYPES = new Set(["class", "subclass", "race", "background"]);
const managerEntries = new WeakMap();

/**
 * Actors an AdvancementManager is saving right now. Their updates and item changes belong to the advancement record,
 * so manual tracking ignores them even if the save does not carry the isAdvancement option.
 */
const advancing = new Map();

function markAdvancing(actor) {
  clearTimeout(advancing.get(actor.uuid));
  advancing.set(actor.uuid, setTimeout(() => advancing.delete(actor.uuid), 15000));
}

function unmarkAdvancing(actor) {
  setTimeout(() => {
    clearTimeout(advancing.get(actor.uuid));
    advancing.delete(actor.uuid);
  }, 0);
}

function safe(fn) {
  try { return fn(); } catch(err) { return null; }
}

function traitKey(chosen, mastery) {
  const parts = String(chosen).split(":");
  if ( parts.length < 2 ) return null;
  const id = parts.at(-1);
  if ( id === "*" ) return null;
  return mastery ? `mastery:${id}` : `${parts[0]}:${id}`;
}

function traitTarget(mode) {
  return ["expertise", "forcedExpertise"].includes(mode) ? 2 : 1;
}

function scaleDisplay(v) {
  if ( (v === null) || (v === undefined) ) return "";
  const out = v.display ?? v.formula ?? v.value ?? v;
  return (typeof out === "object") ? "" : String(out);
}

/**
 * What one advancement granted at one level, as "protos": { key, via, delta?, to?, removed?, standalone? }.
 * Keys match snapshot keys. Standalone protos (hit points, scale values) have no snapshot counterpart.
 */
export function advancementProtos(adv, level) {
  const value = adv.value ?? {};
  const via = advancementTitle(adv);
  const out = [];
  switch ( adv.type ) {
    case "AbilityScoreImprovement":
      for ( const [a, n] of Object.entries(value.assignments ?? {}) ) {
        if ( Number(n) ) out.push({ key: `ability:${a}`, delta: Number(n), via });
      }
      for ( const id of Object.keys(value.feat ?? {}) ) out.push({ key: `item:${id}`, via: `${via} (feat)` });
      break;
    case "Trait": {
      const mode = adv.configuration?.mode;
      for ( const c of value.chosen ?? [] ) {
        const key = traitKey(c, mode === "mastery");
        if ( key ) out.push({ key, via, to: traitTarget(mode) });
      }
      break;
    }
    case "ItemGrant":
      for ( const id of Object.keys(value.added ?? {}) ) out.push({ key: `item:${id}`, via });
      break;
    case "ItemChoice": {
      for ( const id of Object.keys(value.added?.[level] ?? {}) ) out.push({ key: `item:${id}`, via });
      const rep = value.replaced?.[level];
      if ( rep?.original ) out.push({ key: `item:${rep.original}`, via: `${via} (replaced)`, removed: true });
      break;
    }
    case "Subclass":
      if ( value.document ) out.push({ key: `item:${value.document}`, via });
      break;
    case "Size":
      if ( value.size ) out.push({ key: "size", via, to: value.size });
      break;
    case "HitPoints": {
      const hp = Number(safe(() => adv.valueForLevel(level)));
      if ( !hp ) break;
      const raw = value[level];
      const die = safe(() => adv.hitDie) ?? "";
      const how = raw === "max" ? `maximum on ${die}` : (raw === "avg" ? `average of ${die}` : `rolled ${raw} on ${die}`);
      out.push({
        standalone: true, key: `hp:${adv.item?.id}:${level}`, category: "hp", delta: hp, via,
        label: `Hit points +${hp}`, detail: `${how}, plus Constitution modifier`
      });
      break;
    }
    case "ScaleValue": {
      const now = scaleDisplay(safe(() => adv.valueForLevel(level)));
      const prev = level > 0 ? scaleDisplay(safe(() => adv.valueForLevel(level - 1))) : "";
      if ( now && (now !== prev) ) {
        out.push({
          standalone: true, key: `scale:${adv.id}:${level}`, category: "scale", via,
          label: `${via}: ${now}`, detail: prev ? `${prev} → ${now}` : ""
        });
      }
      break;
    }
  }
  return out;
}

function sourceFor(step, via) {
  const item = step.item;
  const classLevel = ["class", "subclass"].includes(item.type) ? step.level : null;
  return { name: item.name, type: item.type, id: item.id, classLevel, via };
}

/** A stand-in atom for rebuilt history, where there is no before and after to compare. */
function pseudoAtom(p, snap) {
  if ( p.key.startsWith("item:") ) {
    const it = snap.items[p.key.slice(5)] ?? { name: "An item no longer on the character", type: "" };
    return { key: p.key, added: !p.removed, removed: !!p.removed, item: it };
  }
  if ( p.key === "size" ) return { key: "size", from: null, to: p.to };
  return { key: p.key, to: p.to ?? 1 };
}

/**
 * Turn advancement steps (and, when tracking live, the before/after atoms) into history entries.
 * @param {{adv, item, level}[]} steps
 * @param {object} ctx  { mode: "live"|"rebuild", atoms, before, after, newItemIds, singleClass }
 */
export function buildEntries(steps, ctx) {
  const { mode, atoms=[], before=null, after, newItemIds=new Set(), singleClass=true, order=null } = ctx;
  const live = mode === "live";
  for ( const s of steps ) s.protos = advancementProtos(s.adv, s.level);

  // Class anchor: which class level an entry belongs to. Lets the History tab tag cards with their class, and lets a
  // GM-set class order move rebuilt entries to their real character level later.
  const parentLevel = new Map();
  const parentAnchor = new Map();
  const anchorOf = s => {
    const t = s.item.type;
    if ( t === "class" ) return { classId: s.item.id, className: s.item.name, classLevel: s.level };
    if ( t === "subclass" ) {
      const cls = s.item.class;
      return cls ? { classId: cls.id, className: cls.name, classLevel: s.level } : null;
    }
    return parentAnchor.get(s.item.id) ?? null;
  };

  // Character level for each step. Class steps carry a class level; items granted by a step inherit its level.
  const levelOf = s => {
    const t = s.item.type;
    if ( (t === "class") || (t === "subclass") ) {
      if ( !live ) {
        const at = order ? charLevelFor(order, s.anchor?.classId, s.level) : null;
        return at ?? s.level;
      }
      const cls = (t === "class") ? s.item : s.item.class;
      const classLevels = Number(cls?.system?.levels ?? s.level);
      return Math.max(0, after.level - (classLevels - s.level));
    }
    if ( FIXED_LEVEL_TYPES.has(t) ) return s.level;
    if ( parentLevel.has(s.item.id) ) return parentLevel.get(s.item.id);
    if ( live && newItemIds.has(s.item.id) ) return after.level;
    return s.level;
  };
  let pending = [...steps];
  for ( let pass = 0; (pass < 4) && pending.length; pass++ ) {
    const rest = [];
    for ( const s of pending ) {
      const ready = FIXED_LEVEL_TYPES.has(s.item.type) || parentLevel.has(s.item.id) || (pass === 3);
      if ( !ready ) {
        rest.push(s);
        continue;
      }
      s.anchor = anchorOf(s);
      s.charLevel = levelOf(s);
      for ( const p of s.protos ) {
        if ( p.removed || !p.key.startsWith("item:") ) continue;
        const id = p.key.slice(5);
        if ( !parentLevel.has(id) ) {
          parentLevel.set(id, s.charLevel);
          if ( s.anchor ) parentAnchor.set(id, s.anchor);
        }
      }
    }
    if ( rest.length === pending.length ) pass = Math.max(pass, 2);
    pending = rest;
  }

  const ordered = steps.slice().sort((a, b) => (a.charLevel - b.charLevel));
  const atomBy = new Map(atoms.map(a => [a.key, a]));
  const used = new Set();
  const running = { ...(before?.abilities ?? {}) };
  const claimed = {};
  const entries = [];

  for ( const s of ordered ) {
    for ( const p of s.protos ) {
      const base = {
        level: s.charLevel,
        source: sourceFor(s, p.via),
        origin: live ? "advancement" : "reconstructed"
      };
      if ( s.anchor ) base.anchor = s.anchor;
      if ( !live && !singleClass && !order && s.anchor ) base.levelApprox = true;

      if ( p.standalone ) {
        entries.push(makeEntry({ ...base, key: p.key, category: p.category, label: p.label, detail: p.detail, delta: p.delta ?? null }));
        continue;
      }
      if ( p.key.startsWith("ability:") ) {
        const a = p.key.slice(8);
        let atom = { key: p.key, delta: p.delta };
        if ( live ) {
          if ( !atomBy.has(p.key) ) continue;
          atom = { key: p.key, from: running[a], to: running[a] + p.delta, delta: p.delta };
          running[a] = atom.to;
          claimed[a] = (claimed[a] ?? 0) + p.delta;
        }
        entries.push(makeEntry({ ...base, ...describeAtom(atom) }));
        continue;
      }
      if ( live ) {
        const atom = atomBy.get(p.key);
        if ( !atom || used.has(p.key) ) continue;
        used.add(p.key);
        entries.push(makeEntry({ ...base, ...describeAtom(atom) }));
      }
      else {
        // A record pointing at an item id the character no longer has (copied or re-imported) says nothing; the
        // item itself, under its new id, is matched to its grant later.
        if ( p.key.startsWith("item:") && !p.removed && !after.items[p.key.slice(5)] ) continue;
        entries.push(makeEntry({ ...base, ...describeAtom(pseudoAtom(p, after)) }));
      }
    }
  }

  // Live: whatever no step claimed (the class or background item itself, class levels, leftovers).
  if ( live ) {
    for ( const atom of atoms ) {
      if ( atom.key.startsWith("ability:") ) {
        const a = atom.key.slice(8);
        const rest = atom.delta - (claimed[a] ?? 0);
        if ( !rest ) continue;
        entries.push(makeEntry({
          level: after.level, origin: "advancement", source: null,
          ...describeAtom({ key: atom.key, from: atom.to - rest, to: atom.to, delta: rest })
        }));
        continue;
      }
      if ( used.has(atom.key) ) continue;
      let level = atom.removed ? before.level : after.level;
      let anchor = null;
      const it = atom.item;
      if ( atom.key.startsWith("classLevel:") && !atom.removed && (Number(atom.to) > Number(atom.from)) ) {
        anchor = { classId: it.id, className: it.name, classLevel: Number(atom.to) };
      }
      else if ( atom.added && (it?.type === "class") ) {
        // A class added with several levels at once started at the first of them.
        level = Math.max(1, after.level - ((Number(it.levels) || 1) - 1));
        anchor = { classId: it.id, className: it.name, classLevel: 1 };
      }
      entries.push(makeEntry({ level, origin: "advancement", source: null, ...(anchor ? { anchor } : {}), ...describeAtom(atom) }));
    }
  }
  entries.sort((a, b) => (a.level ?? 999) - (b.level ?? 999));
  return entries;
}

/* -------------------------------------------- */
/*  Live advancement                            */
/* -------------------------------------------- */

function onPreComplete(manager, updates) {
  // dnd5e saves the clone's whole flags object with recursive: false, which replaces the actor's flags rather than
  // merging into them. The clone's copy of our flag may be stale (the revision can change while the advancement window
  // is open), and leaving it out would delete it. So the save carries the actor's current value instead.
  if ( updates?.flags ) {
    const current = manager.actor?._source?.flags?.[MODULE_ID];
    if ( current ) updates.flags[MODULE_ID] = foundry.utils.deepClone(current);
    else delete updates.flags[MODULE_ID];
  }
  if ( manager.actor ) markAdvancing(manager.actor);
  try {
    const actor = manager.actor;
    if ( !isCharacter(actor) || actor.isToken || !setting("trackAdvancement") ) return;
    // Read the raw source data directly; snapshot never mutates it, so nothing is copied.
    const before = snapshot(actor._source);
    const after = snapshot(manager.clone._source);
    const atoms = diffSnapshots(before, after);
    const steps = [];
    for ( const step of manager.steps ?? [] ) {
      if ( !["forward", "restore"].includes(step.type) ) continue;
      const flow = step.flow;
      const adv = flow?.advancement;
      const item = adv?.item ?? flow?.item;
      if ( !adv || !item ) continue;
      steps.push({ adv, item, level: Number(flow.level ?? adv.level ?? 0) });
    }
    const newItemIds = new Set(Object.keys(after.items).filter(id => !before.items[id]));
    const entries = buildEntries(steps, { mode: "live", atoms, before, after, newItemIds });
    if ( entries.length ) managerEntries.set(manager, entries);
  } catch(err) {
    console.error(`${MODULE_ID} | Could not record advancement`, err);
  }
}

function onComplete(manager) {
  if ( manager.actor ) unmarkAdvancing(manager.actor);
  const entries = managerEntries.get(manager);
  if ( !entries?.length ) return;
  managerEntries.delete(manager);
  const batch = foundry.utils.randomID();
  const ts = Date.now();
  entries.forEach((e, i) => Object.assign(e, { batch, ts, seq: i }));
  submit(manager.actor, [{ type: "append", entries }]).then(reportResults);
}

/* -------------------------------------------- */
/*  Manual changes                              */
/* -------------------------------------------- */

const manualQueue = new Map();
const itemQueue = new Map();

function editSource(user, via) {
  return { name: user?.name ?? "", type: "user", via };
}

function onPreUpdateActor(actor, changes, options, userId) {
  if ( !isCharacter(actor) || actor.isToken || advancing.has(actor.uuid) ) return;
  if ( options.isAdvancement || options.kgPcHistory || !setting("trackManual") ) return;
  const sys = changes.system;
  if ( !sys ) return;
  // Only the four tracked branches are read, and only those are copied: never the whole actor or its items.
  const changed = TRACKED_SYSTEM.filter(k => sys[k] !== undefined);
  if ( !changed.length ) return;
  const current = actor._source.system;
  const afterSystem = { ...current };
  for ( const k of changed ) {
    afterSystem[k] = foundry.utils.mergeObject(foundry.utils.deepClone(current[k] ?? {}), foundry.utils.deepClone(sys[k]),
      { performDeletions: true });
  }
  const atoms = diffSnapshots(snapshot({ system: current }), snapshot({ system: afterSystem }));
  if ( !atoms.length ) return;
  const level = Number(actor.system?.details?.level) || 0;
  const user = game.users.get(userId) ?? game.user;
  const via = user.isGM ? "GM edit on the sheet" : "Edited on the sheet";
  const entries = atoms.map((a, i) => makeEntry({
    ...describeAtom(a), level, origin: "manual", user: user.id, seq: i, source: editSource(user, via)
  }));
  manualQueue.set(actor.uuid, [...(manualQueue.get(actor.uuid) ?? []), ...entries]);
}

function onUpdateActor(actor, changes, options, userId) {
  if ( userId !== game.user.id ) return;
  const entries = manualQueue.get(actor.uuid);
  if ( !entries?.length ) return;
  manualQueue.delete(actor.uuid);
  submit(actor, [{ type: "append", entries }]).then(reportResults);
}

function queueItemEntry(actor, entry) {
  let q = itemQueue.get(actor.uuid);
  if ( !q ) itemQueue.set(actor.uuid, q = { actor, entries: [], timer: null });
  q.entries.push(entry);
  clearTimeout(q.timer);
  q.timer = setTimeout(() => {
    itemQueue.delete(actor.uuid);
    q.entries.forEach((e, i) => e.seq = i);
    submit(q.actor, [{ type: "append", entries: q.entries }]).then(reportResults);
  }, 150);
}

function onItemChange(item, options, userId, removed) {
  if ( userId !== game.user.id ) return;
  const actor = item.parent;
  if ( !isCharacter(actor) || actor.isToken || advancing.has(actor.uuid) ) return;
  if ( options.isAdvancement || options.kgPcHistory || !setting("trackManual") ) return;
  if ( !TRACKED_ITEM_TYPES.has(item.type) ) return;
  if ( item.getFlag?.("dnd5e", "advancementOrigin") ) return;
  const it = { name: item.name, type: item.type, subtype: item.system?.type?.value ?? "" };
  const user = game.users.get(userId) ?? game.user;
  queueItemEntry(actor, makeEntry({
    ...describeAtom({ key: `item:${item.id}`, added: !removed, removed, item: it }),
    level: actor.system?.details?.level ?? 0, origin: "manual", user: user.id,
    source: editSource(user, removed ? "Removed on the sheet" : "Added on the sheet")
  }));
}

/* -------------------------------------------- */
/*  Rebuild (legacy characters)                 */
/* -------------------------------------------- */

/** "Fighter 3" in a feature's requirements: the class it belongs to (if on the actor) and the class level. */
function requirementAnchor(item, classes) {
  const m = String(item.system?.requirements ?? "").trim().match(/^(.*?)\s*(\d+)$/);
  if ( !m ) return { classLevel: null, cls: null };
  const name = m[1].trim().toLowerCase();
  const cls = classes.find(c => c.name.toLowerCase() === name) ?? (classes.length === 1 ? classes[0] : null);
  return { classLevel: Number(m[2]), cls };
}

/**
 * Grants an advancement already filled: its record maps item id to source uuid. Only ids still on the character count;
 * a copied or re-imported character can keep records that point at item ids it no longer has.
 */
function takenUuids(actor, added) {
  return new Set(Object.entries(added ?? {}).filter(([id]) => actor.items.has(id)).map(([, uuid]) => uuid));
}

/** Lowercase, trimmed, without a trailing "(...)", so "Wild Shape (Druid)" matches "Wild Shape". */
function nameKey(name) {
  return String(name ?? "").replace(/\s*\([^)]*\)\s*$/, "").trim().toLowerCase();
}

/**
 * Every feature the character's class, subclass, species and background advancements are set up to grant, at the level
 * they grant it. Imported or hand-built characters often have the features without the advancement recording that it
 * granted them; matching against these slots puts them at the right level anyway.
 * Names come from compendium indexes (fromUuidSync), which are already in memory, so nothing is fetched.
 */
function grantSlots(actor, at) {
  const slots = [];
  for ( const item of actor.items ) {
    if ( !FIXED_LEVEL_TYPES.has(item.type) ) continue;
    slots.push(...slotsFrom(item, item, actor, at));
  }
  return slots;
}

/**
 * Grant slots read from `reader`'s advancements, credited to `owner` (the character's own class, subclass, species or
 * background). Usually both are the same item; for a reference class from a compendium, `reader` is that copy.
 */
function slotsFrom(reader, owner, actor, at, via=null) {
  const slots = [];
  const cls = (owner.type === "class") ? owner : (owner.type === "subclass" ? owner.class : null);
  if ( (owner.type === "subclass") && !cls ) return slots;
  const cap = cls ? Number(cls.system?.levels ?? 0) : Infinity;
  for ( const adv of Object.values(reader.advancement?.byId ?? {}) ) {
    let pool;
    let levels;
    let taken;
    if ( adv.type === "ItemGrant" ) {
      pool = adv.configuration?.items ?? [];
      levels = [Number(adv.level)];
      taken = takenUuids(actor, adv.value?.added);
    }
    else if ( adv.type === "ItemChoice" ) {
      // A choice made through advancement is already linked; only levels with picks left over can hold a stray feature.
      const added = adv.value?.added ?? {};
      const choices = adv.configuration?.choices ?? {};
      pool = adv.configuration?.pool ?? [];
      levels = Object.keys(choices).map(Number).sort((a, b) => a - b)
        .filter(L => Object.keys(added[L] ?? {}).filter(id => actor.items.has(id)).length < (Number(choices[L]?.count) || 0));
      taken = new Set(Object.values(added).flatMap(o => [...takenUuids(actor, o)]));
    }
    else continue;
    levels = levels.filter(L => Number.isFinite(L) && (L <= cap));
    if ( !levels.length ) continue;
    for ( const entry of pool ) {
      const uuid = (typeof entry === "string") ? entry : entry?.uuid;
      if ( !uuid || taken.has(uuid) ) continue;
      const name = safe(() => fromUuidSync(uuid, { strict: false })?.name);
      const anchor = cls ? { classId: cls.id, className: cls.name, classLevel: levels[0] } : null;
      slots.push({
        uuid, name: nameKey(name), used: false, anchor, ref: !!via,
        level: cls ? at(cls.id, levels[0]) : levels[0],
        source: {
          name: owner.name, type: owner.type, id: owner.id, classLevel: cls ? levels[0] : null,
          via: via ? `${advancementTitle(adv)}, ${via}` : advancementTitle(adv)
        }
      });
    }
  }
  return slots;
}

/**
 * Characters moved between worlds often lose their class's feature grants: the class item is there, but nothing on it
 * says Wild Shape comes at level 2. For each class and subclass on the character, look for one with the same name in
 * the world's Item compendiums and read the levels from its grants instead. Of several candidates, the one whose grants
 * name the most of the character's unplaced features wins. Only runs when features are left over, and only loads the
 * few same-named classes from the in-memory indexes.
 * @returns {Promise<{slots: object[], subclassLevel: Map<string, number>}>}
 */
async function referenceSlots(actor, at, wanted) {
  const slots = [];
  const subclassLevel = new Map();
  const owners = actor.items.filter(i => (i.type === "class") || ((i.type === "subclass") && i.class));
  for ( const owner of owners ) {
    const key = nameKey(owner.name);
    const candidates = [];
    for ( const pack of game.packs ) {
      if ( pack.documentName !== "Item" ) continue;
      for ( const e of pack.index ) {
        if ( (e.type === owner.type) && (nameKey(e.name) === key) ) candidates.push({ pack, id: e._id });
      }
    }
    let best = null;
    for ( const { pack, id } of candidates.slice(0, 8) ) {
      const doc = await safeAsync(() => pack.getDocument(id));
      if ( !doc ) continue;
      const found = slotsFrom(doc, owner, actor, at, `from ${doc.name} in ${pack.title}`);
      const score = found.filter(s => wanted.has(s.name)).length;
      if ( !best || (score > best.score) ) best = { doc, found, score };
    }
    if ( !best ) continue;
    if ( best.score ) slots.push(...best.found);
    if ( owner.type === "class" ) {
      const L = Number(Object.values(best.doc.advancement?.byId ?? {}).find(a => a.type === "Subclass")?.level);
      if ( Number.isFinite(L) ) subclassLevel.set(owner.id, L);
    }
  }
  return { slots, subclassLevel };
}

async function safeAsync(fn) {
  try { return await fn(); } catch(err) { return null; }
}

/**
 * The grant slot each feature came from: by compendium source first (for every feature), then by name, lowest level
 * first. Each slot is used once, so two features with the same name land on two different grants.
 * @returns {Map<string, object>} item id to slot
 */
function matchGrants(items, slots) {
  const out = new Map();
  slots.sort((a, b) => a.level - b.level);
  for ( const item of items ) {
    const src = item._stats?.compendiumSource ?? item.flags?.core?.sourceId ?? null;
    const slot = src && slots.find(s => !s.used && (s.uuid === src));
    if ( slot ) {
      slot.used = true;
      out.set(item.id, slot);
    }
  }
  for ( const item of items ) {
    if ( out.has(item.id) ) continue;
    const name = nameKey(item.name);
    const slot = name && slots.find(s => !s.used && (s.name === name));
    if ( slot ) {
      slot.used = true;
      out.set(item.id, slot);
    }
  }
  return out;
}

/**
 * Rebuild a history from what dnd5e already stores on a character's items: every advancement keeps its choices
 * (ability score improvements, feats, proficiencies, granted features, hit points). Items no advancement accounts
 * for are added too, placed by their requirements ("Fighter 3") when possible. dnd5e does not record the order
 * classes were taken in, so a multiclass character needs a class order (set by the GM) for exact levels; without one,
 * entries sit at their class level and are flagged as approximate.
 */
export async function rebuildEntries(actor, { order=null }={}) {
  const snap = snapshot(actor._source);
  const classes = actor.items.filter(i => i.type === "class");
  const singleClass = classes.length <= 1;
  if ( order && !validClassOrder(actor, order) ) order = null;
  const at = (classId, classLevel) => (order ? charLevelFor(order, classId, classLevel) : null) ?? classLevel;
  const approx = !singleClass && !order;
  const steps = [];
  for ( const item of actor.items ) {
    let cap = snap.level;
    if ( item.type === "class" ) cap = Number(item.system?.levels ?? 0);
    else if ( item.type === "subclass" ) cap = Number(item.class?.system?.levels ?? 0);
    for ( const adv of Object.values(item.advancement?.byId ?? {}) ) {
      const levels = adv.levels ?? [adv.level];
      for ( const L of levels ) {
        const n = Number(L);
        if ( Number.isFinite(n) && (n <= cap) ) steps.push({ adv, item, level: n });
      }
    }
  }
  const entries = buildEntries(steps, { mode: "rebuild", after: snap, singleClass, order });
  const referenced = new Set(entries.filter(e => e.key?.startsWith("item:")).map(e => e.key.slice(5)));

  for ( const cls of classes ) {
    const levels = Number(cls.system?.levels ?? 0);
    for ( let L = 1; L <= levels; L++ ) {
      const anchor = { classId: cls.id, className: cls.name, classLevel: L };
      entries.push(makeEntry({
        ...describeAtom({ key: `classLevel:${cls.id}`, from: L - 1, to: L, item: snap.items[cls.id] }),
        level: at(cls.id, L), origin: "reconstructed", levelApprox: approx, anchor,
        source: { name: cls.name, type: "class", id: cls.id, classLevel: L }
      }));
    }
    referenced.add(cls.id);
  }
  const unlinked = actor.items.filter(i => TRACKED_ITEM_TYPES.has(i.type) && !referenced.has(i.id));
  const feats = unlinked.filter(i => i.type === "feat");
  const matched = matchGrants(feats, grantSlots(actor, at));

  // Features the character's own items could not place: try same-named classes and subclasses from the compendiums.
  const leftover = feats.filter(i => !matched.has(i.id));
  let subclassLevel = new Map();
  if ( leftover.length ) {
    const ref = await referenceSlots(actor, at, new Set(leftover.map(i => nameKey(i.name))));
    subclassLevel = ref.subclassLevel;
    for ( const [id, slot] of matchGrants(leftover, ref.slots) ) matched.set(id, slot);
  }

  // Species and background features say what they are (system.type), which is enough to put them at level 0.
  const originOf = { race: actor.items.filter(i => i.type === "race"), background: actor.items.filter(i => i.type === "background") };

  for ( const item of unlinked ) {
    let level = null;
    let anchor = null;
    const slot = matched.get(item.id);
    if ( slot ) {
      entries.push(makeEntry({
        ...describeAtom({ key: `item:${item.id}`, added: true, item: snap.items[item.id] }),
        level: slot.level, origin: "reconstructed", source: slot.source, ...(slot.anchor ? { anchor: slot.anchor } : {}),
        levelApprox: !!slot.anchor && approx
      }));
      continue;
    }
    const kind = item.system?.type?.value;
    if ( (item.type === "feat") && originOf[kind] ) {
      const owner = (originOf[kind].length === 1) ? originOf[kind][0] : null;
      entries.push(makeEntry({
        ...describeAtom({ key: `item:${item.id}`, added: true, item: snap.items[item.id] }),
        level: 0, origin: "reconstructed",
        source: owner ? { name: owner.name, type: owner.type, id: owner.id, classLevel: null, via: "Feature type" } : null
      }));
      continue;
    }
    if ( ["race", "background"].includes(item.type) ) level = 0;
    else if ( (item.type === "subclass") && item.class ) {
      // A subclass the class's Subclass advancement did not record: it was still taken at that advancement's level
      // (or, when the class has lost its advancements, at the level a same-named compendium class gives).
      const cls = item.class;
      const L = Number(Object.values(cls.advancement?.byId ?? {}).find(a => a.type === "Subclass")?.level
        ?? subclassLevel.get(cls.id));
      if ( Number.isFinite(L) ) {
        anchor = { classId: cls.id, className: cls.name, classLevel: L };
        level = at(cls.id, L);
      }
    }
    else if ( item.type === "feat" ) {
      const req = requirementAnchor(item, classes);
      if ( req.cls ) {
        anchor = { classId: req.cls.id, className: req.cls.name, classLevel: req.classLevel };
        level = at(req.cls.id, req.classLevel);
      }
      else level = req.classLevel;
    }
    entries.push(makeEntry({
      ...describeAtom({ key: `item:${item.id}`, added: true, item: snap.items[item.id] }),
      level, origin: "reconstructed", source: null, ...(anchor ? { anchor } : {}),
      levelApprox: (level !== null) && approx
    }));
  }
  const ts = Date.now();
  const batch = foundry.utils.randomID();
  entries.sort((a, b) => (a.level ?? 999) - (b.level ?? 999));
  entries.forEach((e, i) => Object.assign(e, { ts, batch, seq: i }));
  return entries;
}

/* -------------------------------------------- */

export function registerTracking() {
  Hooks.on("dnd5e.preAdvancementManagerComplete", onPreComplete);
  Hooks.on("dnd5e.advancementManagerComplete", onComplete);
  Hooks.on("preUpdateActor", onPreUpdateActor);
  Hooks.on("updateActor", onUpdateActor);
  Hooks.on("createItem", (item, options, userId) => onItemChange(item, options, userId, false));
  Hooks.on("deleteItem", (item, options, userId) => onItemChange(item, options, userId, true));
}
