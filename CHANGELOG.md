# Changelog

## 3.0.0

### Learning and model use

- Added an optional trainable neural residual evaluator, preserving classical
  evaluation until weights are selected.
- Added model validation, import/export, deterministic SGD and isolated engines.
- Added self-play generation, bounded replay, whole-game held-out partitions,
  continued candidate training and confidence-gated paired-colour arenas.
- Added resumable CLI training with atomic JSON checkpoints and saved settings.
- Added the browser Self-training lab with start/stop, local checkpoints,
  model/checkpoint import, export and reset.
- Added UCI `EvalFile` model loading and classical fallback.

### Measurement and correctness

- Added external UCI opponent matches, paired openings, relative Elo intervals,
  JSON reports and PGN output. Capped games remain unscored.
- Corrected forced-move and terminal search scores used by training labels.
- Made checkmate take precedence over the fifty-move draw boundary.
- Rejected stale browser search results after starting a new game and kept
  queued model updates from overwriting newer selections.
- Repaired the test file layout and expanded neural, training, UCI and
  checkpoint integration coverage.
- Added browser-source synchronization and stale-source verification.

### Documentation and strength

- Updated the README, training/development guides and plain-text quick start.
- Clarified that historical long-time-control strength was extrapolated.
- 3000+ Elo is an unverified target; this release includes no pretrained weights
  or new independently established absolute rating.
