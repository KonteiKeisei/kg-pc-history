import { ABILITIES, MODULE_ID, abilityAbbr, charLevelFor, isCharacter, warn } from "./util.mjs";
import { getPending, getStore, loadData, writeData } from "./storage.mjs";
import {
  MODE_LABELS, POINT_BUY_MAX, POINT_BUY_MIN, STANDARD_ARRAY, allowedModes, allowedRollMethods,
  existingBonuses, getMethod, keptSets, methodLabel, pointBuyBudget, pointBuySpent, postRollCard, rerollState, rollSets
} from "./methods.mjs";

/*
 * Every change to a history file is an operation: { id, ts, user, type, ...payload }.
 * `applyOp` is the one reducer for all of them. The GM's client runs it strictly (invalid operations are refused)
 * before writing the file; other clients run it leniently to preview operations still waiting in `pending`.
 * Applied operation ids are remembered in the file, so an operation that arrives twice (socket and pending) is
 * applied once.
 */

const SOCKET = `module.${MODULE_ID}`;
const GM_ONLY = new Set(["updateEntry", "deleteEntry", "deleteEntries", "rekeyEntries", "placeEntries", "setGeneration", "resetGeneration", "setClassOrder"]);
const APPLIED_CAP = 400;
const REQUEST_TIMEOUT = 15000;
const FLUSH_DELAY = 120;

/* -------------------------------------------- */
/*  Entries                                     */
/* -------------------------------------------- */

export function makeEntry(data={}) {
  return {
    id: foundry.utils.randomID(),
    ts: Date.now(),
    batch: null,
    level: 0,
    category: "other",
    label: "",
    detail: "",
    key: null,
    delta: null,
    source: null,
    origin: "advancement",
    user: game.user?.id ?? null,
    note: "",
    ...data
  };
}

/** Entries a person made or touched: GM entries, notes, the generation record, and anything the GM edited. */
function isKept(e) {
  return !!e.editedBy || (e.origin === "gm") || ["note", "generation"].includes(e.category);
}

/**
 * What Rebuild's "Start over" removes: every entry the module recorded on its own (live level-ups, sheet edits, earlier
 * rebuilds), so the history is rebuilt from the character as it is now. A swapped class or species leaves entries for
 * features that were granted and then deleted, and its undo steps carry no source, so nothing short of this cleans it.
 * GM entries, notes, the generation record and anything the GM edited stay.
 */
export function startOverIds(entries) {
  return entries.filter(e => !isKept(e)).map(e => e.id);
}

/**
 * Kept entries that point at an item the character no longer has (a GM-placed feature whose item was later swapped for
 * a new copy) are re-pointed at the current item of the same name, so a rebuild sees them as recorded.
 * @param {object[]} entries  the entries that stay
 * @param {{id: string, name: string}[]} items  the character's items
 * @returns {{entryId: string, key: string}[]}
 */
export function rekeyPlan(entries, items) {
  const ids = new Set(items.map(i => i.id));
  const claimed = new Set(entries.map(e => e.key).filter(k => String(k).startsWith("item:") && ids.has(k.slice(5))));
  const out = [];
  for ( const e of entries ) {
    const [t, id] = String(e.key ?? "").split(":");
    if ( (t !== "item") || ids.has(id) || e.removed ) continue;
    const name = String(e.label ?? "").split(": ").slice(1).join(": ").trim().toLowerCase();
    const match = name && items.find(i => !claimed.has(`item:${i.id}`) && (String(i.name).trim().toLowerCase() === name));
    if ( !match ) continue;
    claimed.add(`item:${match.id}`);
    out.push({ entryId: e.id, key: `item:${match.id}` });
  }
  return out;
}

/**
 * What a rebuild adds against `existing`: fresh entries not already recorded, and earlier unplaced rebuilt entries to
 * move to the level this rebuild found (instead of adding a duplicate). An item is gained once, so an item recorded as
 * added at any level counts as recorded (a GM may have moved it), as does anything this rebuild cannot place.
 */
export function rebuildPlan(fresh, existing) {
  const unplaced = new Map(existing
    .filter(e => e.key && (e.origin === "reconstructed") && ((e.level === null) || (e.level === undefined)))
    .map(e => [e.key, e]));
  const places = [];
  const placedKeys = new Set();
  for ( const e of fresh ) {
    const old = unplaced.get(e.key);
    if ( !old || (e.level === null) || (e.level === undefined) || placedKeys.has(e.key) ) continue;
    places.push({ entryId: old.id, level: e.level, source: e.source, anchor: e.anchor ?? null, levelApprox: !!e.levelApprox });
    placedKeys.add(e.key);
  }
  const have = new Set(existing.map(e => `${e.key}|${e.level ?? ""}`));
  const anyLevel = new Set(existing.filter(e => !e.removed).map(e => e.key));
  const recorded = e => have.has(`${e.key}|${e.level ?? ""}`)
    || (anyLevel.has(e.key) && (String(e.key).startsWith("item:") || (e.level === null) || (e.level === undefined)));
  const entries = fresh.filter(e => !e.key || (!recorded(e) && !placedKeys.has(e.key)));
  return { entries, places };
}

const EDITABLE =["label", "detail", "category", "level", "note", "source"];

function entryPatch(data={}) {
  const out = {};
  for ( const k of EDITABLE ) if ( k in data ) out[k] = data[k];
  if ( "level" in out ) out.level = (out.level === null) || (out.level === "") ? null : Number(out.level);
  return out;
}

/* -------------------------------------------- */
/*  Generation validation                       */
/* -------------------------------------------- */

function checkRolled(gen, op, isGM) {
  const method = getMethod(op.methodId);
  if ( !method ) return "Unknown rolling method.";
  if ( !isGM && !allowedModes().roll && !op.reroll ) return "Rolling is not allowed in this world.";
  if ( !isGM && !op.reroll && !allowedRollMethods().some(m => m.id === method.id) ) return "That rolling method is not allowed.";
  if ( gen?.status === "final" ) return "Ability scores are already recorded. The GM can reset them from the History tab.";
  if ( op.reroll ) {
    if ( gen?.status !== "rolling" ) return "There is no roll to reroll.";
    if ( method.id !== gen.methodId ) return "A reroll must use the same method.";
    if ( !rerollState(gen, isGM).canReroll ) return "No rerolls left.";
  }
  else if ( gen && !isGM ) return "Ability scores were already rolled for this character.";
  return null;
}

function sameNumbers(a, b) {
  const x = [...a].map(Number).sort((p, q) => p - q);
  const y = [...b].map(Number).sort((p, q) => p - q);
  return (x.length === y.length) && x.every((v, i) => v === y[i]);
}

function checkFinal(gen, op, isGM) {
  if ( gen?.status === "final" ) return "Ability scores are already recorded.";
  const base = op.base ?? {};
  for ( const a of ABILITIES ) {
    const v = Number(base[a]);
    if ( !Number.isInteger(v) || (v < 1) || (v > 30) ) return `Invalid score for ${abilityAbbr(a)}.`;
  }
  const values = ABILITIES.map(a => Number(base[a]));
  const modes = allowedModes();
  switch ( op.mode ) {
    case "roll": {
      if ( gen?.status !== "rolling" ) return "Roll the scores first.";
      const kept = keptSets(gen);
      if ( !sameNumbers(values, kept.map(s => s.total)) ) return "The scores do not match the roll.";
      if ( getMethod(gen.methodId)?.inOrder && kept.some((s, i) => s.total !== values[i]) ) {
        return "This method assigns the scores in the order rolled.";
      }
      return null;
    }
    case "pointBuy":
      if ( gen?.status === "rolling" && !isGM ) return "These scores were rolled; assign the rolled scores.";
      if ( !isGM && !modes.pointBuy ) return "Point buy is not allowed in this world.";
      if ( values.some(v => (v < POINT_BUY_MIN) || (v > POINT_BUY_MAX)) ) return `Point buy scores must be ${POINT_BUY_MIN} to ${POINT_BUY_MAX}.`;
      if ( pointBuySpent(base) > pointBuyBudget() ) return "That spends more points than the budget.";
      return null;
    case "standardArray":
      if ( gen?.status === "rolling" && !isGM ) return "These scores were rolled; assign the rolled scores.";
      if ( !isGM && !modes.standardArray ) return "The standard array is not allowed in this world.";
      if ( !sameNumbers(values, STANDARD_ARRAY) ) return "Use each standard array value once.";
      return null;
    case "manual":
      return isGM ? null : "Only the GM can set scores directly.";
    default:
      return "Unknown generation method.";
  }
}

function generationSummary(base) {
  return ABILITIES.map(a => `${abilityAbbr(a)} ${base[a]}`).join(", ");
}

/* -------------------------------------------- */
/*  Reducer                                     */
/* -------------------------------------------- */

/**
 * Apply one operation to history data in place. Returns true when it changed something.
 * With `strict`, an invalid operation throws; otherwise it is skipped.
 */
export function applyOp(data, op, { isGM=false, strict=false }={}) {
  if ( !op?.id || data.applied.includes(op.id) ) return false;
  const refuse = msg => {
    if ( strict ) throw new Error(msg);
    return false;
  };
  if ( GM_ONLY.has(op.type) && !isGM ) return refuse("Only the GM can do that.");

  switch ( op.type ) {
    case "append": {
      const have = new Set(data.entries.map(e => e.id));
      for ( const e of op.entries ?? [] ) {
        if ( !e?.id || have.has(e.id) ) continue;
        data.entries.push(e);
        have.add(e.id);
      }
      break;
    }
    case "updateEntry": {
      const entry = data.entries.find(e => e.id === op.entryId);
      if ( !entry ) return refuse("That entry no longer exists.");
      Object.assign(entry, entryPatch(op.data), { editedBy: op.user, editedAt: op.ts });
      break;
    }
    case "deleteEntry":
      data.entries = data.entries.filter(e => e.id !== op.entryId);
      break;
    case "deleteEntries": {
      const ids = new Set(op.entryIds ?? []);
      data.entries = data.entries.filter(e => !ids.has(e.id));
      break;
    }
    case "rekeyEntries":
      for ( const r of op.rekeys ?? [] ) {
        const entry = data.entries.find(e => e.id === r.entryId);
        if ( entry && String(r.key).startsWith("item:") ) entry.key = r.key;
      }
      break;
    case "placeEntries":
      // Rebuild found where earlier rebuilt entries with no level belong. Only those are moved.
      for ( const p of op.places ?? [] ) {
        const entry = data.entries.find(e => e.id === p.entryId);
        if ( !entry || (entry.level !== null && entry.level !== undefined) || (entry.origin !== "reconstructed") ) continue;
        entry.level = Number(p.level);
        if ( p.source ) entry.source = p.source;
        if ( p.anchor ) entry.anchor = p.anchor;
        entry.levelApprox = !!p.levelApprox;
      }
      break;
    case "rolled": {
      const gen = data.generation;
      const err = checkRolled(gen, op, isGM);
      if ( err ) return refuse(err);
      const method = getMethod(op.methodId);
      if ( !Array.isArray(op.sets) || (op.sets.length !== method.count) ) return refuse("The roll is incomplete.");
      if ( op.reroll ) {
        const state = rerollState(gen, isGM);
        gen.discarded = [...(gen.discarded ?? []), {
          sets: gen.sets, dropped: gen.dropped, ts: gen.rolledAt, verified: gen.verified !== false, free: state.free
        }];
        if ( !isGM && !state.free ) gen.rerollsUsed = (Number(gen.rerollsUsed) || 0) + 1;
        Object.assign(gen, {
          sets: op.sets, dropped: op.dropped ?? null, rolledAt: op.ts,
          verified: (gen.verified !== false) && (op.verified !== false)
        });
      }
      else {
        data.generation = {
          status: "rolling", mode: "roll", methodId: method.id, methodLabel: method.label,
          sets: op.sets, dropped: op.dropped ?? null, discarded: [], rerollsUsed: 0,
          verified: op.verified !== false, rolledBy: op.user, rolledAt: op.ts
        };
      }
      break;
    }
    case "finalize": {
      const gen = data.generation;
      const err = checkFinal(gen, op, isGM);
      if ( err ) return refuse(err);
      const base = Object.fromEntries(ABILITIES.map(a => [a, Number(op.base[a])]));
      const next = {
        ...(op.mode === "roll" ? gen : {}),
        status: "final",
        mode: op.mode,
        base,
        bonuses: op.bonuses ?? {},
        assignIndex: op.assignIndex ?? null,
        finalizedBy: op.user,
        finalizedAt: op.ts,
        verified: (gen?.verified !== false) && !op.offline
      };
      if ( op.mode === "pointBuy" ) Object.assign(next, { budget: pointBuyBudget(), pointsSpent: pointBuySpent(base) });
      next.methodLabel = (op.mode === "roll") ? gen.methodLabel : MODE_LABELS[op.mode];
      data.generation = next;
      data.entries.push(makeEntry({
        id: `gen${op.id}`, ts: op.ts, user: op.user, level: 0, category: "generation", origin: "generation",
        label: `Ability scores generated: ${methodLabel(next)}`,
        detail: generationSummary(base),
        source: { name: methodLabel(next), type: "generation" }
      }));
      break;
    }
    case "setGeneration":
      if ( op.generation?.inferred ) {
        // Rebuild's guess from the sheet: only fills an empty record, never replaces one.
        if ( data.generation ) return refuse("This character already has a generation record.");
        data.generation = { ...op.generation, finalizedBy: op.user, finalizedAt: op.ts };
        data.entries.push(makeEntry({
          ts: op.ts, user: op.user, level: 0, category: "generation", origin: "reconstructed",
          label: `Ability scores inferred from the sheet: ${methodLabel(data.generation)}`,
          detail: generationSummary(op.generation.base ?? {}),
          source: { name: methodLabel(data.generation), type: "generation" }
        }));
        break;
      }
      data.generation = op.generation ? { ...op.generation, editedBy: op.user, editedAt: op.ts } : null;
      data.entries.push(makeEntry({
        ts: op.ts, user: op.user, level: 0, category: "generation", origin: "gm",
        label: "Ability generation record edited by the GM",
        detail: op.generation?.base ? generationSummary(op.generation.base) : ""
      }));
      break;
    case "resetGeneration":
      if ( data.generation ) data.generation = null;
      data.entries.push(makeEntry({
        ts: op.ts, user: op.user, level: 0, category: "generation", origin: "gm",
        label: "Ability generation reset by the GM", note: op.note ?? ""
      }));
      break;
    case "setClassOrder": {
      // Move entries whose level was a guess (rebuilt, or flagged approximate) to the level the order gives them.
      if ( !Array.isArray(op.order) || !op.order.length ) return refuse("The class order is empty.");
      data.classOrder = op.order.map(String);
      for ( const e of data.entries ) {
        if ( !e.anchor?.classId || !(e.levelApprox || (e.origin === "reconstructed")) ) continue;
        const level = charLevelFor(data.classOrder, e.anchor.classId, e.anchor.classLevel);
        if ( level === null ) continue;
        e.level = level;
        delete e.levelApprox;
      }
      break;
    }
    default:
      return refuse(`Unknown operation "${op.type}".`);
  }
  data.applied.push(op.id);
  if ( data.applied.length > APPLIED_CAP ) data.applied.splice(0, data.applied.length - APPLIED_CAP);
  return true;
}

/* -------------------------------------------- */
/*  Reading                                     */
/* -------------------------------------------- */

/** History as this client should show it: the file plus any operations still waiting for a GM. */
export async function loadView(actor) {
  const data = await loadData(actor);
  const pending = getPending(actor);
  if ( !pending.length ) return data;
  const view = foundry.utils.deepClone(data);
  for ( const op of pending ) {
    try {
      applyOp(view, op, { isGM: !!game.users.get(op.user)?.isGM });
    } catch(err) { /* lenient */ }
  }
  view.pendingCount = pending.length;
  return view;
}

/* -------------------------------------------- */
/*  Writing                                     */
/* -------------------------------------------- */

export function activeGM() {
  const gm = game.users.activeGM;
  if ( gm !== undefined ) return gm;
  return game.users.filter(u => u.isGM && u.active).sort((a, b) => a.id.localeCompare(b.id))[0] ?? null;
}

export function isActiveGM() {
  return activeGM()?.id === game.user.id;
}

/**
 * Submit operations for an actor. Resolves to one result per operation: { ok, error?, generation? }.
 * The active GM writes directly; other users ask the active GM over the socket; with no GM online, operations go
 * into the actor's pending queue.
 */
export async function submit(actor, ops) {
  if ( !actor || !isCharacter(actor) || actor.isToken ) return ops.map(() => ({ ok: false, error: "Not a character." }));
  const full = ops.map(o => ({ id: foundry.utils.randomID(), ts: Date.now(), user: game.user.id, ...o }));
  const gm = activeGM();
  if ( gm?.id === game.user.id ) return Promise.all(full.map(op => enqueueGM(actor, op, "local")));
  if ( gm ) {
    try {
      return await requestGM(actor, full);
    } catch(err) {
      warn("The GM did not answer; queuing the change on the actor.", err);
    }
  }
  return queuePending(actor, full);
}

/** Report failed results to the user. Returns true when everything succeeded. */
export function reportResults(results) {
  const failed = results.filter(r => !r?.ok);
  for ( const r of failed ) ui.notifications.warn(`PC History: ${r?.error ?? "The change was not saved."}`);
  return failed.length === 0;
}

/* GM queue: operations for one actor that arrive close together are written in one file write. */

const gmQueues = new Map();
const locks = new Map();
const queuedPending = new Set();

function withLock(key, fn) {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  locks.set(key, run.catch(() => {}));
  return run;
}

function enqueueGM(actor, op, source) {
  return new Promise(resolve => {
    let q = gmQueues.get(actor.uuid);
    if ( !q ) gmQueues.set(actor.uuid, q = { actor, items: [], timer: null });
    q.items.push({ op, source, resolve });
    clearTimeout(q.timer);
    q.timer = setTimeout(() => flushGM(actor.uuid), FLUSH_DELAY);
  });
}

async function prepareOp(actor, op, source) {
  const user = game.users.get(op.user);
  const isGM = !!user?.isGM;
  const result = { op: foundry.utils.deepClone(op), updates: {}, after: [] };
  if ( (op.type === "rolled") && (source === "socket") && !isGM ) throw new Error("Rolls are made on the GM's client.");
  if ( (op.type === "rolled") && (source === "pending") ) result.op.verified = false;
  if ( op.type === "roll" ) {
    const res = await rollSets(op.methodId);
    Object.assign(result.op, { type: "rolled", sets: res.sets, dropped: res.dropped, verified: true });
    result.after.push(() => postRollCard(actor, res.method, res.sets, res.dropped, res.rolls, { reroll: !!op.reroll }));
  }
  if ( (op.type === "finalize") && !op.selfApplied ) {
    const bonuses = existingBonuses(actor);
    result.op.bonuses = bonuses;
    for ( const a of ABILITIES ) result.updates[`system.abilities.${a}.value`] = Number(op.base?.[a]) + (bonuses[a] || 0);
  }
  return { ...result, isGM };
}

async function flushGM(uuid) {
  const q = gmQueues.get(uuid);
  gmQueues.delete(uuid);
  if ( !q?.items.length ) return;
  await withLock(uuid, async () => {
    const actor = q.actor;
    const finish = r => q.items.forEach(it => it.resolve(typeof r === "function" ? r(it) : r));
    let data;
    try {
      data = foundry.utils.deepClone(await loadData(actor));
      if ( data._loadError ) throw new Error("The history file could not be read, so nothing was written. Try again.");
    } catch(err) {
      finish({ ok: false, error: err.message });
      return;
    }

    const results = new Map();
    const actorUpdates = {};
    const after = [];
    let changed = false;
    for ( const it of q.items ) {
      try {
        const prepared = await prepareOp(actor, it.op, it.source);
        changed = applyOp(data, prepared.op, { isGM: prepared.isGM, strict: true }) || changed;
        Object.assign(actorUpdates, prepared.updates);
        after.push(...prepared.after);
        results.set(it, { ok: true });
      } catch(err) {
        results.set(it, { ok: false, error: err.message });
        if ( it.source === "pending" ) {
          data.entries.push(makeEntry({
            ts: it.op.ts, user: it.op.user, level: null, category: "note", origin: "gm",
            label: "A change queued while no GM was online was refused", detail: err.message
          }));
          changed = true;
        }
      }
    }

    const fromPending = q.items.filter(it => it.source === "pending").map(it => it.op.id);
    if ( fromPending.length ) {
      actorUpdates[`flags.${MODULE_ID}.store.pending`] = getPending(actor).filter(o => !fromPending.includes(o.id));
      fromPending.forEach(id => queuedPending.delete(id));
    }

    try {
      if ( changed ) await writeData(actor, data, actorUpdates);
      else if ( Object.keys(actorUpdates).length ) await actor.update(actorUpdates, { kgPcHistory: true });
    } catch(err) {
      console.error(`${MODULE_ID} | Could not save history for ${actor.name}`, err);
      ui.notifications.error(`PC History: could not save the history file for ${actor.name}. ${err.message}`);
      finish({ ok: false, error: err.message });
      return;
    }
    for ( const fn of after ) {
      try { await fn(); } catch(err) { console.error(err); }
    }
    finish(it => ({ ...results.get(it), generation: data.generation }));
  });
}

/* Socket */

const waiters = new Map();

function requestGM(actor, ops) {
  return new Promise((resolve, reject) => {
    const requestId = foundry.utils.randomID();
    const timer = setTimeout(() => {
      waiters.delete(requestId);
      reject(new Error("timeout"));
    }, REQUEST_TIMEOUT);
    waiters.set(requestId, results => {
      clearTimeout(timer);
      waiters.delete(requestId);
      resolve(results);
    });
    game.socket.emit(SOCKET, { type: "request", requestId, userId: game.user.id, actorUuid: actor.uuid, ops });
  });
}

async function onSocket(msg) {
  if ( msg?.type === "response" ) {
    if ( msg.userId === game.user.id ) waiters.get(msg.requestId)?.(msg.results);
    return;
  }
  if ( (msg?.type !== "request") || !isActiveGM() ) return;
  const user = game.users.get(msg.userId);
  const actor = await fromUuid(msg.actorUuid).catch(() => null);
  let results;
  if ( !user || !actor || !isCharacter(actor) || !actor.testUserPermission(user, "OWNER") ) {
    results = (msg.ops ?? []).map(() => ({ ok: false, error: "You do not own that character." }));
  }
  else results = await Promise.all((msg.ops ?? []).map(op => enqueueGM(actor, { ...op, user: user.id }, "socket")));
  game.socket.emit(SOCKET, { type: "response", requestId: msg.requestId, userId: msg.userId, results });
}

/* Pending queue (no GM online) */

async function queuePending(actor, ops) {
  const preview = foundry.utils.deepClone(await loadView(actor));
  const accepted = [];
  const results = [];
  const abilityUpdates = {};
  const after = [];
  for ( let op of ops ) {
    try {
      if ( GM_ONLY.has(op.type) ) throw new Error("A GM must be online for that.");
      if ( op.type === "roll" ) {
        const err = checkRolled(preview.generation, op, game.user.isGM);
        if ( err ) throw new Error(err);
        const res = await rollSets(op.methodId);
        op = { ...op, type: "rolled", sets: res.sets, dropped: res.dropped, verified: false };
        after.push(() => postRollCard(actor, res.method, res.sets, res.dropped, res.rolls, { reroll: !!op.reroll, verified: false }));
      }
      if ( op.type === "finalize" ) {
        const bonuses = existingBonuses(actor);
        op = { ...op, bonuses, selfApplied: true, offline: true };
        for ( const a of ABILITIES ) abilityUpdates[`system.abilities.${a}.value`] = Number(op.base?.[a]) + (bonuses[a] || 0);
      }
      applyOp(preview, op, { isGM: game.user.isGM, strict: true });
      accepted.push(op);
      results.push({ ok: true });
    } catch(err) {
      results.push({ ok: false, error: err.message });
    }
  }
  if ( accepted.length ) {
    await actor.update({
      ...abilityUpdates,
      [`flags.${MODULE_ID}.store.pending`]: [...getPending(actor), ...accepted]
    }, { kgPcHistory: true });
    for ( const fn of after ) await fn();
  }
  return results.map(r => ({ ...r, generation: preview.generation }));
}

/** Active GM: fold an actor's pending operations into its file. */
export function flushPending(actor) {
  if ( !isActiveGM() || !isCharacter(actor) ) return;
  for ( const op of getPending(actor) ) {
    if ( queuedPending.has(op.id) ) continue;
    queuedPending.add(op.id);
    enqueueGM(actor, op, "pending");
  }
}

/* -------------------------------------------- */
/*  Guard                                       */
/* -------------------------------------------- */

/**
 * preUpdateActor, on the client making the change. Players may only add to `pending`. Anything else under this
 * module's flag (the file link, the revision, removing queued operations, deleting the flag) is stripped from the
 * update, without blocking the rest of it.
 */
export function guardUpdate(actor, changes) {
  if ( game.user.isGM || !changes?.flags ) return;
  const keys = Object.keys(changes.flags).filter(k => k.includes(MODULE_ID));
  if ( !keys.length ) return;
  let ok = (keys.length === 1) && (keys[0] === MODULE_ID);
  const ns = changes.flags[MODULE_ID];
  if ( ok ) ok = !!ns && (typeof ns === "object") && Object.keys(ns).every(k => k === "store");
  const st = ok ? ns.store : null;
  if ( ok ) ok = !!st && (typeof st === "object");
  if ( ok ) {
    const current = getStore(actor);
    for ( const [k, v] of Object.entries(st) ) {
      if ( k === "pending" ) {
        const prev = Array.isArray(current.pending) ? current.pending : [];
        ok = Array.isArray(v) && prev.every(p => v.some(n => n?.id === p.id));
      }
      else ok = (v === current[k]);
      if ( !ok ) break;
    }
  }
  if ( ok ) return;
  for ( const k of keys ) delete changes.flags[k];
  if ( foundry.utils.isEmpty(changes.flags) ) delete changes.flags;
  ui.notifications.warn("PC History: only the GM can change or remove a character's recorded history.");
}

/* -------------------------------------------- */
/*  Setup                                       */
/* -------------------------------------------- */

export function registerStore() {
  game.socket.on(SOCKET, onSocket);
  Hooks.on("updateActor", (actor, changes) => {
    if ( foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.store.pending`) ) flushPending(actor);
  });
  Hooks.on("preUpdateActor", (actor, changes) => {
    if ( isCharacter(actor) ) guardUpdate(actor, changes);
  });
}

/** On the active GM's login: merge anything players queued while no GM was online. */
export function flushAllPending() {
  if ( !isActiveGM() ) return;
  for ( const actor of game.actors ?? [] ) if ( getPending(actor).length ) flushPending(actor);
}

/**
 * Active GM: when an actor is created as a copy of another (duplicate, or a re-import into this world), give it its
 * own history file with the same contents, so the two characters never write to one file.
 */
export async function adoptCopiedHistory(actor) {
  if ( !isActiveGM() || !isCharacter(actor) ) return;
  const s = getStore(actor);
  if ( !s.file || s.file.endsWith(`/${actor.id}.json`) ) return;
  await withLock(actor.uuid, async () => {
    const data = foundry.utils.deepClone(await loadData(actor));
    if ( data._loadError ) return;
    data.copiedFrom = s.file;
    await writeData(actor, data);
  });
}

export { getStore, getPending };
