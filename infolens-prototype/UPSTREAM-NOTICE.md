# Upstream reference and modifications

This prototype includes the fixed English preview token/bit data from [dqy08/InfoLens](https://github.com/dqy08/InfoLens/blob/08c65f0756178db5eb09e1be8328014987507b9d/extension/info-highlight/options.js#L89) and adapts its sixteen-level paint calibration from [highlightStyle.js](https://github.com/dqy08/InfoLens/blob/08c65f0756178db5eb09e1be8328014987507b9d/extension/info-highlight/highlightStyle.js).

Upstream commit: `08c65f0756178db5eb09e1be8328014987507b9d`. Licensed under Apache License 2.0; a copy is included in `UPSTREAM-LICENSE.txt`. Original source and ownership remain with the upstream contributors. No upstream inference code is executed by this prototype.

Changes: separate ES modules, normalized rule scores for imported text, independent UI controls, a fixed four-style reference preview, and a zero-intensity original-text state. Main reading scores are deterministic demo heuristics. Only the explicitly labelled reference preview uses upstream precomputed Qwen3-0.6B-Base sample values, with no local model run. The original extension's foreground palette and separate fade settings are simplified into this prototype's shared color/strength controls. PDF fallback remains a future integration.
