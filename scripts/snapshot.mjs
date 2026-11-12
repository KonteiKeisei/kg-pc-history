import { ABILITIES, abilityLabel, levelFromSource, signed, sizeLabel, traitKeyLabel } from "./util.mjs";

/*
 * A snapshot is the part of an actor's *source* data that history cares about, reduced to comparable keys:
 *   abilities  { str: 15, ... }                      base scores
 *   keys       { "skills:ath": 1, "saves:str": 1,     proficiency multipliers (0, 0.5, 1, 2)
 *                "tool:thief": 1, "languages:elvish": 1, "weapon:mar": 1, "armor:lgt": 1,
 *                "mastery:longsword": 1, "dr:fire": 1, "ci:poisoned": 1 }
 *   items      { id: { name, type, subtype, levels } }
 *   size, level
 * Keys use the dnd5e trait key format, so they match Trait advancement choices and dnd5e can label them.
 */

const SET_TRAITS = [
  ["languages", "languages"], ["weaponProf", "weapon"], ["armorProf", "armor"],
  ["di", "di"], ["dr", "dr"], ["dv", "dv"], ["ci", "ci"]
];

function toArray(v) {
  if ( !v ) return [];
  if ( Array.isArray(v) ) return v;
  if ( v instanceof Set ) return [...v];
  return [];
}

export function snapshot(src) {
  const sys = src?.system ?? {};
  const snap = { abilities: {}, keys: {}, items: {}, size: sys.traits?.size ?? null, level: levelFromSource(src) };
  for ( const a of ABILITIES ) {
    const ab = sys.abilities?.[a];
    if ( !ab ) continue;
    snap.abilities[a] = Number(ab.value ?? 10);
    snap.keys[`saves:${a}`] = Number(ab.proficient ?? 0);
  }
  for ( const [k, v] of Object.entries(sys.skills ?? {}) ) snap.keys[`skills:${k}`] = Number(v?.value ?? 0);
  for ( const [k, v] of Object.entries(sys.tools ?? {}) ) {
    if ( k.startsWith("-=") || !v ) continue;
    snap.keys[`tool:${k}`] = Number(v.value ?? 0);
  }
  for ( const [path, trait] of SET_TRAITS ) {
    for ( const id of toArray(sys.traits?.[path]?.value) ) snap.keys[`${trait}:${id}`] = 1;
  }
  for ( const id of toArray(sys.traits?.weaponProf?.mastery?.value) ) snap.keys[`mastery:${id}`] = 1;
  for ( const it of src?.items ?? [] ) {
    snap.items[it._id] = {
      id: it._id, name: it.name, type: it.type, subtype: it.system?.type?.value ?? "",
      levels: it.type === "class" ? Number(it.system?.levels ?? 0) : null
    };
  }
  return snap;
}

/** Atoms: the individual differences between two snapshots. */
export function diffSnapshots(before, after) {
  const out = [];
  for ( const a of ABILITIES ) {
    const f = before.abilities[a];
    const t = after.abilities[a];
    if ( (f !== undefined) && (t !== undefined) && (f !== t) ) {
      out.push({ key: `ability:${a}`, from: f, to: t, delta: t - f });
    }
  }
  const keys = new Set([...Object.keys(before.keys), ...Object.keys(after.keys)]);
  for ( const k of keys ) {
    const f = before.keys[k] ?? 0;
    const t = after.keys[k] ?? 0;
    if ( f !== t ) out.push({ key: k, from: f, to: t });
  }
  if ( after.size && (before.size !== after.size) ) out.push({ key: "size", from: before.size, to: after.size });
  for ( const [id, it] of Object.entries(after.items) ) {
    const prev = before.items[id];
    if ( !prev ) out.push({ key: `item:${id}`, added: true, item: it });
    else if ( (it.type === "class") && (prev.levels !== it.levels) ) {
      out.push({ key: `classLevel:${id}`, from: prev.levels, to: it.levels, item: it });
    }
  }
  for ( const [id, it] of Object.entries(before.items) ) {
    if ( !after.items[id] ) out.push({ key: `item:${id}`, removed: true, item: it });
  }
  return out;
}

export function categoryForKey(key) {
  const t = key.split(":")[0];
  if ( t === "ability" ) return "ability";
  if ( t === "languages" ) return "language";
  if ( ["di", "dr", "dv", "ci"].includes(t) ) return "defense";
  if ( ["skills", "saves", "tool", "weapon", "armor", "mastery"].includes(t) ) return "proficiency";
  if ( t === "classLevel" ) return "class";
  return "other";
}

export function categoryForItem(it) {
  if ( !it ) return "other";
  if ( ["class", "subclass", "background", "race"].includes(it.type) ) return "class";
  if ( it.type === "spell" ) return "spell";
  if ( it.type === "feat" ) return it.subtype === "feat" ? "feat" : "feature";
  return "other";
}

const ITEM_NOUN = {
  class: "Class", subclass: "Subclass", background: "Background", race: "Species", spell: "Spell"
};

function itemNoun(it) {
  if ( it.type === "feat" ) return it.subtype === "feat" ? "Feat" : "Feature";
  return ITEM_NOUN[it.type] ?? "Item";
}

const PROF_LEVELS = { 0: "Not proficient", 0.5: "Half proficiency", 1: "Proficient", 2: "Expertise" };
const SET_NOUNS = {
  languages: "Language", weapon: "Weapon proficiency", armor: "Armor proficiency", mastery: "Weapon mastery",
  di: "Damage immunity", dr: "Damage resistance", dv: "Damage vulnerability", ci: "Condition immunity"
};

export function keyName(key) {
  const [t, id] = key.split(":");
  if ( t === "mastery" ) return traitKeyLabel(`weapon:${id}`);
  return traitKeyLabel(key);
}

/**
 * Describe an atom (or a pseudo-atom built from advancement data) as entry fields:
 * { key, category, label, detail, delta }.
 */
export function describeAtom(atom) {
  const key = atom.key;
  const [t, id] = key.split(":");
  const known = (atom.from !== undefined) && (atom.from !== null);
  if ( t === "ability" ) {
    return {
      key, category: "ability", delta: atom.delta,
      label: `${abilityLabel(id)} ${signed(atom.delta)}`,
      detail: known ? `${atom.from} → ${atom.to}` : ""
    };
  }
  if ( (t === "skills") || (t === "tool") ) {
    const f = Number(atom.from ?? 0);
    const to = Number(atom.to ?? 1);
    const noun = t === "skills" ? "Skill" : "Tool";
    let label;
    if ( to > f ) label = `${to >= 2 ? "Expertise" : (to >= 1 ? `${noun} proficiency` : "Half proficiency")}: ${keyName(key)}`;
    else label = `${to <= 0 ? `Lost ${noun.toLowerCase()} proficiency` : "Proficiency reduced"}: ${keyName(key)}`;
    return {
      key, category: "proficiency", label, removed: to < f,
      detail: known ? `${PROF_LEVELS[f] ?? f} → ${PROF_LEVELS[to] ?? to}` : ""
    };
  }
  if ( t === "saves" ) {
    const lost = known && (Number(atom.to) < Number(atom.from));
    return {
      key, category: "proficiency", removed: lost,
      label: `${lost ? "Lost saving throw" : "Saving throw"} proficiency: ${abilityLabel(id)}`, detail: ""
    };
  }
  if ( t in SET_NOUNS ) {
    const lost = known && (Number(atom.to) < Number(atom.from));
    return { key, category: categoryForKey(key), removed: lost, label: `${lost ? "Removed " : ""}${SET_NOUNS[t]}: ${keyName(key)}`, detail: "" };
  }
  if ( t === "size" ) {
    return {
      key, category: "other", label: `Size: ${sizeLabel(atom.to)}`,
      detail: atom.from ? `${sizeLabel(atom.from)} → ${sizeLabel(atom.to)}` : ""
    };
  }
  if ( t === "classLevel" ) {
    const up = Number(atom.to) > Number(atom.from);
    return {
      key, category: "class", removed: !up,
      label: up ? `${atom.item.name} level ${atom.to}` : `${atom.item.name} level removed`,
      detail: `${atom.from} → ${atom.to}`
    };
  }
  if ( t === "item" ) {
    const it = atom.item ?? { name: "Unknown item", type: "" };
    const noun = itemNoun(it);
    return {
      key, category: categoryForItem(it), removed: !!atom.removed,
      label: atom.removed ? `Removed ${noun.toLowerCase()}: ${it.name}` : `${noun}: ${it.name}`,
      detail: ""
    };
  }
  return { key, category: "other", label: key, detail: "" };
}
