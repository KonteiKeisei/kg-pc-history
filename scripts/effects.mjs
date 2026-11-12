import { abilityAbbr, traitKeyLabel } from "./util.mjs";

/*
 * Current modifiers: the active effects changing a character right now. Effects never change stored data (they are
 * applied on top of it every time the sheet is prepared), so history never records them by itself. The History tab
 * lists them on a separate card so they can be tracked down, and the GM can copy one into the history by hand.
 */

const GEAR = new Set(["weapon", "equipment", "consumable", "loot", "tool", "container"]);

export const EFFECT_GROUPS = {
  temporary: { label: "Temporary", icon: "fa-solid fa-hourglass-half", hint: "Has a duration or a condition, or came from a spell or another creature" },
  equipment: { label: "Equipment", icon: "fa-solid fa-shirt", hint: "From an item the character carries or wears" },
  // Shown on the feature's own history chip, not on the Current modifiers card: they are part of the build.
  feature: { label: "Features", icon: "fa-solid fa-star", hint: "Passive effects of the character's features, feats, class, background or species" },
  other: { label: "On the character", icon: "fa-solid fa-user", hint: "Placed directly on the character, with no duration" }
};

const MODE_NAMES = { 0: "custom", 1: "multiply", 2: "add", 3: "downgrade", 4: "upgrade", 5: "override" };

function modeName(mode) {
  if ( typeof mode === "number" ) return MODE_NAMES[mode] ?? "custom";
  const m = String(mode ?? "").toLowerCase();
  return Object.values(MODE_NAMES).includes(m) ? m : (MODE_NAMES[Number(m)] ?? "custom");
}

const cap = s => String(s ?? "").replace(/^\w/, c => c.toUpperCase());

function skillLabel(id) {
  const l = CONFIG.DND5E?.skills?.[id]?.label;
  return l ? game.i18n.localize(l) : cap(id);
}

const SET_TRAITS = {
  dr: ["Resistance", "dr"], di: ["Immunity", "di"], dv: ["Vulnerability", "dv"], ci: ["Condition immunity", "ci"],
  languages: ["Language", "languages"], weaponProf: ["Weapon proficiency", "weapon"], armorProf: ["Armor proficiency", "armor"]
};

/** What a change key targets, in words. */
function targetLabel(key) {
  let m;
  if ( (m = key.match(/^system\.abilities\.(\w+)\.value$/)) ) return abilityAbbr(m[1]);
  if ( (m = key.match(/^system\.abilities\.(\w+)\.bonuses\.check$/)) ) return `${abilityAbbr(m[1])} checks`;
  if ( (m = key.match(/^system\.abilities\.(\w+)\.bonuses\.save$/)) ) return `${abilityAbbr(m[1])} saves`;
  if ( (m = key.match(/^system\.abilities\.(\w+)\.proficient$/)) ) return `${abilityAbbr(m[1])} save proficiency`;
  if ( (m = key.match(/^system\.abilities\.(\w+)\.max$/)) ) return `${abilityAbbr(m[1])} maximum`;
  if ( (m = key.match(/^system\.skills\.(\w+)\.value$/)) ) return `${skillLabel(m[1])} proficiency`;
  if ( (m = key.match(/^system\.skills\.(\w+)\.bonuses\.(\w+)$/)) ) return `${skillLabel(m[1])}`;
  if ( key === "system.attributes.hp.bonuses.level" ) return "HP per level";
  if ( key === "system.attributes.hp.bonuses.overall" ) return "Max HP";
  if ( key === "system.attributes.hp.max" ) return "Max HP";
  if ( key === "system.attributes.hp.tempmax" ) return "Temp max HP";
  if ( key === "system.attributes.ac.bonus" ) return "AC";
  if ( /^system\.attributes\.ac\./.test(key) ) return "AC calculation";
  if ( key === "system.attributes.init.bonus" ) return "Initiative";
  if ( key === "system.attributes.exhaustion" ) return "Exhaustion";
  if ( (m = key.match(/^system\.attributes\.movement\.(\w+)$/)) ) return m[1] === "all" ? "All speeds" : `${cap(m[1])} speed`;
  if ( (m = key.match(/^system\.attributes\.senses\.(?:ranges\.)?(\w+)$/)) ) return cap(m[1]);
  if ( (m = key.match(/^system\.bonuses\.(\w+)\.(\w+)$/)) ) return `${m[1].toUpperCase()} ${m[2]}`;
  if ( key === "system.traits.size" ) return "Size";
  return key.replace(/^system\./, "").split(".").filter(s => s !== "value").map(cap).join(" ");
}

function describeChange(c) {
  const key = String(c?.key ?? "");
  if ( !key ) return null;
  const value = c.value ?? "";
  const mode = modeName(c.mode ?? c.type);
  const set = key.match(/^system\.traits\.(\w+)\.value$/);
  if ( set && SET_TRAITS[set[1]] && ["add", "override", "custom"].includes(mode) ) {
    const [noun, trait] = SET_TRAITS[set[1]];
    const names = String(value).split(/[;,]/).map(s => s.trim()).filter(Boolean).map(v => traitKeyLabel(`${trait}:${v}`));
    return { key, text: `${noun}: ${names.join(", ")}` };
  }
  if ( key === "system.attributes.ac.calc" ) {
    const cfg = CONFIG.DND5E?.armorClasses?.[value];
    const label = cfg?.label ? game.i18n.localize(cfg.label) : cap(value);
    return { key, mode, value: String(value), text: `AC: ${label}` };
  }
  const target = targetLabel(key);
  const v = String(value);
  let op;
  switch ( mode ) {
    case "add": op = /^[-+]/.test(v) ? v : `+${v}`; break;
    case "override": op = `= ${v}`; break;
    case "upgrade": op = `at least ${v}`; break;
    case "downgrade": op = `at most ${v}`; break;
    case "multiply": op = `× ${v}`; break;
    default: op = v;
  }
  return { key, mode, value: v, text: `${target} ${op}`.trim() };
}

function originName(effect) {
  if ( !effect.origin ) return "";
  try {
    const doc = fromUuidSync(effect.origin);
    if ( !doc ) return "";
    const owner = doc.parent?.documentName === "Actor" ? doc.parent.name : "";
    return owner ? `${doc.name} (${owner})` : doc.name;
  } catch(err) {
    return "";
  }
}

/** Every effect currently applying to the actor, classified and described. */
export function currentEffects(actor) {
  let list;
  try {
    list = [...(actor.allApplicableEffects?.() ?? actor.effects)];
  } catch(err) {
    list = [...actor.effects];
  }
  const out = [];
  for ( const e of list ) {
    if ( !e.active ) continue;
    const parent = e.parent;
    const fromItem = parent?.documentName === "Item";
    // Item effects carry their item's (often compendium) origin, so only effects placed on the actor itself can be
    // "from someone else": a spell or creature feature applied to this character.
    const foreign = !fromItem && !!e.origin && !String(e.origin).startsWith(actor.uuid);
    let group;
    if ( e.isTemporary || e.statuses?.size || foreign ) group = "temporary";
    else if ( fromItem && GEAR.has(parent.type) ) group = "equipment";
    else if ( fromItem ) group = "feature";
    else group = "other";
    const changes = (e.changes ?? []).map(describeChange).filter(Boolean);
    const statuses = [...(e.statuses ?? [])].map(id => {
      const s = CONFIG.statusEffects?.find(x => x.id === id);
      return s ? game.i18n.localize(s.name ?? s.label ?? id) : cap(id);
    });
    let duration = "";
    try { duration = e.duration?.label ?? ""; } catch(err) { /* v14 may differ */ }
    out.push({
      id: e.uuid ?? e.id,
      name: e.name,
      itemId: fromItem ? parent.id : null,
      group,
      groupLabel: EFFECT_GROUPS[group].label,
      source: fromItem ? parent.name : (originName(e) || (foreign ? "Another creature or spell" : "")),
      duration: duration && (duration !== "None") ? duration : "",
      changes,
      statuses,
      // A condition's name usually is its status ("Frightened"), so only list statuses the name doesn't already say.
      summary: changes.map(c => c.text).join(", ")
        || statuses.filter(s => !String(e.name ?? "").toLowerCase().includes(s.toLowerCase())).join(", "),
      search: [e.name, parent?.name, ...changes.map(c => c.text), ...statuses].filter(Boolean).join(" ").toLowerCase()
    });
  }
  return out;
}

/** Effects changing one ability score's value, as breakdown parts. */
export function abilityEffectParts(effects, ability) {
  const key = `system.abilities.${ability}.value`;
  const parts = [];
  for ( const e of effects ) {
    for ( const c of e.changes ) {
      if ( c.key !== key ) continue;
      parts.push({ text: `${c.text.replace(/^\S+\s/, "")} ${e.name}`, sub: e.groupLabel.toLowerCase(), cls: "muted" });
    }
  }
  return parts;
}

/** A best guess at the history category for an effect, for the GM's "record in history" prefill. */
export function effectCategory(effect) {
  const keys = effect.changes.map(c => c.key);
  if ( keys.some(k => /^system\.abilities\.\w+\.value$/.test(k)) ) return "ability";
  if ( keys.some(k => /^system\.traits\.(dr|di|dv|ci)\./.test(k)) ) return "defense";
  if ( keys.some(k => /^system\.traits\.languages\./.test(k)) ) return "language";
  if ( keys.some(k => /^system\.attributes\.hp\./.test(k)) ) return "hp";
  if ( keys.some(k => /^system\.(skills|abilities\.\w+\.proficient|traits\.(weaponProf|armorProf))/.test(k)) ) return "proficiency";
  return "other";
}
