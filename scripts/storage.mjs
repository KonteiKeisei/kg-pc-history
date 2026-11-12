import { MODULE_ID, warn } from "./util.mjs";

/*
 * History lives in one JSON file per character: worlds/<world>/pc-history/<actorId>.json.
 * The actor carries a single small flag, flags.kg-pc-history.store = { file, rev, pending? }.
 *
 *  - Reads are lazy (only when a History tab or the generation window needs them), deduplicated while in flight,
 *    and cached in memory by revision. The URL carries ?rev=N, so the browser cache is valid per revision too.
 *  - Writes happen only on the active GM's client (players usually cannot upload files), are serialized per actor,
 *    and bump `rev` so every other client knows its cached copy is stale.
 *  - `pending` holds operations made while no GM was online. The GM's client folds them into the file on login.
 */

const cache = new Map();      // actor uuid -> { key, data }
const inflight = new Map();   // cache key -> Promise<data>
let dirReady = null;

export function historyDir() {
  return `worlds/${game.world.id}/pc-history`;
}

export function canonicalPath(actor) {
  return `${historyDir()}/${actor.id}.json`;
}

export function getStore(actor) {
  const s = actor?.getFlag?.(MODULE_ID, "store");
  return (s && (typeof s === "object")) ? s : {};
}

export function getPending(actor) {
  const p = getStore(actor).pending;
  return Array.isArray(p) ? p : [];
}

export function emptyData(actor) {
  return { version: 1, actorId: actor?.id ?? null, actorName: actor?.name ?? "", generation: null, entries: [], applied: [] };
}

function normalize(data, actor) {
  const out = (data && (typeof data === "object")) ? data : emptyData(actor);
  if ( !Array.isArray(out.entries) ) out.entries = [];
  if ( !Array.isArray(out.applied) ) out.applied = [];
  if ( out.generation && (typeof out.generation !== "object") ) out.generation = null;
  out.generation ??= null;
  return out;
}

function filePicker() {
  return foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
}

/**
 * The stored history for an actor (without pending operations). Treat the result as read-only: it is the cached copy.
 * A file that exists but cannot be read comes back with `_loadError` set and is not cached, so the GM never
 * overwrites real history with an empty file after a network hiccup.
 */
export async function loadData(actor) {
  const s = getStore(actor);
  if ( !s.file ) return emptyData(actor);
  const key = `${s.file}@${Number(s.rev) || 0}`;
  const hit = cache.get(actor.uuid);
  if ( hit?.key === key ) return hit.data;
  if ( inflight.has(key) ) return inflight.get(key);

  const promise = (async () => {
    let data = null;
    let failed = false;
    try {
      const res = await fetch(`${foundry.utils.getRoute(s.file)}?rev=${Number(s.rev) || 0}`);
      if ( res.ok ) data = await res.json();
      else if ( res.status !== 404 ) failed = true;
      else warn(`History file ${s.file} for ${actor.name} is missing; starting a new one.`);
    } catch(err) {
      failed = true;
      warn(`Could not read ${s.file}`, err);
    }
    data = normalize(data, actor);
    if ( failed ) data._loadError = true;
    else cache.set(actor.uuid, { key, data });
    return data;
  })().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

async function ensureDir() {
  dirReady ??= (async () => {
    const FP = filePicker();
    const dir = historyDir();
    try {
      await FP.browse("data", dir);
      return;
    } catch(err) { /* does not exist yet */ }
    try {
      await FP.createDirectory("data", dir, {});
    } catch(err) {
      if ( !/EEXIST|exist/i.test(String(err?.message ?? err)) ) throw err;
    }
  })().catch(err => {
    dirReady = null;
    throw err;
  });
  return dirReady;
}

/**
 * Write an actor's history file and bump the revision on the actor in the same update as `actorUpdates`.
 * GM only. Callers serialize per actor.
 */
export async function writeData(actor, data, actorUpdates={}) {
  await ensureDir();
  const FP = filePicker();
  const rev = (Number(getStore(actor).rev) || 0) + 1;
  const path = canonicalPath(actor);
  const out = { ...data };
  delete out._loadError;
  Object.assign(out, {
    version: 1, actorId: actor.id, actorName: actor.name, world: game.world.id, rev, updated: Date.now()
  });
  const file = new File([JSON.stringify(out)], `${actor.id}.json`, { type: "application/json" });
  const res = await FP.upload("data", historyDir(), file, {}, { notify: false });
  if ( !res || (res.status && (res.status !== "success")) ) {
    throw new Error(res?.message ?? `Could not write ${path}`);
  }
  cache.set(actor.uuid, { key: `${path}@${rev}`, data: out });
  await actor.update({
    ...actorUpdates,
    [`flags.${MODULE_ID}.store.file`]: path,
    [`flags.${MODULE_ID}.store.rev`]: rev
  }, { kgPcHistory: true });
  return out;
}

export function forget(actor) {
  cache.delete(actor.uuid);
}
