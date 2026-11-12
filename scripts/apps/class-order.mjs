import { TEMPLATES, esc, openApp, validClassOrder } from "../util.mjs";
import { reportResults, submit } from "../store.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * The actor's classes, original class first, then the rest in the order a saved class order first uses them, then
 * item order. Colors on the History tab follow this order.
 */
export function classesInOrder(actor, order) {
  const classes = actor.items.filter(i => i.type === "class")
    .map(c => ({ id: c.id, name: c.name, levels: Number(c.system?.levels) || 0 }));
  const rank = new Map();
  if ( Array.isArray(order) ) order.forEach((id, i) => { if ( !rank.has(id) ) rank.set(id, i); });
  const original = actor.system?.details?.originalClass;
  return classes.sort((a, b) => {
    if ( a.id === original ) return -1;
    if ( b.id === original ) return 1;
    return (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999);
  });
}

/** The saved order if it still fits the sheet; otherwise the original class's levels first, then the others. */
export function defaultOrder(actor, saved) {
  if ( validClassOrder(actor, saved) ) return [...saved];
  return classesInOrder(actor, saved).flatMap(c => Array(c.levels).fill(c.id));
}

/** GM: which class each character level was taken in, for multiclass characters built before this module. */
export class ClassOrderEditor extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    tag: "form",
    classes: ["kg-pch", "kg-pch-editor", "kg-pch-class-order"],
    window: { icon: "fa-solid fa-layer-group", contentClasses: ["standard-form"] },
    position: { width: 560, height: "auto" },
    form: { handler: ClassOrderEditor.#onSubmit, closeOnSubmit: false }
  };

  static PARTS = {
    form: { template: `${TEMPLATES}/class-order.hbs` },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  static open(actor, saved) {
    if ( !game.user.isGM ) return null;
    const id = `kg-pch-class-order-${actor.id}`;
    const app = openApp(id) ?? new ClassOrderEditor(actor, saved, { id });
    app.render({ force: true });
    return app;
  }

  constructor(actor, saved, options={}) {
    super(options);
    this.actor = actor;
    this.order = defaultOrder(actor, saved);
  }

  get title() {
    return `Class Order: ${this.actor.name}`;
  }

  async _prepareContext() {
    const classes = classesInOrder(this.actor, this.order).map((c, i) => ({ ...c, color: i % 8 }));
    return {
      classes,
      slots: this.order.map((id, i) => ({
        n: i + 1,
        color: classes.find(c => c.id === id)?.color ?? 0,
        options: classes.map(c => ({ id: c.id, name: c.name, selected: c.id === id }))
      })),
      buttons: [{ type: "submit", icon: "fa-solid fa-floppy-disk", label: "Save Order" }]
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    const update = () => {
      this.order = [...this.element.querySelectorAll("select[data-slot]")].map(s => s.value);
      const colors = new Map(context.classes.map(c => [c.id, c.color]));
      this.element.querySelectorAll("select[data-slot]").forEach(s => {
        s.closest(".kg-pch-slot").className = `kg-pch-slot kg-pch-cls-${colors.get(s.value) ?? 0}`;
      });
      const msg = this.element.querySelector(".kg-pch-order-check");
      const ok = validClassOrder(this.actor, this.order);
      const counts = context.classes.map(c => `${esc(c.name)} ${this.order.filter(id => id === c.id).length}`).join(", ");
      const want = context.classes.map(c => `${esc(c.name)} ${c.levels}`).join(", ");
      msg.className = `kg-pch-order-check ${ok ? "ok" : "bad"}`;
      msg.innerHTML = ok ? `Matches the sheet: ${want}.` : `The sheet has ${want}; this order has ${counts}.`;
      this.element.querySelector("button[type=submit]")?.toggleAttribute("disabled", !ok);
    };
    this.element.querySelectorAll("select[data-slot]").forEach(s => s.addEventListener("change", update));
    update();
  }

  static async #onSubmit() {
    if ( !validClassOrder(this.actor, this.order) ) {
      ui.notifications.warn("PC History: the order must use each class exactly as many times as its level.");
      return;
    }
    const ok = reportResults(await submit(this.actor, [{ type: "setClassOrder", order: this.order }]));
    if ( ok ) {
      ui.notifications.info(`Class order saved for ${this.actor.name}. Rebuilt and approximate entries were moved to their levels.`);
      this.close();
    }
  }
}
