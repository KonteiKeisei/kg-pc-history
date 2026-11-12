import { MODULE_ID, refreshCharacterSheets } from "./util.mjs";
import { defaultRollConfig } from "./methods.mjs";
import { RollingConfig } from "./apps/rolling-config.mjs";

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

  // Ability score generation is an optional extra, off until the GM turns it on: another module may already handle
  // character creation, and two creation prompts would collide.
  game.settings.register(MODULE_ID, "setupAsked", {
    scope: "world", config: false, type: Boolean, default: false
  });
  game.settings.register(MODULE_ID, "allowPointBuy", {
    name: "Allow Point Buy",
    hint: "Players may buy their scores with points (8 to 15 before bonuses). Off by default: ability score generation is optional.",
    scope: "world", config: true, type: Boolean, default: false
  });
  game.settings.register(MODULE_ID, "pointBuyBudget", {
    name: "Point Buy Budget",
    hint: "Points to spend. The 5e standard is 27.",
    scope: "world", config: true, type: Number, default: 27,
    range: { min: 1, max: 60, step: 1 }
  });
  game.settings.register(MODULE_ID, "allowStandardArray", {
    name: "Allow Standard Array",
    hint: "Players may assign 15, 14, 13, 12, 10 and 8. Off by default.",
    scope: "world", config: true, type: Boolean, default: false
  });
  game.settings.register(MODULE_ID, "allowRolling", {
    name: "Allow Rolling",
    hint: "Players may roll their scores with any of the methods chosen under Rolling Methods. Rolls are made on the GM's client and cannot be undone by the player. Off by default.",
    scope: "world", config: true, type: Boolean, default: false
  });
  game.settings.register(MODULE_ID, "promptMode", {
    name: "Ask for Ability Scores",
    hint: "When to open the ability score window for a new character (level 1 or lower, with no scores recorded yet). It can always be opened from the History tab.",
    scope: "world", config: true, type: String, default: "open",
    choices: {
      create: "When the character is created",
      open: "When created, and when its player first opens it",
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

/**
 * Once per world, the first time a GM loads it: ask whether to turn on ability score generation. Either answer is
 * remembered, and everything stays changeable in the module settings.
 */
export async function askSetupOnce() {
  if ( !game.user.isGM || game.settings.get(MODULE_ID, "setupAsked") ) return;
  const gm = game.users.activeGM;
  if ( gm && (gm.id !== game.user.id) ) return;
  await game.settings.set(MODULE_ID, "setupAsked", true);
  const choice = await foundry.applications.api.DialogV2.wait({
    window: { title: "KG PC History", icon: "fa-solid fa-scroll" },
    classes: ["kg-pch"],
    content: "<p>The History tab records how each character is built. That part is already on.</p>"
      + "<p><strong>Ability score generation</strong> is optional. It asks new characters for point buy, standard array, "
      + "or a roll, and locks the result. Leave it off if another module or your table already handles character creation.</p>"
      + "<p>You can change this any time under Configure Settings, KG PC History.</p>",
    buttons: [
      { action: "off", label: "Leave it off", icon: "fa-solid fa-xmark", default: true },
      { action: "on", label: "Turn it on", icon: "fa-solid fa-dice" }
    ],
    rejectClose: false
  });
  if ( choice !== "on" ) return;
  for ( const key of ["allowPointBuy", "allowStandardArray", "allowRolling"] ) await game.settings.set(MODULE_ID, key, true);
  ui.notifications.info("KG PC History: point buy, standard array and rolling are on. Choose the dice methods allowed in this window.");
  new RollingConfig().render({ force: true });
}
