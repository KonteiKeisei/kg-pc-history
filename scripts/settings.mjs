import { MODULE_ID, refreshCharacterSheets } from "./util.mjs";
import { defaultRollConfig } from "./methods.mjs";
import { RollingConfig } from "./apps/rolling-config.mjs";

const NEEDS = "Needs Ability Score Generation on.";
const METHOD_KEYS = ["allowPointBuy", "allowStandardArray", "allowRolling"];

export function registerSettings() {
  game.settings.registerMenu(MODULE_ID, "rollingMethods", {
    name: "Rolling Methods",
    label: "Choose Rolling Methods",
    hint: "Which dice methods players may use when Allow Rolling is on, how many times they may reroll a full set, and who sees the rolls.",
    icon: "fa-solid fa-dice",
    type: RollingConfig,
    restricted: true
  });
  game.settings.register(MODULE_ID, "rollingConfig", {
    scope: "world", config: false, type: Object, default: defaultRollConfig()
  });

  // Ability score generation is an optional extra, off until the GM turns it on: another module may already roll or
  // assign ability scores, and two creation prompts would collide. The ability score record, the breakdown and the
  // inferred scores on Rebuild work either way.
  game.settings.register(MODULE_ID, "setupAsked", {
    scope: "world", config: false, type: Boolean, default: false
  });
  game.settings.register(MODULE_ID, "enableGeneration", {
    name: "Ability Score Generation",
    hint: "Players generate their ability scores in this module (point buy, standard array or rolling), and new characters "
      + "are asked for them. Off by default because it can conflict with other modules that roll ability scores. The "
      + "History tab and the ability score record work either way.",
    scope: "world", config: true, type: Boolean, default: false,
    onChange: () => refreshCharacterSheets()
  });
  game.settings.register(MODULE_ID, "allowPointBuy", {
    name: "Allow Point Buy",
    hint: `Players may buy their scores with points (8 to 15 before bonuses). ${NEEDS}`,
    scope: "world", config: true, type: Boolean, default: true
  });
  game.settings.register(MODULE_ID, "pointBuyBudget", {
    name: "Point Buy Budget",
    hint: "Points to spend. The 5e standard is 27.",
    scope: "world", config: true, type: Number, default: 27,
    range: { min: 1, max: 60, step: 1 }
  });
  game.settings.register(MODULE_ID, "allowStandardArray", {
    name: "Allow Standard Array",
    hint: `Players may assign 15, 14, 13, 12, 10 and 8. ${NEEDS}`,
    scope: "world", config: true, type: Boolean, default: true
  });
  game.settings.register(MODULE_ID, "allowRolling", {
    name: "Allow Rolling",
    hint: "Players may roll their scores with any of the methods chosen under Rolling Methods. Rolls are made on the "
      + `GM's client and cannot be undone by the player. ${NEEDS}`,
    scope: "world", config: true, type: Boolean, default: true
  });
  game.settings.register(MODULE_ID, "promptMode", {
    name: "Ask for Ability Scores",
    hint: "When to open the ability score window for a new character (level 1 or lower, with no scores recorded yet). "
      + "For a character the GM makes, the window opens for the player the GM gives ownership to, and the GM sees a "
      + `live copy. It can always be opened from the History tab. ${NEEDS}`,
    scope: "world", config: true, type: String, default: "open",
    choices: {
      create: "When the character is created or given to a player",
      open: "As above, and when its player first opens it",
      never: "Never (use the History tab)"
    }
  });
  game.settings.register(MODULE_ID, "trackAdvancement", {
    name: "Record Advancement",
    hint: "Record what each level up, species, background, class and feat changed, and where it came from.",
    scope: "world", config: true, type: Boolean, default: true
  });
  game.settings.register(MODULE_ID, "trackManual", {
    name: "Record Manual Changes",
    hint: "Also record ability scores, proficiencies and languages changed by hand on the sheet, and features, feats and classes added or removed outside advancement.",
    scope: "world", config: true, type: Boolean, default: true
  });
  game.settings.register(MODULE_ID, "playersSeeHistory", {
    name: "Players See the History Tab",
    hint: "When off, only the GM sees the History tab.",
    scope: "world", config: true, type: Boolean, default: true,
    onChange: () => refreshCharacterSheets()
  });
}

/** Has this world setting ever been saved, as opposed to falling back to its default? */
function isStored(key) {
  return !!game.settings.storage.get("world")?.getSetting(`${MODULE_ID}.${key}`);
}

/**
 * Once per world, the first time a GM loads it: ask whether to turn on ability score generation. Either answer is
 * remembered, and it stays changeable in the module settings.
 *
 * Worlds set up before the main switch existed were asked about the methods instead. They keep what they chose: the
 * switch is turned on if any method was turned on, without asking again, and methods they never turned on stay off.
 */
export async function askSetupOnce() {
  if ( !game.user.isGM ) return;
  const gm = game.users.activeGM;
  if ( gm && (gm.id !== game.user.id) ) return;
  if ( isStored("enableGeneration") ) return;
  if ( game.settings.get(MODULE_ID, "setupAsked") ) {
    const wasOn = METHOD_KEYS.some(k => isStored(k) && game.settings.get(MODULE_ID, k));
    // The methods used to default to off and now default to on. Keep the ones this world never turned on off.
    if ( wasOn ) for ( const k of METHOD_KEYS ) if ( !isStored(k) ) await game.settings.set(MODULE_ID, k, false);
    await game.settings.set(MODULE_ID, "enableGeneration", wasOn);
    return;
  }
  await game.settings.set(MODULE_ID, "setupAsked", true);
  const choice = await foundry.applications.api.DialogV2.wait({
    window: { title: "KG PC History", icon: "fa-solid fa-scroll" },
    classes: ["kg-pch"],
    content: "<p><strong>Enable ability score generation?</strong></p>"
      + "<p>This lets players use point buy, standard array or rolling in this module, and asks new characters for "
      + "their scores. It is off by default because it can conflict with other modules that roll ability scores.</p>"
      + "<p>The History tab and the ability score record work either way. You can turn this on later under Configure "
      + "Settings, KG PC History.</p>",
    buttons: [
      { action: "off", label: "Keep It Off", icon: "fa-solid fa-xmark", default: true },
      { action: "on", label: "Enable", icon: "fa-solid fa-dice" }
    ],
    rejectClose: false
  });
  await game.settings.set(MODULE_ID, "enableGeneration", choice === "on");
  if ( choice !== "on" ) return;
  ui.notifications.info("KG PC History: ability score generation is on. Choose the dice methods allowed in this window.");
  new RollingConfig().render({ force: true });
}
