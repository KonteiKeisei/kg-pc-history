import { ABILITIES, MODULE_ID, TEMPLATES, abilityAbbr, abilityLabel, modifier, openApp, signed } from "../util.mjs";
import {
  POINT_BUY_COSTS, POINT_BUY_MAX, POINT_BUY_MIN, ROLL_METHODS, STANDARD_ARRAY, allowedModes, allowedRollMethods,
  existingBonuses, getMethod, keptSets, methodLabel, pointBuyBudget, pointBuySpent, rerollState
} from "../methods.mjs";
import { loadView, reportResults, submit } from "../store.mjs";

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;

const MODES = [
  { id: "pointBuy", label: "Point Buy", icon: "fa-solid fa-coins" },
  { id: "standardArray", label: "Standard Array", icon: "fa-solid fa-list-ol" },
  { id: "roll", label: "Roll", icon: "fa-solid fa-dice" }
];

/** The ability score window: point buy, standard array, or rolling. */
export class GenerationApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    classes: ["kg-pch", "kg-pch-generation"],
    window: { icon: "fa-solid fa-dice-d20" },
    position: { width: 620, height: "auto" },
    actions: {
      mode: GenerationApp.#onMode,
      step: GenerationApp.#onStep,
      roll: GenerationApp.#onRoll,
      reroll: GenerationApp.#onReroll,
      apply: GenerationApp.#onApply
    }
  };

  static PARTS = {
    body: { template: `${TEMPLATES}/generation.hbs` }
  };

  static open(actor) {
    const app = openApp(`kg-pch-generation-${actor.id}`) ?? new GenerationApp(actor);
    app.render({ force: true });
    return app;
  }

  constructor(actor, options={}) {
    super({ id: `kg-pch-generation-${actor.id}`, ...options });
    this.actor = actor;
    this.mode = null;
    this.methodId = null;
    this.pb = Object.fromEntries(ABILITIES.map(a => [a, POINT_BUY_MIN]));
    this.sa = {};
    this.assign = {};
    this.busy = false;
    this.gen = null;
    this.#hook = Hooks.on("updateActor", (doc, changes) => {
      if ( (doc === this.actor) && foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.store`) && !this.busy ) this.render();
    });
  }

  #hook;

  get title() {
    return `Ability Scores: ${this.actor.name}`;
  }

  _onClose(options) {
    Hooks.off("updateActor", this.#hook);
    super._onClose?.(options);
  }

  async _prepareContext() {
    const view = await loadView(this.actor);
    const gen = view.generation;
    this.gen = gen;
    const isGM = game.user.isGM;
    const allowed = allowedModes();
    const rolling = gen?.status === "rolling";
    const final = gen?.status === "final";
    const modes = MODES.filter(m => isGM || allowed[m.id]);
    if ( rolling ) this.mode = "roll";
    if ( !modes.some(m => m.id === this.mode) ) this.mode = modes[0]?.id ?? null;
    const bonuses = existingBonuses(this.actor);
    const hasBonuses = Object.values(bonuses).some(v => v);

    const ctx = {
      actorName: this.actor.name,
      isGM, final, rolling, busy: this.busy,
      noModes: !modes.length,
      modes: modes.map(m => ({ ...m, active: m.id === this.mode, disabled: rolling && (m.id !== "roll") })),
      mode: this.mode,
      hasBonuses,
      pending: !!view.pendingCount,
      canApply: false
    };

    if ( final ) {
      ctx.summary = {
        method: methodLabel(gen),
        rows: ABILITIES.map(a => ({ abbr: abilityAbbr(a), label: abilityLabel(a), base: gen.base?.[a] ?? "" }))
      };
      return ctx;
    }

    const row = (a, base) => {
      const total = (base === null) || (base === undefined) ? null : Number(base) + (bonuses[a] || 0);
      return {
        key: a, abbr: abilityAbbr(a), label: abilityLabel(a), bonus: bonuses[a] ? signed(bonuses[a]) : "",
        final: total ?? "", mod: total === null ? "" : signed(modifier(total))
      };
    };

    if ( this.mode === "pointBuy" ) {
      const budget = pointBuyBudget();
      const spent = pointBuySpent(this.pb);
      const remaining = budget - spent;
      ctx.pointBuy = {
        budget, spent, remaining, over: remaining < 0,
        rows: ABILITIES.map(a => {
          const score = this.pb[a];
          const next = POINT_BUY_COSTS[score + 1];
          return {
            ...row(a, score), score, cost: POINT_BUY_COSTS[score],
            canDec: score > POINT_BUY_MIN,
            canInc: (score < POINT_BUY_MAX) && ((next - POINT_BUY_COSTS[score]) <= remaining)
          };
        })
      };
      ctx.canApply = remaining >= 0;
      ctx.leftover = remaining > 0 ? remaining : 0;
    }

    else if ( this.mode === "standardArray" ) {
      const counts = {};
      for ( const a of ABILITIES ) if ( this.sa[a] ) counts[this.sa[a]] = (counts[this.sa[a]] ?? 0) + 1;
      ctx.standardArray = {
        rows: ABILITIES.map(a => ({
          ...row(a, this.sa[a] ?? null),
          duplicate: counts[this.sa[a]] > 1,
          options: STANDARD_ARRAY.map(v => ({ value: v, selected: this.sa[a] === v, used: (counts[v] ?? 0) > 0 && (this.sa[a] !== v) }))
        }))
      };
      ctx.canApply = ABILITIES.every(a => this.sa[a]) && Object.values(counts).every(n => n === 1);
    }

    else if ( this.mode === "roll" ) {
      const methods = isGM ? ROLL_METHODS : allowedRollMethods();
      if ( rolling ) this.methodId = gen.methodId;
      if ( !methods.some(m => m.id === this.methodId) && !rolling ) this.methodId = methods[0]?.id ?? null;
      const method = getMethod(this.methodId);
      ctx.roll = {
        methods: methods.map(m => ({ id: m.id, label: m.label, hint: m.hint, selected: m.id === this.methodId })),
        method, locked: rolling
      };
      if ( rolling ) {
        const kept = keptSets(gen);
        const state = rerollState(gen, isGM);
        if ( method?.inOrder ) kept.forEach((s, i) => this.assign[ABILITIES[i]] = s.index);
        const counts = {};
        for ( const a of ABILITIES ) if ( this.assign[a] !== undefined ) counts[this.assign[a]] = (counts[this.assign[a]] ?? 0) + 1;
        ctx.roll.sets = gen.sets.map((s, i) => ({
          index: i, total: s.total, dropped: i === gen.dropped,
          used: Object.values(this.assign).includes(i),
          dice: s.dice.map(d => ({ r: d.r, off: !d.a }))
        }));
        ctx.roll.verified = gen.verified !== false;
        ctx.roll.discarded = gen.discarded?.length ?? 0;
        ctx.roll.reroll = state;
        ctx.roll.rows = ABILITIES.map(a => {
          const idx = this.assign[a];
          const set = (idx === undefined) ? null : gen.sets[idx];
          return {
            ...row(a, set?.total ?? null),
            fixed: !!method?.inOrder,
            duplicate: (idx !== undefined) && (counts[idx] > 1),
            options: kept.map(s => ({ value: s.index, label: `${s.total}  (roll ${s.index + 1})`, selected: idx === s.index }))
          };
        });
        ctx.canApply = ABILITIES.every(a => this.assign[a] !== undefined) && Object.values(counts).every(n => n === 1);
      }
    }
    ctx.canApply &&= !this.busy;
    return ctx;
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    const el = this.element;
    el.querySelectorAll("[data-kg-sa]").forEach(s => s.addEventListener("change", ev => {
      const v = Number(ev.currentTarget.value);
      this.sa[ev.currentTarget.dataset.kgSa] = v || undefined;
      this.render();
    }));
    el.querySelectorAll("[data-kg-assign]").forEach(s => s.addEventListener("change", ev => {
      const raw = ev.currentTarget.value;
      this.assign[ev.currentTarget.dataset.kgAssign] = raw === "" ? undefined : Number(raw);
      this.render();
    }));
    el.querySelector("[data-kg-method]")?.addEventListener("change", ev => {
      this.methodId = ev.currentTarget.value;
      this.render();
    });
  }

  static #onMode(event, target) {
    if ( this.gen?.status === "rolling" ) return;
    this.mode = target.dataset.mode;
    this.render();
  }

  static #onStep(event, target) {
    const a = target.dataset.ability;
    const next = this.pb[a] + Number(target.dataset.delta);
    if ( (next < POINT_BUY_MIN) || (next > POINT_BUY_MAX) ) return;
    const trial = { ...this.pb, [a]: next };
    if ( pointBuySpent(trial) > pointBuyBudget() ) return;
    this.pb = trial;
    this.render();
  }

  async #run(ops) {
    this.busy = true;
    await this.render();
    try {
      const results = await submit(this.actor, ops);
      return reportResults(results);
    } finally {
      this.busy = false;
      if ( this.rendered ) this.render();
    }
  }

  static async #onRoll() {
    const method = getMethod(this.methodId);
    if ( !method ) return;
    const ok = await DialogV2.confirm({
      window: { title: "Roll Ability Scores" },
      content: `<p>Roll with <strong>${method.label}</strong>?</p><p>The result is recorded on this character and cannot be undone.</p>`,
      rejectClose: false
    });
    if ( !ok ) return;
    this.assign = {};
    await this.#run([{ type: "roll", methodId: method.id }]);
  }

  static async #onReroll() {
    const state = rerollState(this.gen, game.user.isGM);
    if ( !state.canReroll ) return;
    const why = state.free ? "This set is below the minimum, so the reroll is free."
      : (game.user.isGM ? "GM reroll." : `You have ${state.left} reroll${state.left === 1 ? "" : "s"} left.`);
    const ok = await DialogV2.confirm({
      window: { title: "Reroll Ability Scores" },
      content: `<p>Discard this set and roll a new one? ${why}</p><p>The discarded set stays in the record.</p>`,
      rejectClose: false
    });
    if ( !ok ) return;
    this.assign = {};
    await this.#run([{ type: "roll", methodId: this.gen.methodId, reroll: true }]);
  }

  static async #onApply() {
    let base;
    let assignIndex = null;
    if ( this.mode === "pointBuy" ) base = { ...this.pb };
    else if ( this.mode === "standardArray" ) base = { ...this.sa };
    else if ( this.mode === "roll" ) {
      base = Object.fromEntries(ABILITIES.map(a => [a, this.gen.sets[this.assign[a]]?.total]));
      assignIndex = { ...this.assign };
    }
    if ( !base ) return;
    const list = ABILITIES.map(a => `${abilityAbbr(a)} ${base[a]}`).join(", ");
    const ok = await DialogV2.confirm({
      window: { title: "Record Ability Scores" },
      content: `<p>Record these base scores?</p><p><strong>${list}</strong></p><p>Once recorded, only the GM can change them.</p>`,
      rejectClose: false
    });
    if ( !ok ) return;
    const saved = await this.#run([{ type: "finalize", mode: this.mode, base, assignIndex }]);
    if ( saved ) {
      ui.notifications.info(`Ability scores recorded for ${this.actor.name}.`);
      this.close();
    }
  }
}
