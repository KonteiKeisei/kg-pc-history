import { MODULE_ID, TEMPLATES } from "../util.mjs";
import { ROLL_METHODS, defaultRollConfig, rollConfig } from "../methods.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** GM menu: which rolling methods are allowed, rerolls, and roll visibility. */
export class RollingConfig extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "kg-pch-rolling-config",
    tag: "form",
    classes: ["kg-pch", "kg-pch-config"],
    window: { title: "Rolling Methods", icon: "fa-solid fa-dice", contentClasses: ["standard-form"] },
    position: { width: 560, height: "auto" },
    form: { handler: RollingConfig.#onSubmit, closeOnSubmit: true },
    actions: { defaults: RollingConfig.#onDefaults }
  };

  static PARTS = {
    form: { template: `${TEMPLATES}/rolling-config.hbs`, scrollable: [".kg-pch-scroll"] },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  #draft = null;

  async _prepareContext() {
    const cfg = this.#draft ?? rollConfig();
    const modes = Object.entries(CONFIG.Dice.rollModes ?? {}).map(([value, v]) => ({
      value, label: game.i18n.localize(v?.label ?? v), selected: value === cfg.rollMode
    }));
    return {
      methods: ROLL_METHODS.map(m => ({ ...m, checked: !!cfg.methods[m.id] })),
      cfg,
      rollModes: modes,
      buttons: [
        { type: "button", action: "defaults", icon: "fa-solid fa-rotate-left", label: "Defaults" },
        { type: "submit", icon: "fa-solid fa-floppy-disk", label: "Save" }
      ]
    };
  }

  static #onDefaults() {
    this.#draft = defaultRollConfig();
    this.render();
  }

  static async #onSubmit(event, form, formData) {
    const d = foundry.utils.expandObject(formData.object);
    const cfg = {
      methods: Object.fromEntries(ROLL_METHODS.map(m => [m.id, !!d.methods?.[m.id]])),
      rerollLimit: Math.max(0, Math.floor(Number(d.rerollLimit) || 0)),
      freeReroll: !!d.freeReroll,
      freeRerollBelow: Math.floor(Number(d.freeRerollBelow) || 0),
      rollMode: d.rollMode || "publicroll"
    };
    await game.settings.set(MODULE_ID, "rollingConfig", cfg);
    if ( !Object.values(cfg.methods).some(v => v) ) {
      ui.notifications.warn("PC History: no rolling method is allowed, so players cannot roll even with Allow Rolling on.");
    }
  }
}
