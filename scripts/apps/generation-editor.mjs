import { ABILITIES, TEMPLATES, abilityAbbr, abilityLabel, openApp } from "../util.mjs";
import { MODE_LABELS, ROLL_METHODS, existingBonuses, getMethod } from "../methods.mjs";
import { reportResults, submit } from "../store.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** GM: write or correct the ability generation record, mainly for characters made before this module. */
export class GenerationEditor extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    tag: "form",
    classes: ["kg-pch", "kg-pch-editor"],
    window: { icon: "fa-solid fa-dice-d20", contentClasses: ["standard-form"] },
    position: { width: 540, height: "auto" },
    form: { handler: GenerationEditor.#onSubmit, closeOnSubmit: true }
  };

  static PARTS = {
    form: { template: `${TEMPLATES}/generation-editor.hbs` },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  static open(actor, generation) {
    if ( !game.user.isGM ) return null;
    const id = `kg-pch-gen-editor-${actor.id}`;
    const app = openApp(id) ?? new GenerationEditor(actor, generation, { id });
    app.generation = generation ?? null;
    app.render({ force: true });
    return app;
  }

  constructor(actor, generation, options={}) {
    super(options);
    this.actor = actor;
    this.generation = generation ?? null;
  }

  get title() {
    return `Ability Generation Record: ${this.actor.name}`;
  }

  async _prepareContext() {
    const gen = this.generation;
    const bonuses = existingBonuses(this.actor);
    const current = gen?.mode === "roll" ? `roll:${gen.methodId}` : (gen?.mode ?? "manual");
    const methods = [
      { value: "pointBuy", label: MODE_LABELS.pointBuy },
      { value: "standardArray", label: MODE_LABELS.standardArray },
      ...ROLL_METHODS.map(m => ({ value: `roll:${m.id}`, label: `Rolled: ${m.label}` })),
      { value: "manual", label: "Other or unknown" }
    ].map(m => ({ ...m, selected: m.value === current }));
    const rows = ABILITIES.map(a => {
      const src = Number(this.actor._source?.system?.abilities?.[a]?.value ?? 10);
      return {
        key: a, abbr: abilityAbbr(a), label: abilityLabel(a),
        base: gen?.base?.[a] ?? (src - (bonuses[a] || 0)),
        bonus: bonuses[a] || 0
      };
    });
    const rolls = (gen?.sets ?? []).map(s => s.total).join(", ");
    return {
      methods, rows, rolls, note: gen?.note ?? "",
      hasBonuses: Object.values(bonuses).some(v => v),
      buttons: [{ type: "submit", icon: "fa-solid fa-floppy-disk", label: "Save Record" }]
    };
  }

  static async #onSubmit(event, form, formData) {
    const d = foundry.utils.expandObject(formData.object);
    const base = {};
    for ( const a of ABILITIES ) {
      const v = Math.floor(Number(d.base?.[a]));
      if ( !Number.isFinite(v) || (v < 1) || (v > 30) ) {
        ui.notifications.warn(`PC History: ${abilityLabel(a)} must be 1 to 30.`);
        return;
      }
      base[a] = v;
    }
    let mode = d.method;
    let methodId = null;
    let methodLabel = MODE_LABELS[mode] ?? "Other or unknown";
    if ( String(mode).startsWith("roll:") ) {
      methodId = mode.slice(5);
      methodLabel = getMethod(methodId)?.label ?? "Rolled";
      mode = "roll";
    }
    const sets = String(d.rolls ?? "").split(/[\s,;]+/).map(Number).filter(n => Number.isFinite(n) && (n > 0))
      .map(total => ({ formula: "", total, dice: [] }));
    const bonuses = existingBonuses(this.actor);
    const generation = {
      status: "final", mode, methodId, methodLabel, base, bonuses,
      sets: sets.length ? sets : null, dropped: null, discarded: [], assignIndex: null,
      note: String(d.note ?? "").trim(), finalizedBy: game.user.id, finalizedAt: Date.now(), verified: true, legacy: true
    };
    const saved = reportResults(await submit(this.actor, [{ type: "setGeneration", generation }]));
    if ( saved && d.applyToSheet ) {
      const updates = {};
      for ( const a of ABILITIES ) updates[`system.abilities.${a}.value`] = base[a] + (bonuses[a] || 0);
      await this.actor.update(updates, { kgPcHistory: true });
    }
  }
}
