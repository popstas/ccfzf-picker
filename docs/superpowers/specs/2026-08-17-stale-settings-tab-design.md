# Separate stale-dimming settings tab

## Goal

Move stale-row controls out of the crowded General settings page into a dedicated `Dim stale sessions` tab, express both age thresholds in hours, and make opacity easier to adjust and understand.

## Settings layout

Add a `Dim stale sessions` tab immediately after `General`. Move all four stale controls there; do not duplicate them in `General`:

- `stale.enabled` — `Dim stale sessions and projects`, checkbox, default `false`.
- `stale.sessionHours` — `Sessions become stale after, hours`, number input, default `2`.
- `stale.projectHours` — `Projects become stale after, hours`, number input, default `24`.
- `stale.opacity` — `Stale opacity`, range input from `0.1` through `1.0` in `0.1` steps, default `0.5`.

The opacity control shows `Current: 0.5` beside the slider. Its displayed value updates immediately on input; saving remains explicit through the existing Save button.

## Configuration contract

`stale.projectHours` is the only supported project-age key. The former `stale.projectDays` key is ignored: it is not migrated, converted, displayed, validated, or written. When `projectHours` is absent or invalid, normalization uses the default of `24` hours.

All other stale behavior stays unchanged:

- stale dimming is disabled by default;
- session age defaults to 2 hours;
- opacity defaults to 0.5 and only values from 0.1 through 1.0 are accepted;
- every stale ordinary session is dimmed regardless of live state or window presence;
- every project uses the single project threshold;
- hover restores full opacity.

## Runtime behavior

Project staleness compares the project activity age directly with `projectHours * 60 * 60 * 1000`. No day-based conversion or compatibility branch remains. The settings page continues to produce a minimal config patch, now under `stale.projectHours`.

## Validation and tests

Update focused tests to cover:

- page order and the exclusive placement of stale fields on `Dim stale sessions`;
- defaults of `false`, `2`, `24`, and `0.5`;
- `projectHours` patch generation and validation as a positive finite number;
- complete ignoring of `projectDays`, including configs that contain only that key;
- project classification at an hourly boundary;
- opacity range markup (`min`, `max`, and `step`) and immediate `Current: …` updates;
- preservation of the existing stale-session rules and full-opacity hover behavior.

Run the focused settings/config/classification/page tests, then the complete `npm test` suite. No dependencies or Rust changes are required. After verification, deploy the branch to Windows with `data/scripts/deploy-win.sh` and verify that the interactive application process is running.
