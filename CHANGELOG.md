# Changelog

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
