import { ABILITIES, abilityLabel, modifier, setting } from "./util.mjs";

/** 5e point buy: scores 8 to 15, standard costs. The budget is a world setting (27 by default). */
export const POINT_BUY_COSTS = { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 };
export const POINT_BUY_MIN = 8;
export const POINT_BUY_MAX = 15;
export const STANDARD_ARRAY = [15, 14, 13, 12, 10, 8];

/**
 * Rolling methods the GM can allow. `count` scores are rolled; with `dropLowest` the lowest score is discarded.
 * `inOrder` assigns the scores to the abilities in the order rolled instead of letting the player arrange them.
 */
export const ROLL_METHODS = [
  {
    id: "4d6dl", label: "4d6, drop lowest", formula: "4d6kh3", count: 6, initial: true,
    hint: "Roll four six-sided dice and drop the lowest die. Do that six times and arrange the totals as you like. The standard 5e method."
  },
  {
    id: "4d6dl-r1", label: "4d6, reroll 1s once, drop lowest", formula: "4d6r1kh3", count: 6,
    hint: "Any die that shows a 1 is rerolled once, and the new result stands even if it is another 1. Then the lowest die is dropped. Slightly higher scores than plain 4d6."
  },
  {
    id: "4d6dl-rr1", label: "4d6, reroll all 1s, drop lowest", formula: "4d6rr1kh3", count: 6,
    hint: "1s are rerolled until they are not 1s, so every die lands 2 to 6. Then the lowest die is dropped. Noticeably higher scores; the lowest possible score is 6."
  },
  {
    id: "4d6dl-order", label: "4d6, drop lowest, in order", formula: "4d6kh3", count: 6, inOrder: true,
    hint: "As 4d6 drop lowest, but the totals go to Strength, Dexterity, Constitution, Intelligence, Wisdom and Charisma in the order rolled. No arranging."
  },
  {
    id: "4d6dl-7", label: "4d6, drop lowest, seven scores", formula: "4d6kh3", count: 7, dropLowest: true,
    hint: "Roll seven scores with 4d6 drop lowest, discard the lowest of the seven, and arrange the other six. A safety net against one bad roll."
  },
  {
    id: "3d6", label: "3d6, arrange", formula: "3d6", count: 6,
    hint: "Roll three six-sided dice six times and arrange the totals. Lower and swingier than 4d6 (average 10.5)."
  },
  {
    id: "3d6-order", label: "3d6, in order", formula: "3d6", count: 6, inOrder: true,
    hint: "The old-school method: 3d6 for each ability in order, no arranging. Expect a lopsided character."
  },
  {
    id: "2d6p6", label: "2d6 + 6", formula: "2d6+6", count: 6,
    hint: "Every score lands between 8 and 18, average 13. No score is ever below 8, so no character is crippled by the dice."
  },
  {
    id: "5d6kh3", label: "5d6, keep highest 3", formula: "5d6kh3", count: 6,
    hint: "Heroic: roll five dice and keep the best three. High scores are common (average about 13.4)."
  }
];

export const MODE_LABELS = { pointBuy: "Point Buy", standardArray: "Standard Array", roll: "Rolled", manual: "Set by GM" };

export function defaultRollConfig() {
  return {
    methods: Object.fromEntries(ROLL_METHODS.map(m => [m.id, !!m.initial])),
    rerollLimit: 0,
    freeReroll: false,
    freeRerollBelow: 1,
    rollMode: "publicroll"
  };
}

export function rollConfig() {
  const stored = setting("rollingConfig") ?? {};
  return foundry.utils.mergeObject(defaultRollConfig(), stored, { inplace: false });
}

export function getMethod(id) {
  return ROLL_METHODS.find(m => m.id === id) ?? null;
}

export function allowedRollMethods() {
  const cfg = rollConfig();
  return ROLL_METHODS.filter(m => cfg.methods[m.id]);
}

export function allowedModes() {
  return {
    pointBuy: !!setting("allowPointBuy"),
    standardArray: !!setting("allowStandardArray"),
    roll: !!setting("allowRolling") && (allowedRollMethods().length > 0)
  };
}

export function anyModeAllowed() {
  return Object.values(allowedModes()).some(v => v);
}

export function pointBuyBudget() {
  return Number(setting("pointBuyBudget")) || 27;
}

export function pointBuySpent(scores) {
  return ABILITIES.reduce((n, a) => n + (POINT_BUY_COSTS[scores[a]] ?? Infinity), 0);
}

export function methodLabel(gen) {
  if ( !gen ) return "";
  if ( gen.mode === "roll" ) return gen.methodLabel || getMethod(gen.methodId)?.label || "Rolled";
  return gen.methodLabel || MODE_LABELS[gen.mode] || "Unknown";
}

/** Totals that count for assignment: all sets except the one dropped by a "seven scores" method. */
export function keptSets(gen) {
  return (gen?.sets ?? []).map((s, i) => ({ ...s, index: i })).filter(s => s.index !== gen.dropped);
}

/** Can the current roll be thrown away and rolled again? */
export function rerollState(gen, isGM=false) {
  const cfg = rollConfig();
  const used = Number(gen?.rerollsUsed) || 0;
  const left = Math.max(0, (Number(cfg.rerollLimit) || 0) - used);
  const modTotal = keptSets(gen).reduce((n, s) => n + modifier(s.total), 0);
  const free = !!cfg.freeReroll && (gen?.status === "rolling") && (modTotal < (Number(cfg.freeRerollBelow) || 0));
  const canReroll = (gen?.status === "rolling") && (isGM || free || (left > 0));
  return { used, left, free, modTotal, canReroll };
}

/** Roll a full set for a method. Returns plain data plus the Roll objects (for the chat card). */
export async function rollSets(methodId) {
  const method = getMethod(methodId);
  if ( !method ) throw new Error(`Unknown rolling method "${methodId}".`);
  const rolls = [];
  for ( let i = 0; i < method.count; i++ ) rolls.push(await new Roll(method.formula).evaluate());
  const sets = rolls.map(summarizeRoll);
  let dropped = null;
  if ( method.dropLowest ) {
    let low = 0;
    sets.forEach((s, i) => { if ( s.total < sets[low].total ) low = i; });
    dropped = low;
  }
  return { sets, dropped, rolls, method };
}

function summarizeRoll(roll) {
  const dice = roll.dice.flatMap(d => d.results.map(r => ({
    r: r.result,
    a: (r.active !== false) && !r.discarded,
    rr: !!r.rerolled
  })));
  return { formula: roll.formula, total: roll.total, dice };
}

/** Post a roll set to chat, as the actor. */
export async function postRollCard(actor, method, sets, dropped, rolls, { reroll=false, verified=true }={}) {
  const cfg = rollConfig();
  const rows = sets.map((s, i) => {
    const dice = s.dice.map(d => `<span class="kg-pch-die${d.a ? "" : " off"}">${d.r}</span>`).join("");
    const cls = (i === dropped) ? " class=\"dropped\"" : "";
    return `<li${cls}><span class="kg-pch-dice">${dice}</span><strong>${s.total}</strong></li>`;
  }).join("");
  const title = reroll ? "Ability scores rerolled" : "Ability scores rolled";
  const note = verified ? "" : "<p class=\"kg-pch-unverified\">Rolled while no GM was online.</p>";
  const content = `<div class="kg-pch-chat"><h3>${title}</h3><p>${method.label}</p><ol>${rows}</ol>${note}</div>`;
  const data = {
    speaker: ChatMessage.getSpeaker({ actor }),
    content,
    rolls,
    sound: CONFIG.sounds?.dice
  };
  const mode = cfg.rollMode || "publicroll";
  try { ChatMessage.applyRollMode?.(data, mode); } catch(err) { /* older API */ }
  return ChatMessage.create(data, { rollMode: mode });
}

/**
 * Bonuses already on the actor from Ability Score Improvement advancements (species, background, feats, class ASIs).
 * Base scores are applied on top of these so generating late does not wipe them out.
 */
export function existingBonuses(actor) {
  const out = Object.fromEntries(ABILITIES.map(a => [a, 0]));
  for ( const item of actor?.items ?? [] ) {
    for ( const adv of Object.values(item.advancement?.byId ?? {}) ) {
      if ( adv.type !== "AbilityScoreImprovement" ) continue;
      for ( const [a, n] of Object.entries(adv.value?.assignments ?? {}) ) {
        if ( a in out ) out[a] += Number(n) || 0;
      }
    }
  }
  return out;
}

export function abilityRows(fn) {
  return ABILITIES.map(a => ({ key: a, label: abilityLabel(a), ...fn(a) }));
}
