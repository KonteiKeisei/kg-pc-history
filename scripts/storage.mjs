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

/**
 * The character's own history file. Lowercase, because some servers lowercase uploaded file names: on a case-sensitive
 * file system a mixed-case path would then never find the file it just wrote. Files from earlier versions keep their
 * mixed-case name and are still read through the link, then rewritten here on the next save.
 */
export function fileName(actor) {
  return `${actor.id.toLowerCase()}.json`;
}

export function canonicalPath(actor) {
  return `${historyDir()}/${fileName(actor)}`;
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
export async function loadData(actor, { fresh=false }={}) {
  const s = getStore(actor);
  // The character's own file comes first, whatever the link says. The link can be lost or point elsewhere (Import
  // Data replaces the whole actor, flags included), and treating that as "no history" would overwrite the real file
  // on the next save. The linked file is the fallback: a copied character reads its original's history once, before
  // it gets its own file.
  const own = canonicalPath(actor);
  const paths = [...new Set([own, s.file].filter(Boolean))];
  const rev = Number(s.rev) || 0;
  const key = `${paths.join("|")}@${rev}`;
  if ( !fresh ) {
    const hit = cache.get(actor.uuid);
    if ( hit?.key === key ) return hit.data;
    if ( inflight.has(key) ) return inflight.get(key);
  }

  const promise = (async () => {
    let data = null;
    let failed = false;
    for ( const path of paths ) {
      try {
        // Writers read past the browser cache, so a stale copy is never the base of a new save.
        const res = await fetch(`${foundry.utils.getRoute(path)}?rev=${rev}`, fresh ? { cache: "no-cache" } : undefined);
        if ( res.ok ) {
          data = await res.json();
          if ( s.file && (path.toLowerCase() !== s.file.toLowerCase()) ) {
            warn(`${actor.name}'s history link pointed elsewhere; using ${path}.`);
          }
          break;
        }
        // Only an unreadable *linked* file stops a save. The character's own file is probed even with no link, and
        // a host may answer a missing file with something other than 404, so for the probe any refusal means "none".
        if ( (res.status !== 404) && (path === s.file) ) {
          failed = true;
          break;
        }
      } catch(err) {
        failed = true;
        warn(`Could not read ${path}`, err);
        break;
      }
    }
    data = normalize(data, actor);
    if ( failed ) data._loadError = true;
    else cache.set(actor.uuid, { key, data });
    return data;
  })().finally(() => { if ( inflight.get(key) === promise ) inflight.delete(key); });
  if ( !fresh ) inflight.set(key, promise);
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
  // Past both the link's revision and the file's own: an imported actor can carry an older revision, and reusing a
  // number other clients have already cached would leave them showing the old history.
  const rev = Math.max(Number(getStore(actor).rev) || 0, Number(data?.rev) || 0) + 1;
  const path = canonicalPath(actor);
  const out = { ...data };
  delete out._loadError;
  Object.assign(out, {
    version: 1, actorId: actor.id, actorName: actor.name, world: game.world.id, rev, updated: Date.now()
  });
  const file = new File([JSON.stringify(out)], fileName(actor), { type: "application/json" });
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
