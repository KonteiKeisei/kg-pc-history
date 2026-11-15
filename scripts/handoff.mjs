import { MODULE_ID, isCharacter, setting } from "./util.mjs";
import { SOCKET } from "./store.mjs";
import { markPrompted, shouldPrompt } from "./tab.mjs";
import { GenerationApp } from "./apps/generation-app.mjs";

/*
 * A character the GM makes is not prompted on the GM's screen. When the GM gives a player ownership of it, the ability
 * score window opens for that player, and the GM gets a read-only live copy of it.
 */

/** Players (not GMs) with owner rights set for them by name. The "all players" default does not count. */
function playerOwners(actor) {
  const owner = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
  return Object.entries(actor.ownership ?? {})
    .filter(([id, level]) => (id !== "default") && (level >= owner) && (game.users.get(id)?.isGM === false))
    .map(([id]) => id);
}

/** GM: ask these players for the character's scores, if it still needs them. */
async function offer(actor, userIds) {
  if ( !userIds.length || (setting("promptMode") === "never") ) return;
  if ( !(await shouldPrompt(actor, { given: true })) ) return;
  GenerationApp.dismissed.delete(actor.id);
  const away = [];
  for ( const id of userIds ) {
    const user = game.users.get(id);
    if ( user?.active ) game.socket.emit(SOCKET, { type: "genOffer", actorUuid: actor.uuid, userId: id });
    else if ( user ) away.push(user.name);
  }
  if ( away.length ) {
    ui.notifications.info(`KG PC History: ${away.join(", ")} ${away.length === 1 ? "is" : "are"} offline. `
      + `The ability score window opens when they next open ${actor.name}.`);
  }
}

/** The server passes the sender's id as the second argument: that, not the message, says who sent it. */
async function onMessage(msg, senderId) {
  if ( msg?.type === "genOffer" ) {
    const gm = game.users.get(senderId);
    if ( !gm?.isGM || game.user.isGM || (msg.userId !== game.user.id) ) return;
    const actor = await fromUuid(msg.actorUuid).catch(() => null);
    if ( !isCharacter(actor) ) return;
    // The ownership change and this message travel separately; give the change a moment to arrive.
    if ( !actor.isOwner ) await new Promise(r => setTimeout(r, 500));
    if ( !(await shouldPrompt(actor, { given: true })) ) return;
    markPrompted(actor);
    GenerationApp.open(actor, { watcher: gm.id });
    return;
  }
  if ( msg?.type === "genState" ) {
    if ( !game.user.isGM || (msg.to !== game.user.id) ) return;
    const player = game.users.get(senderId);
    const actor = await fromUuid(msg.actorUuid).catch(() => null);
    if ( !player || !isCharacter(actor) || !actor.testUserPermission(player, "OWNER") ) return;
    GenerationApp.mirror(actor, player, { state: msg.state, closed: !!msg.closed });
  }
}

/** GM: a character this GM just made, possibly with a player already set as its owner. */
export function offerOnCreate(actor, userId) {
  if ( !game.user.isGM || (userId !== game.user.id) || !isCharacter(actor) ) return;
  offer(actor, playerOwners(actor));
}

export function registerHandoff() {
  game.socket.on(SOCKET, onMessage);

  // Mark characters the GM makes, so their player is asked on open even if they were offline when given it.
  Hooks.on("preCreateActor", (actor, data, options, userId) => {
    if ( game.user.isGM && (userId === game.user.id) && isCharacter(actor) ) {
      actor.updateSource({ [`flags.${MODULE_ID}.askPlayer`]: true });
    }
  });

  // Core's ownership window saves with noHook (no preUpdateActor) and replaces the whole ownership object, so neither
  // the hook nor the change says who owned the character before. GM clients keep that themselves.
  Hooks.once("ready", () => {
    if ( !game.user.isGM ) return;
    for ( const actor of game.actors ) if ( isCharacter(actor) ) owners.set(actor.id, playerOwners(actor));
  });
  Hooks.on("createActor", actor => {
    if ( game.user.isGM && isCharacter(actor) ) owners.set(actor.id, playerOwners(actor));
  });
  Hooks.on("deleteActor", actor => owners.delete(actor.id));
  Hooks.on("updateActor", (actor, changes, options, userId) => {
    if ( !game.user.isGM || !("ownership" in changes) || !isCharacter(actor) ) return;
    const before = new Set(owners.get(actor.id) ?? []);
    const now = playerOwners(actor);
    owners.set(actor.id, now);
    // Only the GM who made the change offers it, so two GMs online do not both send it.
    if ( userId === game.user.id ) offer(actor, now.filter(id => !before.has(id)));
  });
}

/** GM clients: actor id to the players who own it, as last seen. */
const owners = new Map();
