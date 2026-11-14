import { MODULE_ID, isCharacter } from "./util.mjs";
import { askSetupOnce, registerSettings } from "./settings.mjs";
import { registerTracking, rebuildEntries } from "./tracking.mjs";
import { adoptCopiedHistory, flushAllPending, loadView, makeEntry, registerStore, submit } from "./store.mjs";
import { patchCoreSheet, promptOnCreate, registerSheetHooks, registerTidy } from "./tab.mjs";
import { GenerationApp } from "./apps/generation-app.mjs";

// Tidy fires its ready hook during its own setup; listen before anything else runs.
registerTidy();

Hooks.once("init", () => {
  registerSettings();
  registerTracking();
  registerSheetHooks();
  if ( !patchCoreSheet() ) Hooks.once("setup", patchCoreSheet);
});

Hooks.once("setup", () => {
  registerStore();
});

Hooks.once("ready", () => {
  flushAllPending();
  askSetupOnce();
  game.modules.get(MODULE_ID).api = {
    /** The history as this client sees it: { generation, entries, ... }. */
    getHistory: actor => loadView(actor),
    /** Open the ability score window for an actor. */
    openGeneration: actor => GenerationApp.open(actor),
    /** Append entries (objects with label, category, level, detail, source, note). */
    addEntries: (actor, entries) => submit(actor, [{ type: "append", entries: (entries ?? []).map(e => makeEntry(e)) }]),
    /** GM: entries rebuilt from a character's stored advancements, without saving them. */
    rebuildEntries
  };
});

Hooks.on("createActor", (actor, options, userId) => {
  if ( !isCharacter(actor) ) return;
  adoptCopiedHistory(actor);
  promptOnCreate(actor, userId);
});
