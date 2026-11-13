# Changelog

## 1.0.7

- The ability score record's edit and reset buttons are locked with the same padlock as Rebuild. The Ability Scores
  card has its own padlock.
- Unsorted entries are grouped by the item's custom Tidy 5e section when it has one; the rest stay under their type.

## 1.0.6

- Rebuild is locked by default. The GM unlocks it per character with the padlock on the History tab and a
  confirmation; it locks again after one use or a reload.
- Start over now removes every entry the module recorded on its own (level-ups, sheet edits, earlier rebuilds) and
  rebuilds from the sheet, so a swapped class or species no longer leaves duplicates behind. GM entries, notes, edited
  entries and the generation record stay; an edited entry for a replaced item is moved to the current item of the
  same name. It asks you to type START OVER first.
- Rebuild no longer adds a second copy of an item already in the history at another level, such as a feat the GM
  placed by hand.

## 1.0.5

- Rebuild has a Start over option for characters whose class, species or background was replaced. It removes entries
  made by earlier rebuilds and anything tied to items the character no longer has, then rebuilds. GM entries, notes,
  edited entries and the generation record are kept.

## 1.0.4

- Rebuild handles characters whose class lost its feature grants (common after moving a character between worlds):
  it looks up a class or subclass with the same name in the world's compendiums and reads the levels from there. Of
  several matches, the one that names the most of the character's features is used.
- Species and background features are placed at level 0 by their feature type, even when the species grants nothing.
- Rebuild ignores advancement records that point at items the character no longer has, instead of treating those
  grants as filled.
- `rebuildEntries` in the module API now returns a Promise.

## 1.0.3

- Rebuild places features that no advancement recorded (common on imported characters) at the level their class,
  subclass, species or background grants them, matched by compendium source first, then by name. A subclass the
  class's advancement did not record goes to the class's subclass level.
- Running Rebuild again moves features an earlier rebuild left without a level, instead of adding duplicates.

## 1.0.2

- Rebuild now also offers to record the character's base ability scores when it has no generation record: the
  sheet's scores minus the increases its advancements recorded. The method is guessed (standard array, point buy that
  spends exactly the budget, otherwise unknown) and the record is marked Inferred until the GM saves it in the editor.
- The GM's generation editor starts from the same guess when there is no record yet.

## 1.0.1

- Fixed: a level-up could remove the character's link to its history file. dnd5e saves the level-up by replacing the
  character's flags, and the module's link was left out of that save. The next history write could then start a new
  file over the old one. The save now keeps the current link.

## 1.0.0

First release. Tested on Foundry v14 (build 370) with dnd5e 6.0.6, on the default character sheet and Tidy 5e.
Written for Foundry v13 with dnd5e 5.3.3 too, not yet tested there.

- History tab with one card per level: ability scores, proficiencies, languages, defenses, features, feats, spells,
  hit points and scale values, each with its source. Filter by type, class and level, or search.
- Ability score breakdown: base, each increase, and active effects.
- Current modifiers card for effects changing the character now. Not recorded unless the GM records one.
- Hand edits on the sheet are recorded with who made them.
- GM tools: edit, add and delete entries; edit or reset the generation record; rebuild an older character from its
  advancements; set a multiclass character's class order.
- Optional ability score generation (point buy, standard array, nine rolling methods), off by default.
- History is stored in one JSON file per character under `worlds/<world>/pc-history/`.
