export const MODULE_ID = "kg-pc-history";
export const TAB_ID = "kgPcHistory";
export const TEMPLATES = `modules/${MODULE_ID}/templates`;

/** The six core abilities, in sheet order. Point buy, standard array and "in order" rolls all use this order. */
export const ABILITIES = ["str", "dex", "con", "int", "wis", "cha"];

/** History entry categories: the Type filter on the History tab. */
export const CATEGORIES = {
  generation: { label: "Ability Generation", icon: "fa-solid fa-dice-d20" },
  ability: { label: "Ability Scores", icon: "fa-solid fa-dumbbell" },
  proficiency: { label: "Proficiencies", icon: "fa-solid fa-graduation-cap" },
  language: { label: "Languages", icon: "fa-solid fa-language" },
  feat: { label: "Feats", icon: "fa-solid fa-medal" },
  feature: { label: "Features", icon: "fa-solid fa-star" },
  spell: { label: "Spells", icon: "fa-solid fa-wand-sparkles" },
  defense: { label: "Defenses", icon: "fa-solid fa-shield-halved" },
  hp: { label: "Hit Points", icon: "fa-solid fa-heart" },
  class: { label: "Class & Origin", icon: "fa-solid fa-user-shield" },
  scale: { label: "Scale Values", icon: "fa-solid fa-chart-line" },
  other: { label: "Other", icon: "fa-solid fa-circle-info" },
  note: { label: "Notes", icon: "fa-solid fa-note-sticky" }
};

/** Where an entry came from. */
export const ORIGINS = {
  advancement: "Advancement",
  manual: "Manual edit",
  gm: "GM entry",
  generation: "Generation",
  reconstructed: "Rebuilt"
};

export function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function setting(key) {
  return game.settings.get(MODULE_ID, key);
}

export function isCharacter(actor) {
  return actor?.documentName === "Actor" && actor.type === "character";
}

export function renderTemplate(path, data) {
  const fn = foundry.applications?.handlebars?.renderTemplate ?? globalThis.renderTemplate;
  return fn(path, data);
}

export function abilityLabel(key) {
  const label = CONFIG.DND5E?.abilities?.[key]?.label;
  return label ? game.i18n.localize(label) : key.toUpperCase();
}

export function abilityAbbr(key) {
  const abbr = CONFIG.DND5E?.abilities?.[key]?.abbreviation;
  return abbr ? game.i18n.localize(abbr).toUpperCase() : key.toUpperCase();
}

export function modifier(score) {
  return Math.floor((Number(score) - 10) / 2);
}

export function signed(n) {
  const v = Number(n) || 0;
  return v >= 0 ? `+${v}` : `${v}`;
}

/** Label for a trait key such as "skills:ath", "tool:alchemist", "languages:elvish" or "weapon:mar". */
export function traitKeyLabel(key) {
  try {
    const label = dnd5e?.documents?.Trait?.keyLabel?.(key);
    if ( label && (label !== key) ) return label;
  } catch(err) { /* fall through */ }
  const [trait, id] = key.split(":");
  if ( trait === "saves" ) return abilityLabel(id);
  if ( trait === "skills" ) {
    const l = CONFIG.DND5E?.skills?.[id]?.label;
    if ( l ) return game.i18n.localize(l);
  }
  return (id ?? key).replace(/^\w/, c => c.toUpperCase());
}

export function sizeLabel(size) {
  const cfg = CONFIG.DND5E?.actorSizes?.[size];
  const label = (typeof cfg === "string") ? cfg : cfg?.label;
  return label ? game.i18n.localize(label) : (size ?? "");
}

/** Character level from raw actor source: the sum of its class items' levels. */
export function levelFromSource(src) {
  return (src?.items ?? []).filter(i => i.type === "class")
    .reduce((n, i) => n + (Number(i.system?.levels) || 0), 0);
}

export function levelLabel(level) {
  if ( (level === null) || (level === undefined) || (level === "") ) return "Unsorted";
  return Number(level) === 0 ? "Origin" : `Level ${level}`;
}

export function formatDate(ts) {
  if ( !ts ) return "";
  try {
    return new Date(ts).toLocaleDateString(game.i18n.lang, { year: "numeric", month: "short", day: "numeric" });
  } catch(err) {
    return new Date(ts).toDateString();
  }
}

export function userName(id) {
  return game.users?.get(id)?.name ?? "";
}

export function advancementTitle(adv) {
  if ( adv?.title ) return adv.title;
  const meta = adv?.constructor?.metadata?.title;
  return meta ? game.i18n.localize(meta) : (adv?.type ?? "Advancement");
}

/** Find an open ApplicationV2 by id, across v13 and v14. */
export function openApp(id) {
  return foundry.applications?.instances?.get(id) ?? null;
}

/**
 * Class order: an array of class item ids, one per character level (index 0 is level 1).
 * The character level at which a class reached `classLevel`, or null.
 */
export function charLevelFor(order, classId, classLevel) {
  if ( !Array.isArray(order) || !classId || !classLevel ) return null;
  let seen = 0;
  for ( let i = 0; i < order.length; i++ ) {
    if ( order[i] !== classId ) continue;
    seen++;
    if ( seen === Number(classLevel) ) return i + 1;
  }
  return null;
}

/** Does a class order match the actor's classes and their levels? */
export function validClassOrder(actor, order) {
  if ( !Array.isArray(order) ) return false;
  const classes = actor.items.filter(i => i.type === "class");
  const total = classes.reduce((n, c) => n + (Number(c.system?.levels) || 0), 0);
  if ( order.length !== total ) return false;
  return classes.every(c => order.filter(id => id === c.id).length === (Number(c.system?.levels) || 0));
}

/** Re-render open character sheets (after a setting that changes the History tab). */
export function refreshCharacterSheets() {
  for ( const app of foundry.applications?.instances?.values() ?? [] ) {
    if ( isCharacter(app.document) && app.rendered ) app.render();
  }
}

export function log(...args) {
  console.log(`${MODULE_ID} |`, ...args);
}

export function warn(...args) {
  console.warn(`${MODULE_ID} |`, ...args);
}
