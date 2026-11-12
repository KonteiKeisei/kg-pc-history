import { CATEGORIES, TEMPLATES, openApp } from "../util.mjs";
import { makeEntry, reportResults, submit } from "../store.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/** GM: add or edit one history entry. */
export class EntryEditor extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    tag: "form",
    classes: ["kg-pch", "kg-pch-editor"],
    window: { icon: "fa-solid fa-pen", contentClasses: ["standard-form"] },
    position: { width: 500, height: "auto" },
    form: { handler: EntryEditor.#onSubmit, closeOnSubmit: true }
  };

  static PARTS = {
    form: { template: `${TEMPLATES}/entry-editor.hbs` },
    footer: { template: "templates/generic/form-footer.hbs" }
  };

  /**
   * @param {Actor} actor
   * @param {object|null} entry    An existing entry to edit, or null for a new one.
   * @param {object} [prefill]     Starting values for a new entry (label, detail, category, level, source, note).
   */
  static open(actor, entry, prefill=null) {
    if ( !game.user.isGM ) return null;
    const id = `kg-pch-entry-${actor.id}-${entry?.id ?? "new"}`;
    const app = openApp(id) ?? new EntryEditor(actor, entry, { id });
    if ( !entry ) app.prefill = prefill;
    app.render({ force: true });
    return app;
  }

  constructor(actor, entry, options={}) {
    super(options);
    this.actor = actor;
    this.entry = entry ?? null;
    this.prefill = null;
  }

  get title() {
    return `${this.entry ? "Edit" : "Add"} History Entry: ${this.actor.name}`;
  }

  async _prepareContext() {
    const e = this.entry ?? { category: "note", level: this.actor.system?.details?.level ?? 0, ...(this.prefill ?? {}) };
    const src = e.source ?? {};
    return {
      e,
      level: (e.level === null) || (e.level === undefined) ? "" : e.level,
      sourceName: src.classLevel ? `${src.name} ${src.classLevel}` : (src.name ?? ""),
      sourceVia: src.via ?? "",
      categories: Object.entries(CATEGORIES).map(([id, c]) => ({ id, label: c.label, selected: id === e.category })),
      buttons: [{ type: "submit", icon: "fa-solid fa-floppy-disk", label: this.entry ? "Save" : "Add Entry" }]
    };
  }

  static async #onSubmit(event, form, formData) {
    const d = formData.object;
    const label = String(d.label ?? "").trim();
    if ( !label ) {
      ui.notifications.warn("PC History: an entry needs a title.");
      return;
    }
    const levelRaw = d.level;
    const level = (levelRaw === null) || (levelRaw === "") || (levelRaw === undefined) ? null : Math.max(0, Math.floor(Number(levelRaw)));
    const name = String(d.sourceName ?? "").trim();
    const via = String(d.sourceVia ?? "").trim();
    const data = {
      label,
      detail: String(d.detail ?? "").trim(),
      category: d.category in CATEGORIES ? d.category : "note",
      level: Number.isFinite(level) ? level : null,
      note: String(d.note ?? "").trim(),
      source: (name || via) ? { ...(this.entry?.source ?? {}), name, via, classLevel: null } : null
    };
    const ops = this.entry
      ? [{ type: "updateEntry", entryId: this.entry.id, data }]
      : [{ type: "append", entries: [makeEntry({ ...data, origin: "gm" })] }];
    reportResults(await submit(this.actor, ops));
  }
}
